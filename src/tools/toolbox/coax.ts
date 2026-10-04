// Coaxial cable: what a run of it costs, from its dimensions or from its datasheet.
//
// No manufacturer's attenuation table is copied here. A catalogue cable is its nominal
// dimensions (the MIL-C-17 type designations are a public standard) and its dielectric, and
// its loss is CALCULATED: conductor loss from the skin effect in smooth solid copper, and
// dielectric loss from the material's loss tangent. That is a floor. A real braided shield
// and a stranded centre conductor lose more, and how much more is not in the geometry, so
// the catalogue figure is labelled "at least", and a cable's own datasheet figures - two
// frequencies are enough - can be typed in instead and are then used exactly.

import { rhoFromSwr, swrFromRho } from '../../lib/rf';
import { C0, COPPER_OHM_M, MU0 } from '../lc/coil';

/** Impedance of free space, mu0 c: 376.73 ohms. */
export const ETA0 = MU0 * C0;
/** Nepers to decibels: 20 / ln 10. */
export const DB_PER_NEPER = 20 / Math.LN10;

export interface Dielectric {
  id: string;
  label: string;
  epsilon: number;
  /** Loss tangent, a textbook figure for the material class; makers' foams differ. */
  tanDelta: number;
}

export const DIELECTRICS: Dielectric[] = [
  { id: 'pe', label: 'Solid polyethylene', epsilon: 2.25, tanDelta: 3e-4 },
  { id: 'foam', label: 'Foamed polyethylene', epsilon: 1.5, tanDelta: 1.5e-4 },
  { id: 'ptfe', label: 'PTFE', epsilon: 2.1, tanDelta: 2e-4 },
  { id: 'air', label: 'Air', epsilon: 1, tanDelta: 0 },
];

export function dielectricById(id: string): Dielectric {
  return DIELECTRICS.find((d) => d.id === id) ?? DIELECTRICS[0]!;
}

export interface Geometry {
  /** Centre conductor diameter, mm (the overall diameter of a stranded bundle). */
  innerMm: number;
  /** Diameter over the dielectric = inner diameter of the shield, mm. */
  dielectricMm: number;
  dielectric: string;
}

export interface LossPoint {
  fMHz: number;
  dbPer100m: number;
}

export type LossModel = { kind: 'geometry'; geometry: Geometry } | { kind: 'datasheet'; points: [LossPoint, LossPoint] };

export interface Cable {
  id: string;
  name: string;
  /** For the picker: cables of a kind together. Absent on a datasheet cable. */
  group?: string;
  /** Nominal characteristic impedance, ohms. */
  z0: number;
  velocityFactor: number;
  loss: LossModel;
  note?: string;
}

export const velocityFactorOf = (epsilon: number): number => 1 / Math.sqrt(epsilon);

/** A cable's permittivity as its velocity factor implies: the figure its loss and Z0 are worked from. */
export const epsilonOf = (cable: Cable): number => 1 / (cable.velocityFactor * cable.velocityFactor);

const type = (group: string, id: string, name: string, z0: number, innerMm: number, dielectricMm: number, dielectric: string, velocityFactor?: number, note?: string): Cable => ({
  id,
  name,
  group,
  z0,
  velocityFactor: velocityFactor ?? velocityFactorOf(dielectricById(dielectric).epsilon),
  loss: { kind: 'geometry', geometry: { innerMm, dielectricMm, dielectric } },
  ...(note ? { note } : {}),
});

const LMR_NOTE = "Named as its maker names it. The dimensions and velocity factor are the published nominals; the loss is computed here, not taken from the maker's table, and a copper-clad centre is treated as copper.";

/**
 * The common types, by their nominal dimensions. Overall diameters in the names are for
 * recognising the cable in the hand. The RG types are MIL-C-17 designations; the LMR
 * series is listed by its maker's names because that is what people ask for; Mini 8 is a
 * class rather than a type and says so.
 */
export const CATALOGUE: Cable[] = [
  type('RG, 50 Ω', 'rg174', 'RG-174 (2.8 mm, 50 Ω)', 50, 0.48, 1.52, 'pe'),
  type('RG, 50 Ω', 'rg316', 'RG-316 (2.5 mm, 50 Ω, PTFE)', 50, 0.51, 1.52, 'ptfe'),
  type('RG, 50 Ω', 'rg58', 'RG-58 (5 mm, 50 Ω)', 50, 0.9, 2.95, 'pe'),
  type('RG, 50 Ω', 'rg142', 'RG-142 (5 mm, 50 Ω, PTFE)', 50, 0.94, 2.95, 'ptfe'),
  type('RG, 50 Ω', 'mini8', 'Mini 8 / RG-8X class (6.5 mm, 50 Ω, foam)', 50, 1.6, 4.7, 'foam', undefined, 'Not a MIL type: makers differ. Representative dimensions.'),
  type('RG, 50 Ω', 'rg213', 'RG-213 (10.3 mm, 50 Ω)', 50, 2.26, 7.24, 'pe'),
  type('LMR, 50 Ω', 'lmr195', 'LMR-195 (5 mm, 50 Ω, foam)', 50, 0.94, 2.79, 'foam', 0.83, LMR_NOTE),
  type('LMR, 50 Ω', 'lmr240', 'LMR-240 (6.1 mm, 50 Ω, foam)', 50, 1.42, 3.81, 'foam', 0.84, LMR_NOTE),
  type('LMR, 50 Ω', 'lmr400', 'LMR-400 (10.3 mm, 50 Ω, foam)', 50, 2.74, 7.24, 'foam', 0.85, LMR_NOTE),
  type('LMR, 50 Ω', 'lmr600', 'LMR-600 (15 mm, 50 Ω, foam)', 50, 4.47, 11.56, 'foam', 0.87, LMR_NOTE),
  type('RG, 75 Ω', 'rg59', 'RG-59 (6.1 mm, 75 Ω)', 75, 0.58, 3.7, 'pe'),
  type('RG, 75 Ω', 'rg6', 'RG-6 (6.9 mm, 75 Ω, foam)', 75, 1.02, 4.57, 'foam'),
  type('RG, 75 Ω', 'rg11', 'RG-11 (10.3 mm, 75 Ω)', 75, 1.2, 7.24, 'pe'),
];

/** The catalogue's groups, in order of first appearance, for an optgroup picker. */
export function catalogueGroups(): { group: string; cables: Cable[] }[] {
  const groups: { group: string; cables: Cable[] }[] = [];
  for (const cable of CATALOGUE) {
    const group = cable.group ?? 'Other';
    const found = groups.find((g) => g.group === group);
    if (found) found.cables.push(cable);
    else groups.push({ group, cables: [cable] });
  }
  return groups;
}

export function cableById(id: string): Cable | undefined {
  return CATALOGUE.find((c) => c.id === id);
}

/** Z0 of a coaxial geometry: (eta0 / 2 pi sqrt(epsilon)) ln(D / d), with the dielectric's generic permittivity unless given. */
export function characteristicImpedance(g: Geometry, epsilon = dielectricById(g.dielectric).epsilon): number {
  if (!(g.innerMm > 0) || !(g.dielectricMm > g.innerMm) || !(epsilon >= 1)) return NaN;
  return (ETA0 / (2 * Math.PI * Math.sqrt(epsilon))) * Math.log(g.dielectricMm / g.innerMm);
}

/** Surface resistance of a conductor at this frequency, sqrt(pi f mu0 rho), ohms. */
export function surfaceResistanceOhms(fMHz: number, rhoOhmM = COPPER_OHM_M): number {
  return Math.sqrt(Math.PI * fMHz * 1e6 * MU0 * rhoOhmM);
}

export interface MatchedLoss {
  /** The part that grows with sqrt(f): the conductors (or the datasheet fit's sqrt(f) term). */
  conductorDb: number;
  /** The part that grows with f: the dielectric (or the fit's f term). */
  dielectricDb: number;
  totalDb: number;
}

/** Fits a = k1 sqrt(f) + k2 f through two datasheet points, exactly. */
export function fitDatasheet(points: [LossPoint, LossPoint]): { k1: number; k2: number } | undefined {
  const [p, q] = points;
  if (!(p.fMHz > 0) || !(q.fMHz > 0) || p.fMHz === q.fMHz || !(p.dbPer100m >= 0) || !(q.dbPer100m >= 0)) return undefined;
  const sp = Math.sqrt(p.fMHz);
  const sq = Math.sqrt(q.fMHz);
  const det = sp * q.fMHz - sq * p.fMHz;
  return { k1: (p.dbPer100m * q.fMHz - q.dbPer100m * p.fMHz) / det, k2: (sp * q.dbPer100m - sq * p.dbPer100m) / det };
}

/** Matched loss per 100 m at a frequency: what the cable loses with a perfect load on it. */
export function matchedLossPer100m(cable: Cable, fMHz: number): MatchedLoss {
  if (!(fMHz > 0)) return { conductorDb: NaN, dielectricDb: NaN, totalDb: NaN };
  if (cable.loss.kind === 'datasheet') {
    const fit = fitDatasheet(cable.loss.points);
    if (!fit) return { conductorDb: NaN, dielectricDb: NaN, totalDb: NaN };
    const conductorDb = fit.k1 * Math.sqrt(fMHz);
    const dielectricDb = fit.k2 * fMHz;
    return { conductorDb, dielectricDb, totalDb: conductorDb + dielectricDb };
  }
  const g = cable.loss.geometry;
  const material = dielectricById(g.dielectric);
  // Series resistance per metre of the two conductors, each carrying the current in one skin depth.
  const rPerM = (surfaceResistanceOhms(fMHz) / Math.PI) * (1 / (g.innerMm / 1000) + 1 / (g.dielectricMm / 1000));
  const conductorDb = (rPerM / (2 * cable.z0)) * DB_PER_NEPER * 100;
  // The permittivity the cable's own velocity factor implies, with the material family's loss tangent.
  const dielectricDb = ((Math.PI * fMHz * 1e6 * Math.sqrt(epsilonOf(cable)) * material.tanDelta) / C0) * DB_PER_NEPER * 100;
  return { conductorDb, dielectricDb, totalDb: conductorDb + dielectricDb };
}

export interface RunLoss {
  /** Matched loss of this length, dB. */
  matchedDb: number;
  /** What the standing waves add, dB. */
  additionalDb: number;
  totalDb: number;
  /** The SWR the radio sees, which the cable's loss makes better than the antenna's. */
  radioSwr: number;
}

/**
 * Loss of a run with a mismatched load: the classic result for a line of matched loss
 * a (power ratio) feeding a load of reflection rho, total = (a^2 - rho^2) / (a (1 - rho^2)).
 * Every watt that goes in and does not reach the load is heat in the cable.
 */
export function runLoss(matchedDb: number, loadSwr: number): RunLoss {
  const rho = rhoFromSwr(loadSwr);
  const a = 10 ** (matchedDb / 10);
  if (!(matchedDb >= 0) || Number.isNaN(rho)) return { matchedDb: NaN, additionalDb: NaN, totalDb: NaN, radioSwr: NaN };
  const totalDb = rho >= 1 ? Infinity : 10 * Math.log10((a * a - rho * rho) / (a * (1 - rho * rho)));
  return { matchedDb, additionalDb: totalDb - matchedDb, totalDb, radioSwr: swrFromRho(rho / a) };
}

export function lossOfRun(cable: Cable, fMHz: number, lengthM: number, loadSwr = 1): RunLoss {
  return runLoss((matchedLossPer100m(cable, fMHz).totalDb * lengthM) / 100, loadSwr);
}

/** Where the power goes: what reaches the antenna, and what warms the cable. */
export function runPowers(totalDb: number, inputW: number): { deliveredW: number; heatW: number } {
  const deliveredW = Number.isFinite(totalDb) ? inputW * 10 ** (-totalDb / 10) : 0;
  return { deliveredW, heatW: inputW - deliveredW };
}
