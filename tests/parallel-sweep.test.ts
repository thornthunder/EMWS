// A sweep split across cores must be the same sweep. The engine reaches each frequency
// by adding the step to a running total, so the split decks have to do the same, and the
// merged report has to look exactly like the one-run version.

import { describe, expect, it } from 'vitest';
import { mergeRuns } from '../src/engine/nec2/merge';
import type { Nec2Run } from '../src/engine/nec2/types';
import { deckToModel, modelToDeck, perFrequencyDecks, planRuns, steppedFrequencies } from '../src/tools/antenna-modeler/deck';
import type { AntennaModel } from '../src/tools/antenna-modeler/model';
import { loadExample, simulate } from './helpers/engine';

async function sweepModel(): Promise<AntennaModel> {
  const imported = deckToModel(await loadExample('dipole-20m-swr-sweep.nec'));
  if (!imported.ok) throw new Error(imported.reason);
  return imported.model;
}

describe('splitting a sweep', () => {
  it('walks the frequencies the way the engine does: by adding the step', () => {
    const plan = { startMHz: 13.8, stepMHz: 0.05, steps: 17 };
    const stepped = steppedFrequencies(plan);
    expect(stepped).toHaveLength(17);
    expect(stepped[0]).toBe(13.8);
    // Repeated addition, not start + i × step: the two differ in the last bits, and the
    // engine does it this way.
    let expected = 13.8;
    for (let i = 1; i < 17; i++) expected += 0.05;
    expect(stepped[16]).toBe(expected);
    expect(stepped[16]).not.toBe(13.8 + 16 * 0.05);
  });

  it('writes one deck per frequency, each with the exact frequency', async () => {
    const model = await sweepModel();
    const decks = perFrequencyDecks(model);
    expect(decks).toHaveLength(17);
    for (const [i, deck] of decks.entries()) {
      const fr = deck.split('\n').find((line) => line.startsWith('FR'))!;
      expect(fr).toBe(`FR 0 1 0 0 ${String(steppedFrequencies(model.frequency)[i])} 0`);
    }
    // Everything else about the antenna is unchanged.
    expect(decks[0]!.split('\n').filter((l) => l.startsWith('GW'))).toEqual(
      modelToDeck(model).split('\n').filter((l) => l.startsWith('GW')),
    );
  });

  it('gives exactly the results of the single-run sweep', async () => {
    const model = await sweepModel();
    const combined = await simulate(modelToDeck(model));
    const parts: Nec2Run[] = [];
    for (const deck of perFrequencyDecks(model)) parts.push(await simulate(deck));
    const merged = mergeRuns(parts, { elapsedMs: 0 });

    expect(merged.report.frequencies).toHaveLength(combined.report.frequencies.length);
    expect(merged.report.frequencies).toEqual(combined.report.frequencies);
    expect(merged.report.segments).toEqual(combined.report.segments);
    expect(merged.raw.exitCode).toBe(0);
  });

  it('plans a sweep both ways, and leaves a single frequency alone', async () => {
    const model = await sweepModel();
    const plan = planRuns(model);
    expect(plan.perFrequency).toHaveLength(17);
    expect(plan.main).toMatch(/^FR 0 17/m);

    const single = planRuns({ ...model, frequency: { startMHz: 14.2, stepMHz: 0, steps: 1 } });
    expect(single.perFrequency).toBeUndefined();
  });

  it('splits an automatic-pattern sweep into impedance-only decks', async () => {
    const model = { ...(await sweepModel()), pattern: { kind: 'auto' as const } };
    const plan = planRuns(model);
    expect(plan.perFrequency).toHaveLength(17);
    for (const deck of plan.perFrequency!) {
      expect(deck).toMatch(/^XQ$/m);
      expect(deck).not.toMatch(/^RP/m);
    }
    expect(plan.patternDeck).toBeDefined();
  });
});

describe('merging the pieces', () => {
  const run = (frequencyMHz: number, extra: Partial<Nec2Run['raw']> = {}): Nec2Run => ({
    raw: { exitCode: 0, output: `report for ${frequencyMHz}`, stderr: '', elapsedMs: 10, ...extra },
    report: {
      comments: ['a model'],
      segments: [
        {
          index: 1,
          tag: 1,
          center: { x: 0, y: 0, z: 0 },
          start: { x: 0, y: -1, z: 0 },
          end: { x: 0, y: 1, z: 0 },
          length: 2,
          radius: 0.001,
        },
      ],
      frequencies: [
        { frequencyMHz, wavelengthM: 300 / frequencyMHz, environment: 'free-space', feeds: [], currents: [], patterns: [] },
      ],
      errors: [],
    },
  });

  it('keeps the frequencies in the order they were asked for, and the geometry once', () => {
    const merged = mergeRuns([run(14), run(14.1), run(14.2)], { elapsedMs: 1234 });
    expect(merged.report.frequencies.map((f) => f.frequencyMHz)).toEqual([14, 14.1, 14.2]);
    expect(merged.report.segments).toHaveLength(1);
    expect(merged.report.comments).toEqual(['a model']);
    expect(merged.raw.elapsedMs).toBe(1234);
    expect(merged.raw.output).toContain('report for 14.1');
  });

  it('carries a failure out of whichever piece failed', () => {
    const broken = run(14.1, { exitCode: -1, trap: 'divide by zero', stderr: 'boom' });
    const merged = mergeRuns([run(14), broken, run(14.2)], { elapsedMs: 5 });
    expect(merged.raw.exitCode).toBe(-1);
    expect(merged.raw.trap).toBe('divide by zero');
    expect(merged.raw.stderr).toBe('boom');
    // The good frequencies still come through.
    expect(merged.report.frequencies).toHaveLength(3);
  });

  it('gathers each error once', () => {
    const withError = (message: string) => {
      const r = run(14);
      return { ...r, report: { ...r.report, errors: [message] } };
    };
    const merged = mergeRuns([withError('SEGMENT CONNECTION ERROR'), withError('SEGMENT CONNECTION ERROR')], { elapsedMs: 1 });
    expect(merged.report.errors).toEqual(['SEGMENT CONNECTION ERROR']);
  });
});
