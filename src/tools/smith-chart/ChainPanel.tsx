// The left-hand column: what the load is, what the components are, and the matches the
// tool can work out for you.

import type { ChangeEvent } from 'react';
import { useRef, useState } from 'react';
import { type ImpedanceHandoff, loadImpedanceHandoff } from '../../lib/handoff';
import { TouchstoneError, gammaFromImpedance, parseTouchstone, standingWaveRatio } from '../../lib/touchstone';
import { MeasureWithVna } from '../../ui/MeasureWithVna';
import { NumberField } from '../../ui/NumberField';
import { type MatchSolution, lMatchSolutions, leastQ, piTeeSolutions } from './match';
import { type AdjustGoal, type AdjustResult, adjustNetwork, adjustableElements } from './optimise';
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
import { elementTitle, elementValue, formatImpedance, formatMHz, formatSi, editUnit, fromReactance, reactanceOf } from './units';

/** Fixed order, never cycled: component 4 onwards shares the neutral colour. */
export const STEP_COLOURS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'];
export const STEP_COLOUR_MORE = 'var(--series-more)';

export function stepColour(index: number): string {
  return STEP_COLOURS[index] ?? STEP_COLOUR_MORE;
}

/**
 * There is no solve behind this sweep - it is arithmetic along the chain at each
 * frequency - so the only real cost is drawing the curve. High enough to stay out of
 * the way, low enough that a mistyped number cannot lock the page up.
 */
const MAX_SWEEP_POINTS = 10_000;
/** A measured load sets the sweep to its own point count, up to this; a 10001-point FieldFox trace does not need 10001 SVG vertices. */
const MEASURED_SWEEP_POINTS = 2001;

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
  // Three groups, laid out by width (styles.css): one column on a laptop, two on a wide
  // screen (load and sweep | components over matches), three on a very wide one, so that
  // no column is taller than the window - a tester found the single long column meant
  // scrolling at every step, and a first two-column try at a fixed page width crushed the
  // chart instead.
  return (
    <div className="chain-panel">
      <div className="chain-column chain-column-load">
        <LoadSection network={network} onChange={onChange} />
        <SystemSection network={network} onChange={onChange} />
      </div>
      <div className="chain-column chain-column-chain">
        <ChainSection network={network} onChange={onChange} />
      </div>
      <div className="chain-column chain-column-match">
        <MatchSection network={network} onChange={onChange} />
        <AdjustSection network={network} onChange={onChange} />
      </div>
    </div>
  );
}

function LoadSection({ network, onChange }: ChainPanelProps) {
  const { load } = network;
  const [handoff] = useState<ImpedanceHandoff | undefined>(() => loadImpedanceHandoff());
  const [error, setError] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);

  const setLoad = (next: Load) => onChange({ ...network, load: next });

  /**
   * Taking a measured load also points the sweep at the frequencies it covers, with as many
   * points as were measured (up to a sensible ceiling), so the chart samples the measurement
   * and not an interpolation of it. The VNA panel follows the sweep, so the next measurement
   * takes the same points unless someone changes them.
   */
  const useHandoff = (source: ImpedanceHandoff) => {
    const frequencies = source.points.map((p) => p.fMHz);
    onChange({
      ...network,
      load: { kind: 'measured', name: source.name, points: source.points.map((p) => ({ fMHz: p.fMHz, z: { re: p.r, im: p.x } })) },
      sweep: {
        startMHz: Math.min(...frequencies),
        stopMHz: Math.max(...frequencies),
        points: Math.min(MEASURED_SWEEP_POINTS, Math.max(21, frequencies.length)),
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
      <MeasureWithVna
        startMHz={network.sweep.startMHz}
        stopMHz={network.sweep.stopMHz}
        points={network.sweep.points}
        action="Measure the load"
        onMeasured={(points, source) =>
          useHandoff({ name: source, savedAt: new Date().toISOString(), points: points.map((p) => ({ fMHz: p.fMHz, r: p.z.re, x: p.z.im })) })
        }
      />
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
          onCommit={(v) => onChange({ ...network, sweep: { ...network.sweep, points: Math.min(MAX_SWEEP_POINTS, v) } })}
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
          <NumberField wheel
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
            <NumberField wheel
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
            <NumberField wheel label="Cable Z" value={element.z0} above={0} unit="Ω" onCommit={(v) => onChange({ z0: v } as Partial<Element>)} />
            <NumberField wheel
              label="Velocity factor"
              value={element.velocityFactor}
              above={0}
              onCommit={(v) => onChange({ velocityFactor: Math.min(1, v) } as Partial<Element>)}
            />
          </div>
          <div className="field-row">
            <NumberField wheel
              label="Loss"
              value={element.lossDb100m}
              min={0}
              unit="dB/100 m"
              onCommit={(v) => onChange({ lossDb100m: v } as Partial<Element>)}
            />
            <NumberField wheel
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

/** Below this SWR at the radio, nothing a two-element network could add is worth adding. */
const MATCHED_SWR = 1.05;

/**
 * Automatic matches. With no components in the chain there is one question - what brings
 * this load to the radio's impedance - and one list. With components already built, there
 * are two, and a tester who had built a match by hand found the single list baffling:
 * it kept offering to add to the end of their network (tiny values, because little was
 * left to do), and "Use this" added rather than replaced. So with a chain in place the
 * section says what the chain leaves, offers to finish it (add after) and, separately, to
 * start again from the load (replace), each button saying which it does.
 */
function MatchSection({ network, onChange }: ChainPanelProps) {
  const { designMHz, z0 } = network;
  const atRadio = inputImpedance(network, designMHz);
  const atLoad = inputImpedance({ ...network, elements: [] }, designMHz);
  const inPlace = network.elements.filter((e) => !e.bypassed).length;
  const swrNow = standingWaveRatio(gammaFromImpedance(atRadio, z0));
  const finishing = lMatchSolutions(atRadio, z0, designMHz);
  const fromLoad = inPlace > 0 ? lMatchSolutions(atLoad, z0, designMHz) : [];
  const [q, setQ] = useState(3);

  if (inPlace === 0) {
    return (
      <section className="form-section">
        <h3>Match it for me</h3>
        <p className="muted">
          The load shows <strong>{formatImpedance(atRadio)}</strong> at {formatMHz(designMHz)}. Each of these brings it to {z0} Ω there:
        </p>
        {finishing.length === 0 ? (
          <p className="muted">Nothing to do: that is already {z0} Ω, or its resistance is zero.</p>
        ) : (
          <>
            <SolutionList network={network} base={[]} solutions={finishing} action="Use this" onChange={onChange} />
            <PiTee network={network} zLoad={atLoad} q={q} onQ={setQ} base={[]} action="Use this" onChange={onChange} />
          </>
        )}
      </section>
    );
  }

  const matched = Number.isFinite(swrNow) && swrNow < MATCHED_SWR;
  return (
    <section className="form-section">
      <h3>Match it for me</h3>
      <p className="muted">
        Your {inPlace} component{inPlace === 1 ? '' : 's'} leave{inPlace === 1 ? 's' : ''} the radio seeing <strong>{formatImpedance(atRadio)}</strong>{' '}
        ({Number.isFinite(swrNow) ? `${swrNow.toFixed(2)}:1` : 'no match at all'}) at {formatMHz(designMHz)}.
      </p>
      {matched ? (
        <p className="muted">That is a match already: nothing worth adding after it.</p>
      ) : finishing.length === 0 ? (
        <p className="muted">Nothing can be added after it: the resistance there is zero.</p>
      ) : (
        <>
          <h4>Finish it: add after your components</h4>
          <SolutionList network={network} base={network.elements} solutions={finishing} action="Add after mine" onChange={onChange} />
        </>
      )}
      {fromLoad.length > 0 && (
        <>
          <h4>Or start again from the load, in place of your components</h4>
          <SolutionList network={network} base={[]} solutions={fromLoad} action="Replace mine" onChange={onChange} />
          <PiTee network={network} zLoad={atLoad} q={q} onQ={setQ} base={[]} action="Replace mine" onChange={onChange} />
        </>
      )}
    </section>
  );
}

/**
 * Three parts instead of two, with the Q chosen. The L network's Q is whatever the two
 * impedances dictate; a Pi or T lets you ask for more - a narrower match, and in the
 * low-pass shapes more harmonic rejection - never less, and the floor is stated.
 */
function PiTee({
  network,
  zLoad,
  q,
  onQ,
  base,
  action,
  onChange,
}: {
  network: Network;
  zLoad: { re: number; im: number };
  q: number;
  onQ: (q: number) => void;
  base: Element[];
  action: string;
  onChange: (network: Network) => void;
}) {
  const floors = leastQ(zLoad, network.z0);
  const floor = Math.min(floors.pi, floors.tee);
  const solutions = piTeeSolutions(zLoad, network.z0, network.designMHz, q);
  if (!Number.isFinite(floor)) return null;
  return (
    <div className="pi-tee">
      <h4>Or a Pi or T, with the Q you choose</h4>
      <div className="field-row">
        <NumberField label="Loaded Q" value={q} above={0} hint="Higher is a narrower match; the low-pass shapes also reject harmonics harder." onCommit={onQ} />
        <p className="muted pi-tee-floor">
          The L network's own Q here is {floors.pi.toFixed(2)} for a Pi and {floors.tee.toFixed(2)} for a T; these can only be sharper than that.
        </p>
      </div>
      {solutions.length === 0 ? (
        <p className="muted">
          A Pi or T between these needs a Q above {floor.toFixed(2)} - raise it. (At that Q and below, the L network above is the flattest match there is.)
        </p>
      ) : (
        <SolutionList network={network} base={base} solutions={solutions} action={action} onChange={onChange} />
      )}
    </div>
  );
}

/**
 * Adjusts the values of the parts already in the chain - the matcher's answer, or a chain
 * built by hand - for the flattest SWR across the sweep or the best match at the design
 * frequency. One step back is kept, so an answer you like less can be undone.
 */
function AdjustSection({ network, onChange }: ChainPanelProps) {
  const adjustable = adjustableElements(network);
  const [goal, setGoal] = useState<AdjustGoal>('sweep');
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ previous: Network; report: AdjustResult } | undefined>(undefined);
  const chosen = adjustable.filter((e) => !excluded.has(e.id));
  // A report belongs to the chain it was made for: once the parts change, it is history.
  const sameChain = done !== undefined && done.report.network.elements.map((e) => e.id).join() === network.elements.map((e) => e.id).join();
  const report = sameChain ? done : undefined;

  const run = async () => {
    setBusy(true);
    try {
      const result = await adjustNetwork(network, goal, chosen.map((e) => e.id));
      setDone({ previous: network, report: result });
      if (result.improved) onChange(result.network);
    } finally {
      setBusy(false);
    }
  };
  const putBack = () => {
    if (!report) return;
    onChange(report.previous);
    setDone(undefined);
  };
  const swrText = (s: number) => (Number.isFinite(s) ? s.toFixed(2) : '∞');
  const nameOf = (id: string) => {
    const index = network.elements.findIndex((e) => e.id === id);
    return index >= 0 ? `the ${elementTitle(network.elements[index]!).toLowerCase()} (${index + 1})` : 'a part';
  };
  const headline = goal === 'sweep' ? 'Worst SWR across the sweep' : 'SWR at the design frequency';
  const pick = (o: AdjustResult['before']) => (goal === 'sweep' ? o.worstSwr : o.designSwr);
  const other = (o: AdjustResult['before']) => (goal === 'sweep' ? o.designSwr : o.worstSwr);

  return (
    <section className="form-section adjust-section">
      <h3>Adjust what I have</h3>
      {adjustable.length === 0 ? (
        <p className="muted">Add a part with a value to adjust - an inductor, capacitor, stub or line - and this will set the values for you.</p>
      ) : (
        <>
          <p className="muted">Keeps your parts and their order, and moves their values - over the same range as the sliders - towards:</p>
          <div className="segmented" role="radiogroup" aria-label="What to adjust for">
            <button type="button" role="radio" aria-checked={goal === 'sweep'} onClick={() => setGoal('sweep')}>
              The flattest SWR across the sweep
            </button>
            <button type="button" role="radio" aria-checked={goal === 'design'} onClick={() => setGoal('design')}>
              The best match at the design frequency
            </button>
          </div>
          <ul className="adjust-list">
            {adjustable.map((e) => {
              const index = network.elements.indexOf(e);
              return (
                <li key={e.id}>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={!excluded.has(e.id)}
                      onChange={(ev) => {
                        const next = new Set(excluded);
                        if (ev.target.checked) next.delete(e.id);
                        else next.add(e.id);
                        setExcluded(next);
                      }}
                    />{' '}
                    <span className="step-swatch" style={{ background: stepColour(index) }} aria-hidden="true">
                      {index + 1}
                    </span>{' '}
                    {elementTitle(e)} · {elementValue(e)}
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="button-row">
            <button type="button" className="small primary" disabled={busy || chosen.length === 0} onClick={() => void run()}>
              {busy ? 'Adjusting…' : 'Adjust the values'}
            </button>
            {report && (
              <button type="button" className="small" onClick={putBack}>
                Put the values back
              </button>
            )}
          </div>
          {report && (
            <div className="adjust-report" role="status">
              {report.report.improved ? (
                <p>
                  {headline}{' '}
                  <strong>
                    {swrText(pick(report.report.before))} → {swrText(pick(report.report.after))}
                  </strong>{' '}
                  ({goal === 'sweep' ? 'at the design frequency' : 'worst across the sweep'} {swrText(other(report.report.before))} →{' '}
                  {swrText(other(report.report.after))}), in {report.report.evaluations} trials.
                </p>
              ) : (
                <p>
                  Nothing beat the values you have: {headline.toLowerCase()} stays <strong>{swrText(pick(report.report.before))}</strong> (
                  {report.report.evaluations} trials).
                </p>
              )}
              {report.report.atEdge.length > 0 && (
                <p className="alert-inline">
                  {report.report.atEdge.map(nameOf).join(' and ')} ran to the end of {report.report.atEdge.length === 1 ? 'its' : 'their'} range (the
                  slider's). That usually means a different kind of part is wanted there, or the chain a different shape - not a value the slider
                  does not reach.
                </p>
              )}
              {report.report.truncated && <p className="muted">Stopped at the trial limit before the search settled; press again to carry on from here.</p>}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function SolutionList({
  network,
  base,
  solutions,
  action,
  onChange,
}: {
  network: Network;
  /** What the solution's elements go after: the chain as it is, or nothing. */
  base: Element[];
  solutions: MatchSolution[];
  action: string;
  onChange: (network: Network) => void;
}) {
  return (
    <ul className="match-list">
      {solutions.map((solution) => {
        const applied: Network = { ...network, elements: [...base, ...solution.elements] };
        const points: SweepPoint[] = sweepNetwork(applied);
        const band = swrBandwidth(points, 2, network.designMHz);
        return (
          <li key={solution.id}>
            <div className="match-head">
              <strong>{solution.name}</strong>
              {solution.character !== 'mixed' && <span className="badge">{solution.character}</span>}
            </div>
            <p className="muted">
              {solution.elements.map((e) => (e.kind === 'inductor' ? formatSi(e.henries, 'H') : e.kind === 'capacitor' ? formatSi(e.farads, 'F') : '')).join(' then ')}
              {band && ` · under 2:1 from ${formatMHz(band.lowMHz)} to ${formatMHz(band.highMHz)}`}
            </p>
            <button type="button" className="small primary" onClick={() => onChange(applied)}>
              {action}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
