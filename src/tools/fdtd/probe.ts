// The field sandbox's probe: the field at one cell against time, and its spectrum.
//
// The engine steps in picoseconds, so a few thousand samples hold a hundred periods or more.
// The trace shows the last dozen; the spectrum takes everything recorded (up to PROBE_SAMPLES),
// through a Hann window so the recording's abrupt start and end do not smear one frequency
// across its neighbours, and is evaluated only where it is worth looking: DC to three times
// the scene's frequency. It is relative - dB below its own strongest point - because the
// fields themselves are relative.
//
// Public domain (The Unlicense). By ZR1JT.

export const PROBE_SAMPLES = 4096;
/** Below this, a level is drawn at the floor: a Hann window's sidelobes are already lower. */
export const SPECTRUM_FLOOR_DB = -60;

export interface ProbeRecord {
  /** The cell watched (i + j * nx). */
  k: number;
  /** The engine's step when recording began; sample m was taken after step firstStep + m + 1. */
  firstStep: number;
  /** A ring of the last PROBE_SAMPLES values. */
  values: Float32Array;
  count: number;
}

export function newProbeRecord(k: number, step: number): ProbeRecord {
  return { k, firstStep: step, values: new Float32Array(PROBE_SAMPLES), count: 0 };
}

/** Takes one sample: call after every step. */
export function recordProbe(record: ProbeRecord, field: Float32Array): void {
  record.values[record.count % PROBE_SAMPLES] = field[record.k] ?? 0;
  record.count++;
}

export interface ProbeView {
  /** The trace: time in ns, and the field. */
  timeNs: number[];
  trace: number[];
  /** The spectrum: frequency in MHz, and level in dB below this probe's own strongest point. */
  fMHz: number[];
  levelDb: number[];
  /** The spectrum's raw power per bin, and its largest - so several probes can share one reference. */
  power: number[];
  peakPower: number;
  /** Where the spectrum is strongest, MHz; undefined while all is silent. */
  peakMHz: number | undefined;
  /** How many periods of the scene's frequency the spectrum was taken over. */
  periods: number;
}

/**
 * Several probes' spectra against ONE reference - the strongest point of any of them - so
 * that a probe in a null reads so many dB below a probe in a lobe, which its own-peak
 * levels cannot say. Floored like the single-probe levels.
 */
export function levelsAgainstStrongest(views: ProbeView[]): number[][] {
  const top = Math.max(0, ...views.map((v) => v.peakPower));
  return views.map((v) => v.power.map((p) => (top > 0 && p > 0 ? Math.max(SPECTRUM_FLOOR_DB, 10 * Math.log10(p / top)) : SPECTRUM_FLOOR_DB)));
}

/** The recording, oldest first - at most `limit` of its latest samples. */
function samples(record: ProbeRecord, limit = PROBE_SAMPLES): Float32Array {
  const n = Math.max(0, Math.min(record.count, PROBE_SAMPLES, limit));
  const out = new Float32Array(n);
  const start = record.count - n;
  for (let m = 0; m < n; m++) out[m] = record.values[(start + m) % PROBE_SAMPLES]!;
  return out;
}

/**
 * Hann-windowed level at each frequency, dB below the strongest, floored; and the powers,
 * normalised by the window's sum so that a steady sine of amplitude A gives (A / 2)² however
 * long the recording - two probes started at different times can then share one reference.
 */
export function spectrum(x: Float32Array, dt: number, frequenciesHz: number[]): { levelDb: number[]; powers: number[]; peakIndex: number | undefined } {
  const n = x.length;
  const windowed = new Float64Array(n);
  let gain = 0;
  for (let m = 0; m < n; m++) {
    const w = n > 1 ? 0.5 - 0.5 * Math.cos((2 * Math.PI * m) / (n - 1)) : 1;
    windowed[m] = x[m]! * w;
    gain += w;
  }
  const scale = gain > 0 ? 1 / (gain * gain) : 0;
  const powers = frequenciesHz.map((f) => {
    // Rotate a phasor sample by sample rather than call cos and sin n times per bin.
    const step = 2 * Math.PI * f * dt;
    const cs = Math.cos(step);
    const sn = Math.sin(step);
    let c = 1;
    let s = 0;
    let re = 0;
    let im = 0;
    for (let m = 0; m < n; m++) {
      const v = windowed[m]!;
      re += v * c;
      im -= v * s;
      const c2 = c * cs - s * sn;
      s = s * cs + c * sn;
      c = c2;
    }
    return (re * re + im * im) * scale;
  });
  let peakIndex: number | undefined;
  powers.forEach((p, b) => {
    if (p > 0 && (peakIndex === undefined || p > powers[peakIndex]!)) peakIndex = b;
  });
  const top = peakIndex === undefined ? 0 : powers[peakIndex]!;
  const levelDb = powers.map((p) => (top > 0 && p > 0 ? Math.max(SPECTRUM_FLOOR_DB, 10 * Math.log10(p / top)) : SPECTRUM_FLOOR_DB));
  return { levelDb, powers, peakIndex };
}

/**
 * What the probe's charts show, or undefined before a single sample is in. Several probes
 * are compared over the SAME stretch of time - pass the shortest recording's length as
 * `limit` - because a wave that arrived partway through a longer recording averages weaker
 * than the same wave filling a shorter one, and a probe added later read louder than it was.
 */
export function probeView(record: ProbeRecord, dt: number, fHz: number, tracePeriods = 12, bins = 241, limit = PROBE_SAMPLES): ProbeView | undefined {
  const x = samples(record, limit);
  if (x.length < 2) return undefined;
  const start = record.count - x.length;
  const perPeriod = 1 / (fHz * dt);
  const traceLength = Math.min(x.length, Math.ceil(tracePeriods * perPeriod));
  const stride = Math.max(1, Math.ceil(traceLength / 400));
  const timeNs: number[] = [];
  const trace: number[] = [];
  // Thinned from the newest sample backwards, so the trace always ends at the present.
  for (let m = x.length - 1 - stride * Math.floor((traceLength - 1) / stride); m < x.length; m += stride) {
    timeNs.push((record.firstStep + start + m + 1) * dt * 1e9);
    trace.push(x[m]!);
  }
  const frequencies = Array.from({ length: bins }, (_, b) => (3 * fHz * b) / (bins - 1));
  const { levelDb, powers, peakIndex } = spectrum(x, dt, frequencies);
  return {
    timeNs,
    trace,
    fMHz: frequencies.map((f) => f / 1e6),
    levelDb,
    power: powers,
    peakPower: peakIndex === undefined ? 0 : powers[peakIndex]!,
    peakMHz: peakIndex === undefined ? undefined : frequencies[peakIndex]! / 1e6,
    periods: x.length / perPeriod,
  };
}
