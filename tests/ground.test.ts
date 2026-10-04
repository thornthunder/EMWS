// Radial screens and wire materials: carried in the deck, drawn into the checks, and held
// to what nec2c was measured to do with them.

import { describe, expect, it } from 'vitest';
import { mainLobe } from '../src/engine/nec2/pattern';
import { vec } from '../src/lib/vec3';
import { deckToModel, modelToDeck } from '../src/tools/antenna-modeler/deck';
import { type AntennaModel, WIRE_MATERIALS, addFeed, addWire, emptyModel, setWireConductivity } from '../src/tools/antenna-modeler/model';
import { validateModel } from '../src/tools/antenna-modeler/validate';
import { loadExample, simulate } from './helpers/engine';

const imported = (text: string): AntennaModel => {
  const result = deckToModel(text);
  if (!result.ok) throw new Error(result.reason);
  return result.model;
};

/** A 40 m vertical standing on the origin, 21 segments of 2 mm wire. */
function vertical(ground: AntennaModel['ground'], heightM = 10.26): AntennaModel {
  const { model, wireId } = addWire(emptyModel(7.1), vec(0, 0, 0), vec(0, 0, heightM), { segments: 21 });
  return { ...addFeed(model, wireId, 1), ground, pattern: { kind: 'none' } };
}
const screened: AntennaModel['ground'] = { kind: 'real', permittivity: 13, conductivity: 0.005, method: 'reflection', screen: { radials: 16, radiusM: 10, wireRadiusM: 0.001 } };

describe('in the deck', () => {
  it('writes a radial screen on the GN card and reads it back, and still refuses a cliff', () => {
    const deck = modelToDeck(vertical(screened));
    expect(deck).toMatch(/^GN 0 16 0 0 13 0\.005 10 0\.001$/m);
    const back = imported(deck);
    expect(back.ground).toEqual(screened);
    expect(modelToDeck(back)).toBe(deck);
    // A second medium is still beyond the editor.
    const cliff = deckToModel(deck.replace(/^GN .*$/m, 'GN 0 0 0 0 13 0.005 5 0.001 100 0'));
    expect(cliff.ok).toBe(false);
    if (!cliff.ok) expect(cliff.reason).toMatch(/cliff/);
    // A screen on a perfect ground is a contradiction nec2c would not take either.
    const odd = deckToModel(deck.replace(/^GN .*$/m, 'GN 1 16'));
    expect(odd.ok).toBe(false);
  });

  it('writes wire conductivity as LD 5 over the whole wire, reads a per-tag or all-wires LD 5 back, and keeps the rest verbatim', () => {
    const { model, wireId } = addWire(emptyModel(14.2), vec(0, -5, 10), vec(0, 5, 10), { segments: 21 });
    const two = addWire(model, vec(0, -5, 12), vec(0, 5, 12), { segments: 21 });
    const copper = setWireConductivity(addFeed(two.model, wireId, 11), wireId, 5.95e7);
    const deck = modelToDeck(copper);
    expect(deck).toMatch(/^LD 5 1 0 0 59500000$/m);
    expect(deck).not.toMatch(/^LD 5 2/m);
    const back = imported(deck);
    expect(back.wires[0]!.conductivity).toBe(5.95e7);
    expect(back.wires[1]!.conductivity).toBeUndefined();
    // Tag 0 means every wire.
    const everyWire = imported(deck.replace(/^LD 5 1 0 0 59500000$/m, 'LD 5 0 0 0 35000000'));
    expect(everyWire.wires.map((w) => w.conductivity)).toEqual([3.5e7, 3.5e7]);
    // A conductivity over part of a wire is not modelled, and travels untouched.
    const partial = imported(deck.replace(/^LD 5 1 0 0 59500000$/m, 'LD 5 1 3 9 59500000'));
    expect(partial.wires[0]!.conductivity).toBeUndefined();
    expect(partial.extraCards).toEqual(['LD 5 1 3 9 59500000']);
    expect(deckToModel(deck.replace(/^LD 5 1 0 0 59500000$/m, 'LD 5 7 0 0 59500000')).ok).toBe(false);
    // Taking the material away takes the card away.
    expect(modelToDeck(setWireConductivity(copper, wireId, undefined))).not.toMatch(/^LD 5/m);
  });
});

describe('the checks', () => {
  const messages = (m: AntennaModel) => validateModel(m).map((i) => `${i.severity}: ${i.message}`);

  it('warns about a wire on real ground with no screen, and says how to fix it', () => {
    const bare = vertical({ kind: 'real', permittivity: 13, conductivity: 0.005, method: 'sommerfeld' });
    expect(messages(bare)).toContainEqual(expect.stringMatching(/warning: Wire 1 reaches the ground.*radial screen/));
    expect(messages(vertical(screened)).some((t) => /reaches the ground/.test(t))).toBe(false);
    expect(messages(vertical({ kind: 'perfect' })).some((t) => /reaches the ground/.test(t))).toBe(false);
  });

  it('refuses a screen under Sommerfeld, as nec2c does, and wants a wire at the origin', () => {
    expect(messages(vertical({ ...screened, method: 'sommerfeld' }))).toContainEqual(expect.stringMatching(/error: nec2c refuses a radial screen with the Sommerfeld/));
    const offCentre = { ...vertical(screened) };
    offCentre.wires = offCentre.wires.map((w) => ({ ...w, a: { ...w.a, x: 3 }, b: { ...w.b, x: 3 } }));
    expect(messages(offCentre)).toContainEqual(expect.stringMatching(/warning: .*no wire ends there/));
  });
});

describe('what nec2c does with them', () => {
  const solve = async (m: AntennaModel) => (await simulate(modelToDeck({ ...m, pattern: { kind: 'cards', cards: ['RP 0 19 72 1000 0 0 5 5'] } }))).report.frequencies[0]!;
  const peakDb = (f: Awaited<ReturnType<typeof solve>>) => mainLobe(f.patterns.flatMap((p) => p.points))!.totalDb;

  it('a screen connects the base as over perfect ground, whatever its size; the soil shapes the far field', async () => {
    const perfect = await solve(vertical({ kind: 'perfect' }));
    const withScreen = await solve(vertical(screened));
    const z0 = perfect.feeds[0]!.impedance;
    const z1 = withScreen.feeds[0]!.impedance;
    // Measured 2026-10-04: 36.59 - j0.22 ohms in both cases.
    expect(z1.re).toBeCloseTo(z0.re, 2);
    expect(z1.im).toBeCloseTo(z0.im, 2);
    const bigScreen = await solve(vertical({ ...screened, screen: { radials: 64, radiusM: 40, wireRadiusM: 0.01 } }));
    expect(bigScreen.feeds[0]!.impedance.re).toBeCloseTo(z1.re, 6);
    expect(peakDb(bigScreen)).toBeCloseTo(peakDb(withScreen), 6);
    // The real ground takes the horizon away: about -0.1 dBi at 25 degrees against 5.1 dBi at 0.
    expect(peakDb(perfect)).toBeGreaterThan(4.5);
    expect(peakDb(withScreen)).toBeLessThan(0.5);
    expect(peakDb(withScreen)).toBeGreaterThan(-1);
  });

  it('copper costs a little, aluminium a little more, steel a great deal', async () => {
    const eff = async (siemens: number | undefined) => {
      const m = vertical(screened);
      return (await solve(setWireConductivity(m, m.wires[0]!.id, siemens))).power!.efficiencyPct;
    };
    const copper = await eff(WIRE_MATERIALS.find((m) => m.id === 'copper')!.siemensPerM);
    const aluminium = await eff(WIRE_MATERIALS.find((m) => m.id === 'aluminium')!.siemensPerM);
    const steel = await eff(WIRE_MATERIALS.find((m) => m.id === 'steel')!.siemensPerM);
    expect(await eff(undefined)).toBe(100);
    // Measured 2026-10-04: 98.43, 97.91 and 59.8 % for this 2 mm wire.
    expect(copper).toBeGreaterThan(98);
    expect(copper).toBeLessThan(99);
    expect(aluminium).toBeLessThan(copper);
    expect(aluminium).toBeGreaterThan(97);
    expect(steel).toBeLessThan(65);
    expect(steel).toBeGreaterThan(50);
  });

  it('the example resonates where it says, and imports with its screen and its copper', async () => {
    const deck = await loadExample('vertical-40m-radials.nec');
    const model = imported(deck);
    expect(model.ground).toEqual(screened);
    expect(model.wires[0]!.conductivity).toBe(5.95e7);
    const f = (await simulate(deck)).report.frequencies[0]!;
    const z = f.feeds[0]!.impedance;
    expect(z.re).toBeGreaterThan(35);
    expect(z.re).toBeLessThan(38);
    expect(Math.abs(z.im)).toBeLessThan(1);
    expect(f.power!.efficiencyPct).toBeGreaterThan(98);
  });
});
