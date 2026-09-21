// The three orthographic views, laid out in first-angle projection (ISO 128 / SANS 10111):
//
//   ┌────────────┬────────────┐
//   │ Front  X-Z │ Left   Y-Z │   the view from the left is drawn to the RIGHT of the front view
//   ├────────────┼────────────┤
//   │ Top    X-Y │    3-D     │   the view from above is drawn BELOW it
//   └────────────┴────────────┘
//
// The front view looks along +Y; the left view looks along +X, from the -X side; the top
// view looks down. Every view shares one camera (scale and centre), so rows share Z and
// columns share X, exactly as on a drawing.

import type { Vec3 } from '../../../engine/nec2/types';
import type { Axis } from '../../../lib/vec3';

export type Plane = 'front' | 'left' | 'top';

export interface PlaneSpec {
  title: string;
  /** Horizontal screen axis, and its direction (-1: the axis points to the left). */
  u: Axis;
  uSign: 1 | -1;
  /** Vertical screen axis, pointing up. */
  v: Axis;
  /** The axis you are looking along. */
  depth: Axis;
  /** Larger values are further from the viewer. */
  farness: (p: Vec3) => number;
}

export const PLANES: Record<Plane, PlaneSpec> = {
  front: { title: 'Front', u: 'x', uSign: 1, v: 'z', depth: 'y', farness: (p) => p.y },
  left: { title: 'Left', u: 'y', uSign: -1, v: 'z', depth: 'x', farness: (p) => p.x },
  top: { title: 'Top', u: 'x', uSign: 1, v: 'y', depth: 'z', farness: (p) => -p.z },
};

export interface Camera {
  /** World point at the centre of every view. */
  center: Vec3;
  /** Screen pixels per metre. */
  scale: number;
}

export interface Size {
  width: number;
  height: number;
}

export function toScreen(p: Vec3, plane: Plane, camera: Camera, size: Size): [number, number] {
  const s = PLANES[plane];
  return [
    size.width / 2 + s.uSign * (p[s.u] - camera.center[s.u]) * camera.scale,
    size.height / 2 - (p[s.v] - camera.center[s.v]) * camera.scale,
  ];
}

/** The world point under a screen position; the depth coordinate is supplied by the caller. */
export function toWorld(sx: number, sy: number, depth: number, plane: Plane, camera: Camera, size: Size): Vec3 {
  const s = PLANES[plane];
  const p: Vec3 = { x: 0, y: 0, z: 0 };
  p[s.u] = camera.center[s.u] + (s.uSign * (sx - size.width / 2)) / camera.scale;
  p[s.v] = camera.center[s.v] - (sy - size.height / 2) / camera.scale;
  p[s.depth] = depth;
  return p;
}

/** Zooms by `factor`, keeping the world point under screen position (sx, sy) where it is. */
export function zoomAt(camera: Camera, plane: Plane, size: Size, sx: number, sy: number, factor: number): Camera {
  const scale = Math.min(1e6, Math.max(1e-3, camera.scale * factor));
  const s = PLANES[plane];
  const before = toWorld(sx, sy, 0, plane, camera, size);
  const after = toWorld(sx, sy, 0, plane, { ...camera, scale }, size);
  const center = { ...camera.center };
  center[s.u] += before[s.u] - after[s.u];
  center[s.v] += before[s.v] - after[s.v];
  return { center, scale };
}

/** Moves the camera by a screen displacement, as if dragging the drawing. */
export function panBy(camera: Camera, plane: Plane, dx: number, dy: number): Camera {
  const s = PLANES[plane];
  const center = { ...camera.center };
  center[s.u] -= (s.uSign * dx) / camera.scale;
  center[s.v] += dy / camera.scale;
  return { ...camera, center };
}

/** The smallest 1, 2 or 5 × 10^n that is at least `minimum`. */
export function niceStep(minimum: number): number {
  const exponent = Math.floor(Math.log10(minimum));
  const base = 10 ** exponent;
  for (const m of [1, 2, 5, 10]) {
    if (m * base >= minimum) return Number((m * base).toPrecision(12));
  }
  return 10 * base;
}

/** Grid spacing for the current zoom: lines about every 50 pixels. */
export function gridStep(camera: Camera): number {
  return niceStep(50 / camera.scale);
}

export function snapValue(value: number, step: number): number {
  return Number((Math.round(value / step) * step).toPrecision(12));
}

export function formatLength(metres: number): string {
  const abs = Math.abs(metres);
  if (abs !== 0 && abs < 0.01) return `${Number((metres * 1000).toPrecision(4))} mm`;
  if (abs !== 0 && abs < 1) return `${Number((metres * 100).toPrecision(4))} cm`;
  return `${Number(metres.toPrecision(6))} m`;
}

const MARGIN = 28;

/** Camera that shows every point in all three views. */
export function fitCamera(points: readonly Vec3[], size: Size, fallbackSpan: number): Camera {
  if (points.length === 0 || size.width <= 0 || size.height <= 0) {
    return { center: { x: 0, y: 0, z: 0 }, scale: Math.max(1, Math.min(size.width, size.height) - 2 * MARGIN) / fallbackSpan };
  }
  const lo = { x: Infinity, y: Infinity, z: Infinity };
  const hi = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of points) {
    for (const axis of ['x', 'y', 'z'] as const) {
      lo[axis] = Math.min(lo[axis], p[axis]);
      hi[axis] = Math.max(hi[axis], p[axis]);
    }
  }
  const span = { x: hi.x - lo.x, y: hi.y - lo.y, z: hi.z - lo.z };
  const width = Math.max(1, size.width - 2 * MARGIN);
  const height = Math.max(1, size.height - 2 * MARGIN);
  let scale = Infinity;
  for (const plane of Object.values(PLANES)) {
    if (span[plane.u] > 0) scale = Math.min(scale, width / span[plane.u]);
    if (span[plane.v] > 0) scale = Math.min(scale, height / span[plane.v]);
  }
  if (!Number.isFinite(scale)) scale = Math.min(width, height) / fallbackSpan;
  return {
    center: { x: (lo.x + hi.x) / 2, y: (lo.y + hi.y) / 2, z: (lo.z + hi.z) / 2 },
    scale,
  };
}
