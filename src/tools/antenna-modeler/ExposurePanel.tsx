// The RF exposure map: field strength around the antenna on a plan view, at your power.
//
// One solve per map (NE + NH over a square grid at one height), started by a button: a
// map of a big model is real work, and it is the person's call when to spend it. The
// figures are scaled to the AVERAGE power the regulator's averaging asks about, after any
// feed line and balun, and the limit is whatever the person types - EMWS states none.
//
// Colour: one blue ramp in seven steps, each half the field of the next (6 dB). Crossing
// the limit is a state, not a magnitude, so it is drawn as a boundary line and named in
// the legend and the verdict - never by colour alone. Cells too close to a wire to trust
// are grey and say so.
//
// Public domain (The Unlicense). By ZR1JT.

import { type PointerEvent, useEffect, useMemo, useState } from 'react';
import type { Nec2Run } from '../../engine/nec2/types';
import { NumberField } from '../../ui/NumberField';
import { formatSi } from '../smith-chart/units';
import {
  type ExposureGrid,
  type ExposureMap,
  type Quantity,
  averagePowerW,
  exposureDeck,
  exposureMap,
  suggestedGrid,
  valueOf,
  verdict,
} from './exposure';
import type { AntennaModel } from './model';

const STORAGE_KEY = 'emws.exposure.v1';

/** What the person typed that should survive a reload: the regulator's figures above all. */
interface Kept {
  eLimit?: number;
  hLimit?: number;
  dutyPct: number;
  onAirPct: number;
}

function loadKept(): Kept {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const v: unknown = raw ? JSON.parse(raw) : undefined;
    if (v && typeof v === 'object') {
      const k = v as Partial<Kept>;
      const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : undefined);
      return { eLimit: num(k.eLimit), hLimit: num(k.hLimit), dutyPct: num(k.dutyPct) ?? 100, onAirPct: num(k.onAirPct) ?? 100 };
    }
  } catch {
    // storage blocked or holding something older: start fresh
  }
  return { dutyPct: 100, onAirPct: 100 };
}

const DUTIES = [
  { label: 'Key down, FM, FT8, RTTY (100 %)', pct: 100 },
  { label: 'CW (roughly 40 %)', pct: 40 },
  { label: 'SSB speech (roughly 20 %)', pct: 20 },
];

const STEPS = 7;
const UNIT: Record<Quantity, string> = { e: 'V/m', h: 'A/m' };

/** Which of the seven steps a value falls in: each step is half the field of the one above. */
function stepOf(value: number, reference: number): number {
  if (!(value > 0) || !(reference > 0)) return 0;
  const below = Math.floor(Math.log2(reference / value)) + 1; // 0 at or above the reference
  return Math.max(0, Math.min(STEPS - 1, STEPS - 1 - Math.max(0, below)));
}

export interface ExposurePanelProps {
  model: AntennaModel;
  /** The frequency on screen. */
  fMHz: number;
  /** Transmitter power, shared with the ratings and the feed-line budget. */
  powerW: number;
  onPower: (watts: number) => void;
  /** Share of the transmitter's power that reaches the feed point (after feed line and balun). */
  deliveredShare: number;
  /** What sits between radio and antenna, for the words: "30 m of LMR-400", or undefined. */
  through?: string;
  solve: (deck: string) => Promise<Nec2Run>;
  onCancel: () => void;
}

interface Mapped {
  model: AntennaModel;
  fMHz: number;
  grid: ExposureGrid;
  run: Nec2Run;
}

export function ExposurePanel({ model, fMHz, powerW, onPower, deliveredShare, through, solve, onCancel }: ExposurePanelProps) {
  const [kept, setKept] = useState<Kept>(loadKept);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(kept));
    } catch {
      // see loadKept
    }
  }, [kept]);
  const [grid, setGrid] = useState<ExposureGrid>(() => suggestedGrid(model));
  const [quantity, setQuantity] = useState<Quantity>('e');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [mapped, setMapped] = useState<Mapped>();
  const [hover, setHover] = useState<number>();

  const free = model.ground.kind === 'free-space';
  const blocked = !free && !(grid.heightM > 0) ? 'Over ground the plane must be above it: give a height above 0 m.' : undefined;
  const averageW = averagePowerW(powerW * deliveredShare, kept.dutyPct / 100, kept.onAirPct / 100);
  const current = mapped && mapped.model === model && mapped.fMHz === fMHz && sameGrid(mapped.grid, grid) ? mapped : undefined;

  const run = () => {
    setBusy(true);
    setFailure(undefined);
    const ask = { model, fMHz, grid };
    solve(exposureDeck(model, fMHz, grid))
      .then((r) => {
        if (r.report.errors.length > 0) setFailure(r.report.errors.join(' '));
        else setMapped({ ...ask, run: r });
      })
      .catch((e: unknown) => setFailure(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const map: ExposureMap | undefined = useMemo(() => {
    const f = current?.run.report.frequencies[0];
    return f ? exposureMap(f, current.run.report.segments, averageW) : undefined;
  }, [current, averageW]);
  const limit = quantity === 'e' ? kept.eLimit : kept.hLimit;
  const v = map ? verdict(map, quantity, limit) : undefined;

  return (
    <details className="panel exposure" open>
      <summary>RF exposure around the antenna</summary>
      <p className="muted">
        The field strength on a level plane around the antenna, at your power, worked out by NEC-2 from the currents it solved. EMWS
        states <strong>no exposure limits</strong>: type your regulator's figure for this frequency and situation, and the map shows
        where the field crosses it.
      </p>

      <div className="exposure-controls">
        <div className="field-row">
          <label className="field">
            <span className="field-label">Transmitter</span>
            <span className="field-input">
              <input className="z0" type="number" min={0} step={10} value={powerW} onChange={(e) => onPower(Math.max(0, Number(e.target.value) || 0))} aria-label="Transmitter power, watts" /> W
            </span>
          </label>
          <label className="field">
            <span className="field-label">Mode</span>
            <select value={kept.dutyPct} onChange={(e) => setKept({ ...kept, dutyPct: Number(e.target.value) })}>
              {DUTIES.map((d) => (
                <option key={d.pct} value={d.pct}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <NumberField label="On air, of the averaging time" value={kept.onAirPct} min={0} unit="%" onCommit={(x) => setKept({ ...kept, onAirPct: Math.min(100, x) })} />
        </div>
        <div className="field-row">
          <NumberField label="Height of the plane" value={grid.heightM} unit="m" onCommit={(x) => setGrid({ ...grid, heightM: x })} />
          <NumberField label="Map out to, each way" value={grid.halfWidthM} above={0} unit="m" onCommit={(x) => setGrid({ ...grid, halfWidthM: x })} />
        </div>
        <div className="field-row">
          <NumberField label="Your limit, electric" value={kept.eLimit ?? 0} min={0} unit="V/m" onCommit={(x) => setKept({ ...kept, eLimit: x > 0 ? x : undefined })} />
          <NumberField label="Your limit, magnetic" value={kept.hLimit ?? 0} min={0} unit="A/m" onCommit={(x) => setKept({ ...kept, hLimit: x > 0 ? x : undefined })} />
        </div>
        <div className="button-row">
          {busy ? (
            <button type="button" className="small danger" onClick={onCancel}>
              Stop
            </button>
          ) : (
            <button type="button" className="small" disabled={blocked !== undefined} onClick={run}>
              {mapped && !current ? 'Map it again' : 'Map the field'}
            </button>
          )}
          <span className="segmented small-segmented" role="radiogroup" aria-label="Which field">
            <button type="button" role="radio" aria-checked={quantity === 'e'} onClick={() => setQuantity('e')}>
              Electric, V/m
            </button>
            <button type="button" role="radio" aria-checked={quantity === 'h'} onClick={() => setQuantity('h')}>
              Magnetic, A/m
            </button>
          </span>
          {busy && <span className="muted">solving the field at {odd(grid.points) ** 2} points…</span>}
        </div>
        {blocked && <p className="alert-inline">{blocked}</p>}
        {failure && <p className="alert-inline">The map could not be made: {failure}</p>}
        {mapped && !current && !busy && <p className="muted">The model, frequency or plane has changed since this map was made: map it again.</p>}
      </div>

      {map && v && current && (
        <>
          <p className="build-card exposure-verdict">
            {powerW} W{through ? ` through ${through}` : ''}
            {deliveredShare < 0.999 ? `, of which ${(powerW * deliveredShare).toFixed(1)} W reaches the antenna,` : ''} at {kept.dutyPct} % duty and{' '}
            {kept.onAirPct} % of the time on air averages <strong>{averageW.toFixed(1)} W</strong>. At {current.grid.heightM} m the{' '}
            {quantity === 'e' ? 'electric' : 'magnetic'} field reaches <strong>{formatSi(v.peak, UNIT[quantity], 3)}</strong> RMS on this map.
            {limit === undefined && <> Type your regulator's limit above to see where it is crossed.</>}
          </p>
          {limit !== undefined &&
            (v.overCount === 0 ? (
              <p className="exposure-flag exposure-flag-clear">
                <span aria-hidden="true">✓</span> <strong>Nowhere on this map over your {formatSi(limit, UNIT[quantity], 3)}.</strong>
              </p>
            ) : (
              <p className="exposure-flag exposure-flag-over">
                <span aria-hidden="true">✕</span> <strong>Over your {formatSi(limit, UNIT[quantity], 3)}</strong> out to{' '}
                <strong>{v.reachM.toFixed(1)} m</strong> from the nearest wire
                {v.overAtEdge ? ' - and still over at the edge of the map: widen it to find where it ends' : ''}.
              </p>
            ))}
          <FieldMap
            map={map}
            quantity={quantity}
            limit={limit}
            grid={current.grid}
            model={current.model}
            hover={hover}
            onHover={setHover}
            peak={v.peak}
          />
          <p className="muted">
            Free-space or ground as modelled, at points on a level plane; nearby metal, buildings and people are not in the model. Greyed
            points lie closer to a wire than one of its segments, where a thin-wire model is least reliable - EMWS's own cautious rule.
            This is an estimate to plan with; a measurement or a professional assessment is what settles compliance.
          </p>
        </>
      )}
    </details>
  );
}

const odd = (n: number) => {
  const whole = Math.max(3, Math.round(n));
  return whole % 2 === 1 ? whole : whole + 1;
};

function sameGrid(a: ExposureGrid, b: ExposureGrid): boolean {
  return a.centreX === b.centreX && a.centreY === b.centreY && a.halfWidthM === b.halfWidthM && a.heightM === b.heightM && a.points === b.points;
}

const SIZE = 480;
const PAD = { left: 52, right: 12, top: 10, bottom: 40 };

function FieldMap({
  map,
  quantity,
  limit,
  grid,
  model,
  hover,
  onHover,
  peak,
}: {
  map: ExposureMap;
  quantity: Quantity;
  limit: number | undefined;
  grid: ExposureGrid;
  model: AntennaModel;
  hover: number | undefined;
  onHover: (i: number | undefined) => void;
  peak: number;
}) {
  const n = map.points;
  const cell = SIZE / n;
  const x0 = grid.centreX - grid.halfWidthM;
  const y0 = grid.centreY - grid.halfWidthM;
  const span = 2 * grid.halfWidthM;
  const sx = (x: number) => PAD.left + ((x - x0) / span) * (SIZE - cell) + cell / 2;
  // Plan view: Y up, as the editor's Top view draws it.
  const sy = (y: number) => PAD.top + SIZE - (((y - y0) / span) * (SIZE - cell) + cell / 2);
  // With a limit the steps hang from it; without one, from half the peak.
  const reference = limit ?? peak / 2;
  const over = (i: number) => limit !== undefined && !map.cells[i]!.tooClose && valueOf(map.cells[i]!, quantity) > limit;

  // The limit's boundary: every cell edge between an over cell and one that is not.
  let boundary = '';
  if (limit !== undefined) {
    for (let i = 0; i < map.cells.length; i++) {
      if (!over(i)) continue;
      const col = i % n;
      const row = Math.floor(i / n);
      const cx = sx(map.cells[i]!.x);
      const cy = sy(map.cells[i]!.y);
      const h = cell / 2;
      if (col === 0 || !over(i - 1)) boundary += `M${cx - h},${cy - h}V${cy + h}`;
      if (col === n - 1 || !over(i + 1)) boundary += `M${cx + h},${cy - h}V${cy + h}`;
      if (row === 0 || !over(i - n)) boundary += `M${cx - h},${cy + h}H${cx + h}`;
      if (row === n - 1 || !over(i + n)) boundary += `M${cx - h},${cy - h}H${cx + h}`;
    }
  }

  const ticks = [-1, -0.5, 0, 0.5, 1].map((t) => ({ x: grid.centreX + t * grid.halfWidthM, y: grid.centreY + t * grid.halfWidthM }));
  const chosen = hover !== undefined ? map.cells[hover] : undefined;
  const unit = UNIT[quantity];
  const show = (x: number) => formatSi(x, unit, 3);

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * (PAD.left + SIZE + PAD.right) - PAD.left;
    const py = ((e.clientY - box.top) / box.height) * (PAD.top + SIZE + PAD.bottom) - PAD.top;
    if (px < 0 || py < 0 || px >= SIZE || py >= SIZE) return onHover(undefined);
    const col = Math.floor(px / cell);
    const row = n - 1 - Math.floor(py / cell);
    onHover(row * n + col);
  };

  const legend = Array.from({ length: STEPS }, (_, s) => {
    const hi = reference / 2 ** (STEPS - 2 - s);
    const lo = hi / 2;
    const label =
      s === STEPS - 1 ? (limit !== undefined ? `over ${show(reference)}` : `${show(reference)} and up`) : s === 0 ? `under ${show(hi)}` : `${show(lo)} – ${show(hi)}`;
    return { s, label };
  });

  return (
    <figure className="exposure-map">
      <figcaption>
        <span className="chart-title">
          {quantity === 'e' ? 'Electric' : 'Magnetic'} field at {grid.heightM} m, {unit} RMS, seen from above
        </span>
        {chosen && (
          <span className="chart-readout">
            X {chosen.x.toFixed(1)} m, Y {chosen.y.toFixed(1)} m: <strong>{chosen.tooClose ? 'too close to a wire to trust' : show(valueOf(chosen, quantity))}</strong>
            {!chosen.tooClose && ` · ${quantity === 'e' ? formatSi(chosen.hRms, 'A/m', 3) : formatSi(chosen.eRms, 'V/m', 3)}`} · {chosen.wireDistanceM.toFixed(1)} m from the nearest
            wire
          </span>
        )}
      </figcaption>
      <svg
        viewBox={`0 0 ${PAD.left + SIZE + PAD.right} ${PAD.top + SIZE + PAD.bottom}`}
        role="img"
        aria-label={`Map of the ${quantity === 'e' ? 'electric' : 'magnetic'} field, peak ${show(peak)}${limit !== undefined ? `, limit ${show(limit)}` : ''}.`}
        onPointerMove={onMove}
        onPointerLeave={() => onHover(undefined)}
      >
        {map.cells.map((c, i) => (
          <rect
            key={i}
            x={sx(c.x) - cell / 2}
            y={sy(c.y) - cell / 2}
            width={cell}
            height={cell}
            className={c.tooClose ? 'exposure-cell exposure-untrusted' : `exposure-cell exposure-step-${stepOf(valueOf(c, quantity), reference)}`}
          />
        ))}
        {boundary && <path d={boundary} className="exposure-boundary" />}
        {model.wires.map((w) => (
          <g key={w.id}>
            <line x1={sx(w.a.x)} y1={sy(w.a.y)} x2={sx(w.b.x)} y2={sy(w.b.y)} className="exposure-wire-halo" />
            <line x1={sx(w.a.x)} y1={sy(w.a.y)} x2={sx(w.b.x)} y2={sy(w.b.y)} className="exposure-wire" />
          </g>
        ))}
        {chosen && <rect x={sx(chosen.x) - cell / 2} y={sy(chosen.y) - cell / 2} width={cell} height={cell} className="exposure-hover" />}
        {ticks.map((t) => (
          <g key={t.x}>
            <text x={sx(t.x)} y={PAD.top + SIZE + 16} className="plot-label" textAnchor="middle">
              {Number(t.x.toFixed(1))}
            </text>
            <text x={PAD.left - 6} y={sy(t.y) + 4} className="plot-label" textAnchor="end">
              {Number(t.y.toFixed(1))}
            </text>
          </g>
        ))}
        <text x={PAD.left + SIZE / 2} y={PAD.top + SIZE + 34} className="plot-label" textAnchor="middle">
          X, m
        </text>
        <text x={14} y={PAD.top + SIZE / 2} className="plot-label" textAnchor="middle" transform={`rotate(-90 14 ${PAD.top + SIZE / 2})`}>
          Y, m
        </text>
      </svg>
      <ul className="exposure-legend" aria-label="Key">
        {[...legend].reverse().map(({ s, label }) => (
          <li key={s}>
            <svg width="16" height="12" aria-hidden="true">
              <rect width="16" height="12" className={`exposure-step-${s}`} />
            </svg>
            {label}
          </li>
        ))}
        {limit !== undefined && (
          <li>
            <svg width="16" height="12" aria-hidden="true">
              <line x1="0" y1="6" x2="16" y2="6" className="exposure-boundary" />
            </svg>
            <span aria-hidden="true">✕</span> where your {show(limit)} is crossed
          </li>
        )}
        <li>
          <svg width="16" height="12" aria-hidden="true">
            <rect width="16" height="12" className="exposure-untrusted" />
          </svg>
          too close to a wire to trust
        </li>
      </ul>
      <p className="muted exposure-scale-note">Each step is half the field of the one above it: 6 dB, a quarter of the power density.</p>
    </figure>
  );
}
