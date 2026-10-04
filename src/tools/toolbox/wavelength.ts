// Wavelengths, and the lengths of wire and line that follow from them.
//
// Everything here is c / f and a velocity factor. The one place folklore enters - how much
// shorter than a half wave a real dipole is - is given as three figures with their origins,
// not one, because the honest answer depends on the wire and its surroundings, and the
// Antenna Modeler's Tune button is what finds it for a particular antenna.

import { C0 } from '../lc/coil';

/** Free-space wavelength in metres, or in a medium with the given velocity factor. */
export function wavelengthM(fMHz: number, velocityFactor = 1): number {
  if (!(fMHz > 0) || !(velocityFactor > 0)) return NaN;
  return (C0 * velocityFactor) / (fMHz * 1e6);
}

export function frequencyForWavelengthMHz(lambdaM: number, velocityFactor = 1): number {
  if (!(lambdaM > 0) || !(velocityFactor > 0)) return NaN;
  return (C0 * velocityFactor) / lambdaM / 1e6;
}

export interface ElectricalLength {
  wavelengths: number;
  degrees: number;
}

/** How long a physical length is electrically, on a line (or in a wire) of this velocity factor. */
export function electricalLength(physicalM: number, fMHz: number, velocityFactor = 1): ElectricalLength {
  const wavelengths = physicalM / wavelengthM(fMHz, velocityFactor);
  return { wavelengths, degrees: wavelengths * 360 };
}

/** The physical length of so many wavelengths (0.25 for a quarter-wave section). */
export function physicalLengthM(wavelengths: number, fMHz: number, velocityFactor = 1): number {
  return wavelengths * wavelengthM(fMHz, velocityFactor);
}

export interface HalfWaveRule {
  id: string;
  label: string;
  /** Where the figure comes from, for the reader to weigh it. */
  origin: string;
  /** Length x frequency: the dipole is metreMHz / fMHz long. */
  metreMHz: number;
}

/**
 * Half-wave dipole lengths, as metres x MHz. The first is physics, the second was measured
 * with this suite's own engine (feature: Tune, 2026-10-04: a 2 mm wire in free space is
 * resonant at 10.247 m for 14.2 MHz), the third is the handbook rule of thumb.
 */
export const HALF_WAVE_RULES: HalfWaveRule[] = [
  {
    id: 'free-space',
    label: 'A half wave in free space',
    origin: 'c / 2f with no end effect: a dipole this long is slightly inductive',
    metreMHz: C0 / 2 / 1e6,
  },
  {
    id: 'measured',
    label: 'Resonant 2 mm wire in free space',
    origin: 'measured with this engine: 10.247 m at 14.2 MHz, so 145.5 / f',
    metreMHz: 145.5,
  },
  {
    id: 'folklore',
    label: 'The 468 / f rule of thumb',
    origin: '468 feet-MHz, which is 142.6 / f in metres: the old handbook figure for a wire a few metres up',
    metreMHz: 468 * 0.3048,
  },
];
