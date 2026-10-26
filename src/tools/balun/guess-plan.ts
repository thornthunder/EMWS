// The step-by-step guess: what to wind next, and whether two windings agree.
//
// The page cannot know what is on the connector, so each reading is judged after the
// event, from the reading itself, by the rules measure.ts states: a one-port VNA is sure
// of itself between about 5 and 500 ohms, and a test winding that goes capacitive is the
// winding resonating, not the core - trust the curve only below a third of that. Too
// little impedance at the bottom of the sweep means more turns (|Z| goes as N²); a
// resonance low in the sweep means fewer (it goes roughly as N^-1.5: more turns is more
// inductance AND more capacitance). A second winding with a different count then confirms
// the first - the two must agree on the core once the turns are allowed for - which is
// how a miscounted turn or a poor contact shows itself. ZR1JT's three windings of a #31
// agreed within about 4 %; the 10 % allowed here is EMWS's own figure.
//
// Public domain (The Unlicense). By ZR1JT.

import type { MeasuredPoint } from '../../lib/touchstone';
import { trustworthyUpToMHz } from './measure';

/**
 * Low enough to see the knee of a manganese-zinc mix (about 1 MHz), high enough for the
 * nickel-zinc ones, and dense: instruments sweep linearly, and ZR1JT's #77 showed that a
 * 0.5-50 MHz sweep of 201 points left only five of them where that core's whole story was.
 * 401 points is what a classic NanoVNA allows. A FieldFox that cannot go this low gets the
 * range changed on the connect step.
 */
export const WIZARD_SWEEP = { startMHz: 0.2, stopMHz: 30, points: 401 };
/** Two windings that go capacitive within this of each other went capacitive on the CORE. */
export const SAME_CROSSING_WITHIN = 0.15;
export const FIRST_TURNS = 3;
/** Under this at the bottom of the sweep a one-port reading is unsure. */
export const LOW_OHMS = 5;
/** A winding whose curve is the core's only below this is wound too far for the sweep. */
export const MIN_TRUST_MHZ = 3;
/** Two windings agree when their curves match within this, once the turns are allowed for. */
export const AGREE_WITHIN = 0.1;

export interface Reading {
  turns: number;
  points: MeasuredPoint[];
  /** Where it came from: the instrument and range, or a file name. */
  source: string;
}

export interface Judgement {
  ohmsLow: number;
  atMHz: number;
  trustMHz?: number;
  verdict: 'good' | 'more-turns' | 'fewer-turns';
  /** What to wind next: the same count when the reading is good. */
  nextTurns: number;
  why: string;
}

const lowestPoint = (points: readonly MeasuredPoint[]) => points.reduce((a, b) => (b.fMHz < a.fMHz ? b : a));

export function judgeReading(reading: Reading): Judgement {
  const { turns, points } = reading;
  if (points.length === 0) return { ohmsLow: 0, atMHz: 0, verdict: 'more-turns', nextTurns: turns, why: 'The sweep came back empty.' };
  const low = lowestPoint(points);
  const ohmsLow = Math.hypot(low.z.re, low.z.im);
  const trustMHz = trustworthyUpToMHz(points);
  if (ohmsLow < LOW_OHMS) {
    // |Z| goes as N²: aim at twice the floor, never more than four times the turns.
    const next = Math.min(turns * 4, Math.max(turns + 1, Math.ceil(turns * Math.sqrt((2 * LOW_OHMS) / Math.max(ohmsLow, 0.1)))));
    return {
      ohmsLow,
      atMHz: low.fMHz,
      trustMHz,
      verdict: 'more-turns',
      nextTurns: next,
      why: `Only ${ohmsLow.toFixed(1)} Ω at ${low.fMHz} MHz - too little for a one-port reading to be sure of. ${next} turns should give about ${(ohmsLow * (next / turns) ** 2).toFixed(0)} Ω there.`,
    };
  }
  if (trustMHz !== undefined && trustMHz < MIN_TRUST_MHZ && turns > 1) {
    // The resonance goes roughly as N^-1.5, so to lift the trust limit to the minimum:
    const next = Math.max(1, Math.min(turns - 1, Math.floor(turns * (trustMHz / MIN_TRUST_MHZ) ** (2 / 3))));
    return {
      ohmsLow,
      atMHz: low.fMHz,
      trustMHz,
      verdict: 'fewer-turns',
      nextTurns: next,
      why: `The winding resonates at ${(3 * trustMHz).toFixed(1)} MHz, so the reading is the core's only below ${trustMHz.toFixed(1)} MHz - too little of the sweep. ${next} ${next === 1 ? 'turn' : 'turns'} should push that up.`,
    };
  }
  return {
    ohmsLow,
    atMHz: low.fMHz,
    trustMHz,
    verdict: 'good',
    nextTurns: turns,
    why:
      `${ohmsLow.toFixed(0)} Ω at ${low.fMHz} MHz` +
      (trustMHz === undefined
        ? ', and the winding never resonated in the sweep.'
        : `, trustworthy up to ${trustMHz.toFixed(1)} MHz${trustMHz < MIN_TRUST_MHZ ? ' - though with one turn that is more likely the core itself going capacitive, which a second winding will tell' : ''}.`),
  };
}

/** Where a reading first goes capacitive, if it does. */
export function capacitiveAtMHz(points: readonly MeasuredPoint[]): number | undefined {
  return [...points].sort((a, b) => a.fMHz - b.fMHz).find((p) => p.z.im <= 0)?.fMHz;
}

/**
 * Two windings with different counts that go capacitive at the same frequency: that is the
 * core's own crossing - a large manganese-zinc core takes its mu' through zero at a few
 * megahertz, conducting as it does - and not the winding resonating, which would move with
 * the count (as about N^-1.5: one more turn on three moves it by half). ZR1JT's #77 in an
 * FT240 size did this at 1.7 MHz with one turn and with two.
 */
export function commonCrossing(first: Reading, second: Reading): number | undefined {
  if (first.turns === second.turns) return undefined;
  const a = capacitiveAtMHz(first.points);
  const b = capacitiveAtMHz(second.points);
  if (a === undefined || b === undefined) return undefined;
  if (Math.abs(Math.log(a / b)) > Math.log(1 + SAME_CROSSING_WITHIN)) return undefined;
  return Math.sqrt(a * b);
}

/** One reading of this run and what was made of it. */
export interface Tried {
  reading: Reading;
  judgement: Judgement;
}

/**
 * A second winding with a different count: one more, unless the first already sat near
 * the resonance limit - then one fewer. Never a count this run has tried and found wanting;
 * undefined when both neighbours have been, in which case the reading stands alone.
 */
export function confirmingTurns(first: Reading, judgement: Judgement, history: readonly Tried[] = []): number | undefined {
  const wanting = (n: number) => history.some((h) => h.reading.turns === n && h.judgement.verdict !== 'good');
  const preferFewer = judgement.trustMHz !== undefined && judgement.trustMHz < 2 * MIN_TRUST_MHZ && first.turns > 1;
  const order = preferFewer ? [first.turns - 1, first.turns + 1] : [first.turns + 1, first.turns - 1];
  return order.find((n) => n >= 1 && !wanting(n));
}

/** The reading to fall back on: a good one, else one with enough impedance that is the core's furthest up the sweep. */
export function bestSoFar(tried: readonly Tried[]): Reading | undefined {
  const good = tried.filter((t) => t.judgement.verdict === 'good');
  const pool = good.length > 0 ? good : tried.filter((t) => t.judgement.ohmsLow >= LOW_OHMS);
  return pool.reduce<Tried | undefined>((best, t) => (!best || usableTop(t.reading.points) > usableTop(best.reading.points) ? t : best), undefined)?.reading;
}

/**
 * The judgement in the light of what this run has tried already. Two things a single
 * reading cannot know. Whether a capacitive point is the core's own crossing: when an
 * earlier winding with a different count crossed at the same frequency, it is, and the
 * reading is good up to there. And whether the count it would ask for next has already
 * been tried and judged the other way: then the two rules disagree on this core - ZR1JT's
 * #77 was asked for one turn, then two, then one, then two, five times over, one turn
 * giving too little impedance and two "resonating" at the core's own 1.7 MHz - and the
 * best reading in hand is used instead of asking again.
 */
export function judgeNext(reading: Reading, history: readonly Tried[]): { judgement: Judgement; coreCrossingMHz?: number; use?: Reading } {
  const base = judgeReading(reading);
  const twin = history.find((h) => commonCrossing(h.reading, reading) !== undefined);
  const coreCrossingMHz = twin ? commonCrossing(twin.reading, reading) : undefined;
  if (base.verdict === 'fewer-turns' && twin && coreCrossingMHz !== undefined) {
    return {
      coreCrossingMHz,
      judgement: {
        ...base,
        verdict: 'good',
        nextTurns: reading.turns,
        why: `${base.ohmsLow.toFixed(0)} Ω at ${base.atMHz} MHz, and the reading goes capacitive at ${coreCrossingMHz.toFixed(2)} MHz just as the ${twin.reading.turns}-turn one did: that is the core itself, not the winding, and the curve is trusted up to there.`,
      },
    };
  }
  if (base.verdict !== 'good' && history.some((h) => h.reading.turns === base.nextTurns)) {
    const use = bestSoFar([...history, { reading, judgement: base }]);
    if (use) {
      const why = `${base.why.replace(/ \d+ turns? should .*$/, '')} ${base.nextTurns} ${base.nextTurns === 1 ? 'turn was' : 'turns were'} tried already and judged the other way, so the ${use.turns}-turn reading is used.`;
      return { coreCrossingMHz, judgement: { ...base, verdict: 'good', nextTurns: use.turns, why }, use };
    }
  }
  return { judgement: base, coreCrossingMHz };
}

export interface Agreement {
  /** The first reading's curve over the second's, once the turns are allowed for. 1 is perfect. */
  ratio: number;
  fromMHz: number;
  toMHz: number;
  agrees: boolean;
}

const usableTop = (points: readonly MeasuredPoint[]) => Math.min(points.reduce((m, p) => Math.max(m, p.fMHz), 0), trustworthyUpToMHz(points) ?? Infinity);

/** Reactance at a frequency, interpolated on a log axis; undefined outside the points. */
function reactanceAt(sorted: readonly MeasuredPoint[], fMHz: number): number | undefined {
  const i = sorted.findIndex((p) => p.fMHz >= fMHz);
  if (i < 0) return undefined;
  if (i === 0) return sorted[0]!.fMHz === fMHz ? sorted[0]!.z.im : undefined;
  const a = sorted[i - 1]!;
  const b = sorted[i]!;
  const t = (Math.log(fMHz) - Math.log(a.fMHz)) / (Math.log(b.fMHz) - Math.log(a.fMHz));
  return a.z.im + t * (b.z.im - a.z.im);
}

/**
 * How two windings of one core agree: the geometric mean, over the range both readings
 * are the core's, of the reactance per turn squared of the first over the second.
 * Reactance rather than |Z|, because the loss part is the noisier of the two.
 */
export function agreement(first: Reading, second: Reading, coreCrossingMHz?: number): Agreement | undefined {
  const a = [...first.points].sort((p, q) => p.fMHz - q.fMHz);
  const b = [...second.points].sort((p, q) => p.fMHz - q.fMHz);
  if (a.length < 2 || b.length < 2) return undefined;
  const fromMHz = Math.max(a[0]!.fMHz, b[0]!.fMHz);
  // When the capacitive point is the core's own, both are the core's right up to it.
  const toMHz = coreCrossingMHz !== undefined ? Math.min(coreCrossingMHz, a[a.length - 1]!.fMHz, b[b.length - 1]!.fMHz) : Math.min(usableTop(a), usableTop(b));
  if (!(toMHz > fromMHz)) return undefined;
  const n = 24;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const f = fromMHz * (toMHz / fromMHz) ** (i / (n - 1));
    const xa = reactanceAt(a, f);
    const xb = reactanceAt(b, f);
    if (xa === undefined || xb === undefined || xa <= 0 || xb <= 0) continue;
    sum += Math.log(xa / first.turns ** 2 / (xb / second.turns ** 2));
    count++;
  }
  if (count < 4) return undefined;
  const ratio = Math.exp(sum / count);
  return { ratio, fromMHz, toMHz, agrees: Math.abs(Math.log(ratio)) <= Math.log(1 + AGREE_WITHIN) };
}

/** Of two good readings, the one that is the core's over more of the sweep; the later one when they tie. */
export function betterReading(first: Reading, second: Reading): Reading {
  return usableTop(first.points) > usableTop(second.points) ? first : second;
}
