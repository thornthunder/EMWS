// Ladder filters: low-pass and high-pass, Butterworth and Chebyshev.
//
// The classic method. A normalised low-pass prototype - a ladder of unit-frequency,
// one-ohm elements g1..gn - is scaled to the cutoff frequency and the system impedance
// (low-pass), or transformed first (high-pass: every inductor becomes a capacitor of
// reciprocal value and vice versa). The prototype values come from closed forms, not
// tables: Butterworth's g_k = 2 sin((2k-1) pi / 2n), and for Chebyshev the recurrence in
// terms of the ripple. Both are exact.
//
// The response is then worked out honestly, with the parts as they will be built: the
// ladder is chained as ABCD matrices between the real source and load impedances, and
// each inductor and capacitor carries the Q it will really have. So a Chebyshev filter
// of even order, which wants unequal terminations, shows its mismatch rather than a
// textbook curve, and a filter built with Q 50 coils shows its insertion loss.
//
// Public domain (The Unlicense). By ZR1JT.

import { type Complex, cAbs, cAdd, cDiv, cMul, cScale, cSub, complex } from '../../lib/complex';

export type FilterFamily = 'butterworth' | 'chebyshev';
export type FilterKind = 'lowpass' | 'highpass';
export type Position = 'series' | 'shunt';

export interface FilterSpec {
  kind: FilterKind;
  family: FilterFamily;
  /** Number of reactive elements, 2 to 9. */
  order: number;
  /** Butterworth: the 3 dB point. Chebyshev: the edge of the ripple band. */
  cutoffMHz: number;
  /** Source and load impedance, ohms. */
  z0: number;
  /** Chebyshev passband ripple, dB. Ignored for Butterworth. */
  rippleDb: number;
  /** Which element is nearest the source. Shunt-first uses the fewest inductors in a low-pass. */
  first: Position;
}

export interface LadderElement {
  position: Position;
  kind: 'inductor' | 'capacitor';
  /** Henries or farads. */
  value: number;
  /** The prototype value it came from. */
  g: number;
}

export interface Ladder {
  elements: LadderElement[];
  /** The load the prototype was designed for, ohms; z0 for most, not for an even-order Chebyshev. */
  loadOhms: number;
}

export const MIN_ORDER = 2;
export const MAX_ORDER = 9;

/** The normalised prototype: g1..gn and the load g(n+1). */
export function prototype(family: FilterFamily, order: number, rippleDb: number): { g: number[]; load: number } {
  const n = Math.max(MIN_ORDER, Math.min(MAX_ORDER, Math.round(order)));
  const g: number[] = [];
  if (family === 'butterworth') {
    for (let k = 1; k <= n; k++) g.push(2 * Math.sin(((2 * k - 1) * Math.PI) / (2 * n)));
    return { g, load: 1 };
  }
  const ripple = Math.max(0.001, rippleDb);
  // 40 / ln 10: the ripple in decibels, undone.
  const beta = Math.log(1 / Math.tanh(ripple / (40 / Math.LN10)));
  const gamma = Math.sinh(beta / (2 * n));
  const a = (k: number) => Math.sin(((2 * k - 1) * Math.PI) / (2 * n));
  const b = (k: number) => gamma * gamma + Math.sin((k * Math.PI) / n) ** 2;
  g.push((2 * a(1)) / gamma);
  for (let k = 2; k <= n; k++) g.push((4 * a(k - 1) * a(k)) / (b(k - 1) * g[k - 2]!));
  const load = n % 2 === 1 ? 1 : 1 / Math.tanh(beta / 4) ** 2;
  return { g, load };
}

/** Real parts for a real filter. */
export function synthesise(spec: FilterSpec): Ladder {
  const { g, load } = prototype(spec.family, spec.order, spec.rippleDb);
  const wc = 2 * Math.PI * spec.cutoffMHz * 1e6;
  const z0 = spec.z0;
  const elements: LadderElement[] = g.map((gk, i) => {
    const position: Position = (i % 2 === 0) === (spec.first === 'shunt') ? 'shunt' : 'series';
    if (spec.kind === 'lowpass') {
      return position === 'shunt'
        ? { position, kind: 'capacitor', value: gk / (z0 * wc), g: gk }
        : { position, kind: 'inductor', value: (gk * z0) / wc, g: gk };
    }
    return position === 'shunt'
      ? { position, kind: 'inductor', value: z0 / (gk * wc), g: gk }
      : { position, kind: 'capacitor', value: 1 / (gk * z0 * wc), g: gk };
  });
  // The prototype's g(n+1) is a resistance when the last element is shunt, a conductance
  // when it is series.
  const last = elements[elements.length - 1]!;
  const loadOhms = last.position === 'shunt' ? load * z0 : z0 / load;
  return { elements, loadOhms };
}

export interface PartQuality {
  inductor: number;
  capacitor: number;
}

/** A part's own impedance, loss included. */
export function partImpedance(part: LadderElement, fMHz: number, q: PartQuality): Complex {
  const w = 2 * Math.PI * fMHz * 1e6;
  if (part.kind === 'inductor') {
    const x = w * part.value;
    return complex(q.inductor > 0 ? x / q.inductor : 0, x);
  }
  const x = part.value > 0 ? -1 / (w * part.value) : -Infinity;
  return complex(q.capacitor > 0 ? Math.abs(x) / q.capacitor : 0, x);
}

export interface ResponsePoint {
  fMHz: number;
  /** Insertion loss, dB, positive. */
  lossDb: number;
  /** Return loss at the input, dB, positive. */
  returnLossDb: number;
  swr: number;
  /** What the source sees, with the load in place. */
  zIn: Complex;
}

export interface Terminations {
  /** The source, ohms. */
  z0: number;
  /** The load, ohms; the source impedance unless said otherwise. */
  loadOhms?: number;
}

/**
 * The filter between a source and a load, at one frequency. ABCD matrices: a series part
 * is [1 Z; 0 1], a shunt part [1 0; Y 1]; then with source Zs and load Zl,
 * S21 = 2 sqrt(Zs Zl) / (A Zl + B + C Zs Zl + D Zs) and
 * S11 = (A Zl + B - C Zs Zl - D Zs) / (A Zl + B + C Zs Zl + D Zs).
 */
export function respond(ladder: Ladder, ends: Terminations, fMHz: number, q: PartQuality): ResponsePoint {
  let a = complex(1);
  let b = complex(0);
  let c = complex(0);
  let d = complex(1);
  for (const part of ladder.elements) {
    const z = partImpedance(part, fMHz, q);
    if (part.position === 'series') {
      // [a b; c d] * [1 z; 0 1]
      b = cAdd(cMul(a, z), b);
      d = cAdd(cMul(c, z), d);
    } else {
      // [a b; c d] * [1 0; y 1]
      const y = cDiv(complex(1), z);
      a = cAdd(a, cMul(b, y));
      c = cAdd(c, cMul(d, y));
    }
  }
  const zs = ends.z0;
  const zl = ends.loadOhms ?? ends.z0;
  const aZl = cScale(a, zl);
  const cZsZl = cScale(c, zs * zl);
  const dZs = cScale(d, zs);
  const sum = cAdd(cAdd(aZl, b), cAdd(cZsZl, dZs));
  const diff = cSub(cAdd(aZl, b), cAdd(cZsZl, dZs));
  const s21 = cDiv(complex(2 * Math.sqrt(zs * zl)), sum);
  const s11 = cDiv(diff, sum);
  const gamma = Math.min(1, cAbs(s11));
  const zIn = cDiv(cAdd(aZl, b), cAdd(cScale(c, zl), d));
  return {
    fMHz,
    lossDb: -20 * Math.log10(Math.max(1e-12, cAbs(s21))),
    returnLossDb: -20 * Math.log10(Math.max(1e-12, gamma)),
    swr: gamma >= 1 ? Infinity : (1 + gamma) / (1 - gamma),
    zIn,
  };
}

export function sweepResponse(ladder: Ladder, ends: Terminations, freqs: readonly number[], q: PartQuality): ResponsePoint[] {
  return freqs.map((f) => respond(ladder, ends, f, q));
}

/** Frequencies spaced evenly in ratio, as a filter's response wants plotting. */
export function logFrequencies(startMHz: number, stopMHz: number, points: number): number[] {
  const out: number[] = [];
  const ratio = Math.log(stopMHz / startMHz);
  for (let i = 0; i < points; i++) out.push(startMHz * Math.exp((ratio * i) / (points - 1)));
  return out;
}

// ---- standard values ----

export const E24 = [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1];
export const E12 = [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2];

/** The nearest value in a preferred-number series, by ratio. */
export function nearestStandard(value: number, series: readonly number[] = E24): number {
  if (!(value > 0)) return 0;
  const decade = Math.floor(Math.log10(value));
  let best = value;
  let bestError = Infinity;
  for (const exp of [decade - 1, decade, decade + 1]) {
    for (const m of series) {
      const candidate = m * 10 ** exp;
      const error = Math.abs(Math.log(candidate / value));
      if (error < bestError) {
        bestError = error;
        best = candidate;
      }
    }
  }
  return best;
}

/** The same ladder with every capacitor rounded to a standard value; coils are wound to order. */
export function withStandardCapacitors(ladder: Ladder, series: readonly number[] = E24): Ladder {
  return {
    ...ladder,
    elements: ladder.elements.map((e) => (e.kind === 'capacitor' ? { ...e, value: nearestStandard(e.value, series) } : e)),
  };
}
