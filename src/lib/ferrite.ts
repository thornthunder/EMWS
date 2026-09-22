// Ferrite toroids: what the shape is worth, and what the material does with frequency.
//
// Two things decide how a wound ferrite core behaves, and they separate cleanly:
//
//   - the SHAPE, which fixes how much inductance a turn buys. For a toroid of
//     rectangular section this follows exactly from three dimensions, so no table of
//     manufacturers' A_L values is needed - or used.
//   - the MATERIAL, through its complex permeability  mu = mu' - j mu''.  mu' is the part
//     that stores energy (inductance); mu'' is the part that turns it into heat. Both
//     change with frequency, and that change is the whole difference between one mix and
//     another.
//
// Public domain (The Unlicense). By ZR1JT.

import type { Complex } from './complex';

export const MU0 = 4e-7 * Math.PI;

/** A toroid of rectangular cross-section, as wound. Stacked cores sit side by side. */
export interface ToroidGeometry {
  /** Core constant C1 = sum(l/A), per metre. Inductance is mu0 * mu * N^2 / C1. */
  c1: number;
  /** Effective magnetic cross-section, m^2. */
  areaM2: number;
  /** Effective magnetic path length, m. */
  pathM: number;
  /** Volume of ferrite, m^3. */
  volumeM3: number;
  /** Outside surface that can shed heat, m^2. */
  surfaceM2: number;
  /** Height of the whole stack, m. */
  heightM: number;
  odM: number;
  idM: number;
}

/**
 * The effective dimensions of a toroid, by the standard core-constant method:
 *
 *     C1 = 2 pi / (h ln(OD/ID))              C2 = 2 pi (1/r1 - 1/r2) / (h^2 ln^3(OD/ID))
 *     A_e = C1 / C2                          l_e = C1^2 / C2
 *
 * These weight the inside of the ring, where the path is shorter and the flux denser,
 * properly - which the rough "(OD - ID)/2 by h" does not.
 */
export function toroidGeometry(odMm: number, idMm: number, heightMm: number, stack = 1): ToroidGeometry {
  const od = odMm / 1000;
  const id = idMm / 1000;
  const h = (heightMm / 1000) * Math.max(1, stack);
  const r1 = id / 2;
  const r2 = od / 2;
  const ln = Math.log(r2 / r1);
  const c1 = (2 * Math.PI) / (h * ln);
  const c2 = (2 * Math.PI * (1 / r1 - 1 / r2)) / (h * h * ln ** 3);
  return {
    c1,
    areaM2: c1 / c2,
    pathM: (c1 * c1) / c2,
    volumeM3: Math.PI * (r2 * r2 - r1 * r1) * h,
    // Both flat faces, plus the outer and inner walls.
    surfaceM2: 2 * Math.PI * (r2 * r2 - r1 * r1) + 2 * Math.PI * (r2 + r1) * h,
    heightM: h,
    odM: od,
    idM: id,
  };
}

/** Inductance per turn squared (the familiar A_L), in henries, for a relative permeability. */
export function inductanceFactor(geometry: ToroidGeometry, mu: number): number {
  return (MU0 * mu) / geometry.c1;
}

/** Complex permeability, written the way the datasheets and the bench both give it. */
export interface Permeability {
  /** mu', the storing part. */
  real: number;
  /** mu'', the lossy part. Positive. */
  loss: number;
}

/**
 * A single relaxation (the Debye form):  mu = 1 + (mu_i - 1) / (1 + j f/f_r).
 *
 * mu' holds at mu_i well below f_r and falls away above it; mu'' rises to a peak of
 * about mu_i/2 at f_r. Real ferrites relax over a spread of frequencies rather than at
 * one, so their loss peak is lower and broader than this draws it. It is a first
 * approximation with two honest parameters, not a datasheet - and a measured curve, where
 * there is one, replaces it entirely.
 */
export function debyePermeability(muInitial: number, relaxationMHz: number, fMHz: number): Permeability {
  const x = fMHz / relaxationMHz;
  const span = muInitial - 1;
  return { real: 1 + span / (1 + x * x), loss: (span * x) / (1 + x * x) };
}

export type FerriteFamily = 'NiZn' | 'MnZn';

/**
 * Where a material's permeability gives out, from Snoek's law.
 *
 * Snoek's limit ties the two together: the higher the initial permeability, the lower the
 * frequency it survives to, with  f_r (mu_i - 1) = (2/3) (gamma/2pi) mu0 Ms.  For
 * nickel-zinc ferrite, mu0 Ms is about 0.3 T and gamma/2pi is 28 GHz/T, which makes the
 * product about 5.6 GHz.
 *
 * Manganese-zinc ferrite never reaches its Snoek limit at these sizes: eddy currents and
 * domain-wall losses take over first, because the material conducts. The 3 GHz used for
 * it is a rough working figure and deserves less trust than the nickel-zinc one.
 */
export const SNOEK_PRODUCT_MHZ: Record<FerriteFamily, number> = { NiZn: 5600, MnZn: 3000 };

export function snoekRelaxationMHz(muInitial: number, family: FerriteFamily): number {
  return SNOEK_PRODUCT_MHZ[family] / Math.max(1, muInitial - 1);
}

/** One measured point of a permeability curve. */
export interface PermeabilityPoint extends Permeability {
  fMHz: number;
}

/**
 * Reads a measured curve at any frequency. Interpolates on a log frequency axis, which is
 * how these curves are drawn and how they behave; outside the measured span it holds the
 * end value rather than inventing a trend.
 */
export function interpolatePermeability(curve: readonly PermeabilityPoint[], fMHz: number): Permeability {
  if (curve.length === 0) return { real: 1, loss: 0 };
  const first = curve[0]!;
  const last = curve[curve.length - 1]!;
  if (fMHz <= first.fMHz) return { real: first.real, loss: first.loss };
  if (fMHz >= last.fMHz) return { real: last.real, loss: last.loss };
  for (let i = 1; i < curve.length; i++) {
    const hi = curve[i]!;
    if (fMHz > hi.fMHz) continue;
    const lo = curve[i - 1]!;
    const t = Math.log(fMHz / lo.fMHz) / Math.log(hi.fMHz / lo.fMHz);
    return { real: lo.real + (hi.real - lo.real) * t, loss: lo.loss + (hi.loss - lo.loss) * t };
  }
  return { real: last.real, loss: last.loss };
}

/**
 * The impedance of N turns on a core:  Z = j w L0 (mu' - j mu'')  with  L0 = mu0 N^2 / C1.
 *
 * So the lossy part of the permeability arrives as series resistance and the storing part
 * as series reactance - which is exactly how a wound core looks on a VNA.
 */
export function coreImpedance(geometry: ToroidGeometry, turns: number, mu: Permeability, fMHz: number): Complex {
  const wL0 = (2 * Math.PI * fMHz * 1e6 * MU0 * turns * turns) / geometry.c1;
  return { re: wL0 * mu.loss, im: wL0 * mu.real };
}

/** The same relation run backwards: what a measured impedance says the permeability is. */
export function permeabilityFromImpedance(z: Complex, geometry: ToroidGeometry, turns: number, fMHz: number): Permeability {
  const wL0 = (2 * Math.PI * fMHz * 1e6 * MU0 * turns * turns) / geometry.c1;
  return { real: z.im / wL0, loss: z.re / wL0 };
}
