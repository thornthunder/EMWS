// The form side: what to build, what on, what with, and how it is wound.
//
// Everything the pad can do can be done here too, which is what makes the tool usable
// from a keyboard or a phone - dragging is a convenience, not the only way in.

import { type ChangeEvent, type DragEvent, useRef, useState } from 'react';
import { type ImpedanceHandoff, loadImpedanceHandoff } from '../../lib/handoff';
import { TouchstoneError, parseTouchstone } from '../../lib/touchstone';
import { NumberField } from '../../ui/NumberField';
import { COAX, CORES, type CoreSize, type Material, WIRES } from './catalog';
import {
  type CoreProfile,
  ProfileFileError,
  exportProfiles,
  importProfiles,
  initialPermeability,
  makeProfile,
  rederive,
  suggestedFileName,
} from './profiles';
import type { Analysis } from './circuit';
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
  withCustomDimensions,
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
  /** The cores you have measured and kept. */
  profiles: CoreProfile[];
  onPickProfile: (profile: CoreProfile) => void;
  onAddProfiles: (profiles: CoreProfile[]) => void;
  onUpdateProfile: (profile: CoreProfile) => void;
  onRemoveProfile: (id: string) => void;
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
      <LibrarySection {...props} />
    </div>
  );
}

function CoreSection({ design, materials, profiles, onPickCore, onPickProfile, onChange, compareId, onCompare }: DesignPanelProps) {
  const core = coreOf(design);
  const startDrag = (e: DragEvent, payload: object) => {
    e.dataTransfer.setData(CORE_DRAG_TYPE, JSON.stringify(payload));
    e.dataTransfer.effectAllowed = 'copy';
  };
  const setDims = (size: Partial<Pick<CoreSize, 'odMm' | 'idMm' | 'heightMm'>>) => onChange(withCustomDimensions(design, size));
  const catalogue = materials.filter((m) => !m.id.startsWith('core:'));

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
            {catalogue.map((m) => (
              <th key={m.id} scope="col" title={m.note}>
                {m.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {CORES.map((c) => (
            <tr key={c.id}>
              <th scope="row">{c.name}</th>
              {catalogue.map((m) => {
                const chosen = !design.profileId && design.coreId === c.id && design.materialId === m.id;
                return (
                  <td key={m.id}>
                    <button
                      type="button"
                      className={`core-chip${chosen ? ' core-chip-on' : ''}`}
                      draggable
                      aria-pressed={chosen}
                      aria-label={`${c.name} in ${m.name}`}
                      title={`${c.name}-${m.name.replace('#', '')}: ${m.note}`}
                      onDragStart={(e) => startDrag(e, { coreId: c.id, materialId: m.id })}
                      onClick={() => onPickCore(c.id, m.id)}
                    >
                      <CoreGlyph />
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <h4 className="bin-title">Your cores</h4>
      {profiles.length === 0 ? (
        <p className="muted">
          None yet. Measure one below and it appears here, ready to drop onto the pad - and it stays, in this browser, for next
          time.
        </p>
      ) : (
        <ul className="bin" aria-label="Your measured cores">
          {profiles.map((p) => {
            const chosen = design.profileId === p.id;
            return (
              <li key={p.id}>
                <button
                  type="button"
                  className={`core-chip core-chip-wide${chosen ? ' core-chip-on' : ''}`}
                  draggable
                  aria-pressed={chosen}
                  title={`${p.size.name} ${p.mix}, measured ${new Date(p.measuredAt).toLocaleDateString()} with ${p.setup.turns} turns`}
                  onDragStart={(e) => startDrag(e, { profileId: p.id })}
                  onClick={() => onPickProfile(p)}
                >
                  <CoreGlyph measured />
                  <span className="core-chip-name">{p.name}</span>
                </button>
              </li>
            );
          })}
        </ul>
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
        {design.profileId && <p className="muted">Editing these leaves your measured core behind: the numbers would no longer be its.</p>}
        <div className="field-row">
          <NumberField label="Outside" value={core.odMm} above={0} unit="mm" onCommit={(v) => setDims({ odMm: v })} />
          <NumberField label="Inside" value={core.idMm} above={0} unit="mm" onCommit={(v) => setDims({ idMm: v })} />
          <NumberField label="Height" value={core.heightMm} above={0} unit="mm" onCommit={(v) => setDims({ heightMm: v })} />
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
                {m.id.startsWith('core:') ? `your ${m.name}` : `the same, wound on ${m.name}`}
              </option>
            ))}
        </select>
      </label>
    </section>
  );
}

function CoreGlyph({ measured = false }: { measured?: boolean }) {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <circle cx="10" cy="10" r="6.2" fill="none" stroke="currentColor" strokeWidth="4.4" />
      {measured && <circle cx="10" cy="10" r="1.6" fill="currentColor" />}
    </svg>
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

function MeasureSection({ design, onAddProfiles }: DesignPanelProps) {
  const [turns, setTurns] = useState(8);
  const [strayPf, setStrayPf] = useState(0);
  const [mix, setMix] = useState('#43');
  const [family, setFamily] = useState<CoreProfile['family']>('NiZn');
  const [name, setName] = useState('');
  const [message, setMessage] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);
  const core = coreOf(design);
  const suggested = `${core.name} ${mix}`.trim();

  const open = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const parsed = parseTouchstone(await file.text());
      const profile = makeProfile({
        name: name.trim() || suggested,
        size: { ...core, id: 'custom', name: core.name },
        family,
        mix: mix.trim() || 'unknown mix',
        setup: { turns, strayPf, stack: design.stack },
        sweep: parsed.points.map((p) => ({ fMHz: p.fMHz, r: p.z.re, x: p.z.im })),
        sourceFile: file.name,
      });
      onAddProfiles([profile]);
      setMessage(
        `Kept ${profile.name}: μ′ starts at ${initialPermeability(profile)}. ` +
          (profile.trustworthyUpToMHz === undefined
            ? 'The winding never went capacitive in this sweep, so the whole curve is usable.'
            : `The winding resonates in this sweep - trust the curve up to about ${profile.trustworthyUpToMHz.toFixed(1)} MHz, or measure again with fewer turns.`),
      );
      setName('');
    } catch (problem) {
      setMessage(problem instanceof TouchstoneError ? problem.message : String(problem));
    }
  };

  return (
    <section className="form-section">
      <details>
        <summary>Measure the core in your hand</summary>
        <p className="muted">
          Wind a few turns on <strong>the core chosen above ({core.name})</strong>, sweep it with a NanoVNA, and open the{' '}
          <code>.s1p</code> here. EMWS works the permeability out from it, keeps the core under <em>Your cores</em>, and
          uses its measured curve instead of the estimate - which, ferrite varying as it does, is the better number.
        </p>
        <div className="field-row">
          <NumberField label="Turns on the test winding" value={turns} min={1} integer onCommit={setTurns} />
          <NumberField label="Its capacitance, if known" value={strayPf} min={0} unit="pF" onCommit={setStrayPf} />
        </div>
        <div className="field-row">
          <label className="field">
            <span className="field-label">What it is, as far as you know</span>
            <span className="field-input">
              <input type="text" value={mix} placeholder="#43, unknown, from a monitor lead…" onChange={(e) => setMix(e.target.value)} />
            </span>
          </label>
          <label className="field">
            <span className="field-label">Family</span>
            <select value={family} onChange={(e) => setFamily(e.target.value === 'MnZn' ? 'MnZn' : 'NiZn')}>
              <option value="NiZn">Nickel-zinc (#43, #52, #61…)</option>
              <option value="MnZn">Manganese-zinc (#31, #73, #77…)</option>
            </select>
          </label>
        </div>
        <label className="field">
          <span className="field-label">Call it</span>
          <span className="field-input">
            <input type="text" value={name} placeholder={suggested} onChange={(e) => setName(e.target.value)} />
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

/** Everything you have measured: look it over, rename it, correct it, keep it, share it. */
function LibrarySection({ profiles, design, onAddProfiles, onUpdateProfile, onRemoveProfile, onPickProfile }: DesignPanelProps) {
  const [message, setMessage] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);

  const download = (list: CoreProfile[]) => {
    const blob = new Blob([exportProfiles(list)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestedFileName(list);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const open = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const imported = importProfiles(await file.text());
      onAddProfiles(imported);
      setMessage(`Added ${imported.length} ${imported.length === 1 ? 'core' : 'cores'} from ${file.name}.`);
    } catch (problem) {
      setMessage(problem instanceof ProfileFileError ? problem.message : String(problem));
    }
  };

  return (
    <section className="form-section">
      <details>
        <summary>Your core library{profiles.length > 0 ? ` (${profiles.length})` : ''}</summary>
        <p className="muted">
          Kept in this browser only. Export to keep a copy, move it to another machine, or hand a core's measurement to someone
          else; the file carries the whole sweep, so anyone can see exactly what was measured.
        </p>
        <div className="button-row">
          <button type="button" className="small" onClick={() => fileInput.current?.click()}>
            Import…
          </button>
          {profiles.length > 0 && (
            <button type="button" className="small" onClick={() => download(profiles)}>
              Export all
            </button>
          )}
          <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={open} />
        </div>
        {message && <p className="muted">{message}</p>}
        <ul className="library">
          {profiles.map((p) => (
            <li key={p.id} className={`library-item${design.profileId === p.id ? ' library-item-on' : ''}`}>
              <ProfileCard
                profile={p}
                chosen={design.profileId === p.id}
                onUse={() => onPickProfile(p)}
                onUpdate={onUpdateProfile}
                onExport={() => download([p])}
                onRemove={() => onRemoveProfile(p.id)}
              />
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

interface ProfileCardProps {
  profile: CoreProfile;
  chosen: boolean;
  onUse: () => void;
  onUpdate: (p: CoreProfile) => void;
  onExport: () => void;
  onRemove: () => void;
}

function ProfileCard({ profile, chosen, onUse, onUpdate, onExport, onRemove }: ProfileCardProps) {
  const [confirm, setConfirm] = useState(false);
  const first = profile.curve[0];
  const last = profile.curve[profile.curve.length - 1];
  const mhz = (f: number) => f.toFixed(f < 10 ? 2 : 1);
  const span = first && last ? `${mhz(first.fMHz)} – ${mhz(last.fMHz)} MHz` : 'no points';
  return (
    <div className="profile-card">
      <label className="field">
        <span className="visually-hidden">Name</span>
        <span className="field-input">
          <input type="text" value={profile.name} onChange={(e) => onUpdate({ ...profile, name: e.target.value })} />
        </span>
      </label>
      <p className="muted profile-facts">
        {profile.size.name} · {profile.size.odMm} × {profile.size.idMm} × {profile.size.heightMm} mm
        {profile.setup.stack > 1 ? ` ×${profile.setup.stack}` : ''} · {profile.mix} ({profile.family})
        <br />
        measured {new Date(profile.measuredAt).toLocaleDateString()} with {profile.setup.turns} turns
        {profile.setup.strayPf > 0 ? `, ${profile.setup.strayPf} pF taken out` : ''} · {profile.sweep.length} points, {span}
        <br />
        μ′ starts at {initialPermeability(profile)}
        {profile.trustworthyUpToMHz !== undefined ? (
          <>
            {' '}
            · <strong>trust it up to {profile.trustworthyUpToMHz.toFixed(1)} MHz</strong>
          </>
        ) : (
          ' · the whole sweep is usable'
        )}
        {profile.sourceFile ? ` · from ${profile.sourceFile}` : ''}
      </p>
      <div className="field-row">
        <NumberField
          label="Turns it was measured with"
          value={profile.setup.turns}
          min={1}
          integer
          onCommit={(v) => onUpdate(rederive(profile, { turns: v }))}
        />
        <NumberField
          label="Winding capacitance to take out"
          value={profile.setup.strayPf}
          min={0}
          unit="pF"
          onCommit={(v) => onUpdate(rederive(profile, { strayPf: v }))}
        />
      </div>
      <label className="field">
        <span className="field-label">Notes</span>
        <span className="field-input">
          <input
            type="text"
            value={profile.notes ?? ''}
            placeholder="where it came from, what it is for…"
            onChange={(e) => onUpdate({ ...profile, notes: e.target.value })}
          />
        </span>
      </label>
      <div className="button-row">
        <button type="button" className="small" onClick={onUse} aria-pressed={chosen}>
          {chosen ? 'In use' : 'Use it'}
        </button>
        <button type="button" className="small" onClick={onExport}>
          Export
        </button>
        {confirm ? (
          <>
            <button type="button" className="small danger" onClick={onRemove}>
              Yes, forget it
            </button>
            <button type="button" className="small" onClick={() => setConfirm(false)}>
              Keep it
            </button>
          </>
        ) : (
          <button type="button" className="small" onClick={() => setConfirm(true)}>
            Forget…
          </button>
        )}
      </div>
    </div>
  );
}
