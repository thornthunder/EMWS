// Standard cores, ferrite mixes and wire to wind with.
//
// PROVENANCE. Everything here is a physical fact or follows from one; nothing is
// transcribed from a manufacturer's datasheet or curve:
//
//   - Core sizes are the nominal catalogue dimensions that the "FT" part number encodes
//     (FT240 is 2.40 inches across). What a core is worth electrically is CALCULATED from
//     those dimensions - see toroidGeometry() - rather than looked up.
//   - A mix is described by its initial permeability and its ferrite family, both
//     generally published. How its permeability changes with frequency is then ESTIMATED
//     from Snoek's law and a single relaxation (see src/lib/ferrite.ts). That is a first
//     approximation and says so wherever it is shown. The accurate route is to measure the
//     core in your hand with a VNA, which replaces the estimate entirely.
//   - Wire diameters come from the AWG definition; insulation figures are typical values
//     for the material, and velocity factors are calculated from the dielectric.
//
// Ferrite varies by a fifth or so between batches in any case, so a measurement of your
// own core beats any table, this one included.
//
// Public domain (The Unlicense). By ZR1JT.

import type { FerriteFamily, PermeabilityPoint } from '../../lib/ferrite';

export interface CoreSize {
  id: string;
  name: string;
  odMm: number;
  idMm: number;
  heightMm: number;
}

const INCH = 25.4;
const ft = (id: string, od: number, idIn: number, h: number): CoreSize => ({
  id,
  name: id,
  odMm: Number((od * INCH).toFixed(2)),
  idMm: Number((idIn * INCH).toFixed(2)),
  heightMm: Number((h * INCH).toFixed(2)),
});

/** Nominal sizes, in the inches the part numbers are named for. */
export const CORES: CoreSize[] = [
  ft('FT50', 0.5, 0.281, 0.188),
  ft('FT82', 0.825, 0.52, 0.25),
  ft('FT114', 1.142, 0.748, 0.295),
  ft('FT140', 1.4, 0.9, 0.5),
  ft('FT240', 2.4, 1.4, 0.5),
];

export interface Material {
  id: string;
  name: string;
  family: FerriteFamily;
  muInitial: number;
  /** Set for a material measured on the bench; replaces the estimate. */
  curve?: PermeabilityPoint[];
  /** Override for the estimated relaxation frequency, where someone knows better. */
  relaxationMHz?: number;
  /** What it is usually chosen for, in a few words. */
  note: string;
}

export const MATERIALS: Material[] = [
  { id: '31', name: '#31', family: 'MnZn', muInitial: 1500, note: 'common-mode chokes, 1 to 30 MHz' },
  { id: '43', name: '#43', family: 'NiZn', muInitial: 800, note: 'the general-purpose HF mix' },
  { id: '52', name: '#52', family: 'NiZn', muInitial: 250, note: 'lower loss than #43 on the higher bands' },
  { id: '61', name: '#61', family: 'NiZn', muInitial: 125, note: 'low loss, upper HF and VHF' },
  { id: '73', name: '#73', family: 'MnZn', muInitial: 2500, note: 'low-frequency suppression' },
  { id: '77', name: '#77', family: 'MnZn', muInitial: 2000, note: 'low bands and below' },
];

/** Typical saturation flux density for the family, tesla. A guide, not a rating. */
export const SATURATION_T: Record<FerriteFamily, number> = { NiZn: 0.3, MnZn: 0.45 };

export type Insulation = 'enamel' | 'ptfe' | 'pvc';

/** Wall thickness (mm) and relative permittivity typical of each covering. */
export const INSULATION: Record<Insulation, { wallMm: number; epsilon: number; label: string }> = {
  enamel: { wallMm: 0.035, epsilon: 3.5, label: 'enamelled' },
  ptfe: { wallMm: 0.3, epsilon: 2.1, label: 'PTFE-insulated' },
  pvc: { wallMm: 0.4, epsilon: 3.0, label: 'PVC-insulated' },
};

export interface Wire {
  id: string;
  name: string;
  /** Bare copper diameter, mm. */
  conductorMm: number;
  insulation: Insulation;
}

/** The AWG definition: 36 AWG is 0.005 inch, and 39 gauge steps span a ratio of 92. */
export function awgMm(gauge: number): number {
  return 0.127 * 92 ** ((36 - gauge) / 39);
}

const wire = (gauge: number, insulation: Insulation): Wire => ({
  id: `awg${gauge}-${insulation}`,
  name: `${gauge} AWG ${INSULATION[insulation].label} (${awgMm(gauge).toFixed(2)} mm)`,
  conductorMm: Number(awgMm(gauge).toFixed(3)),
  insulation,
});

export const WIRES: Wire[] = [
  wire(14, 'enamel'),
  wire(16, 'enamel'),
  wire(18, 'enamel'),
  wire(20, 'enamel'),
  wire(14, 'ptfe'),
  wire(16, 'ptfe'),
  wire(18, 'ptfe'),
  wire(18, 'pvc'),
];

export function wireOuterMm(w: Wire): number {
  return w.conductorMm + 2 * INSULATION[w.insulation].wallMm;
}

/** A ready-made transmission line: coaxial cable small enough to wind on a toroid. */
export interface Coax {
  id: string;
  name: string;
  z0: number;
  /** Dielectric constant of the insulation; the velocity factor is 1/sqrt of it. */
  epsilon: number;
  outerMm: number;
  innerConductorMm: number;
}

export const COAX: Coax[] = [
  { id: 'rg316', name: 'RG-316 (50 Ω, PTFE)', z0: 50, epsilon: 2.1, outerMm: 2.5, innerConductorMm: 0.51 },
  { id: 'rg174', name: 'RG-174 (50 Ω)', z0: 50, epsilon: 2.25, outerMm: 2.8, innerConductorMm: 0.48 },
  { id: 'rg400', name: 'RG-400 (50 Ω, PTFE)', z0: 50, epsilon: 2.1, outerMm: 4.95, innerConductorMm: 0.94 },
  { id: 'rg58', name: 'RG-58 (50 Ω)', z0: 50, epsilon: 2.25, outerMm: 5.0, innerConductorMm: 0.9 },
  { id: 'rg179', name: 'RG-179 (75 Ω, PTFE)', z0: 75, epsilon: 2.1, outerMm: 2.54, innerConductorMm: 0.3 },
];

export function coreById(id: string): CoreSize | undefined {
  return CORES.find((c) => c.id === id);
}
export function wireById(id: string): Wire | undefined {
  return WIRES.find((w) => w.id === id);
}
export function coaxById(id: string): Coax | undefined {
  return COAX.find((c) => c.id === id);
}
