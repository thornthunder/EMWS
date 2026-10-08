// A terrestrial path with something in the way: Fresnel-zone clearance, the bulge of the
// earth, and the loss over a knife edge. The sums behind "can I see the repeater from here".
//
//   - The n-th Fresnel zone at a point d1 from one end and d2 from the other has radius
//       r_n = sqrt(n lambda d1 d2 / (d1 + d2)).
//     A path with the first zone clear is a free-space path; the usual engineering rule
//     keeps 60 % of it clear, and the knife-edge curve below is why that number: at
//     0.6 r1 of clearance the loss is within a fraction of a dB of free space.
//   - Over a smooth earth the ground rises between the ends by  d1 d2 / (2 k R)  (the
//     "earth bulge"), with k = 4/3 for average refraction - the same k the horizon uses.
//   - A single sharp obstacle a height h above the line of sight (below: h negative) is
//     the knife edge of physical optics. Its Fresnel-Kirchhoff parameter is
//       v = h sqrt(2 (d1 + d2) / (lambda d1 d2))   ( = sqrt(2) h / r1 ),
//     and the field relative to free space is
//       F(v) = (1 + j)/2 * integral from v to infinity of exp(-j pi t^2 / 2) dt,
//     so  |F|^2 = 1/2 [ (1/2 - C(v))^2 + (1/2 - S(v))^2 ]  with C and S the Fresnel
//     integrals, and the loss is -20 log10 |F|. Grazing (v = 0) is exactly 6.02 dB; a
//     little clearance gives a ripple of up to about 1 dB of GAIN; deep shadow falls as
//     20 log10(sqrt(2) pi v).
//
// C(x) and S(x) are integrated numerically here (composite Simpson, with the step
// shrinking as the integrand's phase pi x^2 / 2 speeds up) rather than taken from a
// series with remembered coefficients; tests hold them to the tabulated values.
//
// Real hills are not knife edges, and two of them are not one: this is the textbook
// single-edge estimate, good for "is there a problem" and for a ridge that really is
// sharp, and it says so on the page. Everything is on top of the free-space loss.
//
// Public domain (The Unlicense). By ZR1JT.

import { C0 } from '../lc/coil';
import { EARTH_RADIUS_KM, EFFECTIVE_EARTH } from './link';

/** The usual clearance rule: this much of the first Fresnel zone kept clear counts as line of sight. */
export const CLEAR_FRACTION = 0.6;

/** Radius of the n-th Fresnel zone, metres, at d1 km from one end and d2 km from the other. */
export function fresnelRadiusM(fMHz: number, d1Km: number, d2Km: number, n = 1): number {
  if (!(fMHz > 0) || !(d1Km > 0) || !(d2Km > 0) || !(n > 0)) return NaN;
  const lambdaM = C0 / (fMHz * 1e6);
  return Math.sqrt((n * lambdaM * d1Km * 1000 * d2Km * 1000) / ((d1Km + d2Km) * 1000));
}

/** How far a smooth k-earth rises above the chord between the ends, metres, at d1 / d2 km from them. */
export function earthBulgeM(d1Km: number, d2Km: number, k = EFFECTIVE_EARTH): number {
  if (!(d1Km >= 0) || !(d2Km >= 0) || !(k > 0)) return NaN;
  return (d1Km * 1000 * d2Km * 1000) / (2 * k * EARTH_RADIUS_KM * 1000);
}

/** Fresnel-Kirchhoff parameter v for an edge h metres above the line of sight (negative below it). */
export function diffractionParameter(hM: number, fMHz: number, d1Km: number, d2Km: number): number {
  if (!Number.isFinite(hM) || !(fMHz > 0) || !(d1Km > 0) || !(d2Km > 0)) return NaN;
  const lambdaM = C0 / (fMHz * 1e6);
  const d1 = d1Km * 1000;
  const d2 = d2Km * 1000;
  return hM * Math.sqrt((2 * (d1 + d2)) / (lambdaM * d1 * d2));
}

/** The Fresnel integrals C(x) = int_0^x cos(pi t^2/2) dt and S(x) likewise with sin, by Simpson's rule. */
export function fresnelIntegrals(x: number): { c: number; s: number } {
  if (!Number.isFinite(x)) return { c: NaN, s: NaN };
  if (x === 0) return { c: 0, s: 0 };
  const span = Math.abs(x);
  // The phase pi t^2 / 2 advances at pi t per unit t: keep every step well under a tenth of a radian.
  let steps = Math.ceil(Math.max(200, span * span * 40));
  if (steps % 2 === 1) steps += 1;
  const h = span / steps;
  let c = 0;
  let s = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i * h;
    const weight = i === 0 || i === steps ? 1 : i % 2 === 1 ? 4 : 2;
    const phase = (Math.PI * t * t) / 2;
    c += weight * Math.cos(phase);
    s += weight * Math.sin(phase);
  }
  c *= h / 3;
  s *= h / 3;
  // Both integrals are odd functions.
  return x < 0 ? { c: -c, s: -s } : { c, s };
}

/** Where the numerical integral hands over to the large-v asymptote, 20 log10(sqrt 2 pi v). */
const ASYMPTOTE_FROM = 12;

/** Knife-edge diffraction loss relative to free space, dB (negative = a little gain). */
export function knifeEdgeLossDb(v: number): number {
  if (!Number.isFinite(v)) return NaN;
  if (v > ASYMPTOTE_FROM) return 20 * Math.log10(Math.SQRT2 * Math.PI * v);
  if (v < -ASYMPTOTE_FROM) return 0;
  const { c, s } = fresnelIntegrals(v);
  const magnitudeSquared = 0.5 * ((0.5 - c) ** 2 + (0.5 - s) ** 2);
  return -10 * Math.log10(magnitudeSquared);
}

export interface ObstaclePath {
  fMHz: number;
  d1Km: number;
  d2Km: number;
  /** Top of the obstacle relative to the straight line between the antennas, metres; below it is negative. */
  obstacleM: number;
}

export interface ObstacleResult {
  /** First Fresnel zone radius at the obstacle, metres. */
  r1M: number;
  /** Clearance below the line of sight as a fraction of r1 (positive = clear, negative = blocked). */
  clearanceFraction: number;
  v: number;
  lossDb: number;
  /** The earth's bulge at that point over a 4/3 earth, metres - to be added to a terrain height taken from a map. */
  bulgeM: number;
  /** How far the obstacle would have to be below the line for the 60 % rule, metres. */
  clearanceNeededM: number;
}

export function obstacle(p: ObstaclePath): ObstacleResult {
  const r1M = fresnelRadiusM(p.fMHz, p.d1Km, p.d2Km, 1);
  const v = diffractionParameter(p.obstacleM, p.fMHz, p.d1Km, p.d2Km);
  return {
    r1M,
    clearanceFraction: -p.obstacleM / r1M,
    v,
    lossDb: knifeEdgeLossDb(v),
    bulgeM: earthBulgeM(p.d1Km, p.d2Km),
    clearanceNeededM: CLEAR_FRACTION * r1M,
  };
}
