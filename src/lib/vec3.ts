// Small 3-D vector toolkit. Points are plain {x, y, z} objects and are never mutated.

import type { Vec3 } from '../engine/nec2/types';

export type Axis = 'x' | 'y' | 'z';

export const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };

export function vec(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a: Vec3, k: number): Vec3 {
  return { x: a.x * k, y: a.y * k, z: a.z * k };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function length(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Sum of the absolute coordinate differences: the distance nec2c uses to join wire ends. */
export function manhattan(a: Vec3, b: Vec3): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z);
}

export function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

export function withAxis(p: Vec3, axis: Axis, value: number): Vec3 {
  return { ...p, [axis]: value };
}

/** Rounds away floating-point dust, so 0.1 + 0.2 reads as 0.3 in a card deck and an input box. */
export function tidy(value: number): number {
  return value === 0 ? 0 : Number(value.toPrecision(12));
}

export function tidyVec(p: Vec3): Vec3 {
  return { x: tidy(p.x), y: tidy(p.y), z: tidy(p.z) };
}

/** Parameter t in [0, 1] of the point on segment a-b closest to p. */
export function closestParameter(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a);
  const lengthSq = dot(ab, ab);
  if (lengthSq === 0) return 0;
  return Math.min(1, Math.max(0, dot(sub(p, a), ab) / lengthSq));
}

export interface SegmentApproach {
  distance: number;
  /** Parameters of the closest points along each segment, in [0, 1]. */
  s: number;
  t: number;
}

/** Closest approach of segments p1-q1 and p2-q2 (Ericson, Real-Time Collision Detection, 5.1.9). */
export function segmentApproach(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3): SegmentApproach {
  const d1 = sub(q1, p1);
  const d2 = sub(q2, p2);
  const r = sub(p1, p2);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  const clamp = (v: number) => Math.min(1, Math.max(0, v));

  let s: number;
  let t: number;
  if (a === 0 && e === 0) {
    s = 0;
    t = 0;
  } else if (a === 0) {
    s = 0;
    t = clamp(f / e);
  } else {
    const c = dot(d1, r);
    if (e === 0) {
      t = 0;
      s = clamp(-c / a);
    } else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      s = denom !== 0 ? clamp((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a);
      }
    }
  }
  const c1 = add(p1, scale(d1, s));
  const c2 = add(p2, scale(d2, t));
  return { distance: distance(c1, c2), s, t };
}
