// Several things at once, and the curves between: the multi-variable optimiser and the
// parameter sweep.
//
// Tune moves one thing. A Yagi wants its element lengths AND spacings together, against
// gain and front-to-back and SWR at once - and moving one shifts the best place for every
// other. So this searches all of them together with Nelder-Mead's simplex method (written
// from the 1965 paper's rules: reflect, expand, contract, shrink), in coordinates scaled to
// each variable's range so a 3 cm spacing and a 30 cm length move on equal terms.
//
// The goal is one number made of the things a person weighs, each with a weight they set:
//
//     score = - wG * gain(dBi) - wF * min(F/B, 30 dB) + wS * 10 * max(0, SWR - target)
//
// i.e. "every 0.1 of SWR over your target costs as much as 1 dB of gain, times its weight".
// Front-to-back is capped at 30 dB because past that the optimiser would chase a deep,
// razor-thin null that no real antenna keeps. Lower is better, as in tune.ts.
//
// The parameter sweep is the same machinery without the search: step one variable across a
// range and record gain, take-off angle, front-to-back and SWR at each - the ARRL-book
// "gain against height" curves, for your antenna.
//
// Every trial is a real NEC solve through whatever solver the page uses. Public domain
// (The Unlicense). By ZR1JT.

import { cutsOf, elevationOfTheta, frontToBackDb, mainLobe } from '../../engine/nec2/pattern';
import type { Complex } from '../../lib/complex';
import type { Nec2Run } from '../../engine/nec2/types';
import { swr } from '../../lib/rf';
import { modelToDeck } from './deck';
import type { AntennaModel } from './model';
import { type TuneRange, type TuneVariable, applyVariable, deckFor } from './tune';

// ---------------------------------------------------------------- the search

// Nelder-Mead itself lives in src/lib/simplex.ts, shared with the Smith chart's optimiser;
// re-exported here so the tests and callers that knew it from this file still find it.
export { nelderMead, type SimplexResult } from '../../lib/simplex';
import { nelderMead } from '../../lib/simplex';

// ---------------------------------------------------------------- the goal

export interface OptimiseGoal {
  fMHz: number;
  /** Per dBi of peak gain. 0 = gain does not matter. */
  gainWeight: number;
  /** Per dB of front-to-back, capped at FB_CAP_DB. */
  fbWeight: number;
  /** Every 0.1 of SWR over the target counts as 1 dB, times this. */
  swrWeight: number;
  swrTarget: number;
  /** The SWR at the goal frequency, or the worst across the model's own sweep. */
  swrOver: 'frequency' | 'sweep';
  z0: number;
}

export const FB_CAP_DB = 30;

export interface Measured {
  gainDbi?: number;
  fbDb?: number;
  /** At the goal frequency, or the worst across the sweep, per the goal. */
  swr?: number;
}

export function scoreOf(m: Measured, goal: OptimiseGoal): number {
  let score = 0;
  if (goal.gainWeight > 0) score -= goal.gainWeight * (m.gainDbi ?? -100);
  if (goal.fbWeight > 0) score -= goal.fbWeight * Math.min(FB_CAP_DB, m.fbDb ?? 0);
  if (goal.swrWeight > 0) {
    const s = m.swr ?? Infinity;
    score += goal.swrWeight * (Number.isFinite(s) ? 10 * Math.max(0, s - goal.swrTarget) : 1000);
  }
  return score;
}

export function describeMeasured(m: Measured): string {
  const parts: string[] = [];
  if (m.gainDbi !== undefined) parts.push(`${m.gainDbi.toFixed(2)} dBi`);
  if (m.fbDb !== undefined) parts.push(`F/B ${Number.isFinite(m.fbDb) ? m.fbDb.toFixed(1) : '∞'} dB`);
  if (m.swr !== undefined) parts.push(`SWR ${Number.isFinite(m.swr) ? m.swr.toFixed(2) : '∞'}`);
  return parts.join(' · ');
}

/** What one trial model measures: one solve at the goal frequency, and a sweep solve if the SWR is wanted across it. */
export async function measure(model: AntennaModel, goal: OptimiseGoal, solve: (deck: string) => Promise<Nec2Run>): Promise<Measured> {
  const needsPattern = goal.gainWeight > 0 || goal.fbWeight > 0;
  const atF = await solve(needsPattern ? deckFor(model, { kind: 'gain', fMHz: goal.fMHz }) : deckFor(model, { kind: 'swr', fMHz: goal.fMHz, z0: goal.z0 }));
  const f = atF.report.frequencies[0];
  const m: Measured = {};
  if (needsPattern && f) {
    m.gainDbi = mainLobe(f.patterns.flatMap((p) => p.points))?.totalDb;
    m.fbDb = f.patterns.flatMap(cutsOf).map(frontToBackDb).find((v) => v !== undefined);
  }
  if (goal.swrWeight > 0) {
    if (goal.swrOver === 'sweep' && model.frequency.steps > 1) {
      const band = await solve(deckFor(model, { kind: 'swr-band', z0: goal.z0 }));
      m.swr = Math.max(...band.report.frequencies.map((x) => (x.feeds[0] ? swr(x.feeds[0].impedance, goal.z0) : Infinity)));
    } else {
      const z = f?.feeds[0]?.impedance;
      m.swr = z ? swr(z, goal.z0) : Infinity;
    }
  }
  return m;
}

export interface OptimiseVariable {
  variable: TuneVariable;
  range: TuneRange;
}

export function applyAll(model: AntennaModel, vars: readonly OptimiseVariable[], values: readonly number[]): AntennaModel {
  return vars.reduce((m, v, i) => applyVariable(m, v.variable, values[i]!), model);
}

export interface OptimiseResult {
  values: number[];
  model: AntennaModel;
  before: Measured;
  after: Measured;
  improved: boolean;
  evaluations: number;
  truncated: boolean;
  /** Indexes of variables that ended within 2 % of their range's edge. */
  atEdge: number[];
}

/**
 * Searches every variable at once. The start is the model as it is (clamped into the
 * ranges), so a model that is already good is only ever improved on: if nothing beats it,
 * it is returned unchanged and `improved` says so.
 */
export async function optimise(
  model: AntennaModel,
  vars: readonly OptimiseVariable[],
  goal: OptimiseGoal,
  current: readonly number[],
  solve: (deck: string) => Promise<Nec2Run>,
  onProgress?: (count: number, best: Measured | undefined) => void,
  maxEvaluations = 150,
): Promise<OptimiseResult> {
  const toUnit = (v: number, r: TuneRange) => (r.max > r.min ? (v - r.min) / (r.max - r.min) : 0);
  const fromUnit = (u: number, r: TuneRange) => r.min + u * (r.max - r.min);
  const valuesOf = (x: readonly number[]) => x.map((u, i) => fromUnit(u, vars[i]!.range));

  let bestScore = Infinity;
  let bestMeasured: Measured | undefined;
  /** The search evaluates its start first, so that first measurement IS the model as it was. */
  let before: Measured | undefined;
  const measuredByKey = new Map<string, Measured>();
  const start = current.map((v, i) => toUnit(v, vars[i]!.range));

  const result = await nelderMead(
    async (x) => {
      const m = await measure(applyAll(model, vars, valuesOf(x)), goal, solve);
      before ??= m;
      measuredByKey.set(x.map((v) => v.toFixed(6)).join(','), m);
      const s = scoreOf(m, goal);
      if (s < bestScore) {
        bestScore = s;
        bestMeasured = m;
      }
      onProgress?.(measuredByKey.size, bestMeasured);
      return s;
    },
    start,
    { maxEvaluations },
  );

  const first = before ?? {};
  const improved = result.score < scoreOf(first, goal) - 1e-9;
  const values = improved ? valuesOf(result.x) : [...current];
  const after = improved ? (measuredByKey.get(result.x.map((v) => v.toFixed(6)).join(',')) ?? first) : first;
  const atEdge = improved ? result.x.flatMap((u, i) => (u < 0.02 || u > 0.98 ? [i] : [])) : [];
  return {
    values,
    model: improved ? applyAll(model, vars, values) : model,
    before: first,
    after,
    improved,
    evaluations: result.evaluations,
    truncated: result.truncated,
    atEdge,
  };
}

// ---------------------------------------------------------------- the parameter sweep

export interface SweepRow {
  value: number;
  gainDbi?: number;
  /** Elevation of the main lobe, degrees above the horizon. */
  elevationDeg?: number;
  fbDb?: number;
  z?: Complex;
  swr?: number;
}

/**
 * A pattern fine enough to read a take-off angle from: 2° in elevation, 10° around. The
 * upper hemisphere over ground, the whole sphere in free space.
 */
export function sweepDeck(model: AntennaModel, fMHz: number): string {
  const single = { ...model, frequency: { startMHz: fMHz, stepMHz: 0, steps: 1 } };
  const card = model.ground.kind === 'free-space' ? 'RP 0 91 36 1000 0 0 2 10' : 'RP 0 46 36 1000 0 0 2 10';
  return modelToDeck({ ...single, pattern: { kind: 'cards', cards: [card] } });
}

export function evenlySpaced(range: TuneRange, steps: number): number[] {
  const n = Math.max(2, Math.round(steps));
  return Array.from({ length: n }, (_, i) => range.min + ((range.max - range.min) * i) / (n - 1));
}

/** Steps one variable across its values, one solve each, and reads what a person plots. */
export async function sweepParameter(
  model: AntennaModel,
  variable: TuneVariable,
  values: readonly number[],
  fMHz: number,
  z0: number,
  solve: (deck: string) => Promise<Nec2Run>,
  onRow?: (rows: SweepRow[]) => void,
): Promise<SweepRow[]> {
  const rows: SweepRow[] = [];
  for (const value of values) {
    const run = await solve(sweepDeck(applyVariable(model, variable, value), fMHz));
    const f = run.report.frequencies[0];
    const peak = f ? mainLobe(f.patterns.flatMap((p) => p.points)) : undefined;
    const z = f?.feeds[0]?.impedance;
    rows.push({
      value,
      gainDbi: peak?.totalDb,
      elevationDeg: peak ? elevationOfTheta(peak.thetaDeg) : undefined,
      fbDb: f ? f.patterns.flatMap(cutsOf).map(frontToBackDb).find((v) => v !== undefined) : undefined,
      z,
      swr: z ? swr(z, z0) : undefined,
    });
    onRow?.([...rows]);
  }
  return rows;
}
