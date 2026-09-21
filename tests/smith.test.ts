// The matching-network maths behind the Smith chart tool, against results you can work
// out by hand from transmission-line theory.

import { describe, expect, it } from 'vitest';
import { type Complex, cAbs, complex } from '../src/lib/complex';
import { gammaFromImpedance, parseTouchstone, standingWaveRatio, TouchstoneError } from '../src/lib/touchstone';
import { lMatchSolutions } from '../src/tools/smith-chart/match';
import {
  type Element,
  type Network,
  defaultNetwork,
  newElementId,
} from '../src/tools/smith-chart/model';
import {
  chainImpedances,
  elementImpedance,
  elementPath,
  inputImpedance,
  loadImpedance,
  swrBandwidth,
  sweepNetwork,
  transform,
} from '../src/tools/smith-chart/network';

const F = 14.2;
const OMEGA = 2 * Math.PI * F * 1e6;
/** Wavelength in metres at F in free space. */
const LAMBDA = 299792458 / (F * 1e6);

type InductorPart = Extract<Element, { kind: 'inductor' }>;
type CapacitorPart = Extract<Element, { kind: 'capacitor' }>;

const inductorOf = (reactance: number, connection: 'series' | 'shunt' = 'series'): InductorPart => ({
  id: newElementId(),
  kind: 'inductor',
  connection,
  henries: reactance / OMEGA,
});
const capacitorOf = (reactance: number, connection: 'series' | 'shunt' = 'series'): CapacitorPart => ({
  id: newElementId(),
  kind: 'capacitor',
  connection,
  farads: -1 / (OMEGA * reactance),
});
const lossless = { velocityFactor: 1, lossDb100m: 0, lossRefMHz: F };

function expectClose(actual: Complex, expected: Complex, digits = 9) {
  expect(actual.re).toBeCloseTo(expected.re, digits);
  expect(actual.im).toBeCloseTo(expected.im, digits);
}

describe('components', () => {
  it('cancels a capacitive load with a series inductor', () => {
    const load = complex(50, -50);
    expectClose(transform(load, inductorOf(50), F), complex(50, 0));
  });

  it('gives a component with a Q a series resistance', () => {
    const z = elementImpedance({ ...inductorOf(50), q: 100 }, F);
    expectClose(z, complex(0.5, 50), 9);
  });

  it('makes the same transformation from a shunt capacitor as from a shunt stub', () => {
    const load = complex(50, 0);
    const byCapacitor = transform(load, capacitorOf(-50, 'shunt'), F);
    const byStub = transform(
      load,
      { id: 'stub', kind: 'stub', connection: 'shunt', termination: 'open', z0: 50, lengthM: LAMBDA / 8, ...lossless },
      F,
    );
    expectClose(byCapacitor, complex(25, -25), 6);
    expectClose(byStub, byCapacitor, 6);
  });

  it('makes a shorted eighth-wave stub inductive', () => {
    const stub: Element = {
      id: 'stub',
      kind: 'stub',
      connection: 'series',
      termination: 'short',
      z0: 50,
      lengthM: LAMBDA / 8,
      ...lossless,
    };
    expectClose(elementImpedance(stub, F), complex(0, 50), 6);
  });

  it('transforms through a quarter-wave line as Z0² / ZL, and repeats the load every half wave', () => {
    const line: Element = { id: 'line', kind: 'line', z0: 75, lengthM: LAMBDA / 4, ...lossless };
    expectClose(transform(complex(50, 0), line, F), complex(75 * 75 / 50, 0), 6);
    expectClose(transform(complex(100, 30), { ...line, lengthM: LAMBDA / 2 }, F), complex(100, 30), 6);
  });

  it('leaves a matched line matched, and halves the return loss of a mismatch', () => {
    const line: Element = {
      id: 'line',
      kind: 'line',
      z0: 50,
      lengthM: 100,
      velocityFactor: 0.66,
      lossDb100m: 3,
      lossRefMHz: F,
    };
    expectClose(transform(complex(50, 0), line, F), complex(50, 0), 6);
    // A short seen through 3 dB of line comes back 6 dB down: the classic "coax hides a bad antenna".
    const shorted = transform(complex(0, 0), line, F);
    expect(cAbs(gammaFromImpedance(shorted, 50))).toBeCloseTo(10 ** (-6 / 20), 3);
  });

  it('scales line loss with the square root of frequency', () => {
    const line: Element = { id: 'l', kind: 'line', z0: 50, lengthM: 100, velocityFactor: 1, lossDb100m: 1, lossRefMHz: 14 };
    const at56 = transform(complex(0, 0), line, 56);
    // Four times the frequency is twice the loss: 2 dB each way, so 4 dB of return loss.
    expect(-20 * Math.log10(cAbs(gammaFromImpedance(at56, 50)))).toBeCloseTo(4, 2);
  });

  it('steps impedance down through a 4:1 transformer', () => {
    expectClose(transform(complex(200, 0), { id: 't', kind: 'transformer', ratio: 4 }, F), complex(50, 0), 9);
  });

  it('leaves a bypassed component out of circuit', () => {
    expectClose(transform(complex(50, -50), { ...inductorOf(50), bypassed: true }, F), complex(50, -50));
  });
});

describe('the load', () => {
  it('lets the reactance follow frequency, as the inductor or capacitor it stands for', () => {
    const inductive = { kind: 'impedance', ohmsR: 50, ohmsX: 50, atMHz: 14, follows: 'reactive' } as const;
    expectClose(loadImpedance(inductive, 28), complex(50, 100));
    const capacitive = { ...inductive, ohmsX: -50 };
    expectClose(loadImpedance(capacitive, 28), complex(50, -25));
    expectClose(loadImpedance({ ...inductive, follows: 'fixed' }, 28), complex(50, 50));
  });

  it('interpolates a measured sweep, and holds the ends', () => {
    const load = {
      kind: 'measured' as const,
      name: 'test',
      points: [
        { fMHz: 14, z: complex(40, -20) },
        { fMHz: 14.2, z: complex(50, 0) },
      ],
    };
    expectClose(loadImpedance(load, 14.1), complex(45, -10), 9);
    expectClose(loadImpedance(load, 13), complex(40, -20));
    expectClose(loadImpedance(load, 30), complex(50, 0));
  });
});

describe('the chain', () => {
  it('reports every node from the load to the radio', () => {
    const network: Network = {
      ...defaultNetwork(),
      load: { kind: 'impedance', ohmsR: 50, ohmsX: -50, atMHz: F, follows: 'fixed' },
      elements: [inductorOf(50)],
      designMHz: F,
    };
    const nodes = chainImpedances(network, F);
    expect(nodes).toHaveLength(2);
    expectClose(nodes[0]!, complex(50, -50));
    expectClose(nodes[1]!, complex(50, 0));
    expectClose(inputImpedance(network, F), complex(50, 0));
  });

  it('draws a path that starts where the component sees the load and ends where it leaves it', () => {
    const element = capacitorOf(-30, 'shunt');
    const load = complex(80, 20);
    const path = elementPath(load, element, F, 12);
    expect(path).toHaveLength(13);
    expectClose(path[0]!, load);
    expectClose(path.at(-1)!, transform(load, element, F), 9);
  });
});

describe('SWR across a sweep', () => {
  const network: Network = {
    ...defaultNetwork(),
    load: { kind: 'impedance', ohmsR: 100, ohmsX: 0, atMHz: F, follows: 'fixed' },
    elements: [],
    z0: 50,
    sweep: { startMHz: 14, stopMHz: 14.35, points: 8 },
  };

  it('is 2:1 for a 100 Ω load on 50 Ω', () => {
    const points = sweepNetwork(network);
    expect(points).toHaveLength(8);
    expect(points.every((p) => Math.abs(p.swr - 2) < 1e-9)).toBe(true);
    expect(standingWaveRatio(gammaFromImpedance(complex(50, 0), 50))).toBe(1);
  });

  it('measures the band where SWR stays under a limit', () => {
    // A series-resonant load: R = 25 Ω at resonance, with 1 µH and its resonating capacitor.
    const l = 1e-6;
    const c = 1 / ((2 * Math.PI * F * 1e6) ** 2 * l);
    const resonant: Network = {
      ...network,
      load: { kind: 'impedance', ohmsR: 25, ohmsX: 0, atMHz: F, follows: 'fixed' },
      elements: [
        { id: 'l', kind: 'inductor', connection: 'series', henries: l },
        { id: 'c', kind: 'capacitor', connection: 'series', farads: c },
      ],
      sweep: { startMHz: 13, stopMHz: 15.4, points: 241 },
    };
    const points = sweepNetwork(resonant);
    const band = swrBandwidth(points, 2, F)!;
    expect(band.lowMHz).toBeGreaterThan(13);
    expect(band.highMHz).toBeLessThan(15.4);
    expect(band.lowMHz).toBeLessThan(F);
    expect(band.highMHz).toBeGreaterThan(F);
    // Far from resonance the reactance swamps it, so there is no wide low-SWR region.
    expect(band.widthMHz).toBeLessThan(1);
    expect(swrBandwidth(points, 1.01, 13.2)).toBeUndefined();
  });
});

describe('automatic L matching', () => {
  const loads: Complex[] = [complex(100, 50), complex(25, -30), complex(12.5, 0), complex(300, 0), complex(50, 80)];

  it('matches every load exactly, whichever arrangement you choose', () => {
    for (const load of loads) {
      const solutions = lMatchSolutions(load, 50, F);
      expect(solutions.length, `${load.re}+j${load.im}`).toBeGreaterThanOrEqual(1);
      for (const solution of solutions) {
        const network: Network = {
          ...defaultNetwork(),
          load: { kind: 'impedance', ohmsR: load.re, ohmsX: load.im, atMHz: F, follows: 'fixed' },
          elements: solution.elements,
          z0: 50,
        };
        expectClose(inputImpedance(network, F), complex(50, 0), 6);
      }
    }
  });

  it('offers a single component when the load is already on the right circle', () => {
    // 50 + j80 already has the system resistance: cancel its reactance and you are done.
    const one = lMatchSolutions(complex(50, 80), 50, F);
    expect(one[0]?.elements).toHaveLength(1);
    expect(one[0]?.name).toBe('Series C');

    // A load on the unit conductance circle takes one shunt component instead. 25 + j25
    // is inductive (Y = 0.02 − j0.02), so a capacitor across it brings it to 50 Ω.
    const onCircle = complex(25, 25); // G = 1/50
    const shunt = lMatchSolutions(onCircle, 50, F).find((s) => s.elements.length === 1);
    expect(shunt?.name).toBe('Shunt C');
  });

  it('names the arrangements, and knows a low-pass from a high-pass', () => {
    const solutions = lMatchSolutions(complex(100, 0), 50, F);
    expect(solutions).toHaveLength(2);
    expect(solutions.map((s) => s.name).sort()).toEqual(['Shunt C, then series L', 'Shunt L, then series C']);
    expect(solutions.find((s) => s.name.startsWith('Shunt C'))?.character).toBe('low-pass');
    expect(solutions.find((s) => s.name.startsWith('Shunt L'))?.character).toBe('high-pass');
  });

  it('offers nothing when the load already is the system impedance, or cannot be matched', () => {
    expect(lMatchSolutions(complex(50, 0), 50, F)).toEqual([]);
    expect(lMatchSolutions(complex(0, -30), 50, F)).toEqual([]);
    expect(lMatchSolutions(complex(50, 0), 50, 0)).toEqual([]);
  });
});

describe('Touchstone .s1p files', () => {
  const file = [
    '! A NanoVNA sweep',
    '# MHZ S RI R 50',
    '14.0 0.3333333333 0.0',
    '14.2 0.0 0.0',
    '14.4 -0.3333333333 0.0',
  ].join('\n');

  it('reads reflection data as impedance', () => {
    const { points, referenceZ0, comments } = parseTouchstone(file);
    expect(referenceZ0).toBe(50);
    expect(comments).toEqual(['A NanoVNA sweep']);
    expect(points.map((p) => p.fMHz)).toEqual([14, 14.2, 14.4]);
    expect(points[0]!.z.re).toBeCloseTo(100, 6); // Γ = 1/3 is a 2:1 mismatch, high side
    expect(points[1]!.z.re).toBeCloseTo(50, 9);
    expect(points[2]!.z.re).toBeCloseTo(25, 6);
    expect(standingWaveRatio(points[0]!.gamma)).toBeCloseTo(2, 6);
  });

  it('reads magnitude/angle and decibel formats too', () => {
    const ma = parseTouchstone('# MHZ S MA R 50\n14.2 0.3333333333 180');
    expect(ma.points[0]!.z.re).toBeCloseTo(25, 6);
    const db = parseTouchstone(`# MHZ S DB R 50\n14.2 ${20 * Math.log10(1 / 3)} 0`);
    expect(db.points[0]!.z.re).toBeCloseTo(100, 6);
  });

  it('follows the documented defaults when there is no option line', () => {
    const { points, referenceZ0 } = parseTouchstone('0.0142 0 0');
    expect(points[0]!.fMHz).toBeCloseTo(14.2, 9); // gigahertz by default
    expect(referenceZ0).toBe(50);
  });

  it('explains what it cannot read', () => {
    expect(() => parseTouchstone('# MHZ Y RI R 50\n14 0 0')).toThrow(TouchstoneError);
    expect(() => parseTouchstone('! nothing but a comment')).toThrow(/no measurements/);
    expect(() => parseTouchstone('# MHZ S RI R 50\n14.2 oops')).toThrow(/Cannot read this line/);
  });
});
