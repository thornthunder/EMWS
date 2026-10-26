// The Smith chart's two designers beyond the L network: Pi and T with a chosen Q, and the
// adjuster that moves the values of a built chain towards a goal. Held to what can be
// worked out by hand: every match exact at the design frequency, Q meaning what it says
// (higher = narrower), the adjuster never making things worse and finding the floor the
// closed-form matcher knows.

import { describe, expect, it } from 'vitest';
import { type Complex, complex } from '../src/lib/complex';
import { lMatchSolutions, leastQ, piTeeSolutions } from '../src/tools/smith-chart/match';
import { type Element, type Network, defaultNetwork, newElementId } from '../src/tools/smith-chart/model';
import { inputImpedance, sweepNetwork, swrBandwidth } from '../src/tools/smith-chart/network';
import { REACTANCE_RANGE, adjustNetwork, adjustableElements, atPosition, outcomeOf, positionOf } from '../src/tools/smith-chart/optimise';

const F = 14.2;
const OMEGA = 2 * Math.PI * F * 1e6;

function networkWith(load: Complex, elements: Element[], z0 = 50): Network {
  return {
    ...defaultNetwork(),
    load: { kind: 'impedance', ohmsR: load.re, ohmsX: load.im, atMHz: F, follows: 'reactive' },
    elements,
    z0,
    sweep: { startMHz: 13.5, stopMHz: 14.9, points: 57 },
    designMHz: F,
  };
}

/** The 2:1 band around the design frequency, over a sweep wide enough to find both edges. */
const widthOf = (n: Network) => swrBandwidth(sweepNetwork({ ...n, sweep: { startMHz: 7, stopMHz: 28, points: 421 } }), 2, n.designMHz)?.widthMHz ?? 0;

describe('Pi and T networks', () => {
  const loads: Complex[] = [complex(200, 0), complex(12, 0), complex(100, -40), complex(22, -140), complex(9, -400), complex(300, 250)];

  it('match every load exactly at the design frequency, for any Q above the floor', () => {
    for (const load of loads) {
      const floor = leastQ(load, 50);
      for (const q of [Math.max(floor.pi, floor.tee) + 0.5, 3, 6, 12]) {
        const solutions = piTeeSolutions(load, 50, F, q);
        expect(solutions.length, `${load.re}${load.im >= 0 ? '+' : ''}${load.im}j at Q ${q}`).toBeGreaterThan(0);
        for (const s of solutions) {
          expect(s.elements).toHaveLength(3);
          const z = inputImpedance(networkWith(load, s.elements), F);
          expect(z.re).toBeCloseTo(50, 6);
          expect(z.im).toBeCloseTo(0, 6);
        }
      }
    }
  });

  it('offers nothing below the floor, and the floor is the L network’s own Q', () => {
    // 200 ohms to 50: the L network's Q is sqrt(200/50 - 1) = sqrt 3, for a Pi and a T alike (a resistive load).
    const floor = leastQ(complex(200, 0), 50);
    expect(floor.pi).toBeCloseTo(Math.sqrt(3), 9);
    expect(floor.tee).toBeCloseTo(Math.sqrt(3), 9);
    expect(piTeeSolutions(complex(200, 0), 50, F, 1.5)).toEqual([]);
    expect(piTeeSolutions(complex(200, 0), 50, F, 1.8).length).toBeGreaterThan(0);
    // A reactive load has two floors, because its series and parallel resistances differ.
    const reactive = leastQ(complex(100, -40), 50);
    expect(reactive.pi).toBeCloseTo(Math.sqrt((100 * 100 + 40 * 40) / 100 / 50 - 1), 9);
    expect(reactive.tee).toBeCloseTo(1, 9);
  });

  it('a higher Q is a narrower match, and never broader than the L network', () => {
    const load = complex(200, 0);
    const widths = [2, 4, 8].map((q) => {
      const pi = piTeeSolutions(load, 50, F, q).find((s) => s.character === 'low-pass')!;
      return widthOf(networkWith(load, pi.elements));
    });
    expect(widths[0]!).toBeGreaterThan(widths[1]!);
    expect(widths[1]!).toBeGreaterThan(widths[2]!);
    const ell = lMatchSolutions(load, 50, F).find((s) => s.character === 'low-pass')!;
    expect(widthOf(networkWith(load, ell.elements))).toBeGreaterThan(widths[0]!);
  });

  it('names the shapes and knows a low-pass Pi (C L C) from a high-pass one (L C L), and a T the other way about', () => {
    const solutions = piTeeSolutions(complex(200, 0), 50, F, 3);
    const lowPi = solutions.find((s) => s.name.startsWith('Pi') && s.character === 'low-pass')!;
    expect(lowPi.elements.map((e) => e.kind)).toEqual(['capacitor', 'inductor', 'capacitor']);
    expect(lowPi.elements.map((e) => ('connection' in e ? e.connection : ''))).toEqual(['shunt', 'series', 'shunt']);
    const lowTee = solutions.find((s) => s.name.startsWith('T') && s.character === 'low-pass')!;
    expect(lowTee.elements.map((e) => e.kind)).toEqual(['inductor', 'capacitor', 'inductor']);
    expect(solutions.some((s) => s.name.startsWith('Pi') && s.character === 'high-pass')).toBe(true);
    expect(solutions.some((s) => s.name.startsWith('T') && s.character === 'high-pass')).toBe(true);
    // Low-pass first, so the harmonic-friendly shapes are what you see first.
    expect(solutions[0]!.character).toBe('low-pass');
  });

  it('refuses what cannot be matched', () => {
    expect(piTeeSolutions(complex(0, 50), 50, F, 3)).toEqual([]);
    expect(piTeeSolutions(complex(50, 0), 50, F, 0)).toEqual([]);
  });
});

describe('adjusting the values of a built chain', () => {
  const inductor = (henries: number, connection: 'series' | 'shunt' = 'series'): Element => ({ id: newElementId(), kind: 'inductor', connection, henries });
  const capacitor = (farads: number, connection: 'series' | 'shunt' = 'shunt'): Element => ({ id: newElementId(), kind: 'capacitor', connection, farads });

  it('moves a part through the same range its slider does, and back', () => {
    const l = inductor(100e-9);
    // Values are tidied to six figures on the way back, so the round trip is good to about 1e-6.
    expect(positionOf(atPosition(l, 0, F), F)).toBeCloseTo(0, 5);
    expect(positionOf(atPosition(l, 1, F), F)).toBeCloseTo(1, 5);
    const atTop = atPosition(l, 1, F) as Extract<Element, { kind: 'inductor' }>;
    expect(OMEGA * atTop.henries).toBeCloseTo(REACTANCE_RANGE.max, 0);
    const c = capacitor(100e-12);
    const atBottom = atPosition(c, 0, F) as Extract<Element, { kind: 'capacitor' }>;
    expect(1 / (OMEGA * atBottom.farads)).toBeCloseTo(REACTANCE_RANGE.min, 3);
    expect(positionOf(atPosition(c, 0.37, F), F)).toBeCloseTo(0.37, 4);
  });

  it('lists only the parts that have a value to move', () => {
    const n = networkWith(complex(100, -40), [
      inductor(1e-6),
      { id: 'r', kind: 'resistor', connection: 'series', ohms: 10 },
      { id: 't', kind: 'transformer', ratio: 4 },
      { ...capacitor(1e-10), bypassed: true },
    ]);
    expect(adjustableElements(n).map((e) => e.kind)).toEqual(['inductor']);
  });

  it('finds the exact match the closed form knows, starting from wrong values', async () => {
    // 100 - j40 wants (one answer) a series L then a shunt C; start both parts far off.
    const exact = lMatchSolutions(complex(100, -40), 50, F).find((s) => s.name === 'Shunt C, then series L')!;
    const wrong = networkWith(complex(100, -40), [capacitor(5e-12, 'shunt'), inductor(5e-6, 'series')]);
    expect(outcomeOf(wrong).designSwr).toBeGreaterThan(3);
    const result = await adjustNetwork(wrong, 'design');
    expect(result.improved).toBe(true);
    expect(result.after.designSwr).toBeLessThan(1.01);
    expect(result.evaluations).toBeGreaterThan(10);
    expect(result.truncated).toBe(false);
    // The values it lands on are the closed form's, to the tidy-up.
    const [c, l] = result.network.elements as [Extract<Element, { kind: 'capacitor' }>, Extract<Element, { kind: 'inductor' }>];
    const [ec, el] = exact.elements as [Extract<Element, { kind: 'capacitor' }>, Extract<Element, { kind: 'inductor' }>];
    expect(c.farads / ec.farads).toBeCloseTo(1, 2);
    expect(l.henries / el.henries).toBeCloseTo(1, 2);
    // Ids and order are untouched: it adjusts, it does not rebuild.
    expect(result.network.elements.map((e) => e.id)).toEqual(wrong.elements.map((e) => e.id));
  });

  it('flattens a band: the worst SWR across the sweep comes down and never goes up', async () => {
    // An exact match at the design frequency is not the flattest match across the band.
    const exact = lMatchSolutions(complex(22, -140), 50, F).find((s) => s.character === 'low-pass')!;
    const n = networkWith(complex(22, -140), exact.elements);
    const before = outcomeOf(n);
    expect(before.designSwr).toBeCloseTo(1, 6);
    const result = await adjustNetwork(n, 'sweep');
    expect(result.after.worstSwr).toBeLessThanOrEqual(before.worstSwr + 1e-9);
    expect(result.improved).toBe(true);
    expect(result.after.worstSwr).toBeLessThan(before.worstSwr);
    // Flatter across the band costs a little at the centre: that is the trade, and it is visible.
    expect(result.after.designSwr).toBeGreaterThan(1);
    expect(result.after.designSwr).toBeLessThan(result.after.worstSwr + 1e-9);
  });

  it('leaves a chain alone when nothing beats it, and says so', async () => {
    const exact = lMatchSolutions(complex(100, -40), 50, F)[0]!;
    const n = networkWith(complex(100, -40), exact.elements);
    const result = await adjustNetwork(n, 'design');
    expect(result.improved).toBe(false);
    expect(result.network).toBe(n);
    expect(result.after).toEqual(result.before);
  });

  it('adjusts only the parts asked for, and reports one that runs to the end of its range', async () => {
    const fixed = inductor(1e-8, 'series');
    const free = capacitor(1e-9, 'shunt');
    const n = networkWith(complex(5, 0), [free, fixed]);
    const result = await adjustNetwork(n, 'design', [free.id]);
    const after = result.network.elements as [Extract<Element, { kind: 'capacitor' }>, Extract<Element, { kind: 'inductor' }>];
    expect(after[1].henries).toBe(1e-8);
    expect(after[0].farads).not.toBe(1e-9);
    // A shunt capacitor across 5 ohms can only make it worse, so the best it can do is as
    // little capacitance as its range allows - and the result says it ran to the end.
    expect(result.improved).toBe(true);
    expect(result.atEdge).toEqual([free.id]);
    expect(positionOf(after[0], F)).toBeGreaterThan(0.98);
  });
});
