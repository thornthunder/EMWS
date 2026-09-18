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
    const peak = peakOf(points);
    if (!peak) return [];
    return [
      { kind: 'azimuth', fixedDeg: peak.thetaDeg, points: points.filter((p) => p.thetaDeg === peak.thetaDeg) },
      { kind: 'elevation', fixedDeg: peak.phiDeg, points: points.filter((p) => p.phiDeg === peak.phiDeg) },
    ];
  }
  return [];
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
