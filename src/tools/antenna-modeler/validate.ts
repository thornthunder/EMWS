// Checks a model against the rules NEC-2 needs for trustworthy results, and explains
// problems in terms of the drawing, before the engine gets a chance to be cryptic.

import { segmentApproach } from '../../lib/vec3';
import { estimateResultBytes, estimateSolveMs, formatBytes, formatDuration } from './cost';
import {
  type AntennaModel,
  type Wire,
  frequenciesOf,
  highestFrequencyMHz,
  joined,
  segmentLength,
  suggestedSegments,
  wavelengthM,
  wireLength,
} from './model';

export interface Issue {
  severity: 'error' | 'warning';
  message: string;
  /** Wires the issue concerns, for highlighting and selecting. */
  wireIds: string[];
}

/** Segments longer than this fraction of a wavelength give poor results. */
const MAX_SEGMENT_WAVELENGTHS = 0.1;
/** NEC-2's thin-wire kernel wants segments at least this many times the wire radius. */
const MIN_SEGMENT_TO_RADIUS = 8;
/** Ends this close (as a fraction of a segment) but not joined were almost certainly meant to join. */
const NEAR_MISS = 0.05;
/** Say something before a run that will keep somebody waiting. */
const SLOW_RUN_MS = 10_000;
/**
 * Where a sweep's results start to threaten the tab. Conservative on purpose: a desktop
 * browser will often go further, but a phone will not, and a crash loses the model.
 */
const HEAVY_RESULT_BYTES = 500 * 1024 * 1024;

function label(w: Wire): string {
  return `Wire ${w.tag}`;
}

function formatMHz(f: number): string {
  return `${Number(f.toPrecision(6))} MHz`;
}

export interface ValidateOptions {
  /** How many frequencies will be solved at once. */
  workers?: number;
  /** False when a remote solver is doing the work and its speed is unknown to us. */
  estimateSpeed?: boolean;
}

export function validateModel(model: AntennaModel, options: ValidateOptions = {}): Issue[] {
  const { workers = 1, estimateSpeed = true } = options;
  const issues: Issue[] = [];
  const error = (message: string, ...wires: Wire[]) =>
    issues.push({ severity: 'error', message, wireIds: wires.map((w) => w.id) });
  const warn = (message: string, ...wires: Wire[]) =>
    issues.push({ severity: 'warning', message, wireIds: wires.map((w) => w.id) });

  const plan = model.frequency;
  const frequencies = frequenciesOf(plan);
  if (frequencies.some((f) => !(f > 0))) {
    error('Every frequency must be above 0 MHz.');
    return issues;
  }
  if (plan.steps > 1 && plan.stepMHz <= 0) error('A sweep needs a positive frequency step.');

  if (model.wires.length === 0) {
    error('There are no wires yet. Choose Draw wires, or right-click in a view and choose Add wire from here.');
    return issues;
  }
  if (model.feeds.length === 0) {
    warn('Nothing is driven yet. Right-click a wire and choose Feed here.');
  }

  const topMHz = highestFrequencyMHz(plan);
  const wavelength = wavelengthM(topMHz);
  const hasGround = model.ground.kind !== 'free-space';

  for (const w of model.wires) {
    const len = wireLength(w);
    if (len === 0) {
      error(`${label(w)} has zero length: both ends are at the same point.`, w);
      continue;
    }
    if (!(w.radius > 0)) error(`${label(w)} needs a diameter greater than zero.`, w);

    const seg = segmentLength(w);
    if (hasGround && Math.min(w.a.z, w.b.z) < -seg * 1e-3) {
      error(`${label(w)} goes below ground (Z < 0). NEC-2 cannot model buried wires.`, w);
    }
    if (seg > MAX_SEGMENT_WAVELENGTHS * wavelength) {
      warn(
        `${label(w)}: its segments are ${(seg / wavelength).toFixed(2)} λ long at ${formatMHz(topMHz)}. ` +
          `NEC-2 needs under ${MAX_SEGMENT_WAVELENGTHS} λ; use ${suggestedSegments(len, wavelength)} segments.`,
        w,
      );
    }
    if (w.radius > 0 && seg < MIN_SEGMENT_TO_RADIUS * w.radius) {
      warn(
        `${label(w)}: its segments are only ${(seg / w.radius).toFixed(1)} times the wire radius. ` +
          `NEC-2's thin-wire model wants at least about ${MIN_SEGMENT_TO_RADIUS}; use fewer segments or thinner wire.`,
        w,
      );
    }
  }

  // A big model is not wrong, but nobody should discover the wait by sitting through it.
  const segments = model.wires.reduce((n, w) => n + w.segments, 0);
  const estimate = estimateSolveMs(segments, frequencies.length, workers);
  if (estimateSpeed && estimate > SLOW_RUN_MS) {
    const sensible = model.wires.reduce((n, w) => n + suggestedSegments(wireLength(w), wavelength), 0);
    warn(
      `This will take ${formatDuration(estimate)} to solve: ${segments} segments` +
        `${frequencies.length > 1 ? ` at ${frequencies.length} frequencies` : ''}. ` +
        `The work grows with the cube of the segment count, so halving it is eight times quicker. ` +
        `Auto-segment would use ${sensible}.`,
    );
  }

  // Time is not the only thing a long sweep spends. Every frequency keeps a current
  // reading for every segment, so the results themselves can outgrow the browser tab -
  // and running out of memory loses the model, where waiting only costs patience.
  const resultBytes = estimateResultBytes(segments, frequencies.length);
  if (frequencies.length > 1 && resultBytes > HEAVY_RESULT_BYTES) {
    warn(
      `These results would need about ${formatBytes(resultBytes)} of memory: ` +
        `${segments} segments at ${frequencies.length} frequencies, and every frequency keeps ` +
        `a current reading for every segment. Fewer points, or fewer segments, will fit better ` +
        `than the browser will stretch.`,
    );
  }

  // Pairs of wires: near-miss junctions, ends landing part-way along a wire, crossings.
  for (let i = 0; i < model.wires.length; i++) {
    const w1 = model.wires[i]!;
    if (wireLength(w1) === 0) continue;
    for (let j = i + 1; j < model.wires.length; j++) {
      const w2 = model.wires[j]!;
      if (wireLength(w2) === 0) continue;
      const seg = Math.max(segmentLength(w1), segmentLength(w2));
      const ends1 = [w1.a, w1.b];
      const ends2 = [w2.a, w2.b];

      let isJoined = false;
      let nearMiss = false;
      for (const p of ends1) {
        for (const q of ends2) {
          if (joined(p, q, seg)) isJoined = true;
          else if (Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) < NEAR_MISS * Math.min(segmentLength(w1), segmentLength(w2))) {
            nearMiss = true;
          }
        }
      }
      if (nearMiss) {
        warn(`${label(w1)} and ${label(w2)} almost meet but are not joined. Drag one end onto the other to join them.`, w1, w2);
        continue;
      }
      if (isJoined) continue;

      const approach = segmentApproach(w1.a, w1.b, w2.a, w2.b);
      if (approach.distance > w1.radius + w2.radius) continue;
      const atEnd = (t: number) => t < 1e-6 || t > 1 - 1e-6;
      if (atEnd(approach.s) !== atEnd(approach.t)) {
        const [end, along] = atEnd(approach.s) ? [w1, w2] : [w2, w1];
        warn(
          `${label(end)} ends part-way along ${label(along)}. NEC-2 only joins wires at their ends, so they are not ` +
            `connected. Right-click ${label(along)} there and choose Split wire here.`,
          end,
          along,
        );
      } else {
        warn(`${label(w1)} and ${label(w2)} cross or touch. NEC-2 only joins wires at their ends.`, w1, w2);
      }
    }
  }

  return issues;
}
