// A VNA in a hook: connect, calibrate, sweep. This is the logic of MeasureWithVna lifted
// out of its markup, so that a step-by-step flow (the balun tool's "what is this core?")
// can show one instruction and one button at a time while the panel keeps its own layout.
// Both go by the same rules: a NanoVNA-V2 is raw until short, open and load have been
// measured over THIS range; standards must share their frequencies; a completed
// calibration survives a range change that it still covers.

import { useEffect, useRef, useState } from 'react';
import type { MeasuredPoint } from '../lib/touchstone';
import { type Instrument, VnaError } from '../lib/vna';
import { type Calibration, applyCalibration, calibrationCovers, makeCalibration, sameFrequencies } from '../lib/vna/calibration';

export type Standard = 'short' | 'open' | 'load';
export const STANDARDS: { id: Standard; label: string; hint: string }[] = [
  { id: 'short', label: 'Short', hint: 'the short from the calibration kit on the port' },
  { id: 'open', label: 'Open', hint: 'the open standard on the port (not just nothing)' },
  { id: 'load', label: 'Load', hint: 'the 50 Ω load on the port' },
];

export interface VnaRange {
  startMHz: number;
  stopMHz: number;
  points: number;
}

export interface Vna {
  instrument: Instrument | undefined;
  range: VnaRange;
  setRange: (range: VnaRange) => void;
  busy: string | undefined;
  setBusy: (what: string | undefined) => void;
  progress: [number, number] | undefined;
  error: string | undefined;
  /** Shows an error; `say(undefined)` clears it. */
  say: (e: unknown) => void;
  standards: Partial<Record<Standard, MeasuredPoint[]>>;
  calibration: Calibration | undefined;
  /** A V2: raw until calibrated here. */
  needsCalibration: boolean;
  calibrated: boolean;
  /** Whether the calibration covers the range as now set. */
  coverage: boolean;
  lastSweep: { points: number; at: string } | undefined;
  connected: (instrument: Instrument) => void;
  close: () => Promise<void>;
  /** Takes the sweep from the instrument's own front panel, where it can be asked (the bridge). */
  followInstrument: () => Promise<void>;
  /** Sweeps one standard; true when it was taken. */
  measureStandard: (id: Standard) => Promise<boolean>;
  /** A calibrated sweep of whatever is on the port; undefined on failure, with the reason in `error`. */
  sweep: (what?: string) => Promise<MeasuredPoint[] | undefined>;
}

export function useVna(wanted: VnaRange): Vna {
  const [instrument, setInstrument] = useState<Instrument | undefined>();
  const [range, setRange] = useState<VnaRange>(wanted);
  const [busy, setBusy] = useState<string | undefined>();
  const [progress, setProgress] = useState<[number, number] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [standards, setStandards] = useState<Partial<Record<Standard, MeasuredPoint[]>>>({});
  const [calibration, setCalibration] = useState<Calibration | undefined>();
  const [lastSweep, setLastSweep] = useState<{ points: number; at: string } | undefined>();
  const live = useRef<Instrument | undefined>(undefined);

  // When the tool's own sweep changes - a different model, a different band, more points -
  // measure that, not whatever was there when this first appeared. Points too: a tester
  // set 201 points in the tool, measured, and watched the tool snap back to the 101 this
  // panel had measured, because the two did not follow each other.
  useEffect(() => setRange((r) => ({ ...r, startMHz: wanted.startMHz, stopMHz: wanted.stopMHz, points: wanted.points })), [wanted.startMHz, wanted.stopMHz, wanted.points]);

  // Standards taken so far belong to the range they were swept over. Change the range and
  // they cannot be combined with what comes next, so their ticks are cleared rather than
  // mixed into a calibration that means nothing. A COMPLETED calibration stays: it still
  // covers whatever part of its range you sweep (calibrationCovers guards the rest).
  useEffect(() => setStandards({}), [range.startMHz, range.stopMHz, range.points]);

  // Let go of the port when the owner goes away.
  useEffect(() => () => void live.current?.close().catch(() => {}), []);

  const say = (e: unknown) => setError(e === undefined ? undefined : e instanceof VnaError ? e.message : e instanceof Error ? `${e.name}: ${e.message}` : String(e));

  const connected = (found: Instrument) => {
    live.current = found;
    setInstrument(found);
  };

  const close = async () => {
    await live.current?.close().catch(() => {});
    live.current = undefined;
    setInstrument(undefined);
    setStandards({});
    setCalibration(undefined);
    setLastSweep(undefined);
  };

  const followInstrument = async () => {
    const vna = live.current;
    if (!vna?.readRange) return;
    setError(undefined);
    setBusy('Asking the instrument…');
    try {
      const own = await vna.readRange();
      setRange({ startMHz: own.startMHz, stopMHz: own.stopMHz, points: Math.min(own.points, vna.maxPoints) });
    } catch (e) {
      say(e);
    } finally {
      setBusy(undefined);
    }
  };

  const sweepRaw = async (what: string): Promise<MeasuredPoint[] | undefined> => {
    const vna = live.current;
    if (!vna) return undefined;
    setError(undefined);
    setBusy(what);
    setProgress(undefined);
    try {
      return await vna.sweep({ ...range, onProgress: (done, total) => setProgress([done, total]) });
    } catch (e) {
      say(e);
      return undefined;
    } finally {
      setBusy(undefined);
      setProgress(undefined);
    }
  };

  const needsCalibration = instrument?.kind === 'nanovna-v2';
  const calibrated = !needsCalibration || calibration !== undefined;
  const coverage = calibration ? calibrationCovers(calibration, range.startMHz, range.stopMHz) : true;

  const measureStandard = async (id: Standard): Promise<boolean> => {
    const raw = await sweepRaw(`Measuring the ${id}…`);
    if (!raw) return false;
    // Belt and braces: keep only standards the instrument swept over these same
    // frequencies, whatever changed in between. A dropped one loses its tick.
    const compatible = Object.fromEntries(Object.entries(standards).filter(([, points]) => points && sameFrequencies(points, raw)));
    const next = { ...compatible, [id]: raw };
    setStandards(next);
    if (next.short && next.open && next.load) {
      try {
        setCalibration(makeCalibration(next.short, next.open, next.load));
      } catch (e) {
        say(e);
      }
    }
    return true;
  };

  const sweep = async (what = 'Sweeping…'): Promise<MeasuredPoint[] | undefined> => {
    if (needsCalibration && !calibration) {
      say('Measure the three standards first.');
      return undefined;
    }
    const raw = await sweepRaw(what);
    if (!raw) return undefined;
    const points = needsCalibration && calibration ? applyCalibration(raw, calibration) : raw;
    setLastSweep({ points: points.length, at: new Date().toLocaleTimeString() });
    return points;
  };

  return { instrument, range, setRange, busy, setBusy, progress, error, say, standards, calibration, needsCalibration, calibrated, coverage, lastSweep, connected, close, followInstrument, measureStandard, sweep };
}
