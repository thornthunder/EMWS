// Tuning and ratings: the search on paper, the edits as pure functions, and the real
// engine finding a resonant length and a resonant coil.

import { describe, expect, it } from 'vitest';
import type { FrequencyResult, Nec2Run } from '../src/engine/nec2/types';
import { vec } from '../src/lib/vec3';
import { modelToDeck } from '../src/tools/antenna-modeler/deck';
import { type AntennaModel, addFeed, addLoad, addWire, emptyModel, wireLength } from '../src/tools/antenna-modeler/model';
import { loadRatings } from '../src/tools/antenna-modeler/ratings';
import { applyVariable, currentValue, deckFor, minimise1D, objectiveOf, suggestedRange, tune } from '../src/tools/antenna-modeler/tune';
import { simulate } from './helpers/engine';

/** A 20 m dipole in free space: 10.26 m of 2 mm wire, fed at the centre. */
function dipole(halfM = 5.13, fMHz = 14.2): { model: AntennaModel; wireId: string } {
  const { model, wireId } = addWire(emptyModel(fMHz), vec(0, -halfM, 0), vec(0, halfM, 0), { segments: 21 });
  return { model: { ...addFeed(model, wireId, 11), pattern: { kind: 'none' } }, wireId };
}

/** An inverted V: two legs meeting at the apex, so a junction has to follow a moved end. */
function invertedV(): { model: AntennaModel; left: string; right: string } {
  const m0 = emptyModel(7.1);
  const l = addWire(m0, vec(0, -8, 6), vec(0, 0, 10), { segments: 11 });
  const r = addWire(l.model, vec(0, 0, 10), vec(0, 8, 6), { segments: 11 });
  return { model: addFeed(r.model, l.wireId, 11), left: l.wireId, right: r.wireId };
}

describe('the search, on paper', () => {
  it('finds the minimum of a bowl to within the tolerance, in few evaluations', async () => {
    const calls: number[] = [];
    const found = await minimise1D(
      async (x) => {
        calls.push(x);
        return (x - 3.7) ** 2 + 1;
      },
      { min: 0, max: 10 },
      { tolerance: 1e-4 },
    );
    expect(found.value).toBeCloseTo(3.7, 3);
    expect(found.score).toBeCloseTo(1, 6);
    expect(found.evaluations).toBeLessThan(40);
    expect(found.evaluations).toBe(calls.length);
    expect(found.truncated).toBe(false);
  });

  it('is not fooled by a second, shallower dip', async () => {
    // Dips at 2 (shallow) and 8 (deep): a plain golden section from one end could stop at 2.
    const f = async (x: number) => -0.6 * Math.exp(-((x - 2) ** 2)) - Math.exp(-((x - 8) ** 2) / 0.5);
    const found = await minimise1D(f, { min: 0, max: 10 }, { tolerance: 1e-3 });
    expect(found.value).toBeCloseTo(8, 2);
  });

  it('stops at the evaluation ceiling and says so', async () => {
    const found = await minimise1D(async (x) => Math.abs(x - 0.123456), { min: 0, max: 1 }, { maxEvaluations: 12, tolerance: 1e-9 });
    expect(found.truncated).toBe(true);
    expect(found.evaluations).toBe(12);
    expect(Math.abs(found.value - 0.123456)).toBeLessThan(0.2);
  });
});

describe('what a variable does to the model', () => {
  it('stretches a wire about its middle, or from one end, along its own direction', () => {
    const { model, wireId } = dipole();
    const both = applyVariable(model, { kind: 'wire-length', wireId, ends: 'both' }, 12);
    const w = both.wires[0]!;
    expect(wireLength(w)).toBeCloseTo(12, 9);
    expect(w.a.y).toBeCloseTo(-6, 9);
    expect(w.b.y).toBeCloseTo(6, 9);
    expect(w.a.x).toBe(0);
    const fromB = applyVariable(model, { kind: 'wire-length', wireId, ends: 'b' }, 12);
    expect(fromB.wires[0]!.a.y).toBeCloseTo(-5.13, 9);
    expect(fromB.wires[0]!.b.y).toBeCloseTo(6.87, 9);
    expect(currentValue(fromB, { kind: 'wire-length', wireId, ends: 'b' })).toBeCloseTo(12, 9);
    // The feed stays on its segment; nothing else about the model changes.
    expect(both.feeds).toEqual(model.feeds);
    expect(both.frequency).toBe(model.frequency);
  });

  it('takes a joined end along: lengthening one leg of a V moves the apex and the other leg', () => {
    const { model, left, right } = invertedV();
    const longer = applyVariable(model, { kind: 'wire-length', wireId: left, ends: 'b' }, 10);
    const l = longer.wires.find((w) => w.id === left)!;
    const r = longer.wires.find((w) => w.id === right)!;
    expect(wireLength(l)).toBeCloseTo(10, 9);
    expect(r.a).toEqual(l.b); // still joined at the apex
  });

  it('lifts the whole antenna for a height variable, and edits a load for a load variable', () => {
    const { model, right } = invertedV();
    expect(currentValue(model, { kind: 'height' })).toBe(6);
    const lifted = applyVariable(model, { kind: 'height' }, 9);
    expect(currentValue(lifted, { kind: 'height' })).toBe(9);
    expect(lifted.wires.find((w) => w.id === right)!.a.z).toBeCloseTo(13, 9);
    const loaded = addLoad(model, right, 3, { kind: 'series', henries: 1e-6, ohms: 0.5, farads: 0 });
    const loadId = loaded.loads[0]!.id;
    const variable = { kind: 'load', loadId, field: 'henries' } as const;
    expect(currentValue(loaded, variable)).toBe(1e-6);
    expect(applyVariable(loaded, variable, 2.5e-6).loads[0]!.henries).toBe(2.5e-6);
    const range = suggestedRange(loaded, variable);
    expect(range.min).toBeLessThan(1e-6);
    expect(range.max).toBeGreaterThan(1e-6);
  });

  it('solves one frequency for a point goal, and only grows a pattern when a goal needs one', () => {
    const { model } = dipole();
    const sweep = { ...model, frequency: { startMHz: 14, stepMHz: 0.05, steps: 9 } };
    expect(deckFor(sweep, { kind: 'resonance', fMHz: 14.2 })).toMatch(/^FR 0 1 0 0 14\.2 0$/m);
    expect(deckFor(sweep, { kind: 'resonance', fMHz: 14.2 })).not.toMatch(/^RP/m);
    expect(deckFor(sweep, { kind: 'gain', fMHz: 14.2 })).toMatch(/^RP 0 19 36 1000 0 0 10 10$/m);
    expect(deckFor(sweep, { kind: 'swr-band', z0: 50 })).toMatch(/^FR 0 9 0 0 14 0\.05$/m);
  });
});

describe('scoring a solved run', () => {
  const runWith = (frequencies: Partial<FrequencyResult>[]): Nec2Run =>
    ({ report: { frequencies: frequencies.map((f) => ({ frequencyMHz: 14.2, wavelengthM: 21.1, environment: 'free-space', feeds: [], currents: [], patterns: [], ...f })) } }) as unknown as Nec2Run;
  const feed = (re: number, im: number) => ({ tag: 1, segment: 11, voltage: { re: 1, im: 0 }, current: { re: 0, im: 0 }, impedance: { re, im }, admittance: { re: 0, im: 0 }, powerW: 0 });

  it('scores reactance, SWR, the worst SWR of a sweep, and gain, lower is better', () => {
    expect(objectiveOf(runWith([{ feeds: [feed(72, -30)] }]), { kind: 'resonance', fMHz: 14.2 }).score).toBe(30);
    expect(objectiveOf(runWith([{ feeds: [feed(50, 0)] }]), { kind: 'swr', fMHz: 14.2, z0: 50 }).score).toBeCloseTo(1, 9);
    const band = objectiveOf(runWith([{ frequencyMHz: 14, feeds: [feed(50, 0)] }, { frequencyMHz: 14.3, feeds: [feed(100, 0)] }]), { kind: 'swr-band', z0: 50 });
    expect(band.score).toBeCloseTo(2, 9);
    expect(band.readout).toContain('14.3 MHz');
    const points = [0, 90, 180].map((phiDeg) => ({ thetaDeg: 90, phiDeg, verticalDb: 0, horizontalDb: 0, totalDb: phiDeg === 0 ? 7.5 : 1, axialRatio: 0, tiltDeg: 0, sense: 'LINEAR' }));
    expect(objectiveOf(runWith([{ patterns: [{ points }] }]), { kind: 'gain', fMHz: 14.2 }).score).toBe(-7.5);
    expect(objectiveOf(runWith([{}]), { kind: 'resonance', fMHz: 14.2 }).score).toBe(Infinity);
  });
});

describe('tuning with the engine', () => {
  const solve = (deck: string) => simulate(deck);

  it('finds the resonant length of a 20 m dipole', async () => {
    const { model, wireId } = dipole(4.6); // start well short: about 9.2 m
    const goal = { kind: 'resonance', fMHz: 14.2 } as const;
    const result = await tune(model, { variable: { kind: 'wire-length', wireId, ends: 'both' }, range: { min: 9, max: 11.5 }, goal }, solve);
    // A half wave of 2 mm wire at 14.2 MHz is a little over 10 m; not at either edge.
    expect(result.value).toBeGreaterThan(9.8);
    expect(result.value).toBeLessThan(10.6);
    expect(result.atEdge).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.evaluations.length).toBeLessThan(45);
    // The tuned model really is resonant: solve it afresh and look.
    const check = await simulate(deckFor(result.model, goal));
    expect(Math.abs(check.report.frequencies[0]!.feeds[0]!.impedance.im)).toBeLessThan(3);
  }, 60_000);

  it('finds the loading coil that resonates a short dipole', async () => {
    const { model, wireId } = dipole(3.5); // 7 m at 14.2 MHz: strongly capacitive
    const loaded = addLoad(model, wireId, 11, { kind: 'series', ohms: 0.3, henries: 1e-6, farads: 0, label: 'coil' });
    const loadId = loaded.loads[0]!.id;
    const goal = { kind: 'resonance', fMHz: 14.2 } as const;
    const result = await tune(loaded, { variable: { kind: 'load', loadId, field: 'henries' }, range: { min: 0.2e-6, max: 12e-6 }, goal }, solve);
    expect(result.atEdge).toBe(false);
    const check = await simulate(deckFor(result.model, goal));
    expect(Math.abs(check.report.frequencies[0]!.feeds[0]!.impedance.im)).toBeLessThan(5);
    expect(result.model.loads[0]!.henries).toBe(result.value);
  }, 60_000);
});

describe('what the loads must survive', () => {
  it('scales NEC’s currents to your power and prices volts, amps and heat', () => {
    const { model, wireId } = dipole();
    const loaded = addLoad(model, wireId, 7, { kind: 'series', ohms: 1, henries: 2.2e-6, farads: 0, label: 'coil' });
    const w = 2 * Math.PI * 14.2e6;
    // NEC solved it with one volt: 2 W in, and 0.4 A peak in segment 7.
    const frequency: FrequencyResult = {
      frequencyMHz: 14.2,
      wavelengthM: 21.1,
      environment: 'free-space',
      feeds: [],
      // Every segment of the wire, as the engine lists them; the seventh carries 0.4 A peak.
      currents: Array.from({ length: 21 }, (_, i) => ({ segment: i + 1, tag: 1, current: { re: i === 6 ? 0.4 : 0.1, im: 0 }, magnitude: i === 6 ? 0.4 : 0.1, phaseDeg: 0 })),
      power: { inputW: 2, radiatedW: 2, structureLossW: 0, networkLossW: 0, efficiencyPct: 100 },
      patterns: [],
    };
    const [rating] = loadRatings(loaded, frequency, 100);
    const k = Math.sqrt(100 / 2);
    expect(rating!.where).toBe('Wire 1, segment 7');
    expect(rating!.ampsRms).toBeCloseTo((k * 0.4) / Math.SQRT2, 9);
    expect(rating!.voltsPeak).toBeCloseTo(k * 0.4 * Math.hypot(1, w * 2.2e-6), 6);
    expect(rating!.heatW).toBeCloseTo(0.5 * (k * 0.4) ** 2 * 1, 9);
    // No power solved, or no such segment, and it says nothing rather than something wrong.
    expect(loadRatings(loaded, { ...frequency, power: undefined, feeds: [] }, 100)).toEqual([]);
    expect(loadRatings(loaded, { ...frequency, currents: [] }, 100)).toEqual([]);
  });

  it('agrees with the engine: a resistor in the wire takes the power the budget says it does', async () => {
    const { model, wireId } = dipole();
    const loaded = { ...addLoad(model, wireId, 11, { kind: 'series', ohms: 20, henries: 0, farads: 0, label: 'resistor' }), pattern: { kind: 'none' as const } };
    const run = await simulate(modelToDeck(loaded));
    const frequency = run.report.frequencies[0]!;
    const [rating] = loadRatings(loaded, frequency, 100);
    // NEC's structure loss, scaled to 100 W in, is exactly the heat in the one load.
    const lossAt100W = (frequency.power!.structureLossW / frequency.power!.inputW) * 100;
    expect(rating!.heatW).toBeCloseTo(lossAt100W, 1);
    expect(rating!.heatW).toBeGreaterThan(15); // 20 ohms in series with ~72 ohms of radiation resistance takes about a fifth
  });
});
