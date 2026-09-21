// The left-hand column: what the load is, what the components are, and the matches the
// tool can work out for you.

import type { ChangeEvent } from 'react';
import { useRef, useState } from 'react';
import { type ImpedanceHandoff, loadImpedanceHandoff } from '../../lib/handoff';
import { TouchstoneError, parseTouchstone } from '../../lib/touchstone';
import { NumberField } from '../../ui/NumberField';
import { lMatchSolutions } from './match';
import {
  type Connection,
  type Element,
  type ElementKind,
  type Load,
  type Network,
  addElement,
  defaultElement,
  moveElement,
  removeElement,
  updateElement,
} from './model';
import { type SweepPoint, inputImpedance, sweepNetwork, swrBandwidth } from './network';
import { elementTitle, formatImpedance, formatMHz, formatSi, editUnit, fromReactance, reactanceOf } from './units';

/** Fixed order, never cycled: component 4 onwards shares the neutral colour. */
export const STEP_COLOURS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'];
export const STEP_COLOUR_MORE = 'var(--series-more)';

export function stepColour(index: number): string {
  return STEP_COLOURS[index] ?? STEP_COLOUR_MORE;
}

const ADD_BUTTONS: { label: string; kind: ElementKind; connection: Connection }[] = [
  { label: 'Series L', kind: 'inductor', connection: 'series' },
  { label: 'Series C', kind: 'capacitor', connection: 'series' },
  { label: 'Shunt L', kind: 'inductor', connection: 'shunt' },
  { label: 'Shunt C', kind: 'capacitor', connection: 'shunt' },
  { label: 'Line', kind: 'line', connection: 'series' },
  { label: 'Stub', kind: 'stub', connection: 'shunt' },
  { label: 'Transformer', kind: 'transformer', connection: 'series' },
  { label: 'Resistor', kind: 'resistor', connection: 'series' },
];

export interface ChainPanelProps {
  network: Network;
  onChange: (network: Network) => void;
}

export function ChainPanel({ network, onChange }: ChainPanelProps) {
  return (
    <div className="chain-panel">
      <LoadSection network={network} onChange={onChange} />
      <SystemSection network={network} onChange={onChange} />
      <ChainSection network={network} onChange={onChange} />
      <MatchSection network={network} onChange={onChange} />
    </div>
  );
}

function LoadSection({ network, onChange }: ChainPanelProps) {
  const { load } = network;
  const [handoff] = useState<ImpedanceHandoff | undefined>(() => loadImpedanceHandoff());
  const [error, setError] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);

  const setLoad = (next: Load) => onChange({ ...network, load: next });

  /** Taking a measured load also points the sweep at the frequencies it covers. */
  const useHandoff = (source: ImpedanceHandoff) => {
    const frequencies = source.points.map((p) => p.fMHz);
    onChange({
      ...network,
      load: { kind: 'measured', name: source.name, points: source.points.map((p) => ({ fMHz: p.fMHz, z: { re: p.r, im: p.x } })) },
      sweep: {
        startMHz: Math.min(...frequencies),
        stopMHz: Math.max(...frequencies),
        points: Math.min(201, Math.max(21, frequencies.length)),
      },
      designMHz: (Math.min(...frequencies) + Math.max(...frequencies)) / 2,
    });
  };

  const openFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const parsed = parseTouchstone(await file.text());
      setError(undefined);
      useHandoff({
        name: file.name,
        savedAt: new Date().toISOString(),
        points: parsed.points.map((p) => ({ fMHz: p.fMHz, r: p.z.re, x: p.z.im })),
      });
    } catch (problem) {
      setError(problem instanceof TouchstoneError ? problem.message : String(problem));
    }
  };

  return (
    <section className="form-section">
      <h3>The load</h3>
      <div className="segmented" role="radiogroup" aria-label="Kind of load">
        <button
          type="button"
          role="radio"
          aria-checked={load.kind === 'impedance'}
          onClick={() =>
            load.kind !== 'impedance' && setLoad({ kind: 'impedance', ohmsR: 100, ohmsX: -40, atMHz: network.designMHz, follows: 'reactive' })
          }
        >
          R + jX
        </button>
        <button type="button" role="radio" aria-checked={load.kind === 'measured'} disabled={load.kind !== 'measured'}>
          Measured
        </button>
      </div>

      {load.kind === 'impedance' ? (
        <>
          <div className="field-row">
            <NumberField label="Resistance" value={load.ohmsR} min={0} unit="Ω" onCommit={(v) => setLoad({ ...load, ohmsR: v })} />
            <NumberField label="Reactance" value={load.ohmsX} unit="Ω" onCommit={(v) => setLoad({ ...load, ohmsX: v })} />
            <NumberField label="Measured at" value={load.atMHz} above={0} unit="MHz" onCommit={(v) => setLoad({ ...load, atMHz: v })} />
          </div>
          <select
            value={load.follows}
            aria-label="How the load behaves across the sweep"
            onChange={(e) => setLoad({ ...load, follows: e.target.value === 'fixed' ? 'fixed' : 'reactive' })}
          >
            <option value="reactive">Reactance follows frequency (like real wire)</option>
            <option value="fixed">Hold R + jX at every frequency</option>
          </select>
        </>
      ) : (
        <p className="muted">
          <strong>{load.name}</strong>: {load.points.length} points, {formatMHz(load.points[0]!.fMHz)} to{' '}
          {formatMHz(load.points.at(-1)!.fMHz)}.
        </p>
      )}

      <div className="button-row">
        <button type="button" className="small" onClick={() => fileInput.current?.click()}>
          Open .s1p
        </button>
        {handoff && (
          <button type="button" className="small" onClick={() => useHandoff(handoff)} title={`Saved ${new Date(handoff.savedAt).toLocaleString()}`}>
            Use {handoff.name.slice(0, 28)}
          </button>
        )}
        <input ref={fileInput} type="file" accept=".s1p,.txt,text/plain" hidden onChange={openFile} />
      </div>
      {error && <p className="alert-inline">{error}</p>}
      {!handoff && <p className="muted">Run an antenna in the Antenna Modeler and its impedance appears here.</p>}
    </section>
  );
}

function SystemSection({ network, onChange }: ChainPanelProps) {
  return (
    <section className="form-section">
      <h3>Radio and sweep</h3>
      <div className="field-row">
        <NumberField label="System Z" value={network.z0} above={0} unit="Ω" onCommit={(v) => onChange({ ...network, z0: v })} />
        <NumberField
          label="Design frequency"
          value={network.designMHz}
          above={0}
          unit="MHz"
          onCommit={(v) => onChange({ ...network, designMHz: v })}
        />
      </div>
      <div className="field-row">
        <NumberField
          label="Sweep from"
          value={network.sweep.startMHz}
          above={0}
          unit="MHz"
          onCommit={(v) => onChange({ ...network, sweep: { ...network.sweep, startMHz: v } })}
        />
        <NumberField
          label="to"
          value={network.sweep.stopMHz}
          above={0}
          unit="MHz"
          onCommit={(v) => onChange({ ...network, sweep: { ...network.sweep, stopMHz: v } })}
        />
        <NumberField
          label="Points"
          value={network.sweep.points}
          min={2}
          integer
          onCommit={(v) => onChange({ ...network, sweep: { ...network.sweep, points: Math.min(401, v) } })}
        />
      </div>
    </section>
  );
}

function ChainSection({ network, onChange }: ChainPanelProps) {
  return (
    <section className="form-section">
      <div className="section-head">
        <h3>Components ({network.elements.length})</h3>
        {network.elements.length > 0 && (
          <button type="button" className="small" onClick={() => onChange({ ...network, elements: [] })}>
            Clear
          </button>
        )}
      </div>
      <p className="muted">From the load towards the radio.</p>

      {network.elements.map((element, index) => (
        <ElementCard
          key={element.id}
          element={element}
          index={index}
          count={network.elements.length}
          designMHz={network.designMHz}
          onChange={(patch) => onChange(updateElement(network, element.id, patch))}
          onMove={(by) => onChange(moveElement(network, element.id, by))}
          onRemove={() => onChange(removeElement(network, element.id))}
        />
      ))}

      <div className="add-buttons">
        {ADD_BUTTONS.map((button) => (
          <button
            key={button.label}
            type="button"
            className="small"
            onClick={() => onChange(addElement(network, defaultElement(button.kind, button.connection, network.designMHz)))}
          >
            + {button.label}
          </button>
        ))}
      </div>
    </section>
  );
}

interface ElementCardProps {
  element: Element;
  index: number;
  count: number;
  designMHz: number;
  onChange: (patch: Partial<Element>) => void;
  onMove: (by: number) => void;
  onRemove: () => void;
}

function ElementCard({ element, index, count, designMHz, onChange, onMove, onRemove }: ElementCardProps) {
  const unit = editUnit(element);
  const reactance = reactanceOf(element, designMHz);
  const wavelength = 299792458 / (designMHz * 1e6);

  return (
    <div className={element.bypassed ? 'element-card bypassed' : 'element-card'}>
      <div className="element-head">
        <span className="step-swatch" style={{ background: stepColour(index) }} aria-hidden="true">
          {index + 1}
        </span>
        <strong>{elementTitle(element)}</strong>
        <span className="element-buttons">
          <button type="button" className="icon" disabled={index === 0} onClick={() => onMove(-1)} aria-label="Move towards the load">
            ↑
          </button>
          <button type="button" className="icon" disabled={index === count - 1} onClick={() => onMove(1)} aria-label="Move towards the radio">
            ↓
          </button>
          <button type="button" className="icon" onClick={onRemove} aria-label={`Remove the ${elementTitle(element).toLowerCase()}`}>
            ✕
          </button>
        </span>
      </div>

      {'connection' in element && (
        <div className="segmented small-segmented" role="radiogroup" aria-label="How it is connected">
          {(['series', 'shunt'] as const).map((connection) => (
            <button
              key={connection}
              type="button"
              role="radio"
              aria-checked={element.connection === connection}
              onClick={() => onChange({ connection } as Partial<Element>)}
            >
              {connection === 'series' ? 'In series' : 'Across the line'}
            </button>
          ))}
        </div>
      )}

      {unit && (element.kind === 'inductor' || element.kind === 'capacitor' || element.kind === 'resistor') && (
        <div className="field-row">
          <NumberField
            label="Value"
            value={Number(
              ((element.kind === 'inductor' ? element.henries : element.kind === 'capacitor' ? element.farads : element.ohms) / unit.factor).toPrecision(6),
            )}
            above={0}
            unit={unit.label}
            onCommit={(v) => {
              const value = v * unit.factor;
              onChange(
                element.kind === 'inductor' ? { henries: value } : element.kind === 'capacitor' ? { farads: value } : { ohms: value },
              );
            }}
          />
          {element.kind !== 'resistor' && (
            <NumberField
              label="Q (0 = ideal)"
              value={element.q ?? 0}
              min={0}
              onCommit={(v) => onChange({ q: v > 0 ? v : undefined } as Partial<Element>)}
            />
          )}
        </div>
      )}

      {reactance !== undefined && Number.isFinite(reactance) && (
        <LogSlider
          label={`Reactance at ${formatMHz(designMHz)}`}
          value={Math.abs(reactance)}
          min={1}
          max={2000}
          format={(v) => `${v.toFixed(1)} Ω ${reactance < 0 ? 'capacitive' : 'inductive'}`}
          onChange={(v) => onChange(fromReactance(element, v, designMHz))}
        />
      )}

      {(element.kind === 'line' || element.kind === 'stub') && (
        <>
          {element.kind === 'stub' && (
            <select
              value={element.termination}
              aria-label="Stub end"
              onChange={(e) => onChange({ termination: e.target.value === 'short' ? 'short' : 'open' } as Partial<Element>)}
            >
              <option value="open">Open-circuit end</option>
              <option value="short">Shorted end</option>
            </select>
          )}
          <div className="field-row">
            <NumberField label="Cable Z" value={element.z0} above={0} unit="Ω" onCommit={(v) => onChange({ z0: v } as Partial<Element>)} />
            <NumberField
              label="Velocity factor"
              value={element.velocityFactor}
              above={0}
              onCommit={(v) => onChange({ velocityFactor: Math.min(1, v) } as Partial<Element>)}
            />
          </div>
          <div className="field-row">
            <NumberField
              label="Loss"
              value={element.lossDb100m}
              min={0}
              unit="dB/100 m"
              onCommit={(v) => onChange({ lossDb100m: v } as Partial<Element>)}
            />
            <NumberField
              label="at"
              value={element.lossRefMHz}
              above={0}
              unit="MHz"
              onCommit={(v) => onChange({ lossRefMHz: v } as Partial<Element>)}
            />
          </div>
          <LogSlider
            label="Length"
            value={Math.max(0.01, element.lengthM)}
            min={0.01}
            max={Math.max(2, wavelength)}
            format={(v) => `${v.toFixed(2)} m · ${(v / (wavelength * element.velocityFactor)).toFixed(3)} wavelengths in the cable`}
            onChange={(v) => onChange({ lengthM: Number(v.toPrecision(6)) } as Partial<Element>)}
          />
        </>
      )}

      {element.kind === 'transformer' && (
        <LogSlider
          label="Impedance ratio"
          value={element.ratio}
          min={1}
          max={64}
          format={(v) => `${v.toFixed(2)} : 1`}
          onChange={(v) => onChange({ ratio: Number(v.toPrecision(4)) } as Partial<Element>)}
        />
      )}

      <label className="check">
        <input type="checkbox" checked={element.bypassed ?? false} onChange={(e) => onChange({ bypassed: e.target.checked })} /> Switch
        out of circuit
      </label>
    </div>
  );
}

interface LogSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}

/** A slider that steps by ratio, so it is as usable at 2 Ω as at 2000 Ω. */
function LogSlider({ label, value, min, max, format, onChange }: LogSliderProps) {
  const position = (Math.log(Math.min(max, Math.max(min, value))) - Math.log(min)) / (Math.log(max) - Math.log(min));
  return (
    <label className="slider">
      <span className="field-label">
        {label}: <span className="slider-value">{format(value)}</span>
      </span>
      <input
        type="range"
        min={0}
        max={1000}
        value={Math.round(position * 1000)}
        onChange={(e) => onChange(Math.exp(Math.log(min) + (Number(e.target.value) / 1000) * (Math.log(max) - Math.log(min))))}
      />
    </label>
  );
}

function MatchSection({ network, onChange }: ChainPanelProps) {
  const atRadio = inputImpedance(network, network.designMHz);
  const solutions = lMatchSolutions(atRadio, network.z0, network.designMHz);

  return (
    <section className="form-section">
      <h3>Match it for me</h3>
      <p className="muted">
        What the radio sees now: <strong>{formatImpedance(atRadio)}</strong>. These add to the end of the chain and bring
        it to {network.z0} Ω at {formatMHz(network.designMHz)}.
      </p>
      {solutions.length === 0 ? (
        <p className="muted">Nothing to do: that is already {network.z0} Ω, or its resistance is zero.</p>
      ) : (
        <ul className="match-list">
          {solutions.map((solution) => {
            const applied: Network = { ...network, elements: [...network.elements, ...solution.elements] };
            const points: SweepPoint[] = sweepNetwork(applied);
            const band = swrBandwidth(points, 2, network.designMHz);
            return (
              <li key={solution.id}>
                <div className="match-head">
                  <strong>{solution.name}</strong>
                  {solution.character !== 'mixed' && <span className="badge">{solution.character}</span>}
                </div>
                <p className="muted">
                  {solution.elements
                    .map((e) =>
                      e.kind === 'inductor' ? formatSi(e.henries, 'H') : e.kind === 'capacitor' ? formatSi(e.farads, 'F') : '',
                    )
                    .join(' then ')}
                  {band && ` · under 2:1 from ${formatMHz(band.lowMHz)} to ${formatMHz(band.highMHz)}`}
                </p>
                <button type="button" className="small primary" onClick={() => onChange(applied)}>
                  Use this
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
