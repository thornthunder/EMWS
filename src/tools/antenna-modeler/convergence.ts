// Is the model converged? Solve it again with twice the segments and see what moves.
//
// NEC-2's answer depends on how finely the wires are chopped, and nothing in a single run
// says whether it was chopped finely enough. The numerical analyst's oldest test does:
// refine the mesh and see whether the answer stays put. One button runs it - the same
// model with every wire at double the segment count, at the frequency on screen, with a
// coarse ten-degree sphere for the gain - and if the feed impedance and the peak gain
// barely move, the answer did not depend on the chopping. If they move, the model needs
// more segments, and the single run was not to be trusted at that precision.
//
// The verdict's thresholds are EMWS rules of thumb, measured before they were set: the
// shipped 21-segment 20 m dipole moves 0.31 Ω (0.43 %) and 0.00 dB when doubled
// (MEASURED 2026-10-05; tests/convergence.test.ts holds it there) - the ordinary small
// drift of the thin-wire kernel, not a modelling error - so the line is drawn well above.
//
// Public domain (The Unlicense). By ZR1JT.

import { mainLobe } from '../../engine/nec2/pattern';
import type { Nec2Run } from '../../engine/nec2/types';
import type { Complex } from '../../lib/complex';
import { type AntennaModel, setWireGeometry } from './model';
import { deckFor } from './tune';

export interface ConvergenceReport {
  /** Total segments, before and after. */
  segments: [number, number];
  z: [Complex, Complex];
  /** |Z2 - Z1| in ohms, and as a share of |Z1|. */
  deltaOhm: number;
  deltaShare: number;
  /** Peak gain from a 10-degree sphere at each density; absent when a solve had no pattern. */
  gainDb?: [number, number];
  deltaGainDb?: number;
  settled: boolean;
  /** The verdict, in words that claim no more than the test showed. */
  words: string;
}

/** The impedance moved by more than this share of |Z|, or the gain by more, and the model is called unsettled. */
export const SETTLED_Z_SHARE = 0.05;
export const SETTLED_GAIN_DB = 0.25;

/** Every wire with twice the segments; feeds and loads keep their place along each wire. */
export function doubleSegments(model: AntennaModel): AntennaModel {
  return model.wires.reduce((m, w) => setWireGeometry(m, w.id, { segments: w.segments * 2 }), model);
}

export function totalSegments(model: AntennaModel): number {
  return model.wires.reduce((n, w) => n + w.segments, 0);
}

const cAbs = (z: Complex) => Math.hypot(z.re, z.im);

/**
 * Two fresh solves - the model as it is and the model at double density, both at one
 * frequency with the same coarse sphere - so the only thing that differs is the chopping.
 * `solve` is whatever the page solves with: remote solvers and Cancel behave as usual.
 */
export async function checkConvergence(
  model: AntennaModel,
  fMHz: number,
  solve: (deck: string) => Promise<Nec2Run>,
): Promise<ConvergenceReport> {
  const doubled = doubleSegments(model);
  const goal = { kind: 'gain', fMHz } as const;
  // One after the other, not in parallel: the doubled matrix is four times the memory.
  const run1 = await solve(deckFor(model, goal));
  const run2 = await solve(deckFor(doubled, goal));
  const z1 = run1.report.frequencies[0]?.feeds[0]?.impedance;
  const z2 = run2.report.frequencies[0]?.feeds[0]?.impedance;
  if (!z1 || !z2) throw new Error('A convergence solve came back without a feed impedance.');
  const g1 = mainLobe(run1.report.frequencies.flatMap((f) => f.patterns.flatMap((p) => p.points)))?.totalDb;
  const g2 = mainLobe(run2.report.frequencies.flatMap((f) => f.patterns.flatMap((p) => p.points)))?.totalDb;
  const deltaOhm = cAbs({ re: z2.re - z1.re, im: z2.im - z1.im });
  const deltaShare = cAbs(z1) > 0 ? deltaOhm / cAbs(z1) : Infinity;
  const deltaGainDb = g1 !== undefined && g2 !== undefined ? g2 - g1 : undefined;
  const zSettled = deltaShare <= SETTLED_Z_SHARE;
  const gainSettled = deltaGainDb === undefined || Math.abs(deltaGainDb) <= SETTLED_GAIN_DB;
  const settled = zSettled && gainSettled;

  const n1 = totalSegments(model);
  const n2 = totalSegments(doubled);
  const moved =
    `doubling the segments (${n1} → ${n2}) moved the feed impedance by ${deltaOhm.toFixed(1)} Ω ` +
    `(${(deltaShare * 100).toFixed(1)} %)` +
    (deltaGainDb !== undefined ? ` and the peak gain by ${Math.abs(deltaGainDb).toFixed(2)} dB` : '');
  const words = settled
    ? `Settled: ${moved}. The answers do not depend on the chopping at this precision.`
    : `Not settled: ${moved}. Use more segments - the single run's figures depend on the chopping.`;

  return {
    segments: [n1, n2],
    z: [z1, z2],
    deltaOhm,
    deltaShare,
    ...(g1 !== undefined && g2 !== undefined ? { gainDb: [g1, g2] as [number, number], deltaGainDb } : {}),
    settled,
    words,
  };
}
