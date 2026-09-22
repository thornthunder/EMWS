// "Measure it": a NanoVNA on a USB port, driven from the page.
//
// One component, used by every tool that can take a measured impedance - the Smith
// chart's load, the balun tool's core, the antenna modeller's comparison. It connects,
// says what it found, sweeps on request, and hands back the same MeasuredPoint[] a .s1p
// file would, so the tools do not care which they got.
//
// A NanoVNA-V2 sends raw readings, so for one of these the component insists on a
// short-open-load calibration before it will hand anything on. The classic NanoVNA
// applies its own calibration on the instrument and its readings go straight through.

import { useEffect, useRef, useState } from 'react';
import type { MeasuredPoint } from '../lib/touchstone';
import { type Instrument, VnaError, connect, serialUnavailableReason } from '../lib/vna';
import { type Calibration, applyCalibration, calibrationCovers, makeCalibration } from '../lib/vna/calibration';
import { NumberField } from './NumberField';

export interface MeasureWithVnaProps {
  /** What to sweep, to begin with. The person can change it. */
  startMHz: number;
  stopMHz: number;
  points?: number;
  /** What the measurement is for, in the button: "Measure the load", "Measure this core". */
  action: string;
  /** Called with calibrated points and a name for where they came from. */
  onMeasured: (points: MeasuredPoint[], source: string) => void;
}

type Standard = 'short' | 'open' | 'load';
const STANDARDS: { id: Standard; label: string; hint: string }[] = [
  { id: 'short', label: 'Short', hint: 'the short from the calibration kit on the port' },
  { id: 'open', label: 'Open', hint: 'the open standard on the port (not just nothing)' },
  { id: 'load', label: 'Load', hint: 'the 50 Ω load on the port' },
];

export function MeasureWithVna({ startMHz, stopMHz, points = 101, action, onMeasured }: MeasureWithVnaProps) {
  const unavailable = serialUnavailableReason();
  const [instrument, setInstrument] = useState<Instrument | undefined>();
  const [range, setRange] = useState({ startMHz, stopMHz, points });
  const [busy, setBusy] = useState<string | undefined>();
  const [progress, setProgress] = useState<[number, number] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [standards, setStandards] = useState<Partial<Record<Standard, MeasuredPoint[]>>>({});
  const [calibration, setCalibration] = useState<Calibration | undefined>();
  const [lastSweep, setLastSweep] = useState<{ points: number; at: string } | undefined>();
  const live = useRef<Instrument | undefined>(undefined);

  // When the tool's own range changes - a different model, a different band - measure
  // that, not whatever was there when this first appeared.
  useEffect(() => setRange((r) => ({ ...r, startMHz, stopMHz })), [startMHz, stopMHz]);

  // Let go of the port when the tool goes away.
  useEffect(() => () => void live.current?.close().catch(() => {}), []);

  const say = (e: unknown) => setError(e instanceof VnaError ? e.message : e instanceof Error ? `${e.name}: ${e.message}` : String(e));

  const open = async () => {
    setError(undefined);
    setBusy('Asking for the port…');
    try {
      const found = await connect();
      live.current = found;
      setInstrument(found);
    } catch (e) {
      say(e);
    } finally {
      setBusy(undefined);
    }
  };

  const close = async () => {
    await live.current?.close().catch(() => {});
    live.current = undefined;
    setInstrument(undefined);
    setStandards({});
    setCalibration(undefined);
    setLastSweep(undefined);
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

  const measureStandard = async (id: Standard) => {
    const raw = await sweepRaw(`Measuring the ${id}…`);
    if (!raw) return;
    const next = { ...standards, [id]: raw };
    setStandards(next);
    if (next.short && next.open && next.load) {
      try {
        setCalibration(makeCalibration(next.short, next.open, next.load));
      } catch (e) {
        say(e);
      }
    }
  };

  const measure = async () => {
    const raw = await sweepRaw('Sweeping…');
    if (!raw) return;
    const points = needsCalibration && calibration ? applyCalibration(raw, calibration) : raw;
    setLastSweep({ points: points.length, at: new Date().toLocaleTimeString() });
    onMeasured(points, `${instrument?.name ?? 'NanoVNA'}, ${range.startMHz}–${range.stopMHz} MHz`);
  };

  if (unavailable) {
    return (
      <p className="muted vna-unavailable">
        <strong>Measure with a NanoVNA:</strong> {unavailable}
      </p>
    );
  }

  if (!instrument) {
    return (
      <div className="vna">
        <div className="button-row">
          <button type="button" className="small" onClick={open} disabled={busy !== undefined}>
            {busy ?? 'Connect a NanoVNA…'}
          </button>
          <span className="muted">Plug it in by USB, then choose its port when the browser asks.</span>
        </div>
        {error && <p className="alert-inline">{error}</p>}
      </div>
    );
  }

  return (
    <div className="vna">
      <p className="vna-status">
        <strong>{instrument.name}</strong> connected.{' '}
        <button type="button" className="link" onClick={close}>
          Disconnect
        </button>
      </p>
      <div className="field-row">
        <NumberField label="Sweep from" value={range.startMHz} above={0} unit="MHz" onCommit={(v) => setRange({ ...range, startMHz: Math.min(v, range.stopMHz * 0.99) })} />
        <NumberField label="to" value={range.stopMHz} above={0} unit="MHz" onCommit={(v) => setRange({ ...range, stopMHz: Math.max(v, range.startMHz * 1.01) })} />
        <NumberField label="Points" value={range.points} min={2} integer onCommit={(v) => setRange({ ...range, points: Math.min(v, instrument.kind === 'nanovna-v2' ? 1024 : 401) })} />
      </div>

      {needsCalibration && (
        <div className="vna-calibration">
          <p className="muted">
            A NanoVNA-V2 sends <strong>raw</strong> readings; the correction is done here. Put each standard on the port in turn,
            at the end of whatever cable you will measure through, and press its button. The sweep range above is what gets
            calibrated.
          </p>
          <div className="button-row">
            {STANDARDS.map((s) => (
              <button key={s.id} type="button" className="small" title={s.hint} aria-pressed={standards[s.id] !== undefined} disabled={busy !== undefined} onClick={() => measureStandard(s.id)}>
                {standards[s.id] ? '✓ ' : ''}
                {s.label}
              </button>
            ))}
            {calibration && (
              <span className="muted">
                Calibrated {new Date(calibration.madeAt).toLocaleTimeString()}
                {coverage ? '' : ' — but not over this range. Calibrate again for it.'}
              </span>
            )}
          </div>
        </div>
      )}
      {instrument.kind === 'nanovna' && <p className="muted">Readings carry the NanoVNA's own calibration. Calibrate it on the instrument first, at the end of your cable.</p>}

      <div className="button-row">
        <button type="button" className="small" onClick={measure} disabled={busy !== undefined || !calibrated || !coverage} title={!calibrated ? 'Measure the three standards first' : undefined}>
          {busy ?? action}
        </button>
        {progress && (
          <span className="muted">
            {progress[0]} of {progress[1]}
          </span>
        )}
        {!busy && lastSweep && (
          <span className="muted">
            {lastSweep.points} points at {lastSweep.at}. {action.toLowerCase().startsWith('measure') ? 'Measure again after a change.' : ''}
          </span>
        )}
      </div>
      {error && <p className="alert-inline">{error}</p>}
    </div>
  );
}
