// How long a model will take to solve.
//
// NEC-2 builds an N x N matrix of the interaction between every pair of segments and
// factorises it, so the work grows with the CUBE of the segment count, once per
// frequency. Doubling the segments is eight times the wait; that surprises people, so
// EMWS says so before they press Run.
//
// The starting figure comes from measuring nec2c in this WebAssembly build: 2000
// segments at one frequency took 11.0 s, and 100 to 1200 segments fit the same curve.
// Every real run then re-calibrates it for the machine it is running on.

const STORAGE_KEY = 'emws.antenna-modeler.solve-rate';
const PARALLEL_KEY = 'emws.antenna-modeler.parallel-efficiency';

/** Milliseconds per segment³, per frequency. */
const MEASURED_RATE = 10987 / 2000 ** 3;
/** Below this, the fixed costs matter more than the matrix, so a run tells us nothing. */
const CALIBRATION_FLOOR = 200;
/** Setting up each frequency, and the run itself. */
const PER_FREQUENCY_MS = 0.5;
const PER_RUN_MS = 25;

let rate = MEASURED_RATE;
/**
 * How much of an extra worker actually turns into speed. Never 1: cores share memory
 * bandwidth, and the cores a browser reports include hyperthreads. Measured around 0.36
 * on a four-core laptop reporting eight; calibrated per machine after the first sweep.
 */
let parallelEfficiency = 0.5;
try {
  const stored = Number(localStorage.getItem(STORAGE_KEY));
  if (Number.isFinite(stored) && stored > 0) rate = stored;
  const efficiency = Number(localStorage.getItem(PARALLEL_KEY));
  if (Number.isFinite(efficiency) && efficiency > 0) parallelEfficiency = efficiency;
} catch {
  // storage can be blocked; the built-in figures are fine
}

/** Frequencies solved at once, allowing for the fact that workers never scale perfectly. */
function effectiveWorkers(workers: number): number {
  return Math.max(1, 1 + (Math.max(1, workers) - 1) * parallelEfficiency);
}

/**
 * Roughly how much memory a sweep's results will occupy.
 *
 * EMWS keeps the parsed report for every frequency, and each one carries a current entry
 * per segment - so the cost is segments x frequencies, not frequencies alone. Measured
 * under Node at 601 segments: 50 frequencies retained 8 MB and 200 retained 31 MB, both
 * about 275 bytes per entry once the fixed overhead stops dominating. Rounded up,
 * because a browser's object overhead is not smaller than Node's.
 */
const RESULT_BYTES_PER_ENTRY = 300;

export function estimateResultBytes(segments: number, frequencies: number): number {
  if (segments <= 0 || frequencies <= 0) return 0;
  return segments * frequencies * RESULT_BYTES_PER_ENTRY;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} kB`;
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function estimateSolveMs(segments: number, frequencies: number, workers = 1): number {
  if (segments <= 0 || frequencies <= 0) return 0;
  const perFrequency = rate * segments ** 3 + PER_FREQUENCY_MS;
  return PER_RUN_MS + (frequencies / effectiveWorkers(workers)) * perFrequency;
}

/** Teaches the estimate what this machine actually does. */
export function recordSolve(segments: number, frequencies: number, elapsedMs: number): void {
  if (segments < CALIBRATION_FLOOR || frequencies <= 0 || elapsedMs <= 0) return;
  const matrixMs = elapsedMs - PER_RUN_MS - frequencies * PER_FREQUENCY_MS;
  if (matrixMs <= 0) return;
  const measured = matrixMs / (frequencies * segments ** 3);
  // Move towards the new figure rather than jumping, so one busy moment doesn't skew it.
  rate = rate * 0.6 + measured * 0.4;
  try {
    localStorage.setItem(STORAGE_KEY, String(rate));
  } catch {
    // see above
  }
}

/** Learns what the extra workers were worth on this machine. */
export function recordParallelSolve(segments: number, frequencies: number, workers: number, elapsedMs: number): void {
  if (segments < CALIBRATION_FLOOR || workers < 2 || frequencies < 2 || elapsedMs <= 0) return;
  const sequentialMs = frequencies * (rate * segments ** 3 + PER_FREQUENCY_MS);
  const gained = sequentialMs / elapsedMs; // how many frequencies' worth of work happened at once
  const measured = Math.min(1, Math.max(0.05, (gained - 1) / (workers - 1)));
  parallelEfficiency = parallelEfficiency * 0.6 + measured * 0.4;
  try {
    localStorage.setItem(PARALLEL_KEY, String(parallelEfficiency));
  } catch {
    // see above
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return 'well under a second';
  if (ms < 1500) return 'about a second';
  if (ms < 90_000) return `about ${Math.round(ms / 1000)} seconds`;
  const minutes = ms / 60_000;
  return `about ${minutes < 10 ? minutes.toFixed(1) : Math.round(minutes)} minutes`;
}

/** Short form for a button. */
export function formatDurationShort(ms: number): string {
  if (ms < 1000) return '<1 s';
  if (ms < 90_000) return `~${Math.round(ms / 1000)} s`;
  const minutes = ms / 60_000;
  return `~${minutes < 10 ? minutes.toFixed(1) : Math.round(minutes)} min`;
}
