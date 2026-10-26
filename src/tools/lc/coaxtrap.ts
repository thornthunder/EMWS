// A trap made of coax: a coil of coaxial cable with the inner conductor's near end joined
// to the shield's far end, so that the cable's own capacitance resonates the coil.
//
// Two things happen in the one piece of cable. Along the OUTSIDE of the shield it is simply
// a wire wound into a coil - N turns, inductance L by Wheeler as on the coil tab - carrying
// the trap current. INSIDE, inner conductor against shield, it is a length of transmission
// line: the catalogue cable, with its Z0, velocity factor and loss. The cross-connection
// puts that line between the coil's two ends, which is exactly the Ruthroff wiring of the
// balun tool with its input left open. Writing the end voltages and currents out, with the
// line as [A B; C D] and the coil as Zc, the trap across its ends is
//
//     Z = (A + D + 2 + B / Zc) / (C + A / Zc)
//
// For a short cable that is 4L across C/4 (plus the cable's own inductance, which the inner
// conductor's current threads too): the shield winding and the inner winding are in
// series aiding, so the flux links twice, while the cable's capacitance sees only half the
// trap voltage. Hence the familiar rule f0 = 1 / (2 pi sqrt(L C)) with L the single coil and
// C the WHOLE cable's capacitance - exact in that limit, and the full form above keeps what
// the rule drops: the cable's own inductance (the resonance sits lower by about
// (theta^2 / 6), theta the cable's electrical length) and both of its losses.
// tests/coaxtrap.test.ts holds it to those limits. Nothing here has met a bench yet.
//
// Public domain (The Unlicense). By ZR1JT.

import { type Complex, cAdd, cCosh, cDiv, cInv, cMul, cScale, cSinh, complex } from '../../lib/complex';
import type { Cable } from '../toolbox/coax';
import { C0, type CoilSpec, type QualityEstimate, coilImpedance, inductanceH, qualityEstimate, wireLengthM } from './coil';
import { gammaL } from './stub';
import type { TrapView } from './trap';

export interface CoaxTrapSpec {
  cable: Cable;
  /** Overall diameter of the cable over its jacket, mm: the pitch of a close-wound coil of it. */
  jacketMm: number;
  /** The pipe it is wound on, mm. */
  formerMm: number;
  turns: number;
  /** The coil's Q at the trap frequency - the braid's loss. The cable's own losses are in the line. */
  q: number;
}

/**
 * The cable as the coil tab would see it: a conductor the size of the braid, insulated out to
 * the jacket, close-wound. The braid is taken at the shield's inside diameter (a datasheet
 * cable has no geometry: 0.65 of the jacket, typical of the catalogue), which makes its
 * skin-effect resistance a little high and the Q estimate a little low - a braid is not a
 * smooth tube anyway, so that estimate is a ceiling.
 */
export function coilOf(spec: CoaxTrapSpec): CoilSpec {
  const braidMm = spec.cable.loss.kind === 'geometry' ? spec.cable.loss.geometry.dielectricMm : 0.65 * spec.jacketMm;
  const wireMm = Math.min(braidMm, spec.jacketMm);
  return { turns: spec.turns, formerMm: spec.formerMm, wireMm, wallMm: Math.max(0, (spec.jacketMm - wireMm) / 2), spacing: 1 };
}

/** Metres of cable in the coil. Strip the ends at the coil: cable beyond it adds capacitance that is not counted here. */
export function cableLengthM(spec: CoaxTrapSpec): number {
  return wireLengthM(coilOf(spec));
}

/** The cable's capacitance, inner to shield, over that length: 1 / (v Z0) per metre. */
export function cableCapacitanceF(spec: CoaxTrapSpec): number {
  return cableLengthM(spec) / (C0 * spec.cable.velocityFactor * spec.cable.z0);
}

/** The coil the outside of the shield makes, henries. */
export function coilInductanceH(spec: CoaxTrapSpec): number {
  return inductanceH(coilOf(spec));
}

/** The braid's Q range at a frequency, as the coil tab estimates a wire coil's. */
export function braidQuality(spec: CoaxTrapSpec, fMHz: number): QualityEstimate {
  return qualityEstimate(coilOf(spec), fMHz);
}

/** The trap across its two ends at one frequency. */
export function coaxTrapImpedance(spec: CoaxTrapSpec, fMHz: number): Complex {
  const henries = coilInductanceH(spec);
  if (!(henries > 0) || !(fMHz > 0)) return complex(0);
  const gl = gammaL(spec.cable, cableLengthM(spec), fMHz);
  const a = cCosh(gl);
  const sh = cSinh(gl);
  const b = cScale(sh, spec.cable.z0);
  const c = cScale(sh, 1 / spec.cable.z0);
  const yc = cInv(coilImpedance(henries, fMHz, spec.q));
  return cDiv(cAdd(cAdd(cAdd(a, a), complex(2)), cMul(b, yc)), cAdd(c, cMul(a, yc)));
}

/**
 * The trap's resonance, MHz: the first frequency where its susceptance crosses zero on the
 * way up - inductive below, capacitive above. A log scan finds the crossing, a bisection
 * pins it. 0 when there is none in range.
 */
export function coaxResonanceMHz(spec: CoaxTrapSpec, lowMHz = 0.1, highMHz = 1000): number {
  if (!(coilInductanceH(spec) > 0)) return 0;
  const susceptance = (f: number) => cInv(coaxTrapImpedance(spec, f)).im;
  const steps = 400;
  let prevF = lowMHz;
  let prevB = susceptance(lowMHz);
  for (let i = 1; i <= steps; i++) {
    const f = lowMHz * (highMHz / lowMHz) ** (i / steps);
    const b = susceptance(f);
    if (prevB < 0 && b >= 0) {
      let lo = prevF;
      let hi = f;
      for (let k = 0; k < 60; k++) {
        const mid = Math.sqrt(lo * hi);
        if (susceptance(mid) < 0) lo = mid;
        else hi = mid;
      }
      return Math.sqrt(lo * hi);
    }
    prevF = f;
    prevB = b;
  }
  return 0;
}

/** How many turns resonate at `f0MHz` with everything else fixed. Fractional: round it and say what the rounded coil does. */
export function turnsForCoaxTrap(f0MHz: number, base: Omit<CoaxTrapSpec, 'turns'>): number {
  if (!(f0MHz > 0)) return 0;
  const at = (turns: number) => coaxResonanceMHz({ ...base, turns });
  let low = 0.5;
  let high = 4;
  while (at(high) > f0MHz && high < 1e4) high *= 2;
  while (at(low) < f0MHz && low > 1e-3) low /= 2;
  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2;
    if (at(mid) > f0MHz) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

export interface LumpedEquivalent {
  f0MHz: number;
  henries: number;
  farads: number;
  /** The parallel loss resistance at resonance: the impedance across the trap there. */
  ohms: number;
  q: number;
  bandwidthMHz: number;
}

/**
 * The parallel R L C that behaves as the trap does about its resonance - the figures a
 * builder knows a trap by, and what the Antenna Modeler's LD 1 takes. A parallel RLC's
 * susceptance has slope 2C at resonance, so C comes from the slope and L from C.
 */
export function lumpedEquivalent(spec: CoaxTrapSpec): LumpedEquivalent | undefined {
  const f0MHz = coaxResonanceMHz(spec);
  if (!(f0MHz > 0)) return undefined;
  const w0 = 2 * Math.PI * f0MHz * 1e6;
  const admittance = (f: number) => cInv(coaxTrapImpedance(spec, f));
  const df = f0MHz * 1e-4;
  const slope = (admittance(f0MHz + df).im - admittance(f0MHz - df).im) / (2 * 2 * Math.PI * df * 1e6);
  const farads = slope / 2;
  const henries = 1 / (w0 * w0 * farads);
  const conductance = admittance(f0MHz).re;
  const ohms = conductance > 0 ? 1 / conductance : Infinity;
  const q = ohms / (w0 * henries);
  return { f0MHz, henries, farads, ohms, q, bandwidthMHz: Number.isFinite(q) && q > 0 ? f0MHz / q : 0 };
}

/** What the trap amounts to on some other band, from its exact impedance there. */
export function coaxTrapAt(spec: CoaxTrapSpec, fMHz: number, equivalent: LumpedEquivalent | undefined): TrapView {
  const z = coaxTrapImpedance(spec, fMHz);
  const w = 2 * Math.PI * fMHz * 1e6;
  if (equivalent && Math.abs(fMHz - equivalent.f0MHz) <= equivalent.bandwidthMHz / 2) return { fMHz, z, role: 'trap' };
  if (z.im > 0) return { fMHz, z, role: 'inductor', equivalentH: z.im / w };
  return { fMHz, z, role: 'capacitor', equivalentF: z.im < 0 ? -1 / (w * z.im) : 0 };
}
