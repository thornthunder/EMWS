// The radiation pattern as a surface: NEC's grid of gains over theta and phi turned into
// points in space, on the same ARRL log scale as the polar plots (the peak is 1, each 2 dB
// down shrinks the reach by 0.89). Pattern3D draws it.
//
// Public domain (The Unlicense). By ZR1JT.

import { mainLobe } from '../../engine/nec2/pattern';
import { NO_FIELD_DB, type RadiationPattern, type Vec3 } from '../../engine/nec2/types';
import { arrlRadius } from '../../ui/polar-scale';

/** Beyond this many rows or columns the grid is thinned, so dragging stays smooth. */
const MAX_GRID = 40;
export const FLOOR_DB = -40;

export interface PatternMesh {
  /** Unit-scaled points (the peak is 1), [theta index][phi index]. */
  grid: Vec3[][];
  /** Relative dB at each grid point, for shading. */
  relativeDb: number[][];
  /** Whether phi goes all the way round, so the last column joins the first. */
  wraps: boolean;
  peakDb: number;
  peakDirection: Vec3;
}

const direction = (thetaDeg: number, phiDeg: number): Vec3 => {
  const t = (thetaDeg * Math.PI) / 180;
  const p = (phiDeg * Math.PI) / 180;
  return { x: Math.sin(t) * Math.cos(p), y: Math.sin(t) * Math.sin(p), z: Math.cos(t) };
};

/** Every other value, until the list is small enough; the ends are kept. */
function thin(values: number[]): number[] {
  if (values.length <= MAX_GRID) return values;
  const step = Math.ceil(values.length / MAX_GRID);
  const kept = values.filter((_, i) => i % step === 0);
  if (kept[kept.length - 1] !== values[values.length - 1]) kept.push(values[values.length - 1]!);
  return kept;
}

/**
 * The pattern as a grid over theta and phi, or undefined when what was solved is only a
 * cut or two and there is no surface to draw.
 */
export function patternMesh(patterns: readonly RadiationPattern[]): PatternMesh | undefined {
  const gain = new Map<string, number>();
  let peakDb = -Infinity;
  let peak = { thetaDeg: 0, phiDeg: 0 };
  for (const p of patterns.flatMap((x) => x.points)) {
    gain.set(`${p.thetaDeg},${p.phiDeg}`, p.totalDb);
    if (p.totalDb > NO_FIELD_DB && p.totalDb > peakDb) {
      peakDb = p.totalDb;
      peak = p;
    }
  }
  if (!Number.isFinite(peakDb)) return undefined;
  const allThetas = [...new Set(patterns.flatMap((x) => x.points.map((p) => p.thetaDeg)))].sort((a, b) => a - b);
  const allPhis = [...new Set(patterns.flatMap((x) => x.points.map((p) => p.phiDeg)))].sort((a, b) => a - b);
  if (allThetas.length < 3 || allPhis.length < 3) return undefined;
  // Only a complete grid is a surface. Two crossed cuts share their angles with a sphere
  // but not their points, and joining them up would draw lobes nobody solved.
  if (gain.size < allThetas.length * allPhis.length) return undefined;

  const thetas = thin(allThetas);
  const phis = thin(allPhis);
  const step = allPhis[1]! - allPhis[0]!;
  const wraps = Math.abs(allPhis[allPhis.length - 1]! - allPhis[0]! + step - 360) < 1e-6;

  const grid: Vec3[][] = [];
  const relativeDb: number[][] = [];
  for (const t of thetas) {
    const row: Vec3[] = [];
    const rel: number[] = [];
    for (const p of phis) {
      const db = gain.get(`${t},${p}`);
      const relative = db === undefined || db <= NO_FIELD_DB ? -Infinity : db - peakDb;
      const r = arrlRadius(Math.max(relative, FLOOR_DB)) * (relative <= FLOOR_DB ? 0 : 1);
      const d = direction(t, p);
      row.push({ x: d.x * r, y: d.y * r, z: d.z * r });
      rel.push(relative);
    }
    grid.push(row);
    relativeDb.push(rel);
  }
  // The direction the peak-gain card names: mainLobe breaks ties towards the horizon, which
  // matters for a dipole, whose maximum is a whole ring.
  const lobe = mainLobe(patterns.flatMap((x) => x.points)) ?? peak;
  return { grid, relativeDb, wraps, peakDb, peakDirection: direction(lobe.thetaDeg, lobe.phiDeg) };
}

