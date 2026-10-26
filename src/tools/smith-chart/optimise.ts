// Adjusts the values of the parts already in the chain towards a goal: the flattest SWR
// across the sweep, or the best match at the design frequency.
//
// "Match it for me" designs a network from nothing. This is the other half of the job: the
// network is built - three parts, say, chosen by hand or by the matcher - and the question
// is what values make it best over the whole band. A person does that by sliding each
// part in turn and watching the curve, which is slow and never quite finds the floor; a
// tester spent a minute of screen recording doing exactly that. Nelder-Mead does it in
// a blink, because every trial here is closed-form arithmetic along the chain, not a
// field solve.
//
// Each part moves over the same range its slider does - 1 to 2000 ohms of reactance for
// an inductor or capacitor, 1 cm to a wavelength for a line or stub - in log scale, so a
// factor of two is the same step at 10 ohms as at 1000. The search starts from the values
// as they are and only ever improves on them: if nothing beats them, they are returned
// unchanged and `improved` says so. A part that ends hard against the end of its range is
// reported by id, because that usually means it wants to be a different kind of part, not
// a different value.
//
// Public domain (The Unlicense). By ZR1JT.

import { nelderMead } from '../../lib/simplex';
import { gammaFromImpedance, standingWaveRatio } from '../../lib/touchstone';
import type { Element, Network } from './model';
import { inputImpedance, sweepNetwork } from './network';

const C = 299792458;

export type AdjustGoal = 'sweep' | 'design';

/** The slider's range for a reactive part, ohms of reactance. */
export const REACTANCE_RANGE = { min: 1, max: 2000 };

/** The parts whose value the search may move: reactive parts by value, lines and stubs by length. */
export function adjustableElements(network: Network): Element[] {
  return network.elements.filter(
    (e) => !e.bypassed && (e.kind === 'inductor' || e.kind === 'capacitor' || e.kind === 'line' || e.kind === 'stub'),
  );
}

/** Where a part sits in its search range, 0 to 1 (log scale), at the design frequency. */
export function positionOf(element: Element, designMHz: number): number {
  const omega = 2 * Math.PI * designMHz * 1e6;
  const log01 = (v: number, min: number, max: number) => Math.min(1, Math.max(0, Math.log(Math.max(min, Math.min(max, v)) / min) / Math.log(max / min)));
  switch (element.kind) {
    case 'inductor':
      return log01(omega * element.henries, REACTANCE_RANGE.min, REACTANCE_RANGE.max);
    case 'capacitor':
      return log01(element.farads > 0 ? 1 / (omega * element.farads) : REACTANCE_RANGE.max, REACTANCE_RANGE.min, REACTANCE_RANGE.max);
    case 'line':
    case 'stub':
      return log01(element.lengthM, 0.01, Math.max(2, C / (designMHz * 1e6)));
    default:
      return 0;
  }
}

/** The same part with its value set from a position in its range. Values are tidied to six figures, as the sliders leave them. */
export function atPosition(element: Element, u: number, designMHz: number): Element {
  const omega = 2 * Math.PI * designMHz * 1e6;
  const fromLog = (t: number, min: number, max: number) => min * Math.exp(Math.min(1, Math.max(0, t)) * Math.log(max / min));
  const tidy = (v: number) => Number(v.toPrecision(6));
  switch (element.kind) {
    case 'inductor':
      return { ...element, henries: tidy(fromLog(u, REACTANCE_RANGE.min, REACTANCE_RANGE.max) / omega) };
    case 'capacitor':
      return { ...element, farads: tidy(1 / (omega * fromLog(u, REACTANCE_RANGE.min, REACTANCE_RANGE.max))) };
    case 'line':
    case 'stub':
      return { ...element, lengthM: tidy(fromLog(u, 0.01, Math.max(2, C / (designMHz * 1e6)))) };
    default:
      return element;
  }
}

export interface Outcome {
  /** The worst SWR at any point of the sweep. */
  worstSwr: number;
  /** The SWR at the design frequency. */
  designSwr: number;
}

export function outcomeOf(network: Network): Outcome {
  const points = sweepNetwork(network);
  const worst = points.reduce((w, p) => Math.max(w, p.swr), 1);
  const z = inputImpedance(network, network.designMHz);
  return { worstSwr: worst, designSwr: standingWaveRatio(gammaFromImpedance(z, network.z0)) };
}

export interface AdjustResult {
  network: Network;
  before: Outcome;
  after: Outcome;
  improved: boolean;
  evaluations: number;
  truncated: boolean;
  /** Parts that ended within 2 % of either end of their range, by id. */
  atEdge: string[];
}

/**
 * Searches the values of the chosen parts (every adjustable one when `ids` is not given)
 * for the goal. Two passes of the simplex, the second restarted from where the first
 * stopped with a smaller first step, because a simplex that has collapsed along one axis
 * can miss a better floor nearby; the better of the two is kept.
 */
export async function adjustNetwork(
  network: Network,
  goal: AdjustGoal,
  ids?: readonly string[],
  maxEvaluations = 4000,
): Promise<AdjustResult> {
  const chosen = adjustableElements(network).filter((e) => !ids || ids.includes(e.id));
  const before = outcomeOf(network);
  if (chosen.length === 0) return { network, before, after: before, improved: false, evaluations: 0, truncated: false, atEdge: [] };

  const apply = (x: readonly number[]): Network => {
    const byId = new Map(chosen.map((e, i) => [e.id, atPosition(e, x[i]!, network.designMHz)]));
    return { ...network, elements: network.elements.map((e) => byId.get(e.id) ?? e) };
  };
  const score = (x: readonly number[]): number => {
    const o = outcomeOf(apply(x));
    const s = goal === 'sweep' ? o.worstSwr : o.designSwr;
    return Number.isFinite(s) ? s : 1e6;
  };

  const start = chosen.map((e) => positionOf(e, network.designMHz));
  let evaluations = 0;
  let truncated = false;
  let best = { x: start, score: score(start) };
  for (const [from, step] of [
    [start, 0.2],
    [best.x, 0.05],
  ] as const) {
    const run = await nelderMead(async (x) => score(x), from, { step, tolerance: 1e-5, maxEvaluations: Math.floor(maxEvaluations / 2) });
    evaluations += run.evaluations;
    truncated ||= run.truncated;
    if (run.score < best.score) best = { x: run.x, score: run.score };
  }

  const startScore = score(start);
  const improved = best.score < startScore - 1e-9;
  const adjusted = improved ? apply(best.x) : network;
  return {
    network: adjusted,
    before,
    after: improved ? outcomeOf(adjusted) : before,
    improved,
    evaluations,
    truncated,
    atEdge: improved ? chosen.filter((_, i) => best.x[i]! < 0.02 || best.x[i]! > 0.98).map((e) => e.id) : [],
  };
}
