// Traps: a coil and a capacitor in parallel, cut into an antenna wire.
//
// At its own resonance a trap is a very high impedance, so the wire beyond it might as
// well not be there and the inner part is a complete antenna on that band. Below
// resonance the trap is inductive, and the outer wire is still connected but electrically
// longer than it looks, which is how one wire covers a lower band with less length than
// it ought to need. Above resonance the trap is capacitive and mostly a nuisance.
//
// Loss is the coil's: R = w0 L / Q at resonance, growing with the square root of frequency
// as skin effect does. The capacitor is taken as lossless, which for a decent mica or
// ceramic part it nearly is. Nothing here knows how much current the antenna will push
// through the trap - that takes the antenna, in the modeller.
//
// Public domain (The Unlicense). By ZR1JT.

import { type Complex, cAdd, cInv, complex } from '../../lib/complex';

export interface TrapSpec {
  henries: number;
  farads: number;
  /** The coil's Q at the trap frequency. */
  q: number;
}

export function resonanceMHz({ henries, farads }: { henries: number; farads: number }): number {
  if (!(henries > 0) || !(farads > 0)) return 0;
  return 1 / (2 * Math.PI * Math.sqrt(henries * farads)) / 1e6;
}

export function capacitorFor(f0MHz: number, henries: number): number {
  const w = 2 * Math.PI * f0MHz * 1e6;
  return 1 / (w * w * henries);
}

export function inductorFor(f0MHz: number, farads: number): number {
  const w = 2 * Math.PI * f0MHz * 1e6;
  return 1 / (w * w * farads);
}

/** The coil's series resistance at `fMHz`: set by Q at resonance, following skin effect elsewhere. */
export function coilResistance(trap: TrapSpec, fMHz: number): number {
  const f0 = resonanceMHz(trap);
  if (!(trap.q > 0) || f0 <= 0) return 0;
  const r0 = (2 * Math.PI * f0 * 1e6 * trap.henries) / trap.q;
  return r0 * Math.sqrt(Math.max(0, fMHz) / f0);
}

/** What the wire sees looking into the trap at one frequency. */
export function trapImpedance(trap: TrapSpec, fMHz: number): Complex {
  const w = 2 * Math.PI * fMHz * 1e6;
  const coil = complex(coilResistance(trap, fMHz), w * trap.henries);
  const capacitor = complex(0, -1 / (w * trap.farads));
  return cInv(cAdd(cInv(coil), cInv(capacitor)));
}

/** The impedance at resonance: Q times the coil's reactance, near enough L / (R C). */
export function resonantImpedanceOhms(trap: TrapSpec): number {
  return trap.q * 2 * Math.PI * resonanceMHz(trap) * 1e6 * trap.henries;
}

/** Between the half-power points, MHz. */
export function bandwidthMHz(trap: TrapSpec): number {
  return trap.q > 0 ? resonanceMHz(trap) / trap.q : Infinity;
}

export type TrapRole = 'trap' | 'inductor' | 'capacitor';

export interface TrapView {
  fMHz: number;
  z: Complex;
  role: TrapRole;
  /** Below resonance: the series inductance the wire feels. */
  equivalentH?: number;
  /** Above resonance: the series capacitance instead. */
  equivalentF?: number;
}

/** The trap on some other band: what it amounts to there. */
export function trapAt(trap: TrapSpec, fMHz: number): TrapView {
  const z = trapImpedance(trap, fMHz);
  const f0 = resonanceMHz(trap);
  const w = 2 * Math.PI * fMHz * 1e6;
  const halfBand = bandwidthMHz(trap) / 2;
  if (Math.abs(fMHz - f0) <= halfBand) return { fMHz, z, role: 'trap' };
  if (fMHz < f0) return { fMHz, z, role: 'inductor', equivalentH: z.im / w };
  return { fMHz, z, role: 'capacitor', equivalentF: -1 / (w * z.im) };
}
