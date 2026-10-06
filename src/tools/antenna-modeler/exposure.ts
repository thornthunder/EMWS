// RF exposure: the field strength around your antenna at your power, on a plan view.
//
// NEC-2 computes the near field at any point from the currents it solved (NE cards for
// the electric field, NH for the magnetic), so the same model that gives the SWR gives the
// field where people stand. This module writes the deck that asks for a grid of points on a
// horizontal plane, scales what comes back to the power you actually transmit, and marks
// where the reading stops being trustworthy.
//
// Three facts the arithmetic rests on:
//
//   - nec2c prints PEAK phasors, and its input power is the average ½ Re(V I*) - the same
//     convention ratings.ts deals with. A time-harmonic field's RMS magnitude is
//     sqrt(½ (|Ex|² + |Ey|² + |Ez|²)): the phases do not enter, so only magnitudes are used.
//   - Fields scale with the square root of power. The power that matters for exposure is
//     the AVERAGE over the regulator's averaging time: transmitter power × the mode's duty
//     × the share of that time spent transmitting.
//   - The thin-wire model is least reliable right beside a wire. Points closer to any wire
//     than one of its segments' lengths are greyed out: a cautious rule of EMWS's own, not a
//     published figure, and the guide says so.
//
// EMWS states no exposure limits. You type your regulator's figure; the map shows where
// the field crosses it.
//
// Public domain (The Unlicense). By ZR1JT.

import { formatCard } from '../../engine/nec2/cards';
import type { FrequencyResult, NearFieldPoint, Segment, Vec3 } from '../../engine/nec2/types';
import { modelToDeck } from './deck';
import type { AntennaModel } from './model';

/** Impedance of free space, ohms: for the plane-wave-equivalent power density E² / η0. */
export const ETA0 = 4e-7 * Math.PI * 299_792_458;

export interface ExposureGrid {
  /** Centre of the map, metres. */
  centreX: number;
  centreY: number;
  /** The map runs this far either side of the centre, in X and in Y. */
  halfWidthM: number;
  /** Height of the plane, metres (above the ground when there is one). */
  heightM: number;
  /** Points along each side: odd, so the centre is one of them. */
  points: number;
}

export const DEFAULT_GRID_POINTS = 41;
/** Head height of a standing adult, roughly: where an assessment usually looks first. */
export const DEFAULT_HEIGHT_M = 2;

/** A map centred on the antenna's footprint, wide enough to reach well beyond it. */
export function suggestedGrid(model: AntennaModel): ExposureGrid {
  const ends = model.wires.flatMap((w) => [w.a, w.b]);
  const xs = ends.map((p) => p.x);
  const ys = ends.map((p) => p.y);
  const zs = ends.map((p) => p.z);
  const minX = Math.min(...xs, 0);
  const maxX = Math.max(...xs, 0);
  const minY = Math.min(...ys, 0);
  const maxY = Math.max(...ys, 0);
  const footprint = Math.max(maxX - minX, maxY - minY) / 2;
  // Round the reach up to a tidy figure: 5, 10, 15, 20, 30, 40, 50 m...
  const reach = Math.max(5, footprint * 1.6 + 3);
  const steps = [5, 10, 15, 20, 30, 40, 50, 75, 100, 150, 200];
  const halfWidthM = steps.find((s) => s >= reach) ?? Math.ceil(reach / 50) * 50;
  const free = model.ground.kind === 'free-space';
  return {
    centreX: Number(((minX + maxX) / 2).toFixed(2)),
    centreY: Number(((minY + maxY) / 2).toFixed(2)),
    halfWidthM,
    // In free space there is no ground to stand on: look through the middle of the antenna.
    heightM: free ? Number(((Math.min(...zs) + Math.max(...zs)) / 2 || 0).toFixed(2)) : DEFAULT_HEIGHT_M,
    points: DEFAULT_GRID_POINTS,
  };
}

const odd = (n: number) => {
  const whole = Math.max(3, Math.round(n));
  return whole % 2 === 1 ? whole : whole + 1;
};

/** The deck: the model at one frequency, then one NE and one NH card over the same grid. */
export function exposureDeck(model: AntennaModel, fMHz: number, grid: ExposureGrid): string {
  const n = odd(grid.points);
  const step = (2 * grid.halfWidthM) / (n - 1);
  const x0 = grid.centreX - grid.halfWidthM;
  const y0 = grid.centreY - grid.halfWidthM;
  const fields = [0, n, n, 1];
  const where = [x0, y0, grid.heightM, step, step, 0];
  const cards = [formatCard('NE', fields, where), formatCard('NH', fields, where)];
  return modelToDeck({
    ...model,
    frequency: { startMHz: fMHz, stepMHz: 0, steps: 1 },
    // The model's own execution cards would run too, and their tables would merge into this grid.
    extraCards: model.extraCards.filter((c) => !/^(NE|NH|RP|XQ)\b/i.test(c.trim())),
    pattern: { kind: 'cards', cards },
  });
}

/** RMS magnitude of a near-field point: sqrt(½ Σ |component|²), from nec2c's peak phasors. */
export function rmsMagnitude(p: NearFieldPoint): number {
  const [a, b, c] = p.components;
  return Math.sqrt((a.magnitude ** 2 + b.magnitude ** 2 + c.magnitude ** 2) / 2);
}

/** The power that sets the exposure: transmitter × mode duty × share of the time on air. */
export function averagePowerW(txW: number, dutyShare: number, onAirShare: number): number {
  return Math.max(0, txW) * Math.min(1, Math.max(0, dutyShare)) * Math.min(1, Math.max(0, onAirShare));
}

/** What multiplies NEC's fields (solved at its own input power) to give them at this average power. */
export function fieldScale(nec2InputW: number, averageW: number): number {
  return nec2InputW > 0 ? Math.sqrt(averageW / nec2InputW) : NaN;
}

/** Shortest distance from a point to a straight segment, metres. */
export function distanceToSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const ap = { x: p.x - a.x, y: p.y - a.y, z: p.z - a.z };
  const len2 = ab.x * ab.x + ab.y * ab.y + ab.z * ab.z;
  const t = len2 > 0 ? Math.min(1, Math.max(0, (ap.x * ab.x + ap.y * ab.y + ap.z * ab.z) / len2)) : 0;
  const d = { x: ap.x - ab.x * t, y: ap.y - ab.y * t, z: ap.z - ab.z * t };
  return Math.hypot(d.x, d.y, d.z);
}

export interface ExposureCell {
  x: number;
  y: number;
  z: number;
  /** Electric field, V/m RMS, at the average power. */
  eRms: number;
  /** Magnetic field, A/m RMS, at the average power. */
  hRms: number;
  /** Distance to the nearest wire, metres. */
  wireDistanceM: number;
  /** Closer to a wire than one of its segments: shown, but not trusted. */
  tooClose: boolean;
}

export interface ExposureMap {
  cells: ExposureCell[];
  /** Points along a side; cells are in nec2c's order, X fastest. */
  points: number;
  scale: number;
  averageW: number;
}

/** The grid at the average power, with every cell's distance to the antenna worked out. */
export function exposureMap(result: FrequencyResult, segments: readonly Segment[], averageW: number): ExposureMap | undefined {
  const e = result.nearElectric;
  const h = result.nearMagnetic;
  const inputW = result.power?.inputW;
  if (!e || !h || e.length === 0 || e.length !== h.length || inputW === undefined) return undefined;
  const scale = fieldScale(inputW, averageW);
  const cells = e.map((pe, i): ExposureCell => {
    const ph = h[i]!;
    const p = { x: pe.x, y: pe.y, z: pe.z };
    let wireDistanceM = Infinity;
    let tooClose = false;
    for (const s of segments) {
      const d = distanceToSegment(p, s.start, s.end);
      if (d < wireDistanceM) wireDistanceM = d;
      if (d < Math.max(s.length, 3 * s.radius)) tooClose = true;
    }
    return { ...p, eRms: rmsMagnitude(pe) * scale, hRms: rmsMagnitude(ph) * scale, wireDistanceM, tooClose };
  });
  return { cells, points: Math.round(Math.sqrt(cells.length)), scale, averageW };
}

export type Quantity = 'e' | 'h';
export const valueOf = (cell: ExposureCell, q: Quantity): number => (q === 'e' ? cell.eRms : cell.hRms);

export interface ExposureVerdict {
  /** The highest trusted value on the map. */
  peak: number;
  /** Cells over the limit, of the trusted ones. */
  overCount: number;
  trustedCount: number;
  /** The farthest any over-limit point sits from a wire, metres; 0 when nothing is over. */
  reachM: number;
  /** An over-limit cell lies on the map's edge: the region may continue beyond it. */
  overAtEdge: boolean;
}

/** Where the trusted cells cross the typed limit, and how far from the antenna that reaches. */
export function verdict(map: ExposureMap, q: Quantity, limit: number | undefined): ExposureVerdict {
  const n = map.points;
  let peak = 0;
  let overCount = 0;
  let trustedCount = 0;
  let reachM = 0;
  let overAtEdge = false;
  map.cells.forEach((cell, i) => {
    if (cell.tooClose) return;
    trustedCount += 1;
    const v = valueOf(cell, q);
    if (v > peak) peak = v;
    if (limit !== undefined && limit > 0 && v > limit) {
      overCount += 1;
      reachM = Math.max(reachM, cell.wireDistanceM);
      const col = i % n;
      const row = Math.floor(i / n);
      if (col === 0 || row === 0 || col === n - 1 || row === n - 1) overAtEdge = true;
    }
  });
  return { peak, overCount, trustedCount, reachM, overAtEdge };
}
