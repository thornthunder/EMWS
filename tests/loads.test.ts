// Loads on wires: coils, traps and fixed impedances on one segment (LD 0, 1 and 4 cards).
//
// The model keeps them the way it keeps feeds - a segment on a wire - so every edit that
// moves feeds must move loads the same way, and the deck must carry them in both
// directions without loss. Other LD forms (a run of segments, per-metre loads, wire
// conductivity) are not modelled and must survive untouched.

import { describe, expect, it } from 'vitest';
import { vec } from '../src/lib/vec3';
import { deckToModel, modelToDeck } from '../src/tools/antenna-modeler/deck';
import { loadExample, simulate } from './helpers/engine';
import {
  type AntennaModel,
  addFeed,
  addLoad,
  addWire,
  deleteWire,
  emptyModel,
  loadImpedance,
  removeLoad,
  setLoadPosition,
  setWireGeometry,
  splitWire,
  updateLoad,
} from '../src/tools/antenna-modeler/model';
import { validateModel } from '../src/tools/antenna-modeler/validate';

/** A 20 m dipole with a coil a third of the way along. */
function loadedDipole(): { model: AntennaModel; wireId: string } {
  const { model, wireId } = addWire(emptyModel(14.2), vec(0, -5, 10), vec(0, 5, 10), { segments: 21 });
  const fed = addFeed(model, wireId, 11);
  return { model: addLoad(fed, wireId, 7, { kind: 'series', ohms: 0.3, henries: 2.2e-6, farads: 0, label: 'coil' }), wireId };
}

describe('loads in the model', () => {
  it('adds a load on a segment, several to a segment if asked, and removes it', () => {
    const { model, wireId } = loadedDipole();
    expect(model.loads).toHaveLength(1);
    expect(model.loads[0]).toMatchObject({ wireId, segment: 7, kind: 'series', henries: 2.2e-6, label: 'coil' });
    // NEC adds loads on one segment in series, so two are allowed; and a load may sit on the fed segment.
    const twice = addLoad(addLoad(model, wireId, 7), wireId, 11);
    expect(twice.loads).toHaveLength(3);
    const gone = removeLoad(model, model.loads[0]!.id);
    expect(gone.loads).toHaveLength(0);
    expect(removeLoad(gone, 'nothing')).toBe(gone);
  });

  it('keeps a load in place along the wire when the segment count changes', () => {
    const { model, wireId } = loadedDipole();
    const finer = setWireGeometry(model, wireId, { segments: 63 });
    // Segment 7 of 21 is centred 6.5/21 along; the nearest of 63 is segment 20 (19.5/63).
    expect(finer.loads[0]!.segment).toBe(20);
  });

  it('goes with its wire when the wire is deleted, and to the right half when it is split', () => {
    const { model, wireId } = loadedDipole();
    expect(deleteWire(model, wireId).loads).toHaveLength(0);
    const split = splitWire(model, wireId, 0.5)!;
    // The coil was at 6.5/21 = 31% along, so it stays on the first half, at 62% of it.
    const load = split.model.loads[0]!;
    expect(load.wireId).toBe(wireId);
    expect(load.segment).toBe(7);
    const feed = split.model.feeds[0]!;
    expect(feed.wireId).toBe(split.newWireId);
  });

  it('moves to the segment centre nearest a fraction, and is edited in place', () => {
    const { model } = loadedDipole();
    const id = model.loads[0]!.id;
    const moved = setLoadPosition(model, id, 0.9);
    expect(moved.loads[0]!.segment).toBe(19); // 18.5/21 = 0.881, the nearest centre to 0.9
    expect(setLoadPosition(moved, id, 0.9)).toBe(moved);
    const trap = updateLoad(moved, id, { kind: 'parallel', henries: 8e-6, farads: 62.8e-12, ohms: 70e3, label: '40 m trap' });
    expect(trap.loads[0]).toMatchObject({ kind: 'parallel', segment: 19, label: '40 m trap' });
  });

  it('works out what a load is worth at a frequency the way NEC will', () => {
    const coil = loadImpedance({ id: 'x', wireId: 'w', segment: 1, kind: 'series', ohms: 0.3, henries: 2.2e-6, farads: 0, reactance: 0 }, 14.2);
    expect(coil.re).toBe(0.3);
    expect(coil.im).toBeCloseTo(2 * Math.PI * 14.2e6 * 2.2e-6, 6);
    // A parallel L and C at their own resonance: as high as the parallel R lets it be.
    const w = 2 * Math.PI * 7.1e6;
    const trap = loadImpedance({ id: 'x', wireId: 'w', segment: 1, kind: 'parallel', ohms: 70e3, henries: 8e-6, farads: 1 / (w * w * 8e-6), reactance: 0 }, 7.1);
    expect(trap.re).toBeCloseTo(70e3, 3);
    expect(Math.abs(trap.im)).toBeLessThan(1);
    // Fixed: as typed, whatever the frequency.
    const fixed = loadImpedance({ id: 'x', wireId: 'w', segment: 1, kind: 'impedance', ohms: 10, henries: 0, farads: 0, reactance: -50 }, 3.5);
    expect(fixed).toEqual({ re: 10, im: -50 });
  });

  it('warns about loads that do nothing, cut the wire, or cannot follow a sweep', () => {
    const { model, wireId } = loadedDipole();
    const id = model.loads[0]!.id;
    const messages = (m: AntennaModel) => validateModel(m).map((i) => i.message);
    expect(messages(model).some((t) => /coil/.test(t))).toBe(false);
    expect(messages(updateLoad(model, id, { ohms: 0, henries: 0, farads: 0 }))).toContainEqual(expect.stringMatching(/does nothing/));
    expect(messages(updateLoad(model, id, { kind: 'parallel', ohms: 0, henries: 0, farads: 0 }))).toContainEqual(expect.stringMatching(/open circuit/));
    const swept = { ...updateLoad(model, id, { kind: 'impedance', reactance: 200 }), frequency: { startMHz: 14, stepMHz: 0.05, steps: 7 } };
    expect(messages(swept)).toContainEqual(expect.stringMatching(/fixed R \+ jX/));
    expect(messages(addLoad(model, wireId, 3, { kind: 'impedance', reactance: 200 }))).not.toContainEqual(expect.stringMatching(/fixed R \+ jX/));
  });
});

describe('loads in the deck', () => {
  const imported = (text: string): AntennaModel => {
    const result = deckToModel(text);
    if (!result.ok) throw new Error(result.reason);
    return result.model;
  };

  it('writes LD 0, 1 and 4 cards on the wire’s tag and reads them back the same', () => {
    const { model, wireId } = loadedDipole();
    // Values that survive the deck's ten significant digits, so the comparison can be exact.
    const full = addLoad(addLoad(model, wireId, 3, { kind: 'parallel', ohms: 70e3, henries: 8e-6, farads: 62.8e-12, label: 'trap' }), wireId, 15, {
      kind: 'impedance',
      ohms: 10,
      henries: 0,
      farads: 0,
      reactance: -50,
    });
    const deck = modelToDeck(full);
    const ld = deck.split('\n').filter((l) => l.startsWith('LD'));
    expect(ld).toHaveLength(3);
    expect(ld[0]).toBe('LD 0 1 7 7 0.3 0.0000022 0');
    expect(ld[1]).toBe('LD 1 1 3 3 70000 0.000008 6.28e-11');
    expect(ld[2]).toBe('LD 4 1 15 15 10 -50');
    // Before FR and EX, where a setup card belongs.
    const order = deck.split('\n').map((l) => l.slice(0, 2));
    expect(order.indexOf('LD')).toBeLessThan(order.indexOf('FR'));

    const back = imported(deck);
    expect(back.loads.map((l) => ({ ...l, id: '', wireId: '' }))).toEqual(full.loads.map((l) => ({ ...l, id: '', wireId: '', label: undefined })));
    expect(back.extraCards).toEqual([]);
    expect(modelToDeck(back)).toBe(deck);
  });

  it('resolves a load by tag and by absolute segment, like a source', () => {
    const deck = ['CE', 'GW 1 5 0 -1 0 0 0 0 0.001', 'GW 2 5 0 0 0 0 1 0 0.001', 'GE 0', 'LD 0 2 2 2 0 0.000001 0', 'LD 4 0 8 8 5 20', 'FR 0 1 0 0 14 0', 'EX 0 1 5 0 1 0', 'XQ', 'EN'].join('\n');
    const model = imported(deck);
    const second = model.wires[1]!;
    expect(model.loads).toHaveLength(2);
    expect(model.loads[0]).toMatchObject({ wireId: second.id, segment: 2, kind: 'series', henries: 1e-6 });
    // Absolute segment 8 is the third segment of the second wire.
    expect(model.loads[1]).toMatchObject({ wireId: second.id, segment: 3, kind: 'impedance', ohms: 5, reactance: 20 });
  });

  it('leaves the LD forms it does not model exactly as written', () => {
    // A whole-wire LD 5 is the wire's material (tests/ground.test.ts); these three are not modelled and travel verbatim.
    const kept = ['LD 0 1 2 4 0 0.000001 0', 'LD 2 1 0 0 0 0.000001 0', 'LD -1'];
    const deck = ['CE', 'GW 1 5 0 -1 0 0 0 0 0.001', 'GE 0', 'LD 5 1 0 0 58000000', ...kept, 'LD 0 1 3 3 0 0.000002 0', 'FR 0 1 0 0 14 0', 'EX 0 1 3 0 1 0', 'XQ', 'EN'].join('\n');
    const model = imported(deck);
    expect(model.extraCards).toEqual(kept);
    expect(model.wires[0]!.conductivity).toBe(5.8e7);
    expect(model.loads).toHaveLength(1);
    const out = modelToDeck(model);
    for (const card of [...kept, 'LD 5 1 0 0 58000000']) expect(out).toContain(card);
  });

  it('refuses a load on a segment that does not exist, saying which', () => {
    const deck = ['CE', 'GW 1 5 0 -1 0 0 0 0 0.001', 'GE 0', 'LD 0 1 9 9 0 0.000001 0', 'FR 0 1 0 0 14 0', 'EX 0 1 3 0 1 0', 'XQ', 'EN'].join('\n');
    const result = deckToModel(deck);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/load is on segment 9 of tag 1/);
  });
});

describe('loads through the engine', () => {
  /** The example at one frequency, impedance only. */
  const at = async (deck: string, fMHz: number) => {
    const single = deck.replace(/^FR .*$/m, `FR 0 1 0 0 ${fMHz} 0`).replace(/^RP .*$/m, 'XQ');
    const f = (await simulate(single)).report.frequencies[0]!;
    return { z: f.feeds[0]!.impedance, efficiency: f.power!.efficiencyPct };
  };

  it('the trap dipole works on both bands, and the traps cost what the example says', async () => {
    const deck = await loadExample('trap-dipole-40-80m.nec');
    // Measured with this engine when the example was tuned: 87 + j2 ohms and 90.8 % on 40 m,
    // 47 - j2 ohms and 98.2 % on 80 m, where each trap is only its coil.
    const forty = await at(deck, 7.1);
    expect(forty.z.re).toBeGreaterThan(80);
    expect(forty.z.re).toBeLessThan(95);
    expect(Math.abs(forty.z.im)).toBeLessThan(10);
    expect(forty.efficiency).toBeGreaterThan(88);
    expect(forty.efficiency).toBeLessThan(93);
    const eighty = await at(deck, 3.65);
    expect(eighty.z.re).toBeGreaterThan(40);
    expect(eighty.z.re).toBeLessThan(55);
    expect(Math.abs(eighty.z.im)).toBeLessThan(10);
    expect(eighty.efficiency).toBeGreaterThan(97);
    // The editor reads the traps back as loads, so they can be dragged and edited.
    const result = deckToModel(deck);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.loads).toHaveLength(2);
      expect(result.model.loads.every((l) => l.kind === 'parallel' && l.henries === 8.2e-6 && l.segment === 1)).toBe(true);
      expect(result.model.extraCards).toEqual([]);
    }
  });

  it('a loading coil makes a dipole electrically longer, and its loss shows in the efficiency', async () => {
    const { model } = loadedDipole();
    const solve = async (m: AntennaModel) => (await simulate(modelToDeck({ ...m, pattern: { kind: 'none' } }))).report.frequencies[0]!;
    const plain = await solve({ ...model, loads: [] });
    const loaded = await solve(model);
    // 2.2 uH a third of the way along adds inductive reactance at the feed: the wire reads longer.
    expect(loaded.feeds[0]!.impedance.im).toBeGreaterThan(plain.feeds[0]!.impedance.im + 20);
    // Nothing loses power in the bare model; the coil's 0.3 ohm does.
    expect(plain.power!.efficiencyPct).toBeCloseTo(100, 0);
    expect(loaded.power!.efficiencyPct).toBeLessThan(100);
    expect(loaded.power!.efficiencyPct).toBeGreaterThan(90);
  });
});
