// The form side of the editor: frequency, ground, wires, feeds, pattern and notes.

import { useEffect, useState } from 'react';
import type { Vec3 } from '../../engine/nec2/types';
import { tidy, withAxis } from '../../lib/vec3';
import { bandsUpTo } from '../../lib/bands';
import { loadLoadHandoff } from '../../lib/handoff';
import type { HistoryAction } from './history';
import {
  type AntennaModel,
  AVERAGE_GROUND,
  type Feed,
  type FrequencyPlan,
  type Ground,
  type Load,
  type LoadKind,
  type Wire,
  WIRE_MATERIALS,
  addFeed,
  addLoad,
  autoSegment,
  centreSegment,
  deleteWire,
  feedPosition,
  junctionOf,
  loadImpedance,
  moveEnds,
  removeFeed,
  removeLoad,
  segmentLength,
  segmentNearest,
  segmentsForPosition,
  setFeedPosition,
  setLoadPosition,
  setWireConductivity,
  setWireGeometry,
  suggestedSegments,
  updateFeed,
  updateLoad,
  wavelengthM,
  highestFrequencyMHz,
  wireLength,
} from './model';
import { formatValue, NumberField } from '../../ui/NumberField';
import { type TuneGoal, type TuneRequest, type TuneVariable, currentValue, suggestedRange, variableChoices } from './tune';
import { FB_CAP_DB, type OptimiseGoal, type OptimiseVariable } from './optimise';

/** Amateur bands through 23 cm, from the suite's one band list. Picking one sets up a sweep across it. */
const BANDS = bandsUpTo(1300);

/** Points a sweep starts with when you switch one on, or pick a band. */
const SWEEP_POINTS = 21;
/**
 * A guard against a mistyped number, not a judgement about what is sensible.
 *
 * NEC-2 itself has no limit: nec2c's FR card count is a plain loop counter. What a long
 * sweep actually costs is time and memory, and the design checks estimate both and say
 * so by name before you press Run.
 */
const MAX_SWEEP_POINTS = 10_000;

function sweepPlan(from: number, to: number, points: number): FrequencyPlan {
  const steps = Math.max(2, Math.round(points));
  return { startMHz: tidy(from), stepMHz: tidy((to - from) / (steps - 1)), steps };
}

export interface ModelPanelProps {
  model: AntennaModel;
  /** The tuner, when the page offers one, and the reference impedance its SWR goals use. */
  tune?: TuneHost;
  /** The mesh-refinement check, when the page offers one. */
  convergence?: ConvergenceHost;
  /** The multi-variable optimiser, when the page offers one. */
  optimiser?: OptimiseHost;
  z0?: number;
  dispatch: (action: HistoryAction) => void;
  selection: string | null;
  onSelect: (wireId: string | null) => void;
}

export function ModelPanel({ model, dispatch, selection, onSelect, tune, convergence, optimiser, z0 = 50 }: ModelPanelProps) {
  const edit = (recipe: (m: AntennaModel) => AntennaModel) => dispatch({ type: 'edit', recipe });
  const selected = model.wires.find((w) => w.id === selection);

  return (
    <div className="model-panel">
      <FrequencySection plan={model.frequency} onChange={(frequency) => edit((m) => ({ ...m, frequency }))} />
      <GroundSection ground={model.ground} onChange={(ground) => edit((m) => ({ ...m, ground }))} />

      <section className="form-section">
        <div className="section-head">
          <h3>Wires ({model.wires.length})</h3>
          <button
            type="button"
            className="small"
            disabled={model.wires.length === 0}
            title="Segments of λ/20 at the highest frequency, an odd number per wire"
            onClick={() => edit(autoSegment)}
          >
            Auto-segment
          </button>
        </div>
        {model.wires.length === 0 ? (
          <p className="muted">No wires yet. Use Draw wires, or right-click in a view and choose Add wire from here.</p>
        ) : (
          <ul className="wire-list">
            {model.wires.map((w) => (
              <li key={w.id}>
                <button
                  type="button"
                  aria-pressed={w.id === selection}
                  onClick={() => onSelect(w.id === selection ? null : w.id)}
                >
                  <span className="wire-tag">{w.tag}</span>
                  <span>{formatValue(Number(wireLength(w).toFixed(4)))} m</span>
                  <span className="muted">
                    {w.segments} seg · Ø {formatValue(Number((w.radius * 2000).toFixed(3)))} mm
                  </span>
                  {model.feeds.some((f) => f.wireId === w.id) && <span className="feed-badge">fed</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {selected && (
          <WireProperties key={selected.id} model={model} wire={selected} edit={edit} onDeleted={() => onSelect(null)} />
        )}
      </section>

      <FeedSection model={model} edit={edit} onSelect={onSelect} />
      <LoadSection model={model} edit={edit} onSelect={onSelect} selection={selection} />
      {tune && <TuneSection model={model} tune={tune} z0={z0} />}
      {optimiser && model.wires.length > 0 && <OptimiseSection model={model} host={optimiser} z0={z0} />}
      {convergence && model.wires.length > 0 && <ConvergenceSection model={model} host={convergence} />}
      <PatternSection model={model} edit={edit} />
      <NotesSection comments={model.comments} onChange={(comments) => edit((m) => ({ ...m, comments }))} />
    </div>
  );
}

function FrequencySection({ plan, onChange }: { plan: FrequencyPlan; onChange: (p: FrequencyPlan) => void }) {
  const sweep = plan.steps > 1;
  const end = tidy(plan.startMHz + (plan.steps - 1) * plan.stepMHz);
  const centre = sweep ? Number(((plan.startMHz + end) / 2).toPrecision(6)) : plan.startMHz;

  return (
    <section className="form-section">
      <h3>Frequency</h3>
      <div className="segmented" role="radiogroup" aria-label="Frequency mode">
        <button
          type="button"
          role="radio"
          aria-checked={!sweep}
          onClick={() => sweep && onChange({ startMHz: centre, stepMHz: 0, steps: 1 })}
        >
          Single
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={sweep}
          onClick={() =>
            !sweep &&
            onChange(sweepPlan(Number((centre * 0.975).toPrecision(4)), Number((centre * 1.025).toPrecision(4)), SWEEP_POINTS))
          }
        >
          Sweep
        </button>
      </div>
      {sweep ? (
        <div className="field-row">
          <NumberField label="From" value={plan.startMHz} above={0} unit="MHz" onCommit={(v) => onChange(sweepPlan(v, Math.max(end, v * 1.0001), plan.steps))} />
          <NumberField label="To" value={end} above={0} unit="MHz" onCommit={(v) => onChange(sweepPlan(Math.min(plan.startMHz, v * 0.9999), v, plan.steps))} />
          {/* NEC-2 puts no limit on the number of frequencies - nec2c's FR card is just a
              loop counter. What a long sweep costs is time and memory, both of which the
              design checks estimate and warn about by name, so the ceiling here is only
              a guard against a typo turning into an unkillable run. */}
          <NumberField
            label="Points"
            value={plan.steps}
            min={2}
            integer
            onCommit={(v) => onChange(sweepPlan(plan.startMHz, end, Math.min(MAX_SWEEP_POINTS, v)))}
          />
        </div>
      ) : (
        <div className="field-row">
          <NumberField label="Frequency" value={plan.startMHz} above={0} unit="MHz" onCommit={(v) => onChange({ startMHz: v, stepMHz: 0, steps: 1 })} />
        </div>
      )}
      <select
        className="band-picker"
        value=""
        aria-label="Sweep an amateur band"
        onChange={(e) => {
          const band = BANDS.find((b) => b.name === e.target.value);
          if (band) onChange(sweepPlan(band.from, band.to, SWEEP_POINTS));
        }}
      >
        <option value="">Sweep a band (IARU Region 1)…</option>
        {BANDS.map((b) => (
          <option key={b.name} value={b.name}>
            {b.name}: {b.from}–{b.to} MHz
          </option>
        ))}
      </select>
    </section>
  );
}

function GroundSection({ ground, onChange }: { ground: Ground; onChange: (g: Ground) => void }) {
  return (
    <section className="form-section">
      <h3>Ground</h3>
      <select
        value={ground.kind}
        aria-label="Ground"
        onChange={(e) => {
          const kind = e.target.value;
          if (kind === ground.kind) return;
          onChange(kind === 'real' ? AVERAGE_GROUND : kind === 'perfect' ? { kind: 'perfect' } : { kind: 'free-space' });
        }}
      >
        <option value="free-space">Free space</option>
        <option value="perfect">Perfect ground</option>
        <option value="real">Real ground</option>
      </select>
      {ground.kind === 'real' && (
        <>
          <div className="field-row">
            <NumberField label="Permittivity εr" value={ground.permittivity} above={0} onCommit={(v) => onChange({ ...ground, permittivity: v })} />
            <NumberField label="Conductivity" value={ground.conductivity} above={0} unit="S/m" onCommit={(v) => onChange({ ...ground, conductivity: v })} />
          </div>
          <select
            value={ground.method}
            aria-label="Ground calculation"
            disabled={ground.screen !== undefined}
            title={ground.screen ? 'nec2c allows a radial screen only with the reflection-coefficient method' : undefined}
            onChange={(e) => onChange({ ...ground, method: e.target.value === 'reflection' ? 'reflection' : 'sommerfeld' })}
          >
            <option value="sommerfeld">Sommerfeld-Norton (accurate)</option>
            <option value="reflection">Reflection coefficient (quick, approximate)</option>
          </select>
          <label className="field">
            <span className="field-label">Connection to ground</span>
            <select
              value={ground.screen ? 'screen' : 'none'}
              aria-label="Connection to ground"
              onChange={(e) => {
                const next = { ...ground };
                if (e.target.value === 'screen') onChange({ ...next, method: 'reflection', screen: { radials: 16, radiusM: 10, wireRadiusM: 0.001 } });
                else {
                  delete next.screen;
                  onChange(next);
                }
              }}
            >
              <option value="none">None: wires stay above the ground</option>
              <option value="screen">Radial screen at the origin (a ground-mounted vertical)</option>
            </select>
          </label>
          {ground.screen && (
            <>
              <div className="field-row">
                <NumberField label="Radials" value={ground.screen.radials} min={1} integer onCommit={(v) => onChange({ ...ground, screen: { ...ground.screen!, radials: v } })} />
                <NumberField label="Length" value={ground.screen.radiusM} above={0} unit="m" onCommit={(v) => onChange({ ...ground, screen: { ...ground.screen!, radiusM: v } })} />
                <NumberField label="Wire Ø" value={Number((ground.screen.wireRadiusM * 2000).toPrecision(6))} above={0} unit="mm" onCommit={(v) => onChange({ ...ground, screen: { ...ground.screen!, wireRadiusM: v / 2000 } })} />
              </div>
              <p className="muted">
                The screen connects a wire's base to the ground, which nec2c cannot do otherwise. Its count, length and wire size change nothing in
                nec2c's answer - the base behaves as over perfect ground, and the soil shapes the far field. The guide explains.
              </p>
            </>
          )}
          <p className="muted">Average ground is about εr 13, 0.005 S/m. Z = 0 is the ground surface.</p>
        </>
      )}
      {ground.kind === 'perfect' && <p className="muted">Z = 0 is the ground surface. Wires touching it connect to it.</p>}
    </section>
  );
}

interface EditProps {
  model: AntennaModel;
  edit: (recipe: (m: AntennaModel) => AntennaModel) => void;
}

function WireProperties({ model, wire, edit, onDeleted }: EditProps & { wire: Wire; onDeleted: () => void }) {
  const wavelength = wavelengthM(highestFrequencyMHz(model.frequency));
  const centre = centreSegment(wire);
  const fedAtCentre = model.feeds.some((f) => f.wireId === wire.id && f.segment === centre);

  // An end typed in moves with the ends joined to it, as when dragging.
  const setEnd = (end: 'a' | 'b', axis: 'x' | 'y' | 'z', value: number) =>
    edit((m) => {
      const current = m.wires.find((w) => w.id === wire.id);
      if (!current) return m;
      const point: Vec3 = withAxis(current[end], axis, value);
      return moveEnds(m, junctionOf(m, { wireId: wire.id, end }), point);
    });

  return (
    <div className="wire-properties" aria-label={`Wire ${wire.tag} properties`}>
      <h4>Wire {wire.tag}</h4>
      {(['a', 'b'] as const).map((end, i) => (
        <div key={end} className="field-row coords">
          <span className="coords-label">End {i + 1}</span>
          {(['x', 'y', 'z'] as const).map((axis) => (
            <NumberField
              key={axis}
              label={axis.toUpperCase()}
              value={wire[end][axis]}
              unit="m"
              onCommit={(v) => setEnd(end, axis, v)}
            />
          ))}
        </div>
      ))}
      <div className="field-row">
        <NumberField
          label="Diameter"
          value={Number((wire.radius * 2000).toPrecision(8))}
          above={0}
          unit="mm"
          onCommit={(v) => edit((m) => setWireGeometry(m, wire.id, { radius: v / 2000 }))}
        />
        <NumberField
          label="Segments"
          value={wire.segments}
          min={1}
          integer
          onCommit={(v) => edit((m) => setWireGeometry(m, wire.id, { segments: Math.min(2000, v) }))}
        />
      </div>
      <div className="field-row">
        <label className="field">
          <span className="field-label">Material</span>
          <select
            value={WIRE_MATERIALS.find((m) => m.siemensPerM === wire.conductivity)?.id ?? 'custom'}
            onChange={(e) => {
              const picked = WIRE_MATERIALS.find((m) => m.id === e.target.value);
              edit((m) => setWireConductivity(m, wire.id, picked ? picked.siemensPerM : (wire.conductivity ?? 1e7)));
            }}
          >
            {WIRE_MATERIALS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
            <option value="custom">Other conductivity…</option>
          </select>
        </label>
        {wire.conductivity !== undefined && !WIRE_MATERIALS.some((m) => m.siemensPerM === wire.conductivity) && (
          <NumberField label="Conductivity" value={Number(wire.conductivity.toPrecision(4))} above={0} unit="S/m" onCommit={(v) => edit((m) => setWireConductivity(m, wire.id, v))} />
        )}
      </div>
      <p className="muted">
        Length {formatValue(Number(wireLength(wire).toFixed(4)))} m · segments{' '}
        {formatValue(Number((segmentLength(wire) / wavelength).toFixed(3)))} λ long. Joined ends move together.
      </p>
      <div className="button-row">
        <button type="button" className="small" disabled={fedAtCentre} onClick={() => edit((m) => addFeed(m, wire.id, centre))}>
          Feed at centre
        </button>
        <button type="button" className="small" title="A loading coil on the middle segment; edit it under Loads" onClick={() => edit((m) => addLoad(m, wire.id, centre))}>
          Coil at centre
        </button>
        <button
          type="button"
          className="small danger"
          onClick={() => {
            edit((m) => deleteWire(m, wire.id));
            onDeleted();
          }}
        >
          Delete wire
        </button>
      </div>
    </div>
  );
}

function FeedSection({ model, edit, onSelect }: EditProps & { onSelect: (wireId: string) => void }) {
  return (
    <section className="form-section">
      <h3>Feed points ({model.feeds.length})</h3>
      {model.feeds.length === 0 && <p className="muted">Right-click a wire and choose Feed here.</p>}
      {model.feeds.map((f) => {
        const wire = model.wires.find((w) => w.id === f.wireId);
        if (!wire) return null;
        const magnitude = Math.hypot(f.voltage.re, f.voltage.im);
        const phase = (Math.atan2(f.voltage.im, f.voltage.re) * 180) / Math.PI;
        const setVoltage = (mag: number, deg: number) => {
          const rad = (deg * Math.PI) / 180;
          edit((m) => updateFeed(m, f.id, { voltage: { re: tidy(mag * Math.cos(rad)), im: tidy(mag * Math.sin(rad)) } }));
        };
        return (
          <FeedRow
            key={f.id}
            feed={f}
            wire={wire}
            model={model}
            edit={edit}
            onSelect={onSelect}
            magnitude={magnitude}
            phase={phase}
            setVoltage={setVoltage}
          />
        );
      })}
    </section>
  );
}

interface FeedRowProps extends EditProps {
  feed: Feed;
  wire: Wire;
  onSelect: (wireId: string) => void;
  magnitude: number;
  phase: number;
  setVoltage: (magnitude: number, phaseDeg: number) => void;
}

/**
 * One feed point. The position can be typed as a distance or as a percentage of the
 * wire, which is how an off-centre-fed dipole is specified; NEC can only drive the
 * middle of a segment, so the row says where it actually landed.
 */
function FeedRow({ feed, wire, model, edit, onSelect, magnitude, phase, setVoltage }: FeedRowProps) {
  return (
    <div className="feed-row">
      <div className="feed-head">
        <button type="button" className="link" onClick={() => onSelect(wire.id)}>
          Wire {wire.tag}, segment {feed.segment} of {wire.segments}
        </button>
        <button
          type="button"
          className="small"
          aria-label={`Remove the feed on wire ${wire.tag}`}
          onClick={() => edit((m) => removeFeed(m, feed.id))}
        >
          Remove
        </button>
      </div>
      <PositionFields model={model} edit={edit} wire={wire} segment={feed.segment} place={(fraction) => edit((m) => setFeedPosition(m, feed.id, fraction))} />
      <div className="field-row">
        <NumberField label="Volts" value={Number(magnitude.toPrecision(8))} above={0} unit="V" onCommit={(v) => setVoltage(v, phase)} />
        <NumberField label="Phase" value={Number(phase.toPrecision(8))} unit="°" onCommit={(v) => setVoltage(magnitude, v)} />
      </div>
    </div>
  );
}

interface PositionProps extends EditProps {
  wire: Wire;
  segment: number;
  /** Puts the thing at a fraction of the way along the wire; it lands on a segment centre. */
  place: (fraction: number) => void;
}

/**
 * Where a feed or a load sits along its wire, typed as metres from end 1 or as a
 * percentage. NEC can only use the middle of a segment, so the fields say where the
 * request actually landed, and offer a segment count that lands closer.
 */
function PositionFields({ model, edit, wire, segment, place }: PositionProps) {
  const length = wireLength(wire);
  const at = feedPosition(wire, segment);
  const wavelength = wavelengthM(highestFrequencyMHz(model.frequency));
  const [asked, setAsked] = useState<number | undefined>(undefined);

  const put = (fraction: number) => {
    setAsked(fraction);
    place(fraction);
  };

  // How far the nearest segment centre is from what was asked for, and whether a
  // different segment count would land on it.
  const missM = asked === undefined ? 0 : Math.abs(asked - at.fraction) * length;
  const better = asked === undefined ? wire.segments : segmentsForPosition(asked, suggestedSegments(length, wavelength));
  const betterMiss =
    asked === undefined ? 0 : Math.abs((segmentNearest({ ...wire, segments: better }, asked) - 0.5) / better - asked) * length;

  return (
    <>
      <div className="field-row">
        <NumberField label="From end 1" value={Number(at.metres.toFixed(4))} min={0} unit="m" onCommit={(v) => put(length > 0 ? v / length : 0)} />
        <NumberField label="Along the wire" value={Number((at.fraction * 100).toFixed(3))} min={0} unit="%" onCommit={(v) => put(v / 100)} />
      </div>
      {asked !== undefined && missM > 0.005 && (
        <p className="muted">
          The nearest segment centre is {formatValue(Number(missM.toFixed(3)))} m from there.
          {better !== wire.segments && betterMiss < missM * 0.9 && (
            <>
              {' '}
              <button type="button" className="link" onClick={() => edit((m) => setWireGeometry(m, wire.id, { segments: better }))}>
                Use {better} segments
              </button>{' '}
              to land within {formatValue(Number(Math.max(0.001, betterMiss).toFixed(3)))} m.
            </>
          )}
        </p>
      )}
    </>
  );
}

const ohmsText = (v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(2)} k` : v.toFixed(Math.abs(v) >= 100 ? 0 : 1));
const tidyUnit = (v: number) => Number(v.toPrecision(6));

function LoadSection({ model, edit, onSelect, selection }: EditProps & { onSelect: (wireId: string) => void; selection: string | null }) {
  // What the coil tool last offered, if anything. Read once: it does not change while this page is open.
  const [offer] = useState(() => loadLoadHandoff());
  const target = model.wires.find((w) => w.id === selection) ?? model.wires[0];
  return (
    <section className="form-section">
      <h3>Loads ({model.loads.length})</h3>
      {model.loads.length === 0 && (
        <p className="muted">Nothing in the wires yet. Right-click a wire and choose Coil here, or select a wire and press Coil at centre. A trap is a parallel load.</p>
      )}
      {offer && target && (
        <p className="muted handoff-offer">
          From Coils &amp; Filters: <strong>{offer.name}</strong>.{' '}
          <button
            type="button"
            className="link"
            onClick={() =>
              edit((m) => addLoad(m, target.id, centreSegment(target), { kind: offer.kind, ohms: offer.ohms, henries: offer.henries, farads: offer.farads, reactance: 0, label: offer.name }))
            }
          >
            Put it on wire {target.tag} at the centre
          </button>
          , then drag it where it belongs.
        </p>
      )}
      {model.loads.map((l) => {
        const wire = model.wires.find((w) => w.id === l.wireId);
        return wire ? <LoadRow key={l.id} load={l} wire={wire} model={model} edit={edit} onSelect={onSelect} /> : null;
      })}
    </section>
  );
}

/** One load: what it is, what it is made of, where it sits, and what it comes to at the first frequency. */
function LoadRow({ load, wire, model, edit, onSelect }: EditProps & { load: Load; wire: Wire; onSelect: (wireId: string) => void }) {
  const set = (patch: Partial<Omit<Load, 'id' | 'wireId'>>) => edit((m) => updateLoad(m, load.id, patch));
  const f = model.frequency.startMHz;
  const z = loadImpedance(load, f);
  const rlc = load.kind !== 'impedance';
  const resonance = load.kind === 'parallel' && load.henries > 0 && load.farads > 0 ? 1 / (2 * Math.PI * Math.sqrt(load.henries * load.farads)) / 1e6 : undefined;
  return (
    <div className="feed-row load-row">
      <div className="feed-head">
        <button type="button" className="link" onClick={() => onSelect(wire.id)}>
          Wire {wire.tag}, segment {load.segment} of {wire.segments}
        </button>
        <button type="button" className="small" aria-label={`Remove the load on wire ${wire.tag}`} onClick={() => edit((m) => removeLoad(m, load.id))}>
          Remove
        </button>
      </div>
      <div className="field-row">
        <label className="field">
          <span className="field-label">Kind</span>
          <select value={load.kind} onChange={(e) => set({ kind: e.target.value as LoadKind })}>
            <option value="series">Series R, L, C: a coil or capacitor</option>
            <option value="parallel">Parallel R, L, C: a trap</option>
            <option value="impedance">Fixed R + jX</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Name</span>
          <input key={load.id} type="text" defaultValue={load.label ?? ''} onBlur={(e) => e.target.value !== (load.label ?? '') && set({ label: e.target.value })} />
        </label>
      </div>
      {rlc ? (
        <div className="field-row">
          <NumberField label="R" value={tidyUnit(load.ohms)} min={0} unit="Ω" onCommit={(v) => set({ ohms: v })} />
          <NumberField label="L" value={tidyUnit(load.henries * 1e6)} min={0} unit="µH" onCommit={(v) => set({ henries: v * 1e-6 })} />
          <NumberField label="C" value={tidyUnit(load.farads * 1e12)} min={0} unit="pF" onCommit={(v) => set({ farads: v * 1e-12 })} />
        </div>
      ) : (
        <div className="field-row">
          <NumberField label="R" value={tidyUnit(load.ohms)} min={0} unit="Ω" onCommit={(v) => set({ ohms: v })} />
          <NumberField label="X" value={tidyUnit(load.reactance)} unit="Ω" onCommit={(v) => set({ reactance: v })} />
        </div>
      )}
      <PositionFields model={model} edit={edit} wire={wire} segment={load.segment} place={(fraction) => edit((m) => setLoadPosition(m, load.id, fraction))} />
      <p className="muted">
        {rlc ? 'A 0 leaves that part out. ' : ''}
        At {formatValue(f)} MHz: {Number.isFinite(z.re) ? `${ohmsText(z.re)} ${z.im >= 0 ? '+' : '−'} j${ohmsText(Math.abs(z.im))} Ω` : 'an open circuit'}
        {resonance !== undefined ? `; resonant at ${resonance.toFixed(3)} MHz` : ''}.
      </p>
    </div>
  );
}

function PatternSection({ model, edit }: EditProps) {
  const [deckCards] = useState(() => (model.pattern.kind === 'cards' ? model.pattern.cards : undefined));
  const cards = model.pattern.kind === 'cards' ? model.pattern.cards : deckCards;
  const choose = (kind: 'auto' | 'cards' | 'none') =>
    edit((m) => ({ ...m, pattern: kind === 'cards' && cards ? { kind: 'cards', cards } : kind === 'cards' ? m.pattern : { kind } }));

  return (
    <section className="form-section">
      <h3>Radiation pattern</h3>
      <div className="radio-list" role="radiogroup" aria-label="Radiation pattern">
        <label>
          <input type="radio" checked={model.pattern.kind === 'auto'} onChange={() => choose('auto')} /> Automatic: the whole
          sphere in 5° steps; plots cut through the main lobe
        </label>
        {cards && (
          <label>
            <input type="radio" checked={model.pattern.kind === 'cards'} onChange={() => choose('cards')} /> As in the deck (
            {cards.length} RP {cards.length === 1 ? 'card' : 'cards'})
          </label>
        )}
        <label>
          <input type="radio" checked={model.pattern.kind === 'none'} onChange={() => choose('none')} /> None: impedance and
          currents only, fastest
        </label>
      </div>
      {model.extraCards.length > 0 && (
        <>
          <p className="muted">Other cards, kept as they are (edit them in the card deck):</p>
          <pre className="extra-cards">{model.extraCards.join('\n')}</pre>
        </>
      )}
    </section>
  );
}

function NotesSection({ comments, onChange }: { comments: string[]; onChange: (c: string[]) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = comments.join('\n');
  return (
    <section className="form-section">
      <h3>Notes</h3>
      <textarea
        className="notes"
        rows={3}
        value={draft ?? text}
        placeholder="What is this antenna? Written as CM cards at the top of the deck."
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null && draft !== text) onChange(draft.split('\n').map((l) => l.trim()).filter((l) => l !== ''));
          setDraft(null);
        }}
      />
    </section>
  );
}


// ---- tuning ----

/** What the page gives the Tune section: a way to run, a way to stop, and what is happening. */
export interface TuneHost {
  busy: boolean;
  progress?: string;
  note?: string;
  run: (request: TuneRequest) => void;
  cancel: () => void;
}

/** What the page gives the optimiser: run, stop, and what is happening. */
export interface OptimiseHost {
  busy: boolean;
  progress?: string;
  note?: string;
  run: (request: OptimiseRequest) => void;
  cancel: () => void;
}

export interface OptimiseRequest {
  vars: OptimiseVariable[];
  goal: OptimiseGoal;
  maxEvaluations: number;
}

const MAX_OPTIMISE_VARIABLES = 6;

/**
 * Several things at once against a weighted goal. Every ticked thing gets its own range;
 * the search never leaves them, and the result is one undo step.
 */
function OptimiseSection({ model, host, z0 }: { model: AntennaModel; host: OptimiseHost; z0: number }) {
  const choices = variableChoices(model);
  const [ticked, setTicked] = useState<string[]>([]);
  const [ranges, setRanges] = useState<Record<string, { min: number; max: number }>>({});
  const [fMHz, setFMHz] = useState(model.frequency.startMHz);
  useEffect(() => setFMHz(model.frequency.startMHz), [model.frequency.startMHz]);
  const [gainWeight, setGainWeight] = useState(1);
  const [fbWeight, setFbWeight] = useState(0.5);
  const [swrWeight, setSwrWeight] = useState(1);
  const [swrTarget, setSwrTarget] = useState(1.5);
  const [swrOver, setSwrOver] = useState<'frequency' | 'sweep'>('frequency');
  const [maxEvaluations, setMaxEvaluations] = useState(150);
  const canBand = model.frequency.steps > 1;

  const live = ticked.map((k) => choices.find((c) => c.key === k)).filter((c): c is NonNullable<typeof c> => c !== undefined);
  const shownRange = (c: (typeof choices)[number]) => {
    const u = unitFor(c.variable);
    const s = suggestedRange(model, c.variable);
    return ranges[c.key] ?? { min: s.min * u.factor, max: s.max * u.factor };
  };
  const toggle = (k: string) => setTicked((t) => (t.includes(k) ? t.filter((x) => x !== k) : t.length >= MAX_OPTIMISE_VARIABLES ? t : [...t, k]));
  const ready = live.length > 0 && live.every((c) => shownRange(c).min < shownRange(c).max) && gainWeight + fbWeight + swrWeight > 0;

  const start = () => {
    host.run({
      vars: live.map((c) => {
        const u = unitFor(c.variable);
        const r = shownRange(c);
        return { variable: c.variable, range: { min: r.min / u.factor, max: r.max / u.factor } };
      }),
      goal: { fMHz, gainWeight, fbWeight, swrWeight, swrTarget, swrOver: canBand ? swrOver : 'frequency', z0 },
      maxEvaluations,
    });
  };

  return (
    <section className="form-section optimise">
      <h3>Optimise</h3>
      <p className="muted">
        Change several things at once - a Yagi's element lengths and their places on the boom, say - against gain, front-to-back and SWR
        together, weighed as you choose. Every trial is a real solve.
      </p>
      <ul className="optimise-list">
        {choices.map((c) => {
          const on = ticked.includes(c.key);
          const u = unitFor(c.variable);
          const r = shownRange(c);
          return (
            <li key={c.key}>
              <label className="check">
                <input type="checkbox" checked={on} disabled={!on && ticked.length >= MAX_OPTIMISE_VARIABLES} onChange={() => toggle(c.key)} /> {c.label}
              </label>
              {on && (
                <div className="field-row">
                  <NumberField label="Between" value={Number(r.min.toPrecision(5))} unit={u.label} onCommit={(v) => setRanges({ ...ranges, [c.key]: { min: v, max: r.max } })} />
                  <NumberField label="and" value={Number(r.max.toPrecision(5))} unit={u.label} onCommit={(v) => setRanges({ ...ranges, [c.key]: { min: r.min, max: v } })} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {ticked.length >= MAX_OPTIMISE_VARIABLES && <p className="muted">Six at most: each one more makes the search slower and less sure.</p>}
      <NumberField label="At" value={fMHz} above={0} unit="MHz" onCommit={setFMHz} />
      <div className="field-row">
        <NumberField label="Gain, per dB" value={gainWeight} min={0} onCommit={setGainWeight} />
        <NumberField label="Front to back, per dB" value={fbWeight} min={0} onCommit={setFbWeight} />
      </div>
      <div className="field-row">
        <NumberField label="SWR weight" value={swrWeight} min={0} onCommit={setSwrWeight} />
        <NumberField label="SWR target" value={swrTarget} min={1} onCommit={setSwrTarget} />
        {canBand && (
          <label className="field">
            <span className="field-label">SWR</span>
            <select value={swrOver} onChange={(e) => setSwrOver(e.target.value === 'sweep' ? 'sweep' : 'frequency')}>
              <option value="frequency">at that frequency</option>
              <option value="sweep">worst across the sweep</option>
            </select>
          </label>
        )}
      </div>
      <p className="muted">
        Each 0.1 of SWR over the target costs as much as 1 dB of gain, times its weight. Front-to-back counts up to {FB_CAP_DB} dB and no
        further: past that the search would chase a razor-thin null no real antenna keeps.
      </p>
      <NumberField label="At most" value={maxEvaluations} min={10} integer unit="trials" onCommit={(v) => setMaxEvaluations(Math.min(1000, v))} />
      <div className="button-row">
        {host.busy ? (
          <button type="button" className="small danger" onClick={host.cancel}>
            Stop
          </button>
        ) : (
          <button type="button" className="small" disabled={!ready} onClick={start}>
            Optimise
          </button>
        )}
        {host.busy && host.progress && <span className="muted">{host.progress}</span>}
      </div>
      {!host.busy && host.note && <p className="muted tune-note optimise-note">{host.note}</p>}
    </section>
  );
}

/** What the page gives the convergence check: run, stop, and the verdict in words. */
export interface ConvergenceHost {
  busy: boolean;
  note?: string;
  run: () => void;
  cancel: () => void;
}

/**
 * The numerical analyst's oldest test, as one button: solve again with every wire at
 * twice the segments and report whether the feed impedance and peak gain move.
 */
function ConvergenceSection({ model, host }: { model: AntennaModel; host: ConvergenceHost }) {
  const total = model.wires.reduce((n, w) => n + w.segments, 0);
  return (
    <section className="form-section convergence">
      <h3>Is the model converged?</h3>
      <p className="muted">
        Solves it again with every wire at twice the segments ({total} → {total * 2}) and reports whether the feed impedance and
        the peak gain move. If they barely move, the answers do not depend on how finely the wires were chopped.
      </p>
      <div className="button-row">
        {host.busy ? (
          <button type="button" className="small danger" onClick={host.cancel}>
            Stop
          </button>
        ) : (
          <button type="button" className="small" onClick={host.run}>
            Check it
          </button>
        )}
        {host.busy && <span className="muted">solving at both densities…</span>}
      </div>
      {!host.busy && host.note && <p className="muted tune-note convergence-note">{host.note}</p>}
    </section>
  );
}

/** The unit a person types a variable in; the request goes out in SI. */
function unitFor(variable: TuneVariable): { label: string; factor: number } {
  if (variable.kind !== 'load') return { label: 'm', factor: 1 };
  if (variable.field === 'henries') return { label: 'µH', factor: 1e6 };
  if (variable.field === 'farads') return { label: 'pF', factor: 1e12 };
  return { label: 'Ω', factor: 1 };
}


/**
 * Change one thing until a goal is met. The list of things is built from the model:
 * every wire's length, the height of the lot, and each part of each load.
 */
function TuneSection({ model, tune, z0 }: { model: AntennaModel; tune: TuneHost; z0: number }) {
  const choices = variableChoices(model);

  const [key, setKey] = useState(choices[0]?.key ?? '');
  const [ends, setEnds] = useState<'both' | 'a' | 'b'>('both');
  const [goalKind, setGoalKind] = useState<TuneGoal['kind']>('resonance');
  const [fMHz, setFMHz] = useState(model.frequency.startMHz);
  // A new model, a new band: the goal frequency follows it rather than staying where it was.
  useEffect(() => setFMHz(model.frequency.startMHz), [model.frequency.startMHz]);
  /** Typed in the display unit; undefined means "whatever is suggested". */
  const [range, setRange] = useState<{ min: number; max: number } | undefined>(undefined);

  const chosen = choices.find((c) => c.key === key) ?? choices[0];
  const variable: TuneVariable | undefined = chosen && (chosen.variable.kind === 'wire-length' ? { ...chosen.variable, ends } : chosen.variable);
  const unit = variable ? unitFor(variable) : { label: '', factor: 1 };
  const suggested = variable ? suggestedRange(model, variable) : undefined;
  const shown = range ?? (suggested ? { min: suggested.min * unit.factor, max: suggested.max * unit.factor } : { min: 0, max: 1 });
  const now = variable ? currentValue(model, variable) : undefined;
  const canBand = model.frequency.steps > 1;

  const start = () => {
    if (!variable) return;
    const goal: TuneGoal =
      goalKind === 'swr-band' ? { kind: 'swr-band', z0 }
      : goalKind === 'swr' ? { kind: 'swr', fMHz, z0 }
      : goalKind === 'gain' ? { kind: 'gain', fMHz }
      : goalKind === 'front-to-back' ? { kind: 'front-to-back', fMHz }
      : { kind: 'resonance', fMHz };
    tune.run({ variable, range: { min: shown.min / unit.factor, max: shown.max / unit.factor }, goal });
  };

  return (
    <section className="form-section tune">
      <h3>Tune</h3>
      {choices.length === 0 ? (
        <p className="muted">Draw a wire first.</p>
      ) : (
        <>
          <p className="muted">Change one thing until a goal is met. Every trial is a real solve, so the answer is the model's, not a formula's.</p>
          <label className="field">
            <span className="field-label">Change</span>
            <select
              value={chosen?.key}
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
          {variable?.kind === 'wire-length' && (
            <label className="field">
              <span className="field-label">Moving</span>
              <select
                value={ends}
                onChange={(e) => {
                  setEnds(e.target.value as 'both' | 'a' | 'b');
                  setRange(undefined);
                }}
              >
                <option value="both">both ends, about the middle</option>
                <option value="b">end 2 only</option>
                <option value="a">end 1 only</option>
              </select>
            </label>
          )}
          <div className="field-row">
            <NumberField label="Between" value={Number(shown.min.toPrecision(5))} unit={unit.label} onCommit={(v) => setRange({ min: v, max: shown.max })} />
            <NumberField label="and" value={Number(shown.max.toPrecision(5))} unit={unit.label} onCommit={(v) => setRange({ min: shown.min, max: v })} />
          </div>
          {now !== undefined && (
            <p className="muted">
              Now {formatValue(Number((now * unit.factor).toPrecision(5)))} {unit.label}.
            </p>
          )}
          <div className="field-row">
            <label className="field">
              <span className="field-label">Until</span>
              <select value={goalKind} onChange={(e) => setGoalKind(e.target.value as TuneGoal['kind'])}>
                <option value="resonance">it is resonant (X = 0)</option>
                <option value="swr">the SWR is lowest</option>
                {canBand && <option value="swr-band">the worst SWR over the sweep is lowest</option>}
                <option value="gain">the peak gain is highest</option>
                <option value="front-to-back">the front-to-back is best</option>
              </select>
            </label>
            {goalKind !== 'swr-band' && <NumberField label="at" value={fMHz} above={0} unit="MHz" onCommit={setFMHz} />}
          </div>
          <div className="button-row">
            {tune.busy ? (
              <button type="button" className="small danger" onClick={tune.cancel}>
                Stop
              </button>
            ) : (
              <button type="button" className="small" onClick={start} disabled={!(shown.min < shown.max)}>
                Tune
              </button>
            )}
            {tune.busy && tune.progress && <span className="muted">{tune.progress}</span>}
          </div>
          {!tune.busy && tune.note && <p className="muted tune-note">{tune.note}</p>}
        </>
      )}
    </section>
  );
}
