// Coax stubs and quarter-wave resonators: the filters a VHF/UHF station makes from cable.
//
// A length of line, shorted or left open at the far end, is a resonator. Hung across a
// feed line at a T it becomes a filter:
//
//   - an OPEN quarter-wave stub is a short circuit at its frequency: a notch there, and
//     transparent at twice it (now an open half wave);
//   - a SHORTED quarter-wave stub is an open circuit at its frequency - it passes it - and
//     a short at twice it: the classic second-harmonic trap, and a DC path to ground too;
//   - a SHORTED half-wave stub notches its frequency and passes half of it.
//
// The stub's impedance is the lossy line's, with cosh and sinh written out rather than
// tanh or coth - tanh is infinite a quarter wave down a lossless line, the Smith chart's
// lesson - and the line's loss is the RF toolbox's cable model, so the notch depth this
// shows is the depth that loss allows.
//
// The band-pass is the coupled-resonator design of the microwave texts (Matthaei, Young
// and Jones): shorted stubs as shunt resonators, joined by small series capacitors acting
// as admittance inverters, from the same low-pass prototype as the ladder filters. The
// design formulas hold for narrow bands (up to ~10 %); the response drawn is the EXACT
// analysis of the circuit as listed - stubs with their loss, capacitors as capacitors - so
// where the formulas run out the curve shows it.
//
// Public domain (The Unlicense). By ZR1JT.

import { type Complex, cAbs, cAdd, cDiv, cMul, complex } from '../../lib/complex';
import { C0 } from './coil';
import { type Cable, DB_PER_NEPER, matchedLossPer100m } from '../toolbox/coax';
import { type FilterFamily, prototype } from './filter';

export type StubKind = 'open-quarter' | 'shorted-quarter' | 'shorted-half';

export const STUB_KINDS: { id: StubKind; label: string; does: string }[] = [
  { id: 'open-quarter', label: 'Open quarter-wave stub', does: 'notches its frequency; passes twice it' },
  { id: 'shorted-quarter', label: 'Shorted quarter-wave stub', does: 'passes its frequency; notches twice it (and shorts DC)' },
  { id: 'shorted-half', label: 'Shorted half-wave stub', does: 'notches its frequency; passes half of it' },
];

/**
 * A cavity or trough line as a resonator: air-spaced (velocity factor 1), of impedance z0,
 * with the unloaded Q you give at the design frequency. Coax stubs rarely reach a Q of a
 * few hundred; a good cavity has thousands, and a narrow filter needs them. Built as a
 * "datasheet" cable whose loss is the one that Q implies, α = β / 2Q, rising with
 * frequency as β does - so every formula above applies unchanged.
 */
export function cavityLine(z0: number, unloadedQ: number, fMHz: number): Cable {
  const dbPer100mAt = (f: number) => {
    const beta = (2 * Math.PI * f * 1e6) / C0;
    return (beta / (2 * Math.max(1, unloadedQ))) * DB_PER_NEPER * 100;
  };
  return {
    id: 'cavity',
    name: `Cavity, ${z0} Ω, Q ${unloadedQ}`,
    z0,
    velocityFactor: 1,
    loss: { kind: 'datasheet', points: [{ fMHz, dbPer100m: dbPer100mAt(fMHz) }, { fMHz: 2 * fMHz, dbPer100m: dbPer100mAt(2 * fMHz) }] },
  };
}

/** The line's propagation over a length at a frequency: γl = αl + jβl. */
export function gammaL(cable: Cable, lengthM: number, fMHz: number): Complex {
  const alpha = (matchedLossPer100m(cable, fMHz).totalDb / 100 / DB_PER_NEPER) * lengthM;
  const beta = ((2 * Math.PI * fMHz * 1e6) / (C0 * cable.velocityFactor)) * lengthM;
  return { re: alpha, im: beta };
}

const cosh = (z: Complex): Complex => ({ re: Math.cosh(z.re) * Math.cos(z.im), im: Math.sinh(z.re) * Math.sin(z.im) });
const sinh = (z: Complex): Complex => ({ re: Math.sinh(z.re) * Math.cos(z.im), im: Math.cosh(z.re) * Math.sin(z.im) });

/** Input impedance of a stub: shorted Zc·sinh/cosh, open Zc·cosh/sinh. */
export function stubImpedance(cable: Cable, lengthM: number, shorted: boolean, fMHz: number): Complex {
  const gl = gammaL(cable, lengthM, fMHz);
  const zc = complex(cable.z0);
  return shorted ? cMul(zc, cDiv(sinh(gl), cosh(gl))) : cMul(zc, cDiv(cosh(gl), sinh(gl)));
}

/** Physical length of a stub that is a quarter (or half) wave at f in this cable. */
export function stubLengthM(cable: Cable, kind: StubKind, fMHz: number): number {
  const wavelengthInLine = (C0 * cable.velocityFactor) / (fMHz * 1e6);
  return kind === 'shorted-half' ? wavelengthInLine / 2 : wavelengthInLine / 4;
}

/** S21 of a shunt impedance across a matched z0 line: 2 / (2 + z0 / Z). */
export function shuntS21(z: Complex, z0 = 50): Complex {
  return cDiv(complex(2), cAdd(complex(2), cDiv(complex(z0), z)));
}

export const db = (s21: Complex) => 20 * Math.log10(Math.max(1e-30, cAbs(s21)));

export function stubResponse(cable: Cable, kind: StubKind, lengthM: number, fMHz: number, z0 = 50): Complex {
  return shuntS21(stubImpedance(cable, lengthM, kind !== 'open-quarter', fMHz), z0);
}

// ---------------------------------------------------------------- band-pass

export interface BandpassSpec {
  centreMHz: number;
  /** Passband width, MHz: Butterworth at its 3 dB points, Chebyshev at the ripple's edge. */
  bandwidthMHz: number;
  order: number;
  family: FilterFamily;
  rippleDb: number;
  z0: number;
}

export interface Bandpass {
  /** Series coupling capacitors, farads: n + 1 of them, source side first. */
  couplingF: number[];
  /** Each shorted resonator's physical length, metres - shorter than a quarter wave by the capacitors' loading. */
  resonatorM: number[];
  /** Its electrical length at the centre, degrees. */
  resonatorDeg: number[];
}

/**
 * The coupled-resonator design. Each resonator's slope parameter b, the inverters J from
 * the prototype, the capacitors that make them (an end one sized against the 50 Ω it
 * faces), and each stub shortened until its inductance cancels the capacitance the
 * inverters hang on its node. b depends on the shortened length, so the loop is run until
 * it settles - a handful of passes.
 */
export function designBandpass(spec: BandpassSpec, cable: Cable): Bandpass {
  const { g, load } = prototype(spec.family, spec.order, spec.rippleDb);
  const n = g.length;
  const w0 = 2 * Math.PI * spec.centreMHz * 1e6;
  const w = spec.bandwidthMHz / spec.centreMHz;
  const yr = 1 / cable.z0;
  const ga = 1 / spec.z0;
  const gs = [1, ...g, load];
  let theta = new Array<number>(n).fill(Math.PI / 2);
  let couplingF: number[] = [];
  for (let pass = 0; pass < 12; pass++) {
    // b = (ω0/2) dB/dω of (stub + the capacitance it carries) at ω0.
    const nodeC = (j: number, c: number[], ends: number[]) => (j === 0 ? ends[0]! : c[j]!) + (j === n - 1 ? ends[1]! : c[j + 1]!);
    const prevEnds = couplingF.length ? [effectiveEnd(couplingF[0]!, w0, ga), effectiveEnd(couplingF[n]!, w0, ga)] : [0, 0];
    const b = theta.map((t, j) => (yr * t) / (2 * Math.sin(t) ** 2) + (w0 / 2) * (couplingF.length ? nodeC(j, couplingF, prevEnds) : 0));
    const J: number[] = [];
    J.push(Math.sqrt((ga * b[0]! * w) / (gs[0]! * gs[1]!)));
    for (let j = 1; j < n; j++) J.push(w * Math.sqrt((b[j - 1]! * b[j]!) / (gs[j]! * gs[j + 1]!)));
    J.push(Math.sqrt((ga * b[n - 1]! * w) / (gs[n]! * gs[n + 1]!)));
    // Ends against the 50 Ω they face; between resonators simply J / ω0.
    const endC = (j: number) => j / (w0 * Math.sqrt(Math.max(1e-12, 1 - (j / ga) ** 2)));
    couplingF = J.map((j, i) => (i === 0 || i === n ? endC(j) : j / w0));
    const ends = [effectiveEnd(couplingF[0]!, w0, ga), effectiveEnd(couplingF[n]!, w0, ga)];
    // The stub must cancel the capacitance at its node: -Yr cot θ = -ω0 ΣC.
    const next = theta.map((_, j) => Math.atan(yr / (w0 * nodeC(j, couplingF, ends))));
    const settled = next.every((t, j) => Math.abs(t - theta[j]!) < 1e-9);
    theta = next;
    if (settled) break;
  }
  const lambdaLine = (C0 * cable.velocityFactor) / (spec.centreMHz * 1e6);
  return {
    couplingF,
    resonatorM: theta.map((t) => (t / (2 * Math.PI)) * lambdaLine),
    resonatorDeg: theta.map((t) => (t * 180) / Math.PI),
  };
}

/** The shunt capacitance an end capacitor presents at its node, with the 50 Ω behind it: C / (1 + (ω C / G)²). */
function effectiveEnd(c: number, w0: number, g: number): number {
  return c / (1 + ((w0 * c) / g) ** 2);
}

type Abcd = [Complex, Complex, Complex, Complex];
const series = (z: Complex): Abcd => [complex(1), z, complex(0), complex(1)];
const shunt = (y: Complex): Abcd => [complex(1), complex(0), y, complex(1)];
const chain = (m: Abcd, k: Abcd): Abcd => [
  cAdd(cMul(m[0], k[0]), cMul(m[1], k[2])),
  cAdd(cMul(m[0], k[1]), cMul(m[1], k[3])),
  cAdd(cMul(m[2], k[0]), cMul(m[3], k[2])),
  cAdd(cMul(m[2], k[1]), cMul(m[3], k[3])),
];

/** S21 of the band-pass as built, between z0 terminations: the exact ABCD of its parts. */
export function bandpassResponse(design: Bandpass, cable: Cable, fMHz: number, z0 = 50): Complex {
  const w = 2 * Math.PI * fMHz * 1e6;
  const cap = (c: number): Complex => ({ re: 0, im: -1 / (w * c) });
  let m: Abcd = series(cap(design.couplingF[0]!));
  design.resonatorM.forEach((len, j) => {
    m = chain(m, shunt(cDiv(complex(1), stubImpedance(cable, len, true, fMHz))));
    m = chain(m, series(cap(design.couplingF[j + 1]!)));
  });
  // S21 = 2 / (A + B/z0 + C z0 + D) between equal terminations.
  const sum = cAdd(cAdd(m[0], cDiv(m[1], complex(z0))), cAdd(cMul(m[2], complex(z0)), m[3]));
  return cDiv(complex(2), sum);
}

/** A sweep of frequencies, evenly spaced: these responses are read on a linear axis. */
export function linearFrequencies(startMHz: number, stopMHz: number, points: number): number[] {
  const n = Math.max(2, Math.round(points));
  return Array.from({ length: n }, (_, i) => startMHz + ((stopMHz - startMHz) * i) / (n - 1));
}
