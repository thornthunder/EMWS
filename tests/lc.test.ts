// Coils, traps and filters, against the limits the textbooks give exactly.
//
// Nothing here is a number typed in from a table. Every expectation is either a closed
// form (the ideal long solenoid, the skin depth of copper, Butterworth's response at
// twice the cutoff) or an identity the maths must satisfy (a lossless filter passes
// what it does not reflect; a Chebyshev ripple never exceeds the ripple asked for).

import { describe, expect, it } from 'vitest';
import { cAbs } from '../src/lib/complex';
import {
  type CoilSpec,
  CLOSE_WOUND_PROXIMITY,
  MU0,
  inductanceH,
  meanDiameterMm,
  qualityEstimate,
  selfResonanceBoundMHz,
  skinDepthM,
  turnsFor,
  wheeler1928H,
  windingLengthMm,
  wireLengthM,
  wireResistanceOhms,
} from '../src/tools/lc/coil';
import { bandwidthMHz, capacitorFor, inductorFor, resonanceMHz, resonantImpedanceOhms, trapAt, trapImpedance } from '../src/tools/lc/trap';
import { E24, logFrequencies, nearestStandard, prototype, respond, synthesise, withStandardCapacitors } from '../src/tools/lc/filter';

const bare = (turns: number, formerMm: number, wireMm: number, spacing = 1): CoilSpec => ({ turns, formerMm, wireMm, wallMm: 0, spacing });

describe('air-cored coils', () => {
  it('tends to the ideal long solenoid, mu0 N^2 A / l, short of it by the end correction', () => {
    // A finite solenoid falls short of the ideal by Nagaoka's first-order term, 4D / 3 pi l.
    const shortfall = (spec: CoilSpec) => 1 - (4 * meanDiameterMm(spec)) / (3 * Math.PI * windingLengthMm(spec));
    const ideal = (spec: CoilSpec) => (MU0 * spec.turns ** 2 * Math.PI * (meanDiameterMm(spec) / 2000) ** 2) / (windingLengthMm(spec) / 1000);
    // 1000 turns of 0.5 mm wire on a 9.5 mm former: half a metre long, 1 cm across.
    const long = bare(1000, 9.5, 0.5);
    expect(inductanceH(long) / ideal(long)).toBeCloseTo(shortfall(long), 3);
    // Ten times longer still: within a thousandth of the ideal.
    const longer = bare(10000, 9.5, 0.5);
    expect(inductanceH(longer) / ideal(longer)).toBeCloseTo(shortfall(longer), 4);
    expect(inductanceH(longer) / ideal(longer)).toBeGreaterThan(0.999);
  });

  it('agrees with Wheeler 1928 to 1% wherever that formula is specified', () => {
    // Shapes from 0.4 diameters long (the older formula's floor) to ten diameters.
    for (const [turns, spacing] of [
      [8, 1],
      [20, 1],
      [30, 2],
      [100, 2],
    ] as const) {
      const spec = bare(turns, 20, 1, spacing);
      const shape = windingLengthMm(spec) / meanDiameterMm(spec);
      expect(shape).toBeGreaterThanOrEqual(0.38);
      expect(inductanceH(spec) / wheeler1928H(spec)).toBeCloseTo(1, 1.7); // |diff| < 1%
    }
  });

  it('inverts: the turns found for an inductance give that inductance', () => {
    const base = { formerMm: 25, wireMm: 1, wallMm: 0.05, spacing: 1.5 };
    for (const target of [0.5e-6, 4e-6, 33e-6]) {
      const turns = turnsFor(target, base);
      expect(turns).toBeGreaterThan(0);
      expect(inductanceH({ ...base, turns })).toBeCloseTo(target, 12);
    }
  });

  it('counts the wire as a helix', () => {
    const spec = bare(10, 30, 1, 3);
    const perTurn = Math.hypot(Math.PI * meanDiameterMm(spec), 3);
    expect(wireLengthM(spec)).toBeCloseTo((10 * perTurn) / 1000, 9);
  });

  it('has the skin depth of copper: about 65 um at 1 MHz, falling as 1/sqrt f', () => {
    expect(skinDepthM(1) * 1e6).toBeCloseTo(65.2, 0);
    expect(skinDepthM(4) / skinDepthM(1)).toBeCloseTo(0.5, 6);
  });

  it('bounds Q by the skin effect, and prices close winding at Medhurst’s factor', () => {
    const spec = bare(12, 25, 1.2);
    const f = 7.1;
    const { upper, closeWound } = qualityEstimate(spec, f);
    expect(upper).toBeCloseTo((2 * Math.PI * f * 1e6 * inductanceH(spec)) / wireResistanceOhms(spec, f), 6);
    expect(upper / closeWound).toBeCloseTo(CLOSE_WOUND_PROXIMITY, 9);
    // Thicker wire, higher Q; higher frequency, higher Q (reactance grows faster than skin loss).
    expect(qualityEstimate(bare(12, 25, 2), f).upper).toBeGreaterThan(upper);
    expect(qualityEstimate(spec, 2 * f).upper).toBeGreaterThan(upper);
  });

  it('cannot self-resonate above the half-wave frequency of its wire', () => {
    const spec = bare(50, 30, 1);
    expect(selfResonanceBoundMHz(spec)).toBeCloseTo(299.792458 / (2 * wireLengthM(spec)), 6);
  });
});

describe('traps', () => {
  const trap = { henries: 8e-6, farads: capacitorFor(7.1, 8e-6), q: 200 };

  it('resonates where it was told to, both ways round', () => {
    expect(resonanceMHz(trap)).toBeCloseTo(7.1, 9);
    expect(inductorFor(7.1, trap.farads)).toBeCloseTo(8e-6, 15);
  });

  it('is Q times the coil reactance at resonance, less a Q-th of that in quadrature', () => {
    const z = trapImpedance(trap, 7.1);
    // Exactly L / (R C) at 1 / 2 pi sqrt(LC), which is Q w0 L...
    expect(z.re).toBeCloseTo(resonantImpedanceOhms(trap), 3);
    // ...and not quite real there: -j w0 L remains, 1/Q of the resistive part.
    expect(z.im).toBeCloseTo(-2 * Math.PI * 7.1e6 * trap.henries, 3);
    expect(bandwidthMHz(trap)).toBeCloseTo(7.1 / 200, 9);
  });

  it('is an inductor below resonance and a capacitor above', () => {
    const low = trapAt(trap, 3.6);
    expect(low.role).toBe('inductor');
    // Below resonance the trap looks like a bigger coil than the one in it: L / (1 - (f/f0)^2).
    expect(low.equivalentH).toBeCloseTo(8e-6 / (1 - (3.6 / 7.1) ** 2), 9);
    const high = trapAt(trap, 14.2);
    expect(high.role).toBe('capacitor');
    // Above resonance the coil cancels part of the capacitor: C (1 - (f0/f)^2) is what is left.
    expect(high.equivalentF).toBeCloseTo(trap.farads * (1 - (7.1 / 14.2) ** 2), 13);
    expect(trapAt(trap, 7.1 + 0.01).role).toBe('trap');
  });
});

describe('ladder filters', () => {
  const q = { inductor: 0, capacitor: 0 }; // lossless

  it('gives the Butterworth prototype, 1 2 1 for third order', () => {
    const { g, load } = prototype('butterworth', 3, 0);
    expect(g.map((v) => Number(v.toFixed(6)))).toEqual([1, 2, 1]);
    expect(load).toBe(1);
  });

  it('scales a 10 MHz, 50 ohm, third-order low-pass to 318 pF and 1.59 uH', () => {
    const ladder = synthesise({ kind: 'lowpass', family: 'butterworth', order: 3, cutoffMHz: 10, z0: 50, rippleDb: 0, first: 'shunt' });
    const wc = 2 * Math.PI * 10e6;
    expect(ladder.elements.map((e) => `${e.position} ${e.kind}`)).toEqual(['shunt capacitor', 'series inductor', 'shunt capacitor']);
    expect(ladder.elements[0]!.value).toBeCloseTo(1 / (50 * wc), 15); // 318.3 pF
    expect(ladder.elements[1]!.value).toBeCloseTo((2 * 50) / wc, 12); // 1.5915 uH
    expect(ladder.loadOhms).toBe(50);
  });

  it('is 3.01 dB down at the cutoff and 10 log(1 + 2^2n) dB at twice it', () => {
    const spec = { kind: 'lowpass' as const, family: 'butterworth' as const, order: 5, cutoffMHz: 30, z0: 50, rippleDb: 0, first: 'shunt' as const };
    const ladder = synthesise(spec);
    expect(respond(ladder, spec, 30, q).lossDb).toBeCloseTo(10 * Math.log10(2), 6);
    expect(respond(ladder, spec, 60, q).lossDb).toBeCloseTo(10 * Math.log10(1 + 2 ** 10), 6);
    expect(respond(ladder, spec, 3, q).lossDb).toBeLessThan(1e-6);
  });

  it('turns a high-pass into the mirror of the low-pass', () => {
    const lp = { kind: 'lowpass' as const, family: 'butterworth' as const, order: 4, cutoffMHz: 7, z0: 50, rippleDb: 0, first: 'series' as const };
    const hp = { ...lp, kind: 'highpass' as const };
    const low = synthesise(lp);
    const high = synthesise(hp);
    expect(high.elements.map((e) => e.kind)).toEqual(['capacitor', 'inductor', 'capacitor', 'inductor']);
    for (const ratio of [0.25, 0.5, 0.9, 1, 1.5, 3]) {
      expect(respond(high, hp, 7 / ratio, q).lossDb).toBeCloseTo(respond(low, lp, 7 * ratio, q).lossDb, 6);
    }
  });

  it('keeps a Chebyshev ripple within the ripple asked for, and exactly on it at the edge', () => {
    const spec = { kind: 'lowpass' as const, family: 'chebyshev' as const, order: 5, cutoffMHz: 14, z0: 50, rippleDb: 0.5, first: 'shunt' as const };
    const ladder = synthesise(spec);
    const inBand = logFrequencies(0.5, 14, 400).map((f) => respond(ladder, spec, f, q).lossDb);
    expect(Math.max(...inBand)).toBeLessThanOrEqual(0.5 + 1e-6);
    expect(Math.max(...inBand)).toBeGreaterThan(0.49);
    expect(respond(ladder, spec, 14, q).lossDb).toBeCloseTo(0.5, 5);
    // Steeper than Butterworth of the same order, which is the point of it.
    const flat = { ...spec, family: 'butterworth' as const };
    expect(respond(ladder, spec, 28, q).lossDb).toBeGreaterThan(respond(synthesise(flat), flat, 28, q).lossDb);
  });

  it('says an even-order Chebyshev wants an unequal load: given it the ripple is exact, with equal ends it is not', () => {
    const spec = { kind: 'lowpass' as const, family: 'chebyshev' as const, order: 4, cutoffMHz: 10, z0: 50, rippleDb: 1, first: 'shunt' as const };
    const ladder = synthesise(spec);
    expect(ladder.loadOhms).not.toBeCloseTo(50, 0);
    const designed = { z0: 50, loadOhms: ladder.loadOhms };
    const inBand = logFrequencies(0.05, 10, 400).map((f) => respond(ladder, designed, f, q).lossDb);
    expect(Math.max(...inBand)).toBeLessThanOrEqual(1 + 1e-6);
    expect(respond(ladder, designed, 10, q).lossDb).toBeCloseTo(1, 5);
    // An even order starts its ripple on a peak, so towards DC the loss is the full ripple -
    // the mismatch between 50 ohms and the load it was designed for...
    expect(respond(ladder, designed, 0.05, q).lossDb).toBeCloseTo(1, 3);
    // ...which equal 50 ohm ends cannot show: a ladder of reactances is transparent there.
    expect(respond(ladder, { z0: 50 }, 0.05, q).lossDb).toBeLessThan(1e-3);
  });

  it('conserves power when lossless, and loses some when the coils have finite Q', () => {
    const spec = { kind: 'lowpass' as const, family: 'butterworth' as const, order: 7, cutoffMHz: 21, z0: 50, rippleDb: 0, first: 'shunt' as const };
    const ladder = synthesise(spec);
    for (const f of [5, 15, 21, 25, 40]) {
      const p = respond(ladder, spec, f, q);
      const through = 10 ** (-p.lossDb / 10);
      const back = 10 ** (-p.returnLossDb / 10);
      expect(through + back).toBeCloseTo(1, 6);
    }
    const lossy = respond(ladder, spec, 15, { inductor: 50, capacitor: 1000 });
    expect(lossy.lossDb).toBeGreaterThan(0.1);
    expect(cAbs(lossy.zIn)).toBeGreaterThan(0);
  });

  it('rounds capacitors to E24 by ratio', () => {
    expect(nearestStandard(318e-12)).toBeCloseTo(330e-12, 15);
    expect(nearestStandard(1.04e-9, E24)).toBeCloseTo(1e-9, 15);
    expect(nearestStandard(1.05e-9, E24)).toBeCloseTo(1.1e-9, 15); // nearer by ratio, though not by difference
    expect(nearestStandard(9.6e-9, E24)).toBeCloseTo(1e-8, 15);
    const ladder = synthesise({ kind: 'lowpass', family: 'butterworth', order: 3, cutoffMHz: 10, z0: 50, rippleDb: 0, first: 'shunt' });
    const rounded = withStandardCapacitors(ladder);
    expect(rounded.elements[0]!.value).toBeCloseTo(330e-12, 15);
    expect(rounded.elements[1]!.value).toBe(ladder.elements[1]!.value);
  });
});
