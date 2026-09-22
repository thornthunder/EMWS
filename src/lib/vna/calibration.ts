// One-port calibration: short, open, load.
//
// What a VNA measures at its connector is not what is attached to it. The bridge, the
// cable and the connector between them add a fixed error that the textbook writes as
// three terms:
//
//     Gm = e00 + (e10e01 * Ga) / (1 - e11 * Ga)
//
// Gm being what the instrument reads and Ga what is really there. Measure three things
// whose true reflection is known - a short (-1), an open (+1) and a good load (0) - and
// the three unknowns fall out; after that every reading can be corrected:
//
//     Ga = (Gm - e00) / (e11 * (Gm - e00) + e10e01)
//
// The classic NanoVNA does this on the instrument and sends corrected data over USB. The
// NanoVNA-V2 sends raw data and leaves correction to the host, so it needs this. Either
// can use it: a calibration done at the end of your own cable, with the tool's own
// standards, is the measurement of the thing you actually connected.
//
// Public domain (The Unlicense). By ZR1JT.

import { type Complex, cAdd, cDiv, cMul, cSub, complex } from '../complex';
import type { MeasuredPoint } from '../touchstone';
import { impedanceFromGamma } from '../touchstone';

/** The three error terms at one frequency. */
export interface ErrorTerms {
  fMHz: number;
  e00: Complex;
  e11: Complex;
  e10e01: Complex;
}

export interface Calibration {
  /** Where the standards were measured; each is raw S11 against frequency. */
  short: MeasuredPoint[];
  open: MeasuredPoint[];
  load: MeasuredPoint[];
  terms: ErrorTerms[];
  madeAt: string;
}

/**
 * Solves the three-term model at each frequency from the three standards, which are
 * assumed ideal: short -1, open +1, load 0. (A real open has a little fringing
 * capacitance and a real short a little inductance; at HF, at the end of a cable, that
 * is a second-order refinement and is not attempted here.)
 *
 * With Ga = 0 the model gives Gm_load = e00 directly. With Ga = ±1:
 *     Gm_short - e00 = -e10e01 / (1 + e11)
 *     Gm_open  - e00 =  e10e01 / (1 - e11)
 * from which e11 and e10e01 follow in closed form.
 */
export function solveTerms(short: readonly MeasuredPoint[], open: readonly MeasuredPoint[], load: readonly MeasuredPoint[]): ErrorTerms[] {
  if (short.length !== open.length || open.length !== load.length || load.length === 0) {
    throw new Error('The three standards must be swept over the same frequencies.');
  }
  const terms: ErrorTerms[] = [];
  for (let i = 0; i < load.length; i++) {
    const s = short[i]!.gamma;
    const o = open[i]!.gamma;
    const l = load[i]!.gamma;
    const e00 = l;
    const a = cSub(s, e00); // = -e10e01 / (1 + e11)
    const b = cSub(o, e00); // =  e10e01 / (1 - e11)
    // b(1 - e11) = -a(1 + e11)  ->  e11 = (b + a) / (b - a)... with the sign sorted out:
    // b - b e11 = -a - a e11  ->  b + a = e11 (b - a)
    const e11 = cDiv(cAdd(b, a), cSub(b, a));
    const e10e01 = cMul(b, cSub(complex(1), e11));
    terms.push({ fMHz: load[i]!.fMHz, e00, e11, e10e01 });
  }
  return terms;
}

export function makeCalibration(short: MeasuredPoint[], open: MeasuredPoint[], load: MeasuredPoint[]): Calibration {
  return { short, open, load, terms: solveTerms(short, open, load), madeAt: new Date().toISOString() };
}

/** Error terms at any frequency, straight lines between the calibrated ones. */
function termsAt(terms: readonly ErrorTerms[], fMHz: number): ErrorTerms {
  const first = terms[0]!;
  const last = terms[terms.length - 1]!;
  if (fMHz <= first.fMHz) return first;
  if (fMHz >= last.fMHz) return last;
  let hi = 1;
  while (terms[hi]!.fMHz < fMHz) hi++;
  const a = terms[hi - 1]!;
  const b = terms[hi]!;
  const t = (fMHz - a.fMHz) / (b.fMHz - a.fMHz);
  const mix = (p: Complex, q: Complex): Complex => ({ re: p.re + (q.re - p.re) * t, im: p.im + (q.im - p.im) * t });
  return { fMHz, e00: mix(a.e00, b.e00), e11: mix(a.e11, b.e11), e10e01: mix(a.e10e01, b.e10e01) };
}

/** Raw readings, corrected. */
export function applyCalibration(raw: readonly MeasuredPoint[], calibration: Calibration, z0 = 50): MeasuredPoint[] {
  return raw.map((p) => {
    const e = termsAt(calibration.terms, p.fMHz);
    const d = cSub(p.gamma, e.e00);
    const gamma = cDiv(d, cAdd(cMul(e.e11, d), e.e10e01));
    return { fMHz: p.fMHz, gamma, z: impedanceFromGamma(gamma, z0) };
  });
}

/** True when the calibration's frequencies cover the sweep, give or take a percent. */
export function calibrationCovers(calibration: Calibration, startMHz: number, stopMHz: number): boolean {
  const first = calibration.terms[0];
  const last = calibration.terms[calibration.terms.length - 1];
  return first !== undefined && last !== undefined && first.fMHz <= startMHz * 1.01 && last.fMHz >= stopMHz * 0.99;
}
