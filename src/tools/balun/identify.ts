// What is the core in your hand? A guess from its measurement.
//
// A measured profile is a permeability curve, mu'(f) and mu''(f). EMWS knows six mixes as
// pictures of its own - an initial permeability and a family, with the frequency behaviour
// estimated through Snoek's law (ferrite.ts) - and it knows the other cores you measured.
// This compares the measured curve with each of those and says which it most resembles.
//
// What decides is the SHAPE of the curve, in two parts that are each a ratio and so do not
// depend on the turns or the dimensions typed in, nor on how far a built-in picture's
// absolute level sits from the real material:
//   - the loss angle atan(mu'' / mu') against frequency, and
//   - the fall-off of mu' relative to its own value at the bottom of the compared range,
// both sampled evenly on a log axis over the part of the sweep that is the core's. The
// LEVEL - how mu' compares with the picture's mu' - is reported beside them, never ranked
// on, for a reason that was measured: ZR1JT's Fair-Rite #31 (2026-10-05, three windings)
// read mu' 2100 at 1 MHz where its picture has 1200 - 1.7x the level, the same shape. Ranked
// on level it came out as #43 or #77; on the loss angle the two- and three-turn readings
// said #31 (0.17 and 0.10 radians RMS). The 1.7x turned out (2026-10-25) to be the HEIGHT
// typed into those measurements: 12.7 mm for a core that is 20 mm (ratio 1.57); measured
// again with the right size it reads 1598 at 0.2 MHz, the maker's 1500. The level depends
// on what is typed; the shape does not - which is the point. The fall-off was added after
// ZR1JT's #77 (2026-10-25): compared over a
// sliver of 0.50-0.58 MHz its loss angle looked nickel-zinc, while its mu' halving by
// 1.49 MHz is the #77 picture to the digit - and a sliver is now refused outright.
//
// A large manganese-zinc core can take its mu' through zero at a few megahertz on its own
// (it conducts, and resonates on its own dimensions); the reading goes capacitive and
// measure.ts's rule - "a bare core never does" - reads it as the winding resonating. Two
// windings tell them apart: a winding resonance moves with the turns, the core's own
// crossing does not. The step-by-step guess passes that in as a hint, and the curve is
// then trusted up to the crossing. tests/identify.test.ts holds all of it.
//
// Public domain (The Unlicense). By ZR1JT.

import { type FerriteFamily, type Permeability, debyePermeability, interpolatePermeability, snoekRelaxationMHz } from '../../lib/ferrite';
import { CORES, type CoreSize, MATERIALS, type Material } from './catalog';
import type { CoreProfile } from './profiles';
import { isReference } from './reference-cores';

/** Combined shape score (loss angle in radians, fall-off in log units, RMS together) under which a picture "fits"; under ROUGHLY_BELOW it is "roughly like". */
export const FITS_BELOW = 0.2;
export const ROUGHLY_BELOW = 0.4;
/** A runner-up this close to the best is named too. */
export const RUNNER_UP_GAP = 0.1;
/** A catalogue size is reported when every dimension is within this. */
export const SIZE_TOLERANCE = 0.1;
/** The compared range must span at least this ratio - an octave - or nothing is said. */
export const MIN_SPAN = 2;
/** ...and must hold some shape: mu' down by this fraction, or the loss angle up to SHAPE_ANGLE (radians), by its top. */
export const SHAPE_FALL = 0.2;
export const SHAPE_ANGLE = (15 * Math.PI) / 180;
const SAMPLES = 40;
/** A one-port VNA is unsure below this many ohms (measure.ts says 5 to 500). */
const LOW_OHMS = 5;

export interface Candidate {
  id: string;
  name: string;
  family: FerriteFamily;
  /** A built-in picture of a mix, one of your own measured cores, or a measured core shipped with EMWS. */
  kind: 'mix' | 'core' | 'reference';
  /** What to call a core that matches this: the mix's name, or a measured core's mix label when it has one. */
  callIt?: string;
  /** RMS difference of loss angle over the compared range, radians. */
  angleRms: number;
  /** RMS difference of ln(mu' / mu' at the bottom of the range) over the compared range. */
  shapeRms: number;
  /** The two together: what the ranking is on. */
  score: number;
  /** Geometric mean of mu' measured over mu' of the candidate, over the same range. Information only. */
  levelRatio: number;
}

export interface SizeMatch {
  core: CoreSize;
  /** The worst of the three dimensions' relative differences. */
  deviation: number;
}

export type Fit = 'fits' | 'roughly' | 'none';

export interface Hints {
  /** Both windings went capacitive here, so it is the core's own crossing: trust the curve up to it. */
  coreCrossingMHz?: number;
}

export interface CoreGuess {
  /** The range compared: the sweep, cut where the reading stops being the core's. */
  fromMHz: number;
  toMHz: number;
  muLow: number;
  lossLow: number;
  /** |Z| of the test winding at the bottom of the sweep: the measurement's own footing. */
  ohmsLow: number;
  /** mu' still dropping at the bottom: the sweep started above the material's knee. */
  stillFalling: boolean;
  /** Where the loss overtakes the reactance, if it does within the compared range. */
  crossoverMHz?: number;
  /** Where mu' has fallen to half its value at the bottom, if it does in the sweep. */
  halfMHz?: number;
  /** The comparison stopped there: the pictures describe the knee, not the tail. */
  cutAtHalf: boolean;
  /** Where the reading went capacitive, if it did: the winding resonating - or the core itself. */
  capacitiveAtMHz?: number;
  /** The hint, when given: the capacitive point is the core's own and the curve is trusted up to it. */
  coreCrossingMHz?: number;
  /** Every candidate, best first. */
  candidates: Candidate[];
  best?: Candidate;
  /** Runners-up within RUNNER_UP_GAP of the best and themselves at least "roughly" like it. */
  alsoPossible: Candidate[];
  fit: Fit;
  /** The family, when the best and the runners-up agree on it. */
  family?: FerriteFamily;
  /** When nothing fits: the family the three nearest pictures share, if they share one. */
  nearestFamily?: FerriteFamily;
  /** The candidate to call it after: the best, or the nearest within the runner-up gap that carries a mix label (`callIt`). */
  suggestedMix?: Candidate;
  /** Why no verdict could be given, when none could. */
  undecidable?: string;
  size?: SizeMatch;
  caveats: string[];
}

const lossAngle = (mu: Permeability) => Math.atan2(Math.max(0, mu.loss), Math.max(1e-9, mu.real));

/** The catalogue size nearest the dimensions, if one is within SIZE_TOLERANCE on every dimension. */
export function nearestSize(size: Pick<CoreSize, 'odMm' | 'idMm' | 'heightMm'>, sizes: readonly CoreSize[] = CORES): SizeMatch | undefined {
  let best: SizeMatch | undefined;
  for (const core of sizes) {
    const deviation = Math.max(Math.abs(core.odMm / size.odMm - 1), Math.abs(core.idMm / size.idMm - 1), Math.abs(core.heightMm / size.heightMm - 1));
    if (!best || deviation < best.deviation) best = { core, deviation };
  }
  return best && best.deviation <= SIZE_TOLERANCE ? best : undefined;
}

export function identifyCore(profile: CoreProfile, others: readonly CoreProfile[] = [], materials: readonly Material[] = MATERIALS, sizes: readonly CoreSize[] = CORES, hints: Hints = {}): CoreGuess {
  const curve = profile.curve;
  const caveats: string[] = [];
  const size = nearestSize(profile.size, sizes);
  const first = curve[0];
  const last = curve[curve.length - 1];
  if (!first || !last) {
    return { fromMHz: 0, toMHz: 0, muLow: 0, lossLow: 0, ohmsLow: 0, stillFalling: false, cutAtHalf: false, candidates: [], alsoPossible: [], fit: 'none', undecidable: 'Nothing was measured.', size, caveats: ['Nothing was measured.'] };
  }

  const fromMHz = first.fMHz;
  // A saved profile carries its own crossing, when the step-by-step guess found one.
  const coreCrossingMHz = hints.coreCrossingMHz ?? profile.coreCrossingMHz;
  const capacitiveAtMHz = coreCrossingMHz ?? (profile.trustworthyUpToMHz !== undefined ? 3 * profile.trustworthyUpToMHz : undefined);
  let toMHz: number;
  if (coreCrossingMHz !== undefined) {
    toMHz = Math.min(last.fMHz, coreCrossingMHz);
    caveats.push(
      `Both windings went capacitive at ${coreCrossingMHz.toFixed(2)} MHz, so that is the core itself, not the winding: a large manganese-zinc core does this (it conducts, and resonates on its own dimensions in the low megahertz); nickel-zinc does not at HF. The curve is trusted up to there. None of EMWS's pictures includes the effect.`,
    );
  } else {
    toMHz = Math.min(last.fMHz, profile.trustworthyUpToMHz ?? Infinity);
    if (capacitiveAtMHz !== undefined && toMHz < last.fMHz) {
      caveats.push(
        `The reading went capacitive at ${capacitiveAtMHz.toFixed(2)} MHz. Taken as the test winding resonating, so only up to ${toMHz.toFixed(2)} MHz is compared. If a second winding with a different count goes capacitive at the same frequency, that is the core itself and the curve is good up to it - the step-by-step guess checks this.`,
      );
    }
  }

  const lowest = profile.sweep.reduce((a, b) => (b.fMHz < a.fMHz ? b : a), profile.sweep[0] ?? { fMHz: fromMHz, r: 0, x: 0 });
  const ohmsLow = Math.hypot(lowest.r, lowest.x);
  if (ohmsLow > 0 && ohmsLow < LOW_OHMS) {
    caveats.push(`Only ${ohmsLow.toFixed(1)} Ω at the bottom of the sweep: a one-port reading is uncertain that low, and the shape with it. More turns would help.`);
  }

  const at = (f: number) => interpolatePermeability(curve, f);
  const muLow = first.real;
  const lossLow = first.loss;
  const stillFalling = at(fromMHz * 1.5).real < 0.9 * muLow;
  if (stillFalling) caveats.push("μ′ is still falling at the bottom of the sweep, so the sweep starts above the material's knee; starting lower would show more of the shape.");
  // The pictures are one relaxation each: they describe the knee, where mu' falls to half,
  // not the tail beyond it - real ferrite falls off far more slowly there (ZR1JT's #31: 534
  // at 10 MHz where its picture has 58), and a large MnZn core plunges through zero (the
  // #77: nothing left at 1.74 MHz, halved at 1.49). So the comparison stops where mu' has
  // halved, which is where a picture's relaxation frequency sits.
  // The octave rule is about how much of the sweep is the core's at all; the cut at the
  // half below is the method's own choice of where to stop, and a window that holds the
  // knee is informative however narrow (the #73 picture swept from 1 MHz halves by 1.85).
  const usableTop = toMHz;
  const half = curve.find((p) => p.fMHz >= fromMHz && p.fMHz <= toMHz && p.real <= muLow / 2);
  const cutAtHalf = half !== undefined && half.fMHz < toMHz;
  if (cutAtHalf) toMHz = half.fMHz;
  const crossover = curve.find((p) => p.fMHz >= fromMHz && p.fMHz <= toMHz && p.real > 0 && p.loss >= p.real);

  const base = { fromMHz, toMHz, muLow, lossLow, ohmsLow, stillFalling, crossoverMHz: crossover?.fMHz, halfMHz: half?.fMHz, cutAtHalf, capacitiveAtMHz, coreCrossingMHz, size };

  // Below every knee all the pictures are flat and lossless, and a flat measured curve
  // "fits" each of them to a few hundredths - ZR1JT's #77 over 0.2-0.51 MHz read "#43, or
  // #52 or #61" at 0.05. A verdict needs some shape in the window: mu' fallen by a fifth,
  // or the loss angle up to 15 degrees, by the top of it.
  const top = at(toMHz);
  const hasShape = top.real <= (1 - SHAPE_FALL) * muLow || lossAngle(top) >= SHAPE_ANGLE;
  if (!hasShape && toMHz / fromMHz >= MIN_SPAN) {
    const undecidable = `Flat so far: over ${fromMHz.toFixed(2)} to ${toMHz.toFixed(2)} MHz μ′ has not fallen by a fifth and the loss angle has not reached 15°, which is below the knee of every mix EMWS knows - nothing to tell them apart by. ${
      capacitiveAtMHz !== undefined && coreCrossingMHz === undefined
        ? 'The reading went capacitive above there: measure a second winding with a different count - if it goes capacitive at the same frequency, that is the core itself and the curve can be trusted up to it.'
        : 'Sweep higher, or the knee is above what this winding can show.'
    }`;
    return { ...base, candidates: [], alsoPossible: [], fit: 'none', undecidable, caveats: [...caveats, undecidable] };
  }

  if (!(usableTop / fromMHz >= MIN_SPAN)) {
    const undecidable = `Only ${fromMHz.toFixed(2)} to ${usableTop.toFixed(2)} MHz of the sweep is the core's - less than an octave, too little to compare shapes. ${
      capacitiveAtMHz !== undefined ? 'Measure a second winding with a different count: if it goes capacitive at the same frequency, that is the core itself and the curve can be trusted further. Otherwise wind fewer turns, or sweep from lower.' : 'Sweep from lower, or over more of the band.'
    }`;
    return { ...base, candidates: [], alsoPossible: [], fit: 'none', undecidable, caveats: [...caveats, undecidable] };
  }

  const samples = Array.from({ length: SAMPLES }, (_, i) => fromMHz * (toMHz / fromMHz) ** (i / (SAMPLES - 1)));
  const measured = samples.map((f) => ({ f, mu: at(f) })).filter((s) => s.mu.real > 1);
  if (measured.length < 5) {
    const undecidable = 'Too little of the sweep is usable to compare shapes: μ′ is below 1 almost everywhere, which no ferrite gives - check the turns and the size.';
    return { ...base, candidates: [], alsoPossible: [], fit: 'none', undecidable, caveats: [...caveats, undecidable] };
  }
  const measuredLow = measured[0]!.mu.real;

  const compare = (model: (f: number) => Permeability) => {
    const modelLow = Math.max(1e-9, model(measured[0]!.f).real);
    let angle = 0;
    let shape = 0;
    let level = 0;
    for (const s of measured) {
      const m = model(s.f);
      angle += (lossAngle(s.mu) - lossAngle(m)) ** 2;
      shape += (Math.log(s.mu.real / measuredLow) - Math.log(Math.max(1e-9, m.real) / modelLow)) ** 2;
      level += Math.log(s.mu.real / Math.max(1e-9, m.real));
    }
    const n = measured.length;
    return { angleRms: Math.sqrt(angle / n), shapeRms: Math.sqrt(shape / n), score: Math.sqrt((angle + shape) / n), levelRatio: Math.exp(level / n) };
  };

  const candidates: Candidate[] = [];
  for (const m of materials) {
    if (m.curve && m.curve.length > 0) continue; // measured materials come in as the profiles below
    const fr = snoekRelaxationMHz(m.muInitial, m.family);
    candidates.push({ id: m.id, name: m.name, family: m.family, kind: 'mix', callIt: m.name, ...compare((f) => debyePermeability(m.muInitial, fr, f)) });
  }
  for (const other of others) {
    if (other.id === profile.id || other.curve.length === 0) continue;
    // A measured core labelled with a mix ("#43") can be called that; "unknown" cannot.
    const callIt = /^#\d+/.test(other.mix.trim()) ? other.mix.trim() : undefined;
    candidates.push({ id: other.id, name: other.name, family: other.family, kind: isReference(other.id) ? 'reference' : 'core', callIt, ...compare((f) => interpolatePermeability(other.curve, f)) });
  }
  candidates.sort((a, b) => a.score - b.score);

  const best = candidates[0];
  const fit: Fit = !best ? 'none' : best.score <= FITS_BELOW ? 'fits' : best.score <= ROUGHLY_BELOW ? 'roughly' : 'none';
  const alsoPossible = best ? candidates.slice(1).filter((c) => c.score - best.score <= RUNNER_UP_GAP && c.score <= ROUGHLY_BELOW) : [];
  const family = best && fit !== 'none' && alsoPossible.every((c) => c.family === best.family) ? best.family : undefined;
  const suggestedMix = best && fit !== 'none' ? [best, ...alsoPossible].find((c) => c.callIt !== undefined) : undefined;
  const nearestMixes = candidates.filter((c) => c.kind === 'mix').slice(0, 3);
  const nearestFamily = fit === 'none' && nearestMixes.length === 3 && nearestMixes.every((c) => c.family === nearestMixes[0]!.family) ? nearestMixes[0]!.family : undefined;

  return { ...base, candidates, best, alsoPossible, fit, family, nearestFamily, suggestedMix, caveats };
}
