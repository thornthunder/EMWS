// A coil of coax as a trap, held to its limits: the textbook rule where the cable is short,
// the cable's own inductance where it is not, the lumped trap it reduces to, and passivity.
// None of this is a bench measurement - see the guide.

import { describe, expect, it } from 'vitest';
import { cAbs } from '../src/lib/complex';
import { type Cable, cableById } from '../src/tools/toolbox/coax';
import { C0 } from '../src/tools/lc/coil';
import { type CoaxTrapSpec, cableCapacitanceF, cableLengthM, coaxResonanceMHz, coaxTrapAt, coaxTrapImpedance, coilInductanceH, lumpedEquivalent, turnsForCoaxTrap } from '../src/tools/lc/coaxtrap';
import { trapImpedance } from '../src/tools/lc/trap';

const rg58 = cableById('rg58')!;
const lossless = (z0: number): Cable => ({ id: `ideal-${z0}`, name: 'ideal', z0, velocityFactor: 0.66, loss: { kind: 'datasheet', points: [{ fMHz: 1, dbPer100m: 0 }, { fMHz: 100, dbPer100m: 0 }] } });
/** Ten turns of RG-58 on a 50 mm pipe; q 0 is a lossless coil, as coilImpedance reads it. */
const spec = (over: Partial<CoaxTrapSpec> = {}): CoaxTrapSpec => ({ cable: rg58, jacketMm: 4.95, formerMm: 50, turns: 10, q: 0, ...over });
const rule = (s: CoaxTrapSpec) => 1 / (2 * Math.PI * Math.sqrt(coilInductanceH(s) * cableCapacitanceF(s))) / 1e6;

describe('a trap made of coax', () => {
  it('resonates at 1 / (2 pi sqrt(L C)), L the coil and C the whole cable, where the cable is electrically short', () => {
    // The cable's electrical length at resonance is sqrt(l Z0 / (v L)): a low-impedance line
    // makes it as short as one likes, and there the rule must be exact. (5 ohms left the
    // resonance 0.18 % low - theta^2 / 6 to the digit, the next test's claim.)
    const s = spec({ cable: lossless(0.5) });
    expect(coaxResonanceMHz(s) / rule(s)).toBeCloseTo(1, 3);
  });

  it('sits below the rule by theta^2 / 6 otherwise: the cable has inductance of its own', () => {
    const s = spec({ cable: lossless(50) });
    const f0 = coaxResonanceMHz(s);
    const theta = ((2 * Math.PI * f0 * 1e6) / (C0 * 0.66)) * cableLengthM(s);
    const shortfall = rule(s) / f0 - 1;
    expect(theta).toBeGreaterThan(0.1); // not negligible for this coil
    expect(shortfall).toBeGreaterThan(0.8 * (theta * theta) / 6);
    expect(shortfall).toBeLessThan(1.2 * (theta * theta) / 6);
  });

  it('is 4 L plus the cable\'s own inductance, across C / 4, well below resonance', () => {
    // The inner conductor's current threads the coax's own inductance (Z0 l / v: 0.44 uH of
    // RG-58 here) as well as the coil's, so "4L" is short by that much - 2.75 % of 16 uH.
    const s = spec({ cable: lossless(50) });
    const f = coaxResonanceMHz(s) / 10;
    const coilH = coilInductanceH(s);
    const cableH = (cableLengthM(s) * 50) / (C0 * 0.66);
    const exact = coaxTrapImpedance(s, f);
    const lumped = trapImpedance({ henries: 4 * coilH + cableH, farads: cableCapacitanceF(s) / 4, q: 0 }, f);
    expect(exact.im / lumped.im).toBeCloseTo(1, 2);
    const ruleOnly = trapImpedance({ henries: 4 * coilH, farads: cableCapacitanceF(s) / 4, q: 0 }, f);
    expect((exact.im / ruleOnly.im - 1) / (cableH / (4 * coilH))).toBeCloseTo(1, 1);
    expect(Math.abs(exact.re)).toBeLessThan(1e-6);
  });

  it('drops its resonance by more than half when the turns double, because the cable grows with the coil', () => {
    const ratio = coaxResonanceMHz(spec({ turns: 20 })) / coaxResonanceMHz(spec({ turns: 10 }));
    expect(ratio).toBeLessThan(0.5);
    expect(ratio).toBeGreaterThan(0.3);
  });

  it('finds the turns for a frequency, and the real cable leaves a finite impedance at resonance', () => {
    const base = { cable: rg58, jacketMm: 4.95, formerMm: 50, q: 200 };
    const turns = turnsForCoaxTrap(7.1, base);
    const s: CoaxTrapSpec = { ...base, turns };
    expect(coaxResonanceMHz(s) / 7.1).toBeCloseTo(1, 3);
    const eq = lumpedEquivalent(s)!;
    expect(eq.f0MHz / 7.1).toBeCloseTo(1, 3);
    expect(eq.q).toBeGreaterThan(20);
    expect(eq.q).toBeLessThan(1000);
    expect(eq.ohms).toBeGreaterThan(1000);
    // Lossless everything: nothing damps it.
    const ideal = spec({ cable: lossless(50), turns, formerMm: 50 });
    expect(cAbs(coaxTrapImpedance(ideal, coaxResonanceMHz(ideal)))).toBeGreaterThan(1e6);
  });

  it('is reproduced by its lumped equivalent across its own bandwidth', () => {
    const s = spec({ q: 200 });
    const eq = lumpedEquivalent(s)!;
    for (const f of [eq.f0MHz - eq.bandwidthMHz / 2, eq.f0MHz, eq.f0MHz + eq.bandwidthMHz / 2]) {
      const exact = cAbs(coaxTrapImpedance(s, f));
      const lumped = cAbs(trapImpedance({ henries: eq.henries, farads: eq.farads, q: eq.q }, f));
      expect(lumped / exact).toBeGreaterThan(0.97);
      expect(lumped / exact).toBeLessThan(1.03);
    }
    expect(coaxTrapAt(s, eq.f0MHz, eq).role).toBe('trap');
    expect(coaxTrapAt(s, eq.f0MHz / 2, eq).role).toBe('inductor');
    expect(coaxTrapAt(s, eq.f0MHz * 2, eq).role).toBe('capacitor');
  });

  it('is passive from 1 to 300 MHz', () => {
    const s = spec({ q: 200 });
    for (let i = 0; i <= 200; i++) {
      const f = 300 ** (i / 200);
      expect(coaxTrapImpedance(s, f).re).toBeGreaterThanOrEqual(-1e-9);
    }
  });
});
