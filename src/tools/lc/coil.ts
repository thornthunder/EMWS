// Air-cored single-layer coils: the inductor you wind yourself.
//
// Inductance is Wheeler's 1982 formula for a single-layer solenoid, which holds for any
// shape from a short fat coil to a long thin one. The tests check it against his
// better-known 1928 formula over the range where that one is specified (within 1% for
// coils at least 0.4 diameters long) and against the ideal long solenoid.
//
// Loss is where honesty matters. The resistance here is the skin effect in an isolated
// round copper wire, and that is an UPPER BOUND on Q: neighbouring turns crowd each
// other's current too (the proximity effect), and in a long close-wound coil that
// multiplies the resistance by about 3.4 (Medhurst, 1947). Spacing the turns brings it
// back towards 1. The tool shows both ends of that range and lets a measured Q replace
// them. Self-resonance is bounded the same way: a coil cannot resonate higher than the
// frequency at which its wire is half a wavelength long, and short fat coils resonate
// well below that.
//
// Public domain (The Unlicense). By ZR1JT.

export const MU0 = 4e-7 * Math.PI;
export const C0 = 299792458;
export const COPPER_OHM_M = 1.68e-8;
/** Medhurst's resistance factor for a long, close-wound coil relative to the same wire straight. */
export const CLOSE_WOUND_PROXIMITY = 3.4;

export interface CoilSpec {
  turns: number;
  /** Inside diameter of the winding - the former it is wound on - in mm. */
  formerMm: number;
  /** Bare copper diameter, mm. */
  wireMm: number;
  /** Insulation wall, mm; 0 for bare wire. */
  wallMm: number;
  /** Turn pitch as a multiple of the wire's outside diameter; 1 is close-wound. */
  spacing: number;
}

export function wireOuterMm(spec: CoilSpec): number {
  return spec.wireMm + 2 * spec.wallMm;
}

export function pitchMm(spec: CoilSpec): number {
  return Math.max(1, spec.spacing) * wireOuterMm(spec);
}

/** The diameter the current flows on: the former plus one wire. */
export function meanDiameterMm(spec: CoilSpec): number {
  return spec.formerMm + wireOuterMm(spec);
}

export function windingLengthMm(spec: CoilSpec): number {
  return spec.turns * pitchMm(spec);
}

/** Metres of wire in the coil: N turns of a helix. */
export function wireLengthM(spec: CoilSpec): number {
  const turn = Math.PI * meanDiameterMm(spec);
  return (spec.turns * Math.hypot(turn, pitchMm(spec))) / 1000;
}

/** Wheeler's 1982 formula, henries. */
export function inductanceH(spec: CoilSpec): number {
  const a = meanDiameterMm(spec) / 2000;
  const b = windingLengthMm(spec) / 1000;
  const n = spec.turns;
  if (n <= 0 || a <= 0 || b <= 0) return 0;
  const shape = b / a;
  return MU0 * n * n * a * (Math.log(1 + Math.PI / shape) + 1 / (2.3 + 1.6 * shape + 0.44 * shape * shape));
}

/** Wheeler's 1928 formula, henries: within 1% for coils at least 0.4 diameters long. Kept for the tests. */
export function wheeler1928H(spec: CoilSpec): number {
  const r = meanDiameterMm(spec) / 2000;
  const l = windingLengthMm(spec) / 1000;
  const n = spec.turns;
  if (n <= 0 || r <= 0) return 0;
  return ((39.37 * r * r * n * n) / (9 * r + 10 * l)) * 1e-6;
}

/** How far current reaches into copper at this frequency, metres. */
export function skinDepthM(fMHz: number): number {
  return Math.sqrt(COPPER_OHM_M / (Math.PI * fMHz * 1e6 * MU0));
}

/** Ohms per metre of round copper wire at radio frequency, skin effect only. */
export function copperOhmsPerM(conductorMm: number, fMHz: number): number {
  const d = conductorMm / 1000;
  const skin = skinDepthM(fMHz);
  const area = skin < d / 2 ? Math.PI * (d * skin - skin * skin) : (Math.PI * d * d) / 4;
  return COPPER_OHM_M / area;
}

/** The coil's series resistance with the wire treated as if it were straight, ohms. */
export function wireResistanceOhms(spec: CoilSpec, fMHz: number): number {
  return wireLengthM(spec) * copperOhmsPerM(spec.wireMm, fMHz);
}

export function reactanceOhms(henries: number, fMHz: number): number {
  return 2 * Math.PI * fMHz * 1e6 * henries;
}

export interface QualityEstimate {
  /** Skin effect alone: the most this wire can give. */
  upper: number;
  /** A long close-wound coil, by Medhurst's factor. Spaced turns land between the two. */
  closeWound: number;
}

export function qualityEstimate(spec: CoilSpec, fMHz: number): QualityEstimate {
  const r = wireResistanceOhms(spec, fMHz);
  const upper = r > 0 ? reactanceOhms(inductanceH(spec), fMHz) / r : 0;
  return { upper, closeWound: upper / CLOSE_WOUND_PROXIMITY };
}

/** The coil cannot resonate on its own above this: its wire is half a wavelength long here. */
export function selfResonanceBoundMHz(spec: CoilSpec): number {
  const wire = wireLengthM(spec);
  return wire > 0 ? C0 / (2 * wire) / 1e6 : Infinity;
}

/**
 * How many turns give `henries` with everything else fixed. Fractional, so the caller can
 * round and say what the rounded coil really is. Inductance rises monotonically with
 * turns at fixed pitch, so a bisection finds it.
 */
export function turnsFor(henries: number, base: Omit<CoilSpec, 'turns'>): number {
  if (!(henries > 0)) return 0;
  let low = 0.25;
  let high = 4;
  const at = (turns: number) => inductanceH({ ...base, turns });
  while (at(high) < henries && high < 1e5) high *= 2;
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2;
    if (at(mid) < henries) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/** A coil as an impedance: R + jX, with R set by whatever Q the caller trusts. */
export function coilImpedance(henries: number, fMHz: number, q: number): { re: number; im: number } {
  const x = reactanceOhms(henries, fMHz);
  return { re: q > 0 ? x / q : 0, im: x };
}
