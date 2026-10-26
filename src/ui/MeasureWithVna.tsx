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
// The logic lives in useVna.ts (the balun tool's step-by-step guess drives it too);
// this is the panel.

import type { MeasuredPoint } from '../lib/touchstone';
import type { BridgeInstrument } from '../lib/vna';
import { NumberField } from './NumberField';
import { STANDARDS, useVna } from './useVna';
import { VnaSources } from './VnaSources';

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

export function MeasureWithVna({ startMHz, stopMHz, points = 101, action, onMeasured }: MeasureWithVnaProps) {
  const vna = useVna({ startMHz, stopMHz, points });
  const { instrument, range, setRange, busy, progress, error, standards, calibration, needsCalibration, calibrated, coverage, lastSweep } = vna;

  const measure = async () => {
    const measured = await vna.sweep('Sweeping…');
    if (measured) onMeasured(measured, `${instrument?.name ?? 'VNA'}, ${range.startMHz}–${range.stopMHz} MHz`);
  };

  if (!instrument) {
    return (
      <div className="vna">
        <VnaSources onConnected={vna.connected} busy={busy} setBusy={vna.setBusy} onError={vna.say} />
        {error && <p className="alert-inline">{error}</p>}
      </div>
    );
  }
  const correction = instrument.kind === 'bridge' ? (instrument as BridgeInstrument).lastCorrection : undefined;
  const bridgeNotes = instrument.kind === 'bridge' ? (instrument as BridgeInstrument).lastNotes : [];

  return (
    <div className="vna">
      <p className="vna-status">
        <strong>{instrument.name}</strong> connected.{' '}
        <button type="button" className="link" onClick={vna.close}>
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
          <button type="button" className="link" onClick={vna.followInstrument} disabled={busy !== undefined}>
            Use the instrument's own range
          </button>{' '}
          instead, as set on its front panel.
        </p>
      )}

      {needsCalibration && (
        <div className="vna-calibration">
          <p className="muted">
            A NanoVNA-V2 sends <strong>raw</strong> readings; the correction is done here. Put each standard on the port in turn,
            at the end of whatever cable you will measure through, and press its button. The sweep range above is what gets
            calibrated.
          </p>
          <div className="button-row">
            {STANDARDS.map((s) => (
              <button key={s.id} type="button" className="small" title={s.hint} aria-pressed={standards[s.id] !== undefined} disabled={busy !== undefined} onClick={() => vna.measureStandard(s.id)}>
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
      {instrument.kind === 'bridge' && (
        <p className="muted">
          Readings carry the instrument's own correction: calibrate it on the instrument first (QuickCal, CalReady or a cal kit), at the end of
          your cable. Sweeps go through the EMWS VNA bridge on this machine.
        </p>
      )}
      {correction && correction.corrected === false && (
        <p className="alert-inline">The instrument reports that its correction is OFF: these readings are uncorrected. Calibrate it, then measure again.</p>
      )}
      {correction && correction.corrected && correction.method === 'CalReady' && (
        <p className="muted">
          The instrument is using <strong>CalReady</strong>, its factory calibration at its own port - right for something on the port, not for something at
          the end of a cable. For that, calibrate it (QuickCal or a kit) at the cable's end and measure again.
        </p>
      )}
      {bridgeNotes.map((note) => (
        <p key={note.text} className={note.level === 'warning' ? 'alert-inline' : 'muted'}>
          {note.text}
        </p>
      ))}

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
