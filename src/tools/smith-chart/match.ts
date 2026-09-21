// Works out the L networks that match a load to the system impedance at one frequency.
//
// Two components can match any load whose resistance differs from the target: either a
// series part next to the load and a shunt part next to the radio, or the other way
// round. Each arrangement has two answers (one using an inductor where the other uses a
// capacitor), so you get up to four, and you pick by what you have in the junk box.

import type { Complex } from '../../lib/complex';
import { type Element, newElementId } from './model';

/** An L match is built from inductors and capacitors only. */
type ReactivePart = Extract<Element, { kind: 'inductor' | 'capacitor' }>;

export interface MatchSolution {
  id: string;
  /** "Series L, then shunt C" and so on. */
  name: string;
  /** Low-pass networks also keep harmonics down; high-pass ones block DC. */
  character: 'low-pass' | 'high-pass' | 'mixed';
  /** In chain order: the load comes first. */
  elements: Element[];
}

function componentFor(reactanceOhms: number, connection: 'series' | 'shunt', fMHz: number): ReactivePart | undefined {
  const omega = 2 * Math.PI * fMHz * 1e6;
  if (!Number.isFinite(reactanceOhms) || Math.abs(reactanceOhms) < 1e-9 || omega <= 0) return undefined;
  return reactanceOhms > 0
    ? { id: newElementId(), kind: 'inductor', connection, henries: reactanceOhms / omega }
    : { id: newElementId(), kind: 'capacitor', connection, farads: -1 / (omega * reactanceOhms) };
}

function describe(elements: ReactivePart[]): { name: string; character: MatchSolution['character'] } {
  const part = (e: ReactivePart) =>
    `${e.connection === 'series' ? 'series' : 'shunt'} ${e.kind === 'inductor' ? 'L' : 'C'}`;
  const name = elements.map(part).join(', then ');
  const kinds = elements.map((e) => e.kind);
  const series = elements.find((e) => e.connection === 'series');
  const character =
    kinds[0] === kinds[1] ? 'mixed'
    : series?.kind === 'inductor' ? 'low-pass'
    : 'high-pass';
  return { name: name.charAt(0).toUpperCase() + name.slice(1), character };
}

/**
 * Every two-component L match for `zLoad` at `fMHz`, against a real system impedance.
 * The list is empty when the load needs no match, or when its resistance is zero.
 */
export function lMatchSolutions(zLoad: Complex, z0: number, fMHz: number): MatchSolution[] {
  const r = zLoad.re;
  const x = zLoad.im;
  if (!(r > 0) || !Number.isFinite(x) || !(z0 > 0) || !(fMHz > 0)) return [];

  const solutions: MatchSolution[] = [];
  const add = (parts: (ReactivePart | undefined)[]) => {
    const elements = parts.filter((e): e is ReactivePart => e !== undefined);
    if (elements.length === 0) return;
    const { name, character } = describe(elements);
    solutions.push({ id: `${name}-${solutions.length}`, name, character, elements });
  };

  // A load already on the right circle needs only one component: a series part when its
  // resistance is already the system impedance, a shunt part when its conductance is.
  const denom = r * r + x * x;
  const conductance = r / denom;
  const susceptance = -x / denom;
  if (Math.abs(r - z0) < 1e-6 * z0 && Math.abs(x) > 1e-9) {
    add([componentFor(-x, 'series', fMHz)]);
  }
  if (Math.abs(conductance - 1 / z0) < 1e-6 / z0 && Math.abs(susceptance) > 1e-12) {
    add([componentFor(1 / susceptance, 'shunt', fMHz)]);
  }

  // A: a series part at the load brings the resistance seen through it to z0, then a
  // shunt part cancels what is left. Needs the load resistance below z0.
  if (r <= z0) {
    const root = Math.sqrt(r * (z0 - r));
    for (const sign of [1, -1]) {
      const xs = -x + sign * root;
      const total = x + xs; // the reactance in series with r
      if (Math.abs(total) < 1e-12) continue;
      const xp = -(r * z0) / total;
      add([componentFor(xs, 'series', fMHz), componentFor(xp, 'shunt', fMHz)]);
    }
  }

  // B: the same trick in admittance: a shunt part at the load, then a series part.
  const g = conductance;
  const b = susceptance;
  if (g <= 1 / z0) {
    const root = Math.sqrt(g * (1 / z0 - g));
    for (const sign of [1, -1]) {
      const bp = -b + sign * root;
      const total = b + bp;
      if (Math.abs(g) < 1e-15) continue;
      const xs = (total * z0) / g;
      const xp = Math.abs(bp) < 1e-15 ? Number.NaN : -1 / bp;
      add([componentFor(xp, 'shunt', fMHz), componentFor(xs, 'series', fMHz)]);
    }
  }

  // Drop duplicates (a load on the boundary r == z0 solves the same way twice).
  return solutions.filter(
    (s, i) =>
      solutions.findIndex(
        (o) =>
          o.name === s.name &&
          o.elements.every((e, k) => Math.abs(valueOf(e) - valueOf(s.elements[k]!)) < 1e-15 * Math.max(1, valueOf(e))),
      ) === i,
  );
}

function valueOf(element: Element): number {
  return element.kind === 'inductor' ? element.henries : element.kind === 'capacitor' ? element.farads : 0;
}
