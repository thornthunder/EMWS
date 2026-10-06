// Transmission, port 1 to port 2: S21, and the response calibration that makes it mean
// something.
//
// What arrives at port 2 has been through the instrument's own paths and both cables as
// well as the thing being measured. The textbook's two-term response model says what
// the receiver reads is
//
//     S21m = e30 + e10e32 * S21a
//
// e30 being leakage straight across inside the instrument (isolation) and e10e32 the
// tracking of the whole path. Connect the two cables together - a THRU, S21a = 1 - and
// you have e30 + e10e32. Terminate both ports instead - ISOLATION, S21a = 0 - and you
// have e30. Then every reading corrects as
//
//     S21a = (S21m - e30) / e10e32 = (S21m - iso) / (thru - iso)
//
// Isolation is optional: skipped, e30 is taken as zero, which is fine until the
// measurement goes deeper than the instrument's own leakage - a notch filter's floor.
//
// A response calibration ignores the mismatch at either port, so a filter whose ports are
// not near 50 Ω reads a little off in its passband. For a notch's depth or a band-pass's
// shape that is a fraction of a dB; the guide says so.
//
// Public domain (The Unlicense). By ZR1JT.

import { type Complex, cAbs, cDiv, cSub } from '../complex';

export interface TransmissionPoint {
  fMHz: number;
  s21: Complex;
}

export interface ThruCalibration {
  thru: TransmissionPoint[];
  isolation?: TransmissionPoint[];
  madeAt: string;
}

/** Whether two sweeps sampled the same frequencies, to within rounding. */
export function sameTransmissionFrequencies(a: readonly TransmissionPoint[], b: readonly TransmissionPoint[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((p, i) => Math.abs(p.fMHz - b[i]!.fMHz) <= Math.max(p.fMHz, b[i]!.fMHz) * 1e-9);
}

export function makeThruCalibration(thru: TransmissionPoint[], isolation?: TransmissionPoint[]): ThruCalibration {
  if (thru.length === 0) throw new Error('The thru sweep is empty.');
  // Point-by-point correction: a thru over one range and an isolation over another would
  // combine into a calibration that means nothing while looking like one.
  if (isolation && !sameTransmissionFrequencies(thru, isolation)) throw new Error('The thru and the isolation must be swept over the same frequencies.');
  return { thru, ...(isolation ? { isolation } : {}), madeAt: new Date().toISOString() };
}

/** A sweep's value at any frequency: straight lines between its points, held at the ends. */
function valueAt(points: readonly TransmissionPoint[], fMHz: number): Complex {
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (fMHz <= first.fMHz) return first.s21;
  if (fMHz >= last.fMHz) return last.s21;
  let hi = 1;
  while (points[hi]!.fMHz < fMHz) hi++;
  const a = points[hi - 1]!;
  const b = points[hi]!;
  const t = (fMHz - a.fMHz) / (b.fMHz - a.fMHz);
  return { re: a.s21.re + (b.s21.re - a.s21.re) * t, im: a.s21.im + (b.s21.im - a.s21.im) * t };
}

/** Raw readings, corrected by the thru (and the isolation, if one was taken). */
export function applyThru(raw: readonly TransmissionPoint[], calibration: ThruCalibration): TransmissionPoint[] {
  return raw.map((p) => {
    const iso = calibration.isolation ? valueAt(calibration.isolation, p.fMHz) : { re: 0, im: 0 };
    return { fMHz: p.fMHz, s21: cDiv(cSub(p.s21, iso), cSub(valueAt(calibration.thru, p.fMHz), iso)) };
  });
}

export function thruCovers(calibration: ThruCalibration, startMHz: number, stopMHz: number): boolean {
  const first = calibration.thru[0];
  const last = calibration.thru[calibration.thru.length - 1];
  return first !== undefined && last !== undefined && first.fMHz <= startMHz * 1.01 && last.fMHz >= stopMHz * 0.99;
}

/** |S21| in dB: the insertion loss is its negative. */
export function s21Db(s21: Complex): number {
  const m = cAbs(s21);
  return m > 0 ? 20 * Math.log10(m) : -Infinity;
}
