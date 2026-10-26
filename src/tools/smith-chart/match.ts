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

// ---------------------------------------------------------------- Pi and T, with a Q you choose

/**
 * An L network's Q is fixed by the two resistances it joins: sqrt(Rhigh / Rlow - 1), and
 * that sets its bandwidth whether you like it or not. A Pi or a T is two L networks back to
 * back through a "virtual" resistance in the middle - below both ends for a Pi, above both
 * for a T - and the choice of that resistance is the choice of Q: a higher Q means a
 * narrower match and (for the low-pass shapes) more harmonic rejection. So a Pi or T can
 * only ever be SHARPER than the L network between the same two impedances, never broader;
 * the lowest Q either shape can have is the L network's own, which is what `leastQ` gives.
 *
 * Built exactly as described: each half is one of the L-network sections above, so every
 * solution is exact at the design frequency by construction, and the middle parts of the
 * two halves merge into one (two series reactances add; two shunt susceptances add).
 */
export interface LeastQ {
  /** The L network's Q between the load's PARALLEL resistance and z0: the floor for a Pi. */
  pi: number;
  /** Between the load's SERIES resistance and z0: the floor for a T. */
  tee: number;
}

export function leastQ(zLoad: Complex, z0: number): LeastQ {
  const r = zLoad.re;
  const x = zLoad.im;
  if (!(r > 0) || !(z0 > 0)) return { pi: Infinity, tee: Infinity };
  const rParallel = (r * r + x * x) / r;
  const q = (high: number, low: number) => Math.sqrt(Math.max(0, high / low - 1));
  return { pi: q(Math.max(rParallel, z0), Math.min(rParallel, z0)), tee: q(Math.max(r, z0), Math.min(r, z0)) };
}

/** Series reactance at the load, then a shunt one: brings r + jx (r <= target) to a real `target`. Both roots. */
function seriesThenShunt(z: Complex, target: number): { xs: number; xp: number }[] {
  const r = z.re;
  const x = z.im;
  if (!(r > 0) || r > target * (1 + 1e-12)) return [];
  const root = Math.sqrt(Math.max(0, r * (target - r)));
  const out: { xs: number; xp: number }[] = [];
  for (const sign of [1, -1]) {
    const xs = -x + sign * root;
    const total = x + xs;
    if (Math.abs(total) < 1e-12) continue;
    out.push({ xs, xp: -(r * target) / total });
  }
  return out;
}

/** Shunt reactance at the load, then a series one: the same in admittance. Needs g <= 1 / target. */
function shuntThenSeries(z: Complex, target: number): { xp: number; xs: number }[] {
  const denom = z.re * z.re + z.im * z.im;
  if (!(z.re > 0) || denom === 0) return [];
  const g = z.re / denom;
  const b = -z.im / denom;
  if (g > (1 / target) * (1 + 1e-12)) return [];
  const root = Math.sqrt(Math.max(0, g * (1 / target - g)));
  const out: { xp: number; xs: number }[] = [];
  for (const sign of [1, -1]) {
    const bp = -b + sign * root;
    if (Math.abs(bp) < 1e-15) continue;
    out.push({ xp: -1 / bp, xs: ((b + bp) * target) / g });
  }
  return out;
}

export type ThreeShape = 'pi' | 'tee';

/**
 * Every Pi and T that matches `zLoad` to `z0` at `fMHz` with loaded Q `q`. Empty when q is
 * below the shape's floor (see leastQ), because then there is no virtual resistance to
 * build it round. Low-pass shapes first, then high-pass, then the mixed ones.
 */
export function piTeeSolutions(zLoad: Complex, z0: number, fMHz: number, q: number): MatchSolution[] {
  const r = zLoad.re;
  const x = zLoad.im;
  if (!(r > 0) || !Number.isFinite(x) || !(z0 > 0) || !(fMHz > 0) || !(q > 0)) return [];
  const rParallel = (r * r + x * x) / r;
  const solutions: MatchSolution[] = [];

  const finish = (shape: ThreeShape, parts: (ReactivePart | undefined)[]) => {
    if (parts.some((p) => p === undefined)) return;
    const elements = parts as ReactivePart[];
    const letter = (e: ReactivePart) => (e.kind === 'inductor' ? 'L' : 'C');
    const name = `${shape === 'pi' ? 'Pi' : 'T'}: ${elements.map((e) => `${e.connection} ${letter(e)}`).join(', ')}`;
    const kinds = elements.map(letter).join('');
    const character: MatchSolution['character'] =
      (shape === 'pi' && kinds === 'CLC') || (shape === 'tee' && kinds === 'LCL') ? 'low-pass'
      : (shape === 'pi' && kinds === 'LCL') || (shape === 'tee' && kinds === 'CLC') ? 'high-pass'
      : 'mixed';
    const duplicate = solutions.some(
      (s) => s.name === name && s.elements.every((e, k) => Math.abs(valueOf(e) - valueOf(elements[k]!)) < 1e-12 * Math.max(1e-30, valueOf(e))),
    );
    if (!duplicate) solutions.push({ id: `${shape}-${solutions.length}`, name, character, elements });
  };

  // Pi: the virtual resistance sits below both ends; the load side is shunt-then-series
  // (it needs the load's conductance below 1/Rv), the radio side series-then-shunt.
  const rvPi = Math.max(rParallel, z0) / (1 + q * q);
  if (rvPi <= Math.min(rParallel, z0) * (1 + 1e-9)) {
    for (const a of shuntThenSeries(zLoad, rvPi)) {
      for (const b of seriesThenShunt({ re: rvPi, im: 0 }, z0)) {
        const series = a.xs + b.xs;
        if (Math.abs(series) < 1e-9) continue;
        finish('pi', [componentFor(a.xp, 'shunt', fMHz), componentFor(series, 'series', fMHz), componentFor(b.xp, 'shunt', fMHz)]);
      }
    }
  }

  // T: the virtual resistance sits above both ends; series-then-shunt at the load, then
  // shunt-then-series to the radio, the two shunt parts merging as susceptances.
  const rvTee = Math.min(r, z0) * (1 + q * q);
  if (rvTee >= Math.max(r, z0) * (1 - 1e-9)) {
    for (const a of seriesThenShunt(zLoad, rvTee)) {
      for (const b of shuntThenSeries({ re: rvTee, im: 0 }, z0)) {
        const susceptance = -1 / a.xp - 1 / b.xp;
        if (Math.abs(susceptance) < 1e-15) continue;
        finish('tee', [componentFor(a.xs, 'series', fMHz), componentFor(-1 / susceptance, 'shunt', fMHz), componentFor(b.xs, 'series', fMHz)]);
      }
    }
  }

  const rank = { 'low-pass': 0, 'high-pass': 1, mixed: 2 };
  return solutions.sort((p, s) => rank[p.character] - rank[s.character]);
}
