// Puts the pieces of a split sweep back together.
//
// A sweep solved one frequency per core comes back as several runs of one frequency
// each. They describe the same antenna, so the geometry is taken from the first and the
// frequency results are strung together in the order they were asked for.

import { TRAPPED } from './run';
import type { Nec2Report, Nec2Run } from './types';

export interface MergeOptions {
  /** Wall-clock time for the whole batch, which is what the person waited. */
  elapsedMs: number;
}

export function mergeRuns(runs: readonly Nec2Run[], options: MergeOptions): Nec2Run {
  if (runs.length === 0) {
    throw new Error('Nothing to merge');
  }
  const first = runs[0]!;
  if (runs.length === 1) return { ...first, raw: { ...first.raw, elapsedMs: options.elapsedMs } };

  // A run that fell over decides the exit code; a good one decides the geometry.
  const failed = runs.find((r) => r.raw.exitCode !== 0);
  const sound = runs.find((r) => r.report.segments.length > 0) ?? first;

  const report: Nec2Report = {
    comments: sound.report.comments,
    segments: sound.report.segments,
    frequencies: runs.flatMap((r) => r.report.frequencies),
    errors: [...new Set(runs.flatMap((r) => r.report.errors))],
  };

  return {
    raw: {
      exitCode: failed?.raw.exitCode ?? 0,
      trap: runs.find((r) => r.raw.trap !== undefined)?.raw.trap,
      output: runs.map((r) => r.raw.output).join('\n'),
      stderr: runs
        .map((r) => r.raw.stderr)
        .filter((s) => s !== '')
        .join('\n'),
      elapsedMs: options.elapsedMs,
    },
    report,
  };
}

/** Whether a run came back without the engine complaining. */
export function ranCleanly(run: Nec2Run): boolean {
  return run.raw.exitCode !== TRAPPED && run.raw.exitCode === 0 && run.report.errors.length === 0;
}
