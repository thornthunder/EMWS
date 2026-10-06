// The "is my model converged?" check: double the segments, solve again, compare. These
// tests run the real engine, so the thresholds in convergence.ts were set from what this
// file MEASURED, not the other way round.

import { describe, expect, it } from 'vitest';
import { deckToModel } from '../src/tools/antenna-modeler/deck';
import { checkConvergence, doubleSegments, totalSegments } from '../src/tools/antenna-modeler/convergence';
import type { AntennaModel } from '../src/tools/antenna-modeler/model';
import { loadExample, simulate } from './helpers/engine';

function imported(text: string): AntennaModel {
  const result = deckToModel(text);
  if (!result.ok) throw new Error(result.reason);
  return result.model;
}

describe('doubling the segments', () => {
  it('doubles every wire and keeps the feed where it was along the wire', async () => {
    const model = imported(await loadExample('dipole-20m-free-space.nec'));
    const doubled = doubleSegments(model);
    expect(totalSegments(doubled)).toBe(2 * totalSegments(model));
    const feed = model.feeds[0]!;
    const feedNow = doubled.feeds[0]!;
    // The same place along the wire, within half an old segment.
    const wire = model.wires.find((w) => w.id === feed.wireId)!;
    const wireNow = doubled.wires.find((w) => w.id === feedNow.wireId)!;
    const before = (feed.segment - 0.5) / wire.segments;
    const after = (feedNow.segment - 0.5) / wireNow.segments;
    expect(Math.abs(after - before)).toBeLessThan(0.5 / wire.segments);
  });
});

describe('the convergence check, on the real engine', () => {
  it('calls the shipped 21-segment 20 m dipole settled, with the movement it really shows', async () => {
    const model = imported(await loadExample('dipole-20m-free-space.nec'));
    const report = await checkConvergence(model, 14.2, (deck) => simulate(deck));
    expect(report.segments).toEqual([21, 42]);
    // MEASURED 2026-10-05 on nec2c: doubling 21 -> 42 segments moves the feed impedance
    // 0.31 Ohm (72.35 + j1.99 -> 72.50 + j2.27, 0.43 %) and the 10-degree-sphere peak
    // gain not at all (2.14 -> 2.14 dBi). Held here with a little room for build drift.
    expect(report.deltaOhm).toBeGreaterThan(0.1);
    expect(report.deltaOhm).toBeLessThan(0.6);
    expect(report.deltaShare).toBeLessThan(0.01);
    expect(report.gainDb).toBeDefined();
    expect(Math.abs(report.deltaGainDb ?? Infinity)).toBeLessThan(0.05);
    expect(report.settled).toBe(true);
    expect(report.words).toContain('Settled');
    expect(report.words).toContain('21 → 42');
  }, 30_000);

  it('calls a crudely chopped vertical over radials what it is', async () => {
    // One segment per wire is as coarse as it gets: the answer must move when refined.
    const model = imported(await loadExample('dipole-20m-free-space.nec'));
    const crude: AntennaModel = { ...model, wires: model.wires.map((w) => ({ ...w, segments: 1 })), feeds: model.feeds.map((f) => ({ ...f, segment: 1 })) };
    const report = await checkConvergence(crude, 14.2, (deck) => simulate(deck));
    expect(report.segments).toEqual([1, 2]);
    expect(report.settled).toBe(false);
    expect(report.words).toContain('Not settled');
  }, 30_000);
});
