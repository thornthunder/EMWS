// The form side: what to build, what on, what with, and how it is wound.
//
// Everything the pad can do can be done here too, which is what makes the tool usable
// from a keyboard or a phone - dragging is a convenience, not the only way in.

import { type ChangeEvent, type DragEvent, useRef, useState } from 'react';
import { type ImpedanceHandoff, loadImpedanceHandoff } from '../../lib/handoff';
import { TouchstoneError, parseTouchstone } from '../../lib/touchstone';
import { NumberField } from '../../ui/NumberField';
import { COAX, CORES, type Material, WIRES } from './catalog';
import type { Analysis } from './circuit';
import { measuredMaterial, trustworthyUpToMHz } from './measure';
import {
  type Design,
  type Step,
  type Topology,
  canAdd,
  chokeDesign,
  coreOf,
  crossover,
  efhwDesign,
  guanella4Design,
  removeStep,
  setStepTurns,
  summarise,
  tap,
  wind,
} from './model';
import { CORE_DRAG_TYPE } from './WindingPad';

export interface DesignPanelProps {
  design: Design;
  materials: Material[];
  analysis: Analysis | undefined;
  compareId: string;
  onCompare: (materialId: string) => void;
  onChange: (design: Design) => void;
  onPickCore: (coreId: string, materialId: string) => void;
  onAddMaterial: (material: Material) => void;
  onRemoveMaterial: (id: string) => void;
  /** A load taken from the Antenna Modeler, if one is in use. */
  antenna: ImpedanceHandoff | undefined;
  onAntenna: (handoff: ImpedanceHandoff | undefined) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}

const TOPOLOGIES: { id: Topology; label: string; blurb: string; start: () => Design }[] = [
  { id: 'autotransformer', label: 'Tapped', blurb: 'One tapped winding: the 49:1 and 9:1 ununs.', start: efhwDesign },
  { id: 'guanella-1-1', label: '1:1 current', blurb: 'A line wound on a core: the common-mode choke.', start: chokeDesign },
  { id: 'guanella-1-4', label: '1:4 Guanella', blurb: 'Two lines, in parallel one side and in series the other.', start: guanella4Design },
];

const DUTIES = [
  { label: 'Key down, FT8, RTTY (all of it)', pct: 100 },
  { label: 'CW (roughly 40 %)', pct: 40 },
  { label: 'SSB speech (roughly 20 %)', pct: 20 },
];

export function DesignPanel(props: DesignPanelProps) {
  const { design, onChange } = props;
  const set = (patch: Partial<Design>) => onChange({ ...design, ...patch });

  /** Changing what is being built brings that type's own wire, winding and load with it. */
  const switchTo = (topology: Topology) => {
    if (topology === design.topology) return;
    const fresh = TOPOLOGIES.find((t) => t.id === topology)!.start();
    onChange({ ...fresh, coreId: design.coreId, customCore: design.customCore, stack: design.stack, materialId: design.materialId, powerW: design.powerW, dutyPct: design.dutyPct, z0: design.z0, sweep: design.sweep });
  };

  return (
    <div className="chain-panel">
      <section className="form-section">
        <h3>What to build</h3>
        <div className="segmented" role="radiogroup" aria-label="Kind of transformer">
          {TOPOLOGIES.map((t) => (
            <button key={t.id} type="button" role="radio" aria-checked={design.topology === t.id} onClick={() => switchTo(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <p className="muted">{TOPOLOGIES.find((t) => t.id === design.topology)!.blurb}</p>
      </section>

      <CoreSection {...props} />
      <WireSection design={design} set={set} />
      <RecipeSection {...props} set={set} />
      <LoadSection {...props} set={set} />
      <StraysSection design={design} analysis={props.analysis} set={set} />
      <MeasureSection {...props} />
    </div>
  );
}

function CoreSection({ design, materials, onPickCore, onChange, compareId, onCompare, onRemoveMaterial }: DesignPanelProps) {
  const core = coreOf(design);
  const startDrag = (e: DragEvent, coreId: string, materialId: string) => {
    e.dataTransfer.setData(CORE_DRAG_TYPE, JSON.stringify({ coreId, materialId }));
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <section className="form-section">
      <h3>Core</h3>
      <p className="muted">Drag one onto the pad, or just click it. The same one again stacks it.</p>
      <table className="core-table">
        <thead>
          <tr>
            <th scope="col">
              <span className="visually-hidden">Size</span>
            </th>
            {materials.map((m) => (
              <th key={m.id} scope="col" title={m.note}>
                {m.curve ? '★' : m.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {CORES.map((c) => (
            <tr key={c.id}>
              <th scope="row">{c.name}</th>
              {materials.map((m) => {
                const chosen = design.coreId === c.id && design.materialId === m.id;
                return (
                  <td key={m.id}>
                    <button
                      type="button"
                      className={`core-chip${chosen ? ' core-chip-on' : ''}`}
                      draggable
                      aria-pressed={chosen}
                      aria-label={`${c.name} in ${m.name}${m.curve ? ' (measured)' : ''}`}
                      title={`${c.name}-${m.name.replace('#', '')}: ${m.note}`}
                      onDragStart={(e) => startDrag(e, c.id, m.id)}
                      onClick={() => onPickCore(c.id, m.id)}
                    >
                      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
                        <circle cx="10" cy="10" r="6.2" fill="none" stroke="currentColor" strokeWidth="4.4" />
                      </svg>
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {materials.some((m) => m.curve) && (
        <p className="muted">
          ★ measured:{' '}
          {materials
            .filter((m) => m.curve)
            .map((m) => (
              <span key={m.id} className="measured-tag">
                {m.name}{' '}
                <button type="button" className="link" onClick={() => onRemoveMaterial(m.id)} aria-label={`Forget ${m.name}`}>
                  forget
                </button>
              </span>
            ))}
        </p>
      )}

      <div className="field-row">
        <NumberField label="Stacked" value={design.stack} min={1} integer onCommit={(v) => onChange({ ...design, stack: Math.min(4, v) })} />
        {design.topology === 'guanella-1-4' && (
          <label className="field">
            <span className="field-label">Cores</span>
            <select value={design.positions} onChange={(e) => onChange({ ...design, positions: e.target.value === '1' ? 1 : 2 })}>
              <option value="2">Two, one per line</option>
              <option value="1">One, both lines on it</option>
            </select>
          </label>
        )}
      </div>

      <details>
        <summary>A core that is not in the list</summary>
        <div className="field-row">
          <NumberField label="Outside" value={core.odMm} above={0} unit="mm" onCommit={(v) => onChange({ ...design, coreId: 'custom', customCore: { ...core, id: 'custom', name: 'Custom', odMm: v } })} />
          <NumberField label="Inside" value={core.idMm} above={0} unit="mm" onCommit={(v) => onChange({ ...design, coreId: 'custom', customCore: { ...core, id: 'custom', name: 'Custom', idMm: v } })} />
          <NumberField label="Height" value={core.heightMm} above={0} unit="mm" onCommit={(v) => onChange({ ...design, coreId: 'custom', customCore: { ...core, id: 'custom', name: 'Custom', heightMm: v } })} />
        </div>
      </details>

      <label className="field">
        <span className="field-label">Compare with</span>
        <select value={compareId} onChange={(e) => onCompare(e.target.value)}>
          <option value="">nothing</option>
          {materials
            .filter((m) => m.id !== design.materialId)
            .map((m) => (
              <option key={m.id} value={m.id}>
                the same, wound on {m.name}
              </option>
            ))}
        </select>
      </label>
    </section>
  );
}

function WireSection({ design, set }: { design: Design; set: (patch: Partial<Design>) => void }) {
  const tapped = design.topology === 'autotransformer';
  const value = design.conductor.kind === 'coax' ? `coax:${design.conductor.coaxId}` : `${design.conductor.kind}:${design.conductor.wireId}`;
  const pick = (e: ChangeEvent<HTMLSelectElement>) => {
    const [kind, id] = e.target.value.split(':') as [string, string];
    if (kind === 'coax') set({ conductor: { kind: 'coax', coaxId: id }, overrides: { ...design.overrides, lineZ0: undefined, velocityFactor: undefined } });
    else set({ conductor: { kind: kind === 'pair' ? 'pair' : 'wire', wireId: id }, overrides: { ...design.overrides, lineZ0: undefined, velocityFactor: undefined } });
  };
  return (
    <section className="form-section">
      <h3>{tapped ? 'Wire' : 'Line to wind with'}</h3>
      <select value={value} onChange={pick} aria-label={tapped ? 'Wire' : 'Transmission line'}>
        {tapped ? (
          WIRES.map((w) => (
            <option key={w.id} value={`wire:${w.id}`}>
              {w.name}
            </option>
          ))
        ) : (
          <>
            <optgroup label="Coax">
              {COAX.map((c) => (
                <option key={c.id} value={`coax:${c.id}`}>
                  {c.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="A pair of wires, side by side">
              {WIRES.map((w) => (
                <option key={w.id} value={`pair:${w.id}`}>
                  Pair of {w.name}
                </option>
              ))}
            </optgroup>
          </>
        )}
      </select>
    </section>
  );
}

function stepText(step: Step): string {
  return step.kind === 'tap' ? 'Tap: bring a connection out here' : 'Cross over to the far side of the core';
}

function RecipeSection({ design, set, canUndo, canRedo, onUndo, onRedo }: DesignPanelProps & { set: (patch: Partial<Design>) => void }) {
  const tapped = design.topology === 'autotransformer';
  const summary = summarise(design.steps);
  const inside = summary.taps.filter((t) => t > 0 && t < summary.totalTurns);
  return (
    <section className="form-section">
      <h3>Winding</h3>
      <ol className="recipe">
        {design.steps.map((step) => (
          <li key={step.id}>
            {step.kind === 'wind' ? (
              <NumberField label="Wind" value={step.turns} min={1} integer unit="turns" onCommit={(v) => set({ steps: setStepTurns(design.steps, step.id, v) })} />
            ) : (
              <span className="recipe-text">{stepText(step)}</span>
            )}
            <button type="button" className="small" aria-label="Remove this step" onClick={() => set({ steps: removeStep(design.steps, step.id) })}>
              ×
            </button>
          </li>
        ))}
      </ol>
      <div className="button-row">
        <button type="button" className="small" onClick={() => set({ steps: [...design.steps, wind(1)] })}>
          + Wind
        </button>
        {tapped && (
          <button type="button" className="small" disabled={!canAdd(design.steps, 'tap')} onClick={() => set({ steps: [...design.steps, tap()] })}>
            + Tap
          </button>
        )}
        <button type="button" className="small" disabled={!canAdd(design.steps, 'crossover')} onClick={() => set({ steps: [...design.steps, crossover()] })}>
          + Cross over
        </button>
        <button type="button" className="small" disabled={!canUndo} onClick={onUndo}>
          Undo
        </button>
        <button type="button" className="small" disabled={!canRedo} onClick={onRedo}>
          Redo
        </button>
      </div>
      {tapped && inside.length > 1 && (
        <label className="field">
          <span className="field-label">The radio connects to</span>
          <select value={design.inputTap} onChange={(e) => set({ inputTap: Number(e.target.value) })}>
            {inside.map((t, i) => (
              <option key={t} value={i}>
                the tap at {t} turns ({((summary.totalTurns / t) ** 2).toFixed(1)}:1)
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="field-row">
        {tapped && <NumberField label="Capacitor across input" value={design.compensationPf} min={0} unit="pF" onCommit={(v) => set({ compensationPf: v })} />}
        <NumberField label="Each lead" value={design.leadMm} min={0} unit="mm" onCommit={(v) => set({ leadMm: v })} />
      </div>
    </section>
  );
}

function LoadSection({ design, set, antenna, onAntenna }: DesignPanelProps & { set: (patch: Partial<Design>) => void }) {
  const [offered] = useState<ImpedanceHandoff | undefined>(() => loadImpedanceHandoff());
  return (
    <section className="form-section">
      <h3>Load and radio</h3>
      {antenna ? (
        <p className="muted">
          Load: <strong>{antenna.name}</strong>, as modelled ({antenna.points.length} {antenna.points.length === 1 ? 'frequency' : 'frequencies'}).{' '}
          <button type="button" className="link" onClick={() => onAntenna(undefined)}>
            Use a fixed load instead
          </button>
        </p>
      ) : (
        <div className="field-row">
          <NumberField label="Load R" value={design.load.ohmsR} min={0} unit="Ω" onCommit={(v) => set({ load: { ...design.load, ohmsR: v } })} />
          <NumberField label="Load X" value={design.load.ohmsX} unit="Ω" onCommit={(v) => set({ load: { ...design.load, ohmsX: v } })} />
        </div>
      )}
      {!antenna && offered && (
        <div className="button-row">
          <button type="button" className="small" onClick={() => onAntenna(offered)} title={`Saved ${new Date(offered.savedAt).toLocaleString()}`}>
            Use {offered.name.slice(0, 28)} as the load
          </button>
        </div>
      )}
      {design.topology === 'guanella-1-4' && (
        <label className="check">
          <input type="checkbox" checked={design.loadGrounded} onChange={(e) => set({ loadGrounded: e.target.checked })} /> One side of the load is earthed
        </label>
      )}
      <div className="field-row">
        <NumberField label="Radio" value={design.z0} above={0} unit="Ω" onCommit={(v) => set({ z0: v })} />
        <NumberField label="Power" value={design.powerW} min={0} unit="W" onCommit={(v) => set({ powerW: v })} />
      </div>
      <label className="field">
        <span className="field-label">How much of the time</span>
        <select value={design.dutyPct} onChange={(e) => set({ dutyPct: Number(e.target.value) })}>
          {DUTIES.map((d) => (
            <option key={d.pct} value={d.pct}>
              {d.label}
            </option>
          ))}
        </select>
      </label>
      <div className="field-row">
        <NumberField label="Sweep from" value={design.sweep.startMHz} above={0} unit="MHz" onCommit={(v) => set({ sweep: { ...design.sweep, startMHz: Math.min(v, design.sweep.stopMHz * 0.99) } })} />
        <NumberField label="to" value={design.sweep.stopMHz} above={0} unit="MHz" onCommit={(v) => set({ sweep: { ...design.sweep, stopMHz: Math.max(v, design.sweep.startMHz * 1.01) } })} />
      </div>
    </section>
  );
}

/** One estimate, with the measurement that can replace it. */
function Stray({ label, unit, estimate, override, digits, onSet }: { label: string; unit: string; estimate: number | undefined; override: number | undefined; digits: number; onSet: (value: number | undefined) => void }) {
  if (estimate === undefined) return null;
  return (
    <div className="stray">
      <NumberField label={label} value={Number((override ?? estimate).toFixed(digits))} min={0} unit={unit} onCommit={(v) => onSet(v)} />
      {override === undefined ? (
        <span className="stray-tag">estimate</span>
      ) : (
        <button type="button" className="link" onClick={() => onSet(undefined)}>
          measured · back to the estimate
        </button>
      )}
    </div>
  );
}

function StraysSection({ design, analysis, set }: { design: Design; analysis: Analysis | undefined; set: (patch: Partial<Design>) => void }) {
  if (!analysis) return null;
  const o = design.overrides;
  const put = (patch: Partial<Design['overrides']>) => set({ overrides: { ...o, ...patch } });
  return (
    <section className="form-section">
      <h3>Strays</h3>
      <p className="muted">
        Worked out from the geometry, and only as good as that. They decide the <em>top</em> of the range; the bottom is decided by the core. Type a
        measured value over any of them.
      </p>
      <Stray label="Leakage inductance" unit="µH" digits={3} estimate={analysis.strays.leakageUh} override={o.leakageUh} onSet={(v) => put({ leakageUh: v })} />
      <Stray label="Winding capacitance" unit="pF" digits={2} estimate={analysis.strays.windingPf} override={o.windingPf} onSet={(v) => put({ windingPf: v })} />
      <Stray label="Line impedance" unit="Ω" digits={0} estimate={analysis.strays.lineZ0} override={o.lineZ0} onSet={(v) => put({ lineZ0: v })} />
      <Stray label="Velocity factor" unit="" digits={2} estimate={analysis.strays.velocityFactor} override={o.velocityFactor} onSet={(v) => put({ velocityFactor: v })} />
    </section>
  );
}

function MeasureSection({ design, onAddMaterial }: DesignPanelProps) {
  const [turns, setTurns] = useState(8);
  const [strayPf, setStrayPf] = useState(0);
  const [name, setName] = useState('My core');
  const [message, setMessage] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);

  const open = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const parsed = parseTouchstone(await file.text());
      const material = measuredMaterial(name.trim() || file.name, parsed.points, { core: coreOf(design), stack: design.stack, turns, strayPf });
      onAddMaterial(material);
      const limit = trustworthyUpToMHz(parsed.points);
      setMessage(
        `Added ${material.name}: μ′ starts at ${material.muInitial}. ` +
          (limit === undefined
            ? 'The winding never went capacitive in this sweep, so the whole curve is usable.'
            : `The winding resonates in this sweep - trust the curve up to about ${limit.toFixed(1)} MHz, or measure again with fewer turns.`),
      );
    } catch (problem) {
      setMessage(problem instanceof TouchstoneError ? problem.message : String(problem));
    }
  };

  return (
    <section className="form-section">
      <details>
        <summary>Measure the core in your hand</summary>
        <p className="muted">
          Wind a few turns on <strong>the core chosen above</strong>, sweep it with a NanoVNA, and open the <code>.s1p</code> here. EMWS works the
          permeability out from it and uses that instead of its own estimate - which, ferrite varying as it does, is the better number.
        </p>
        <div className="field-row">
          <NumberField label="Turns on the test winding" value={turns} min={1} integer onCommit={setTurns} />
          <NumberField label="Its capacitance, if known" value={strayPf} min={0} unit="pF" onCommit={setStrayPf} />
        </div>
        <label className="field">
          <span className="field-label">Call it</span>
          <span className="field-input">
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </span>
        </label>
        <div className="button-row">
          <button type="button" className="small" onClick={() => fileInput.current?.click()}>
            Open .s1p
          </button>
          <input ref={fileInput} type="file" accept=".s1p,.txt,text/plain" hidden onChange={open} />
        </div>
        {message && <p className="muted">{message}</p>}
      </details>
    </section>
  );
}
