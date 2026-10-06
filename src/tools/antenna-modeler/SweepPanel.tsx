// Parameter sweep: step one thing across a range and watch what the antenna does - gain
// and take-off angle against height, SWR against element length. Nothing in the model
// changes until you click a point and press "Use it", which is one undo step.
//
// Public domain (The Unlicense). By ZR1JT.

import { useState } from 'react';
import type { Nec2Run } from '../../engine/nec2/types';
import { NumberField } from '../../ui/NumberField';
import { XYChart } from '../../ui/XYChart';
import type { AntennaModel } from './model';
import { type SweepRow, evenlySpaced, sweepParameter } from './optimise';
import { type TuneVariable, currentValue, describeVariable, formatTunedValue, suggestedRange, variableChoices } from './tune';

export interface SweepPanelProps {
  model: AntennaModel;
  fMHz: number;
  z0: number;
  solve: (deck: string) => Promise<Nec2Run>;
  onCancel: () => void;
  onApply: (variable: TuneVariable, value: number) => void;
}

/** The unit a person types a variable in; the sweep runs in SI. */
function unitFor(variable: TuneVariable): { label: string; factor: number } {
  if (variable.kind !== 'load') return { label: 'm', factor: 1 };
  if (variable.field === 'henries') return { label: 'µH', factor: 1e6 };
  if (variable.field === 'farads') return { label: 'pF', factor: 1e12 };
  return { label: 'Ω', factor: 1 };
}

interface Done {
  model: AntennaModel;
  variable: TuneVariable;
  /** What was swept, as the list named it: "Height of the antenna". */
  label: string;
  fMHz: number;
  rows: SweepRow[];
}

export function SweepPanel({ model, fMHz, z0, solve, onCancel, onApply }: SweepPanelProps) {
  const choices = variableChoices(model);
  const [key, setKey] = useState(() => choices.find((c) => c.key === 'height')?.key ?? choices[0]?.key ?? '');
  const chosen = choices.find((c) => c.key === key) ?? choices[0];
  const unit = chosen ? unitFor(chosen.variable) : { label: '', factor: 1 };
  const [range, setRange] = useState<{ min: number; max: number }>();
  const [steps, setSteps] = useState(9);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [done, setDone] = useState<Done>();
  const [hover, setHover] = useState<number>();
  const [picked, setPicked] = useState<number>();
  if (!chosen) return null;

  const suggested = suggestedRange(model, chosen.variable);
  const shown = range ?? { min: suggested.min * unit.factor, max: suggested.max * unit.factor };
  const now = currentValue(model, chosen.variable);
  const stale = done && (done.model !== model || done.fMHz !== fMHz);

  const run = () => {
    const values = evenlySpaced({ min: shown.min / unit.factor, max: shown.max / unit.factor }, steps);
    const ask = { model, variable: chosen.variable, label: chosen.label, fMHz };
    setBusy(true);
    setFailure(undefined);
    setPicked(undefined);
    setDone({ ...ask, rows: [] });
    sweepParameter(model, chosen.variable, values, fMHz, z0, solve, (rows) => setDone({ ...ask, rows }))
      .catch((e: unknown) => setFailure(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const rows = done?.rows ?? [];
  const x = rows.map((r) => r.value * unitFor(done!.variable).factor);
  const directional = rows.some((r) => r.fbDb !== undefined && Number.isFinite(r.fbDb) && Math.abs(r.fbDb) >= 1);
  const xUnit = unitFor(done?.variable ?? chosen.variable).label;
  const charts = { hover, onHover: setHover, selected: picked, onSelect: setPicked, xLabel: xUnit, xTitle: done ? `${done.label}, ${xUnit}` : undefined, x };
  const pickedRow = picked !== undefined ? rows[picked] : undefined;

  return (
    <details className="panel sweep-panel">
      <summary>Sweep a parameter</summary>
      <p className="muted">
        Step one thing across a range and plot what the antenna does at each - the "gain against height" curves of the handbooks, for
        your antenna. Every point is a full solve at {fMHz} MHz; the model is not changed unless you pick a point and use it.
      </p>
      <div className="field-row">
        <label className="field">
          <span className="field-label">Sweep</span>
          <select
            value={chosen.key}
            onChange={(e) => {
              setKey(e.target.value);
              setRange(undefined);
            }}
          >
            {choices.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <NumberField label="From" value={Number(shown.min.toPrecision(5))} unit={unit.label} onCommit={(v) => setRange({ min: v, max: shown.max })} />
        <NumberField label="to" value={Number(shown.max.toPrecision(5))} unit={unit.label} onCommit={(v) => setRange({ min: shown.min, max: v })} />
        <NumberField label="Points" value={steps} min={2} integer onCommit={(v) => setSteps(Math.min(41, v))} />
      </div>
      {now !== undefined && (
        <p className="muted">
          Now {Number((now * unit.factor).toPrecision(5))} {unit.label}.
        </p>
      )}
      <div className="button-row">
        {busy ? (
          <button type="button" className="small danger" onClick={onCancel}>
            Stop
          </button>
        ) : (
          <button type="button" className="small" disabled={!(shown.min < shown.max)} onClick={run}>
            Sweep it
          </button>
        )}
        {busy && (
          <span className="muted">
            {rows.length} of {steps} solved…
          </span>
        )}
      </div>
      {failure && <p className="alert-inline">The sweep stopped: {failure}</p>}
      {stale && !busy && <p className="muted">The model or frequency has changed since this sweep: sweep it again for current curves.</p>}

      {rows.length >= 2 && done && (
        <>
          <p className="muted sweep-what">
            {describeVariable(done.model, done.variable)[0]!.toUpperCase() + describeVariable(done.model, done.variable).slice(1)}, at {done.fMHz} MHz.
            Click a point to pick it.
          </p>
          <XYChart title="Peak gain" unit="dBi" series={[{ label: 'gain', colour: 'var(--series-1)', values: rows.map((r) => r.gainDbi) }]} {...charts} />
          <XYChart
            title="Elevation of the main lobe"
            unit="° above the horizon"
            series={[{ label: 'elevation', colour: 'var(--series-1)', values: rows.map((r) => r.elevationDeg) }]}
            format={(v) => v.toFixed(0)}
            fromZero
            {...charts}
          />
          {directional && <XYChart title="Front to back" unit="dB" series={[{ label: 'F/B', colour: 'var(--series-1)', values: rows.map((r) => r.fbDb) }]} {...charts} />}
          <XYChart title={`SWR against ${z0} Ω`} unit="" series={[{ label: 'SWR', colour: 'var(--series-1)', values: rows.map((r) => r.swr) }]} guides={[1.5, 2]} {...charts} />
          <XYChart
            title="Feed impedance"
            unit="Ω"
            series={[
              { label: 'R', colour: 'var(--series-1)', values: rows.map((r) => r.z?.re) },
              { label: 'X', colour: 'var(--series-2)', values: rows.map((r) => r.z?.im) },
            ]}
            {...charts}
          />
          <p className="muted">The elevation is read from a pattern in 2° steps, so it is good to about a degree either way.</p>
          {pickedRow && !stale && (
            <div className="button-row">
              <button type="button" className="small" onClick={() => onApply(done.variable, pickedRow.value)}>
                Use {formatTunedValue(done.variable, pickedRow.value)}
              </button>
              <span className="muted">sets {describeVariable(done.model, done.variable)} - one undo step</span>
            </div>
          )}
        </>
      )}
    </details>
  );
}
