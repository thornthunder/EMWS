// Turns the table from an RP card into the 2-D cuts hams actually look at.

import { NO_FIELD_DB, type PatternPoint, type RadiationPattern } from './types';

export interface PatternCut {
  /** 'azimuth': theta fixed, phi swept. 'elevation': phi fixed, theta swept. */
  kind: 'azimuth' | 'elevation';
  /** The angle held constant: theta for an azimuth cut, phi for an elevation cut. */
  fixedDeg: number;
  points: PatternPoint[];
}

export function peakOf(points: readonly PatternPoint[]): PatternPoint | undefined {
  let best: PatternPoint | undefined;
  for (const p of points) {
    if (p.totalDb <= NO_FIELD_DB) continue;
    if (!best || p.totalDb > best.totalDb) best = p;
  }
  return best;
}

/**
 * An RP card sweeping one angle is already a cut. A full theta x phi grid yields the
 * two principal cuts through the direction of maximum gain.
 */
export function cutsOf(pattern: RadiationPattern): PatternCut[] {
  const { points } = pattern;
  const thetas = new Set(points.map((p) => p.thetaDeg));
  const phis = new Set(points.map((p) => p.phiDeg));

  if (thetas.size === 1 && phis.size > 1) {
    return [{ kind: 'azimuth', fixedDeg: points[0]?.thetaDeg ?? 0, points }];
  }
  if (phis.size === 1 && thetas.size > 1) {
    return [{ kind: 'elevation', fixedDeg: points[0]?.phiDeg ?? 0, points }];
  }
  if (thetas.size > 1 && phis.size > 1) {
    let lobe = mainLobe(points);
    if (!lobe) return [];
    // Straight up (a low dipole over ground, say) every azimuth is the same direction, so
    // cut the azimuth pattern at the strongest ring below the zenith instead.
    if (isPole(lobe)) lobe = mainLobe(points.filter((p) => !isPole(p))) ?? lobe;
    return [azimuthCut(points, lobe.thetaDeg), elevationCut(points, lobe.phiDeg)];
  }
  return [];
}

const same = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** Straight up or straight down, where azimuth means nothing. */
function isPole(p: PatternPoint): boolean {
  return Math.abs(Math.sin((p.thetaDeg * Math.PI) / 180)) < 1e-9;
}

/**
 * The direction of maximum gain. Where several directions share the maximum (a dipole
 * radiates equally all round its broadside plane), the one nearest the horizon wins,
 * and a pole only when it is strictly the maximum.
 */
export function mainLobe(points: readonly PatternPoint[]): PatternPoint | undefined {
  const peak = peakOf(points);
  if (!peak) return undefined;
  let best: PatternPoint | undefined;
  for (const p of points) {
    if (p.totalDb !== peak.totalDb || isPole(p)) continue;
    if (!best || Math.abs(elevationOfTheta(p.thetaDeg)) < Math.abs(elevationOfTheta(best.thetaDeg))) best = p;
  }
  return best ?? peak;
}

/** The ring of a grid at one elevation, closed back to its start when it goes all the way round. */
function azimuthCut(points: readonly PatternPoint[], thetaDeg: number): PatternCut {
  const ring = points.filter((p) => same(p.thetaDeg, thetaDeg)).sort((a, b) => a.phiDeg - b.phiDeg);
  const first = ring[0];
  const second = ring[1];
  const last = ring[ring.length - 1];
  if (first && second && last) {
    const step = second.phiDeg - first.phiDeg;
    if (same(last.phiDeg + step, first.phiDeg + 360)) ring.push({ ...first, phiDeg: first.phiDeg + 360 });
  }
  return { kind: 'azimuth', fixedDeg: thetaDeg, points: ring };
}

/**
 * The vertical plane at one azimuth. A grid stores it as two half-planes, at phi and
 * phi + 180°; the far half is folded in with negative theta, as an RP card sweeping
 * theta through negative values would give it.
 */
function elevationCut(points: readonly PatternPoint[], phiDeg: number): PatternCut {
  const opposite = (phiDeg + 180) % 360;
  const near = points.filter((p) => same(p.phiDeg, phiDeg));
  const far = points
    .filter((p) => same(p.phiDeg % 360, opposite) && p.thetaDeg > 0)
    .map((p) => ({ ...p, thetaDeg: -p.thetaDeg, phiDeg }));
  const plane = [...far, ...near].sort((a, b) => a.thetaDeg - b.thetaDeg);
  return { kind: 'elevation', fixedDeg: phiDeg, points: plane };
}

/** Elevation above the horizon (negative below it) for a NEC theta, which may run past 180. */
export function elevationOfTheta(thetaDeg: number): number {
  const wrapped = ((((thetaDeg + 180) % 360) + 360) % 360) - 180; // into [-180, 180)
  return 90 - Math.abs(wrapped);
}

function angularDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Front-to-back ratio in dB from an azimuth cut: peak gain over the gain 180 degrees away. */
export function frontToBackDb(cut: PatternCut): number | undefined {
  if (cut.kind !== 'azimuth') return undefined;
  const peak = peakOf(cut.points);
  if (!peak) return undefined;
  const behind = peak.phiDeg + 180;
  let back: PatternPoint | undefined;
  for (const p of cut.points) {
    if (!back || angularDistance(p.phiDeg, behind) < angularDistance(back.phiDeg, behind)) back = p;
  }
  // Only meaningful if the cut actually reaches round to the back.
  if (!back || angularDistance(back.phiDeg, behind) > 5) return undefined;
  return back.totalDb <= NO_FIELD_DB ? Infinity : peak.totalDb - back.totalDb;
}
