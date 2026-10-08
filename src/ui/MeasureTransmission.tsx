// "Measure what you built": a NanoVNA's port 1 into the filter, port 2 out of it.
//
// MeasureWithVna's sibling for S21. A NanoVNA-V2 sends raw readings, so for one of these
// the component insists on a THRU (the two cables joined) before it hands anything on,
// and offers an ISOLATION (both cables terminated) for measurements deeper than the
// instrument's own leakage - a notch's floor. The classic NanoVNA applies its own
// calibration, thru included, and its readings go straight through.
//
// Public domain (The Unlicense). By ZR1JT.

import { useEffect, useRef, useState } from 'react';
import { type BridgeInstrument, type Instrument, VnaError } from '../lib/vna';
import { type ThruCalibration, type TransmissionPoint, applyThru, makeThruCalibration, sameTransmissionFrequencies, thruCovers } from '../lib/vna/transmission';
import { NumberField } from './NumberField';
import { VnaSources } from './VnaSources';

export interface MeasureTransmissionProps {
  startMHz: number;
  stopMHz: number;
  points?: number;
  action: string;
  onMeasured: (points: TransmissionPoint[], source: string) => void;
}

export function MeasureTransmission({ startMHz, stopMHz, points = 201, action, onMeasured }: MeasureTransmissionProps) {
  const [instrument, setInstrument] = useState<Instrument | undefined>();
  const [range, setRange] = useState({ startMHz, stopMHz, points });
  const [busy, setBusy] = useState<string | undefined>();
  const [progress, setProgress] = useState<[number, number] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [thru, setThru] = useState<TransmissionPoint[] | undefined>();
  const [isolation, setIsolation] = useState<TransmissionPoint[] | undefined>();
  const [calibration, setCalibration] = useState<ThruCalibration | undefined>();
  const [lastSweep, setLastSweep] = useState<{ points: number; at: string } | undefined>();
  const live = useRef<Instrument | undefined>(undefined);

  useEffect(() => setRange((r) => ({ ...r, startMHz, stopMHz, points })), [startMHz, stopMHz, points]);
  // Standards belong to the range they were swept over; a new range starts them again.
  useEffect(() => {
    setThru(undefined);
    setIsolation(undefined);
  }, [range.startMHz, range.stopMHz, range.points]);
  useEffect(() => () => void live.current?.close().catch(() => {}), []);

  const say = (e: unknown) => setError(e === undefined ? undefined : e instanceof VnaError ? e.message : e instanceof Error ? `${e.name}: ${e.message}` : String(e));

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

  const connected = (found: Instrument) => {
    live.current = found;
    setInstrument(found);
  };

  const close = async () => {
    await live.current?.close().catch(() => {});
    live.current = undefined;
    setInstrument(undefined);
    setThru(undefined);
    setIsolation(undefined);
    setCalibration(undefined);
    setLastSweep(undefined);
  };

  const sweepRaw = async (what: string): Promise<TransmissionPoint[] | undefined> => {
    const vna = live.current;
    if (!vna) return undefined;
    setError(undefined);
    setBusy(what);
    setProgress(undefined);
    try {
      return await vna.sweepTransmission({ ...range, onProgress: (done, total) => setProgress([done, total]) });
    } catch (e) {
      say(e);
      return undefined;
    } finally {
      setBusy(undefined);
      setProgress(undefined);
    }
  };

  const needsCalibration = instrument?.kind === 'nanovna-v2';
  const coverage = calibration ? thruCovers(calibration, range.startMHz, range.stopMHz) : true;
  const calibrated = !needsCalibration || (calibration !== undefined && coverage);

  const takeThru = async () => {
    const raw = await sweepRaw('Measuring the thru…');
    if (!raw) return;
    setThru(raw);
    // An isolation from another range cannot be combined with this thru.
    const iso = isolation && sameTransmissionFrequencies(raw, isolation) ? isolation : undefined;
    if (!iso) setIsolation(undefined);
    setCalibration(makeThruCalibration(raw, iso));
  };

  const takeIsolation = async () => {
    const raw = await sweepRaw('Measuring the isolation…');
    if (!raw) return;
    setIsolation(raw);
    if (thru && sameTransmissionFrequencies(thru, raw)) setCalibration(makeThruCalibration(thru, raw));
  };

  const measure = async () => {
    const raw = await sweepRaw('Sweeping…');
    if (!raw) return;
    const points = needsCalibration && calibration ? applyThru(raw, calibration) : raw;
    setLastSweep({ points: points.length, at: new Date().toLocaleTimeString() });
    onMeasured(points, `${instrument?.name ?? 'VNA'}, ${range.startMHz}–${range.stopMHz} MHz`);
  };

  if (!instrument) {
    return (
      <div className="vna vna-s21">
        <VnaSources onConnected={connected} busy={busy} setBusy={setBusy} onError={say} />
        <p className="muted">Port 1 into the filter, port 2 out of it.</p>
        {error && <p className="alert-inline">{error}</p>}
      </div>
    );
  }

  return (
    <div className="vna vna-s21">
      <p className="vna-status">
        <strong>{instrument.name}</strong> connected.{' '}
        <button type="button" className="link" onClick={close}>
          Disconnect
        </button>
      </p>
      <div className="field-row">
        <NumberField label="Sweep from" value={range.startMHz} above={0} unit="MHz" onCommit={(v) => setRange({ ...range, startMHz: Math.min(v, range.stopMHz * 0.99) })} />
        <NumberField label="to" value={range.stopMHz} above={0} unit="MHz" onCommit={(v) => setRange({ ...range, stopMHz: Math.max(v, range.startMHz * 1.01) })} />
        <NumberField label="Points" value={range.points} min={2} integer onCommit={(v) => setRange({ ...range, points: Math.min(v, instrument.maxPoints) })} />
      </div>
      {instrument.readRange && (
        <p className="muted vna-follow">
          The sweep above is what the bridge asks the instrument for.{' '}
          <button type="button" className="link" onClick={followInstrument} disabled={busy !== undefined}>
            Use the instrument's own range
          </button>{' '}
          instead, as set on its front panel.
        </p>
      )}
      {needsCalibration ? (
        <div className="vna-calibration">
          <p className="muted">
            A NanoVNA-V2 sends <strong>raw</strong> readings. Join the two cables with a barrel and press <em>Thru</em>. For a deep notch,
            also put a 50 Ω load on the end of each cable and press <em>Isolation</em>: it takes out the leakage inside the instrument.
          </p>
          <div className="button-row">
            <button type="button" className="small" aria-pressed={thru !== undefined} disabled={busy !== undefined} onClick={takeThru}>
              {thru ? '✓ ' : ''}Thru
            </button>
            <button type="button" className="small" aria-pressed={isolation !== undefined} disabled={busy !== undefined} onClick={takeIsolation}>
              {isolation ? '✓ ' : ''}Isolation (optional)
            </button>
            {calibration && (
              <span className="muted">
                Calibrated {new Date(calibration.madeAt).toLocaleTimeString()}
                {calibration.isolation ? ', with isolation' : ', thru only'}
                {coverage ? '' : ' — but not over this range. Calibrate again for it.'}
              </span>
            )}
          </div>
        </div>
      ) : (
        <p className="muted">
          Readings carry the instrument's own calibration: calibrate it on the instrument with its thru, at the ends of your two cables.
        </p>
      )}
      {instrument.kind === 'bridge' &&
        (instrument as BridgeInstrument).lastNotes.map((note) => (
          <p key={note.text} className={note.level === 'warning' ? 'alert-inline' : 'muted'}>
            {note.text}
          </p>
        ))}
      <div className="button-row">
        <button type="button" className="small" onClick={measure} disabled={busy !== undefined || !calibrated} title={!calibrated ? 'Measure the thru first' : undefined}>
          {busy ?? action}
        </button>
        {progress && (
          <span className="muted">
            {progress[0]} of {progress[1]}
          </span>
        )}
        {!busy && lastSweep && (
          <span className="muted">
            {lastSweep.points} points at {lastSweep.at}.
          </span>
        )}
      </div>
      {error && <p className="alert-inline">{error}</p>}
    </div>
  );
}
