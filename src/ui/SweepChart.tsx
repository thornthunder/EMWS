// SWR against frequency for a swept run. Click a point to inspect that frequency.

const WIDTH = 700;
const HEIGHT = 240;
const PAD = { left: 44, right: 16, top: 14, bottom: 34 };
const SWR_CEILING = 10;
const GUIDES = [1.5, 2, 3];

export interface SweepPoint {
  frequencyMHz: number;
  swr: number;
}

export interface SweepChartProps {
  points: SweepPoint[];
  selected: number;
  onSelect: (index: number) => void;
  z0: number;
  /** A measurement of the real thing, to lay over the model. Any frequencies; clipped to the plot. */
  measured?: SweepPoint[];
  measuredLabel?: string;
}

export function SweepChart({ points, selected, onSelect, z0, measured, measuredLabel }: SweepChartProps) {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || points.length < 2) return null;

  const fMin = first.frequencyMHz;
  const fMax = last.frequencyMHz;
  const inRange = (measured ?? []).filter((m) => m.frequencyMHz >= first.frequencyMHz && m.frequencyMHz <= last.frequencyMHz);
  const worst = Math.max(...[...points, ...inRange].map((p) => Math.min(p.swr, SWR_CEILING)));
  const top = Math.min(SWR_CEILING, Math.max(2, Math.ceil(worst)));

  const x = (f: number) => PAD.left + ((f - fMin) / (fMax - fMin || 1)) * (WIDTH - PAD.left - PAD.right);
  const y = (s: number) =>
    PAD.top + (1 - (Math.min(s, top) - 1) / (top - 1)) * (HEIGHT - PAD.top - PAD.bottom);

  const line = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.frequencyMHz).toFixed(1)},${y(p.swr).toFixed(1)}`)
    .join(' ');

  const measuredLine = inRange
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.frequencyMHz).toFixed(1)},${y(p.swr).toFixed(1)}`)
    .join(' ');
  const best = points.reduce((a, b) => (b.swr < a.swr ? b : a), first);
  // Label frequencies that were actually computed, about five of them.
  const stride = Math.max(1, Math.ceil((points.length - 1) / 5));
  const ticks = points.filter((_, i) => i % stride === 0).map((p) => p.frequencyMHz);
  const hit = (WIDTH - PAD.left - PAD.right) / (points.length - 1);
  const chosen = points[selected];

  return (
    <figure className="plot plot-wide">
      <figcaption>
        SWR ({z0} Ω) vs frequency. Best {best.swr.toFixed(2)}:1 at {best.frequencyMHz} MHz
        {inRange.length > 1 && (
          <span className="chart-legend">
            <span className="chart-key">
              <svg width="22" height="8" aria-hidden="true">
                <line x1="0" x2="22" y1="4" y2="4" className="sweep-line" />
              </svg>
              modelled
            </span>
            <span className="chart-key">
              <svg width="22" height="8" aria-hidden="true">
                <line x1="0" x2="22" y1="4" y2="4" className="sweep-line sweep-measured" />
              </svg>
              {measuredLabel ?? 'measured'}
            </span>
          </span>
        )}
      </figcaption>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="SWR against frequency">
        {Array.from({ length: top }, (_, i) => i + 1).map((s) => (
          <g key={s}>
            <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(s)} y2={y(s)} className="grid" />
            <text x={PAD.left - 8} y={y(s)} className="tick" textAnchor="end" dominantBaseline="central">
              {s}
            </text>
          </g>
        ))}
        {GUIDES.filter((g) => g < top).map((g) => (
          <line key={g} x1={PAD.left} x2={WIDTH - PAD.right} y1={y(g)} y2={y(g)} className="guide" />
        ))}
        {ticks.map((f) => (
          <text key={f} x={x(f)} y={HEIGHT - 12} className="tick" textAnchor="middle">
            {Number(f.toFixed(4))}
          </text>
        ))}
        <path d={line} className="sweep-line" />
        {inRange.length > 1 && <path d={measuredLine} className="sweep-line sweep-measured" />}
        {chosen && (
          <>
            <line x1={x(chosen.frequencyMHz)} x2={x(chosen.frequencyMHz)} y1={PAD.top} y2={HEIGHT - PAD.bottom} className="cursor" />
            <circle cx={x(chosen.frequencyMHz)} cy={y(chosen.swr)} r={5} className="sweep-dot" />
          </>
        )}
        {points.map((p, i) => (
          <rect
            key={p.frequencyMHz}
            x={x(p.frequencyMHz) - hit / 2}
            y={PAD.top}
            width={hit}
            height={HEIGHT - PAD.top - PAD.bottom}
            className="hit"
            onClick={() => onSelect(i)}
          >
            <title>{`${p.frequencyMHz} MHz: SWR ${Number.isFinite(p.swr) ? p.swr.toFixed(2) : '∞'}`}</title>
          </rect>
        ))}
      </svg>
    </figure>
  );
}
