// Tuning: change one thing about the antenna until a goal is met.
//
// The modeller answers "what does this wire do?"; the question people actually have is
// "how long must it be?". This turns the second into the first, many times over: pick a
// variable (a wire's length, the whole antenna's height, a coil or capacitor in a load)
// and a goal (resonance, lowest SWR, best gain or front-to-back), and the search solves
// the model at trial values until the goal is as good as it gets within the range given.
//
// The search is deliberately plain. A coarse scan across the range finds the best
// neighbourhood - which is what makes it robust to a goal with more than one dip - and a
// golden-section search then closes in on it. Every evaluation is a real NEC solve
// through whatever solver the page is using, so what comes back is not a formula's
// opinion but the model's. The result is honest about its own limits: it says how many
// solves it took, and when the best value sits at the edge of the range it says so,
// because that means the real answer is probably outside it.
//
// Public domain (The Unlicense). By ZR1JT.

import { cutsOf, frontToBackDb, mainLobe } from '../../engine/nec2/pattern';
import type { Nec2Run, Vec3 } from '../../engine/nec2/types';
import { swr } from '../../lib/rf';
import { add, scale, sub } from '../../lib/vec3';
import { modelToDeck } from './deck';
import { type AntennaModel, type EndName, type EndRef, junctionOf, moveEnds, translateEnds, updateLoad, vectorOf, wireById, wireLength } from './model';

export type TuneVariable =
  /** The length of one wire, moved from one end or stretched about its middle. */
  | { kind: 'wire-length'; wireId: string; ends: EndName | 'both' }
  /** Where one wire sits along a horizontal axis - a Yagi element's place on the boom. Joined ends come along. */
  | { kind: 'wire-position'; wireId: string; axis: 'x' | 'y' }
  /** The height of the whole antenna: every wire shifted together. */
  | { kind: 'height' }
  /** One part of one load: the coil, the capacitor, the resistance. */
  | { kind: 'load'; loadId: string; field: 'henries' | 'farads' | 'ohms' | 'reactance' };

export interface TuneRange {
  min: number;
  max: number;
}

export type TuneGoal =
  /** Zero reactance at the feed at this frequency. */
  | { kind: 'resonance'; fMHz: number }
  /** Lowest SWR at this frequency, against z0. */
  | { kind: 'swr'; fMHz: number; z0: number }
  /** Lowest worst-case SWR across the model's own sweep. */
  | { kind: 'swr-band'; z0: number }
  /** Highest peak gain at this frequency. */
  | { kind: 'gain'; fMHz: number }
  /** Highest front-to-back ratio at this frequency. */
  | { kind: 'front-to-back'; fMHz: number };

export interface TuneRequest {
  variable: TuneVariable;
  range: TuneRange;
  goal: TuneGoal;
  /** A ceiling on solves; the search stops there and says so. */
  maxEvaluations?: number;
}

export interface Evaluation {
  value: number;
  /** Lower is better, whatever the goal. */
  score: number;
  readout: string;
}

export interface TuneResult {
  value: number;
  model: AntennaModel;
  readout: string;
  evaluations: Evaluation[];
  /** The best value is within this of the range's edge: the real optimum is probably beyond it. */
  atEdge: boolean;
  /** Stopped at maxEvaluations before converging. */
  truncated: boolean;
}

const unit = (v: Vec3): Vec3 => {
  const n = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / n, y: v.y / n, z: v.z / n };
};

/** What the variable is now, in SI units (metres, henries, farads, ohms). */
export function currentValue(model: AntennaModel, variable: TuneVariable): number | undefined {
  switch (variable.kind) {
    case 'wire-length': {
      const wire = wireById(model, variable.wireId);
      return wire ? wireLength(wire) : undefined;
    }
    case 'wire-position': {
      const wire = wireById(model, variable.wireId);
      return wire ? (wire.a[variable.axis] + wire.b[variable.axis]) / 2 : undefined;
    }
    case 'height':
      return model.wires.length > 0 ? Math.min(...model.wires.flatMap((w) => [w.a.z, w.b.z])) : undefined;
    case 'load': {
      const load = model.loads.find((l) => l.id === variable.loadId);
      return load?.[variable.field];
    }
  }
}

export interface VariableChoice {
  key: string;
  label: string;
  variable: TuneVariable;
}

const PART_NAMES = { henries: 'L', farads: 'C', ohms: 'R', reactance: 'X' } as const;

/**
 * Everything about a model that can be tuned, in the person's words: every wire's length,
 * where each horizontal wire sits across its own direction (a Yagi element's place on the
 * boom), the height of the lot, and each part of each load. Tune, the optimiser and the
 * parameter sweep all offer this same list.
 */
export function variableChoices(model: AntennaModel): VariableChoice[] {
  const choices: VariableChoice[] = [];
  for (const w of model.wires) choices.push({ key: 'wire:' + w.id, label: 'Length of wire ' + w.tag, variable: { kind: 'wire-length', wireId: w.id, ends: 'both' } });
  for (const w of model.wires) {
    const d = vectorOf(w);
    // A mostly vertical wire has no "along the boom"; its height is the antenna's height.
    if (Math.abs(d.z) > Math.hypot(d.x, d.y)) continue;
    const axis = Math.abs(d.x) <= Math.abs(d.y) ? 'x' : 'y';
    choices.push({ key: 'pos:' + w.id + ':' + axis, label: `Position of wire ${w.tag} along ${axis.toUpperCase()}`, variable: { kind: 'wire-position', wireId: w.id, axis } });
  }
  if (model.wires.length > 0) choices.push({ key: 'height', label: 'Height of the antenna', variable: { kind: 'height' } });
  for (const l of model.loads) {
    const wire = model.wires.find((w) => w.id === l.wireId);
    const name = l.label ? '"' + l.label + '"' : 'load on wire ' + (wire?.tag ?? '?');
    const fields: ('henries' | 'farads' | 'ohms' | 'reactance')[] = l.kind === 'impedance' ? ['ohms', 'reactance'] : ['henries', 'farads', 'ohms'];
    for (const field of fields) {
      choices.push({ key: 'load:' + l.id + ':' + field, label: PART_NAMES[field] + ' of ' + name, variable: { kind: 'load', loadId: l.id, field } });
    }
  }
  return choices;
}

/** A range worth searching: wide enough to hold the answer, narrow enough to find it. */
export function suggestedRange(model: AntennaModel, variable: TuneVariable): TuneRange {
  const now = currentValue(model, variable) ?? 0;
  switch (variable.kind) {
    case 'wire-length':
      return { min: Math.max(0.01, now * 0.7), max: now * 1.3 || 1 };
    case 'wire-position': {
      // A quarter of the wire's own length either way, and never less than 10 cm.
      const wire = wireById(model, variable.wireId);
      const reach = Math.max(0.1, wire ? wireLength(wire) * 0.25 : 1);
      return { min: now - reach, max: now + reach };
    }
    case 'height':
      return { min: Math.max(0, now - 5), max: now + 10 };
    case 'load':
      // Loads span decades: a third to three times what is there, or a sensible start from 0.
      if (now > 0) return { min: now / 3, max: now * 3 };
      return variable.field === 'farads' ? { min: 1e-12, max: 1e-9 } : variable.field === 'henries' ? { min: 1e-7, max: 1e-4 } : { min: 0, max: 1000 };
  }
}

/** The model with the variable set to `value`. Pure, like every other edit. */
export function applyVariable(model: AntennaModel, variable: TuneVariable, value: number): AntennaModel {
  switch (variable.kind) {
    case 'wire-length': {
      const wire = wireById(model, variable.wireId);
      if (!wire || !(value > 0)) return model;
      const u = unit(vectorOf(wire));
      const ref = (end: EndName): EndRef[] => junctionOf(model, { wireId: wire.id, end });
      if (variable.ends === 'b') return moveEnds(model, ref('b'), add(wire.a, scale(u, value)));
      if (variable.ends === 'a') return moveEnds(model, ref('a'), sub(wire.b, scale(u, value)));
      const centre = scale(add(wire.a, wire.b), 0.5);
      const half = scale(u, value / 2);
      // Both ends, and whatever is joined to each comes along.
      const movedA = moveEnds(model, ref('a'), sub(centre, half));
      const wireNow = wireById(movedA, wire.id)!;
      return moveEnds(movedA, junctionOf(movedA, { wireId: wireNow.id, end: 'b' }), add(centre, half));
    }
    case 'wire-position': {
      const now = currentValue(model, variable);
      if (now === undefined) return model;
      // Both ends, and every end joined to either: the element moves as one, as a drag does.
      const ends = [...junctionOf(model, { wireId: variable.wireId, end: 'a' }), ...junctionOf(model, { wireId: variable.wireId, end: 'b' })];
      const delta = { x: 0, y: 0, z: 0, [variable.axis]: value - now };
      return translateEnds(model, ends, delta);
    }
    case 'height': {
      const now = currentValue(model, variable);
      if (now === undefined) return model;
      const ends: EndRef[] = model.wires.flatMap((w) => [
        { wireId: w.id, end: 'a' as const },
        { wireId: w.id, end: 'b' as const },
      ]);
      return translateEnds(model, ends, { x: 0, y: 0, z: value - now });
    }
    case 'load':
      return updateLoad(model, variable.loadId, { [variable.field]: value });
  }
}

/** The variable in the person's words: "the length of wire 1 (both ends)". */
export function describeVariable(model: AntennaModel, variable: TuneVariable): string {
  switch (variable.kind) {
    case 'wire-length': {
      const wire = wireById(model, variable.wireId);
      const how = variable.ends === 'both' ? 'both ends' : `end ${variable.ends === 'a' ? 1 : 2}`;
      return `the length of wire ${wire?.tag ?? '?'} (${how})`;
    }
    case 'wire-position':
      return `the position of wire ${wireById(model, variable.wireId)?.tag ?? '?'} along ${variable.axis.toUpperCase()}`;
    case 'height':
      return 'the height of the antenna';
    case 'load': {
      const load = model.loads.find((l) => l.id === variable.loadId);
      const wire = load && wireById(model, load.wireId);
      const part = { henries: 'L', farads: 'C', ohms: 'R', reactance: 'X' }[variable.field];
      return `${part} of ${load?.label ? `"${load.label}"` : 'the load'} on wire ${wire?.tag ?? '?'}`;
    }
  }
}

/** A value of the variable, in the unit a person would use for it. */
export function formatTunedValue(variable: TuneVariable, value: number): string {
  if (variable.kind !== 'load') return `${value.toFixed(3)} m`;
  switch (variable.field) {
    case 'henries':
      return `${Number((value * 1e6).toPrecision(4))} µH`;
    case 'farads':
      return `${Number((value * 1e12).toPrecision(4))} pF`;
    default:
      return `${Number(value.toPrecision(4))} Ω`;
  }
}

/** Goals that need the far field solve a coarse sphere: ten-degree steps are plenty to rank by. */
function needsPattern(goal: TuneGoal): boolean {
  return goal.kind === 'gain' || goal.kind === 'front-to-back';
}

/** The deck to solve for one trial: one frequency (or the model's sweep), no more pattern than the goal needs. */
export function deckFor(model: AntennaModel, goal: TuneGoal): string {
  if (goal.kind === 'swr-band') return modelToDeck(model, { pattern: 'none' });
  const single = { ...model, frequency: { startMHz: goal.fMHz, stepMHz: 0, steps: 1 } };
  if (!needsPattern(goal)) return modelToDeck(single, { pattern: 'none' });
  const sphere = model.ground.kind === 'free-space' ? 'RP 0 19 36 1000 0 0 10 10' : 'RP 0 10 36 1000 0 0 10 10';
  return modelToDeck({ ...single, pattern: { kind: 'cards', cards: [sphere] } });
}

/** How far a solved run is from the goal: lower is better. */
export function objectiveOf(run: Nec2Run, goal: TuneGoal): { score: number; readout: string } {
  const frequencies = run.report.frequencies;
  const first = frequencies[0];
  const z = first?.feeds[0]?.impedance;
  switch (goal.kind) {
    case 'resonance': {
      if (!z) return { score: Infinity, readout: 'no feed impedance' };
      return { score: Math.abs(z.im), readout: `${z.im >= 0 ? '+' : '−'}j${Math.abs(z.im).toFixed(1)} Ω at the feed (R ${z.re.toFixed(1)} Ω)` };
    }
    case 'swr': {
      if (!z) return { score: Infinity, readout: 'no feed impedance' };
      const ratio = swr(z, goal.z0);
      return { score: ratio, readout: `SWR ${Number.isFinite(ratio) ? ratio.toFixed(2) : '∞'} : 1 against ${goal.z0} Ω` };
    }
    case 'swr-band': {
      let worst = 0;
      let where = first?.frequencyMHz ?? 0;
      for (const f of frequencies) {
        const zf = f.feeds[0]?.impedance;
        const ratio = zf ? swr(zf, goal.z0) : Infinity;
        if (ratio > worst) {
          worst = ratio;
          where = f.frequencyMHz;
        }
      }
      return { score: worst, readout: `worst SWR ${Number.isFinite(worst) ? worst.toFixed(2) : '∞'} : 1, at ${where} MHz` };
    }
    case 'gain': {
      const peak = mainLobe(frequencies.flatMap((f) => f.patterns.flatMap((p) => p.points)));
      if (!peak) return { score: Infinity, readout: 'no pattern' };
      return { score: -peak.totalDb, readout: `${peak.totalDb.toFixed(2)} dBi peak` };
    }
    case 'front-to-back': {
      const cuts = frequencies.flatMap((f) => f.patterns.flatMap(cutsOf));
      const fb = cuts.map(frontToBackDb).find((v) => v !== undefined && Number.isFinite(v));
      if (fb === undefined) return { score: Infinity, readout: 'no front-to-back' };
      return { score: -fb, readout: `${fb.toFixed(1)} dB front-to-back` };
    }
  }
}

const GOLDEN = (Math.sqrt(5) - 1) / 2;

/**
 * Minimises a function of one number on a range: a coarse scan to find the best
 * neighbourhood, then a golden-section search inside it. Evaluations are cached by
 * value, so the scan's points are not solved twice. Pure, so it can be tested on paper.
 */
export async function minimise1D(
  f: (value: number) => Promise<number>,
  range: TuneRange,
  options: { scanPoints?: number; tolerance?: number; maxEvaluations?: number; onEvaluation?: (value: number, score: number, count: number) => void } = {},
): Promise<{ value: number; score: number; evaluations: number; truncated: boolean }> {
  const { scanPoints = 9, maxEvaluations = 60 } = options;
  const tolerance = options.tolerance ?? Math.abs(range.max - range.min) * 1e-3;
  const cache = new Map<number, number>();
  let count = 0;
  let truncated = false;
  const at = async (value: number): Promise<number> => {
    const key = Number(value.toPrecision(12));
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    if (count >= maxEvaluations) {
      truncated = true;
      return Infinity;
    }
    count += 1;
    const score = await f(key);
    cache.set(key, score);
    options.onEvaluation?.(key, score, count);
    return score;
  };

  // The scan: including both edges, so a goal that only improves one way says so.
  const points = Array.from({ length: Math.max(3, scanPoints) }, (_, i) => range.min + ((range.max - range.min) * i) / (Math.max(3, scanPoints) - 1));
  let bestIndex = 0;
  let best = Infinity;
  for (let i = 0; i < points.length; i++) {
    const score = await at(points[i]!);
    if (score < best) {
      best = score;
      bestIndex = i;
    }
  }
  if (!Number.isFinite(best)) return { value: points[bestIndex]!, score: best, evaluations: count, truncated };

  // Golden section between the scan points either side of the best one.
  let lo = points[Math.max(0, bestIndex - 1)]!;
  let hi = points[Math.min(points.length - 1, bestIndex + 1)]!;
  let x1 = hi - GOLDEN * (hi - lo);
  let x2 = lo + GOLDEN * (hi - lo);
  let f1 = await at(x1);
  let f2 = await at(x2);
  while (hi - lo > tolerance && !truncated) {
    if (f1 < f2) {
      hi = x2;
      x2 = x1;
      f2 = f1;
      x1 = hi - GOLDEN * (hi - lo);
      f1 = await at(x1);
    } else {
      lo = x1;
      x1 = x2;
      f1 = f2;
      x2 = lo + GOLDEN * (hi - lo);
      f2 = await at(x2);
    }
  }
  // The best of everything seen, scan included.
  let value = points[bestIndex]!;
  for (const [v, s] of cache) {
    if (s < best) {
      best = s;
      value = v;
    }
  }
  return { value, score: best, evaluations: count, truncated };
}

/**
 * Runs the tune: solves the model at trial values of the variable until the goal is as
 * good as the range allows. `solve` is whatever the page solves with, so a remote
 * solver, cancellation and fallback all behave as they do for an ordinary run.
 */
export async function tune(
  model: AntennaModel,
  request: TuneRequest,
  solve: (deck: string) => Promise<Nec2Run>,
  onProgress?: (done: number, best: Evaluation | undefined) => void,
): Promise<TuneResult> {
  const evaluations: Evaluation[] = [];
  let best: Evaluation | undefined;
  const search = await minimise1D(
    async (value) => {
      const trial = applyVariable(model, request.variable, value);
      const run = await solve(deckFor(trial, request.goal));
      const { score, readout } = objectiveOf(run, request.goal);
      const evaluation = { value, score, readout };
      evaluations.push(evaluation);
      if (!best || score < best.score) best = evaluation;
      onProgress?.(evaluations.length, best);
      return score;
    },
    request.range,
    { maxEvaluations: request.maxEvaluations },
  );
  const found = evaluations.find((e) => e.value === search.value) ?? best;
  const span = request.range.max - request.range.min;
  return {
    value: search.value,
    model: applyVariable(model, request.variable, search.value),
    readout: found?.readout ?? '',
    evaluations,
    atEdge: span > 0 && Math.min(search.value - request.range.min, request.range.max - search.value) < span * 0.02,
    truncated: search.truncated,
  };
}
