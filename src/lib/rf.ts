// Transmission-line arithmetic shared by every EMWS tool.

import type { Complex } from '../engine/nec2/types';

export const DEFAULT_Z0 = 50;

/** Voltage reflection coefficient of load `z` on a line of impedance `z0`: (z - z0) / (z + z0). */
export function reflectionCoefficient(z: Complex, z0 = DEFAULT_Z0): Complex {
  const nr = z.re - z0;
  const dr = z.re + z0;
  const denominator = dr * dr + z.im * z.im;
  if (denominator === 0) return { re: 1, im: 0 };
  return {
    re: (nr * dr + z.im * z.im) / denominator,
    im: (z.im * dr - nr * z.im) / denominator,
  };
}

export function magnitude(c: Complex): number {
  return Math.hypot(c.re, c.im);
}

/** Standing wave ratio. Infinity for a fully reflective (or non-passive) load. */
export function swr(z: Complex, z0 = DEFAULT_Z0): number {
  const rho = magnitude(reflectionCoefficient(z, z0));
  return rho >= 1 ? Infinity : (1 + rho) / (1 - rho);
}

/** Return loss in dB, as a positive number. Infinity for a perfect match. */
export function returnLossDb(z: Complex, z0 = DEFAULT_Z0): number {
  const rho = magnitude(reflectionCoefficient(z, z0));
  return rho === 0 ? Infinity : -20 * Math.log10(rho);
}

/** Power lost to reflection, in dB, as a positive number. */
export function mismatchLossDb(z: Complex, z0 = DEFAULT_Z0): number {
  const rho = magnitude(reflectionCoefficient(z, z0));
  return rho >= 1 ? Infinity : -10 * Math.log10(1 - rho * rho);
}

/** "72.4 + j2.0" - the way hams write an impedance. */
export function formatImpedance(z: Complex, digits = 1): string {
  const sign = z.im < 0 ? '−' : '+';
  return `${z.re.toFixed(digits)} ${sign} j${Math.abs(z.im).toFixed(digits)}`;
}
