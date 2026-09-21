// The form side of the editor: frequency, ground, wires, feeds, pattern and notes.

import { useState } from 'react';
import type { Vec3 } from '../../engine/nec2/types';
import { tidy, withAxis } from '../../lib/vec3';
import type { HistoryAction } from './history';
import {
  type AntennaModel,
  AVERAGE_GROUND,
  type Feed,
  type FrequencyPlan,
  type Ground,
  type Wire,
  addFeed,
  autoSegment,
  centreSegment,
  deleteWire,
  feedPosition,
  junctionOf,
  moveEnds,
  removeFeed,
  segmentLength,
  segmentNearest,
  segmentsForPosition,
  setFeedPosition,
  setWireGeometry,
  suggestedSegments,
  updateFeed,
  wavelengthM,
  highestFrequencyMHz,
  wireLength,
} from './model';
import { formatValue, NumberField } from '../../ui/NumberField';

/** Amateur bands, IARU Region 1 edges. Picking one sets up a sweep across it. */
const BANDS: { name: string; from: number; to: number }[] = [
  { name: '160 m', from: 1.81, to: 2.0 },
  { name: '80 m', from: 3.5, to: 3.8 },
  { name: '40 m', from: 7.0, to: 7.2 },
  { name: '30 m', from: 10.1, to: 10.15 },
  { name: '20 m', from: 14.0, to: 14.35 },
  { name: '17 m', from: 18.068, to: 18.168 },
  { name: '15 m', from: 21.0, to: 21.45 },
  { name: '12 m', from: 24.89, to: 24.99 },
  { name: '10 m', from: 28.0, to: 29.7 },
  { name: '6 m', from: 50.0, to: 52.0 },
  { name: '2 m', from: 144.0, to: 146.0 },
  { name: '70 cm', from: 430.0, to: 440.0 },
];

const SWEEP_POINTS = 21;

function sweepPlan(from: number, to: number, points: number): FrequencyPlan {
  const steps = Math.max(2, Math.round(points));
  return { startMHz: tidy(from), stepMHz: tidy((to - from) / (steps - 1)), steps };
}

export interface ModelPanelProps {
  model: AntennaModel;
  dispatch: (action: HistoryAction) => void;
  selection: string | null;
  onSelect: (wireId: string | null) => void;
}

export function ModelPanel({ model, dispatch, selection, onSelect }: ModelPanelProps) {
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
          <NumberField label="Points" value={plan.steps} min={2} integer onCommit={(v) => onChange(sweepPlan(plan.startMHz, end, Math.min(401, v)))} />
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
            onChange={(e) => onChange({ ...ground, method: e.target.value === 'reflection' ? 'reflection' : 'sommerfeld' })}
          >
            <option value="sommerfeld">Sommerfeld-Norton (accurate)</option>
            <option value="reflection">Reflection coefficient (quick, approximate)</option>
          </select>
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
      <p className="muted">
        Length {formatValue(Number(wireLength(wire).toFixed(4)))} m · segments{' '}
        {formatValue(Number((segmentLength(wire) / wavelength).toFixed(3)))} λ long. Joined ends move together.
      </p>
      <div className="button-row">
        <button type="button" className="small" disabled={fedAtCentre} onClick={() => edit((m) => addFeed(m, wire.id, centre))}>
          Feed at centre
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
  const length = wireLength(wire);
  const at = feedPosition(wire, feed.segment);
  const wavelength = wavelengthM(highestFrequencyMHz(model.frequency));
  const [asked, setAsked] = useState<number | undefined>(undefined);

  const place = (fraction: number) => {
    setAsked(fraction);
    edit((m) => setFeedPosition(m, feed.id, fraction));
  };

  // How far the nearest segment centre is from what was asked for, and whether a
  // different segment count would land on it.
  const missM = asked === undefined ? 0 : Math.abs(asked - at.fraction) * length;
  const better = asked === undefined ? wire.segments : segmentsForPosition(asked, suggestedSegments(length, wavelength));
  const betterMiss =
    asked === undefined ? 0 : Math.abs((segmentNearest({ ...wire, segments: better }, asked) - 0.5) / better - asked) * length;

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
      <div className="field-row">
        <NumberField
          label="From end 1"
          value={Number(at.metres.toFixed(4))}
          min={0}
          unit="m"
          onCommit={(v) => place(length > 0 ? v / length : 0)}
        />
        <NumberField
          label="Along the wire"
          value={Number((at.fraction * 100).toFixed(3))}
          min={0}
          unit="%"
          onCommit={(v) => place(v / 100)}
        />
      </div>
      <div className="field-row">
        <NumberField label="Volts" value={Number(magnitude.toPrecision(8))} above={0} unit="V" onCommit={(v) => setVoltage(v, phase)} />
        <NumberField label="Phase" value={Number(phase.toPrecision(8))} unit="°" onCommit={(v) => setVoltage(magnitude, v)} />
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
