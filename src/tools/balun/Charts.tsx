// Line charts against frequency, on a log axis.
//
// One axis per chart, always: SWR, decibels, watts and ohms each get their own rather
// than sharing a frame with two scales. Hovering any chart moves a crosshair on all of
// them and drives the readout above, so the charts are one instrument, not five.

import { useRef } from 'react';

const WIDTH = 700;
const HEIGHT = 220;
const PAD = { left: 52, right: 16, top: 14, bottom: 32 };

export interface Series {
  label: string;
  /** A CSS colour, from the validated series tokens, in fixed order. */
  colour: string;
  /** Second design in a comparison: same hue family is not enough, so it is dashed too. */
  dashed?: boolean;
  values: number[];
}

export interface LineChartProps {
  title: string;
  fMHz: number[];
  series: Series[];
  unit: string;
  /** Values above this are drawn at it, so one runaway point cannot flatten the rest. */
  ceiling?: number;
  floor?: number;
  guides?: number[];
  format?: (value: number) => string;
  hover: number | undefined;
  onHover: (index: number | undefined) => void;
}

/** Frequencies worth labelling: the amateur bands, plus round numbers around them. */
const TICKS = [0.1, 0.2, 0.5, 1, 1.8, 3.5, 5, 7, 10, 14, 21, 28, 50, 100, 144, 200, 500];

function niceCeiling(value: number): number {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (value <= step * magnitude) return step * magnitude;
  return 10 * magnitude;
}

export function LineChart({ title, fMHz, series, unit, ceiling, floor = 0, guides = [], format, hover, onHover }: LineChartProps) {
  const svg = useRef<SVGSVGElement>(null);
  const first = fMHz[0];
  const last = fMHz[fMHz.length - 1];
  if (first === undefined || last === undefined || fMHz.length < 2) return null;

  const show = format ?? ((v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2)));
  const finite = series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
  const peak = Math.max(floor + 1e-9, ...finite.map((v) => (ceiling === undefined ? v : Math.min(v, ceiling))));
  const top = ceiling !== undefined && peak >= ceiling ? ceiling : niceCeiling(peak - floor) + floor;

  const x = (f: number) => PAD.left + (Math.log(f / first) / Math.log(last / first)) * (WIDTH - PAD.left - PAD.right);
  const y = (v: number) => {
    const clamped = Math.min(top, Math.max(floor, Number.isFinite(v) ? v : top));
    return PAD.top + (1 - (clamped - floor) / (top - floor)) * (HEIGHT - PAD.top - PAD.bottom);
  };

  let lastTickX = -Infinity;
  const ticks = TICKS.filter((t) => t >= first * 0.999 && t <= last * 1.001).filter((t) => {
    if (x(t) - lastTickX < 44) return false;
    lastTickX = x(t);
    return true;
  });
  // Grid lines on round numbers - 1, 2, 3 for SWR - rather than quarters of whatever the
  // range happens to be.
  const span = top - floor;
  const magnitude = 10 ** Math.floor(Math.log10(span / 4));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => span / s <= 6) ?? span;
  const rows: number[] = [];
  for (let v = floor; v <= top + step * 1e-6; v += step) rows.push(Number(v.toPrecision(10)));

  const onMove = (clientX: number) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box) return;
    const px = ((clientX - box.left) / box.width) * WIDTH;
    let best = 0;
    for (let i = 1; i < fMHz.length; i++) if (Math.abs(x(fMHz[i]!) - px) < Math.abs(x(fMHz[best]!) - px)) best = i;
    onHover(best);
  };

  const at = hover !== undefined ? fMHz[hover] : undefined;

  return (
    <figure className="chart">
      <figcaption>
        <span className="chart-title">
          {title}
          {unit ? `, ${unit}` : ''}
        </span>
        {/* One series is named by the title; two or more always get a legend. */}
        {series.length > 1 && (
          <span className="chart-legend">
            {series.map((s) => (
              <span key={s.label} className="chart-key">
                <svg width="22" height="8" aria-hidden="true">
                  <line x1="0" x2="22" y1="4" y2="4" style={{ stroke: s.colour }} strokeWidth="2.5" strokeDasharray={s.dashed ? '7 5' : undefined} />
                </svg>
                {s.label}
              </span>
            ))}
          </span>
        )}
        {at !== undefined && hover !== undefined && (
          <span className="chart-readout">
            {at.toFixed(at < 10 ? 2 : 1)} MHz:{' '}
            {series.map((s, i) => (
              <span key={s.label}>
                {i > 0 ? ' · ' : ''}
                {series.length > 1 ? `${s.label} ` : ''}
                <strong>{Number.isFinite(s.values[hover]!) ? show(s.values[hover]!) : '—'}</strong>
              </span>
            ))}
          </span>
        )}
      </figcaption>
      <svg
        ref={svg}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`${title}. ${series.map((s) => s.label).join(', ')}.`}
        onPointerMove={(e) => onMove(e.clientX)}
        onPointerLeave={() => onHover(undefined)}
      >
        {rows.map((v) => (
          <g key={v}>
            <line className="plot-grid" x1={PAD.left} x2={WIDTH - PAD.right} y1={y(v)} y2={y(v)} />
            <text className="plot-label" x={PAD.left - 6} y={y(v) + 4} textAnchor="end">
              {show(v)}
            </text>
          </g>
        ))}
        {ticks.map((t) => (
          <g key={t}>
            <line className="plot-grid" x1={x(t)} x2={x(t)} y1={PAD.top} y2={HEIGHT - PAD.bottom} />
            <text className="plot-label" x={x(t)} y={HEIGHT - PAD.bottom + 16} textAnchor="middle">
              {t}
            </text>
          </g>
        ))}
        <text className="plot-label" x={WIDTH - PAD.right} y={HEIGHT - 4} textAnchor="end">
          MHz
        </text>
        {guides
          .filter((g) => g > floor && g < top)
          .map((g) => (
            <g key={g}>
              <line className="plot-guide" x1={PAD.left} x2={WIDTH - PAD.right} y1={y(g)} y2={y(g)} />
              <text className="plot-label" x={WIDTH - PAD.right - 4} y={y(g) - 4} textAnchor="end">
                {show(g)}
              </text>
            </g>
          ))}

        {series.map((s) => (
          <path
            key={s.label}
            className="chart-line"
            style={{ stroke: s.colour }}
            strokeDasharray={s.dashed ? '7 5' : undefined}
            d={s.values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(fMHz[i]!).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}
          />
        ))}

        {at !== undefined && hover !== undefined && (
          <g>
            <line className="chart-crosshair" x1={x(at)} x2={x(at)} y1={PAD.top} y2={HEIGHT - PAD.bottom} />
            {series.map((s) => (
              <circle key={s.label} className="chart-dot" style={{ fill: s.colour }} cx={x(at)} cy={y(s.values[hover]!)} r={4.5} />
            ))}
          </g>
        )}
      </svg>
    </figure>
  );
}
