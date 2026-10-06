// A small chart against a linear axis - gain against height, SWR against element length.
// LineChart's sibling: the same look, the same hover readout, but the x axis is whatever
// was swept rather than frequency on a log scale.
//
// One quantity per chart (one y axis, always). Two series only when they share the unit,
// as R and X both do, and then with a legend. The sweep's points are drawn as dots, because
// they are the only places the model was actually solved.
//
// Public domain (The Unlicense). By ZR1JT.

import type { PointerEvent } from 'react';

const WIDTH = 700;
const HEIGHT = 200;
const PAD = { left: 52, right: 16, top: 12, bottom: 34 };

export interface XYSeries {
  label: string;
  /** A validated series token, in fixed order: var(--series-1), then -2, -3. */
  colour: string;
  /** Undefined where the solve gave nothing to plot. */
  values: (number | undefined)[];
  /** Its own x values, when it was not sampled where the chart's x is - a measurement over a design. */
  x?: number[];
  /** A second kind of line (measured over modelled): dashed, so colour is never the only cue. */
  dashed?: boolean;
}

export interface XYChartProps {
  title: string;
  unit: string;
  /** The x unit, for the readout: "m". */
  xLabel: string;
  /** What the x axis is, written under it: "Height of the antenna, m". */
  xTitle?: string;
  x: number[];
  series: XYSeries[];
  /** How a value is written; x values use xFormat. */
  format?: (v: number) => string;
  xFormat?: (v: number) => string;
  /** Draw from zero rather than from the data's own floor (gain from 0 would flatten it). */
  fromZero?: boolean;
  /** Nothing is drawn below this: a notch's -∞ dB would otherwise flatten everything else. */
  floor?: number;
  /** Guides across the plot, e.g. an SWR of 1.5 and 2. */
  guides?: number[];
  hover: number | undefined;
  onHover: (index: number | undefined) => void;
  /** The point picked by a click, ringed. */
  selected?: number;
  onSelect?: (index: number) => void;
}

function nice(span: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(span / 4 || 1));
  return [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => span / s <= 6) ?? span;
}

export function XYChart({ title, unit, xLabel, xTitle, x, series, format, xFormat, fromZero, floor, guides = [], hover, onHover, selected, onSelect }: XYChartProps) {
  if (x.length < 2) return null;
  const show = format ?? ((v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2)));
  const showX = xFormat ?? ((v: number) => Number(v.toPrecision(4)).toString());
  const atFloor = (v: number) => (floor !== undefined ? Math.max(floor, v) : v);
  const finite = series
    .flatMap((s) => s.values)
    .filter((v): v is number => v !== undefined && (Number.isFinite(v) || (floor !== undefined && v === -Infinity)))
    .map(atFloor);
  if (finite.length === 0) return null;
  // The chart's own x sets the span; a series sampled elsewhere is clipped to it.
  const xMin = Math.min(...x);
  const xMax = Math.max(...x);
  const xsOf = (s: XYSeries) => s.x ?? x;
  /** For a series with its own x: the index nearest an x value of the chart's. */
  const nearestIn = (xs: number[], v: number) => xs.reduce((best, xv, i) => (Math.abs(xv - v) < Math.abs(xs[best]! - v) ? i : best), 0);
  let lo = fromZero ? Math.min(0, ...finite) : Math.min(...finite, ...guides);
  let hi = Math.max(...finite, ...guides);
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  const step = nice(hi - lo);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;

  const sx = (v: number) => PAD.left + ((v - xMin) / (xMax - xMin || 1)) * (WIDTH - PAD.left - PAD.right);
  const sy = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * (HEIGHT - PAD.top - PAD.bottom);
  const rows: number[] = [];
  for (let v = lo; v <= hi + step * 1e-6; v += step) rows.push(Number(v.toPrecision(10)));
  // Axis labels take their decimals from the grid step, so a column reads 100, 80, 60 - not 100, 80.0, 0.00.
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  const axis = (v: number) => v.toFixed(decimals);
  // A sweep of a few solves: label the values that were solved. A dense trace: round numbers.
  let xTicks: number[];
  if (x.length <= 41) {
    const stride = Math.max(1, Math.ceil((x.length - 1) / 6));
    xTicks = x.filter((_, i) => i % stride === 0 || i === x.length - 1);
  } else {
    const xStep = nice(xMax - xMin);
    xTicks = [];
    for (let v = Math.ceil(xMin / xStep) * xStep; v <= xMax + xStep * 1e-9; v += xStep) xTicks.push(Number(v.toPrecision(10)));
  }

  const nearest = (clientX: number, box: DOMRect) => {
    const px = ((clientX - box.left) / box.width) * WIDTH;
    let best = 0;
    for (let i = 1; i < x.length; i++) if (Math.abs(sx(x[i]!) - px) < Math.abs(sx(x[best]!) - px)) best = i;
    return best;
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => onHover(nearest(e.clientX, e.currentTarget.getBoundingClientRect()));

  const at = hover ?? selected;
  return (
    <figure className="chart xy-chart">
      <figcaption>
        <span className="chart-title">
          {title}
          {unit ? `, ${unit}` : ''}
        </span>
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
        {at !== undefined && x[at] !== undefined && (
          <span className="chart-readout">
            {xLabel} {showX(x[at]!)}:{' '}
            {series.map((s, i) => {
              const k = s.x ? nearestIn(s.x, x[at]!) : at;
              const v = s.values[k];
              return (
                <span key={s.label}>
                  {i > 0 ? ' · ' : ''}
                  {series.length > 1 ? `${s.label} ` : ''}
                  <strong>{v !== undefined && Number.isFinite(v) ? show(v) : '—'}</strong>
                </span>
              );
            })}
          </span>
        )}
      </figcaption>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`${title} against ${xLabel}. ${series.map((s) => s.label).join(', ')}.`}
        onPointerMove={onMove}
        onPointerLeave={() => onHover(undefined)}
        onClick={(e) => onSelect?.(nearest(e.clientX, e.currentTarget.getBoundingClientRect()))}
        style={onSelect ? { cursor: 'pointer' } : undefined}
      >
        {rows.map((v) => (
          <g key={v}>
            <line className="plot-grid" x1={PAD.left} x2={WIDTH - PAD.right} y1={sy(v)} y2={sy(v)} />
            <text className="plot-label" x={PAD.left - 6} y={sy(v) + 4} textAnchor="end">
              {axis(v)}
            </text>
          </g>
        ))}
        {guides.map((g) => (
          <line key={g} className="plot-guide" x1={PAD.left} x2={WIDTH - PAD.right} y1={sy(g)} y2={sy(g)} />
        ))}
        {xTicks.map((t) => (
          <text key={t} className="plot-label" x={sx(t)} y={HEIGHT - 16} textAnchor="middle">
            {showX(t)}
          </text>
        ))}
        {xTitle && (
          <text className="plot-label" x={WIDTH - PAD.right} y={HEIGHT - 2} textAnchor="end">
            {xTitle}
          </text>
        )}
        {at !== undefined && x[at] !== undefined && <line className="chart-crosshair" x1={sx(x[at]!)} x2={sx(x[at]!)} y1={PAD.top} y2={HEIGHT - PAD.bottom} />}
        {series.map((s) => {
          const xs = xsOf(s);
          let d = '';
          let pen = false;
          s.values.forEach((v, i) => {
            const xv = xs[i];
            if (v === undefined || Number.isNaN(v) || (v === -Infinity && floor === undefined) || v === Infinity || xv === undefined || xv < xMin || xv > xMax) {
              pen = false;
              return;
            }
            // Clamp to the plot: a deep notch below the axis floor still draws to the floor.
            d += `${pen ? 'L' : 'M'}${sx(xv).toFixed(1)},${sy(Math.max(lo, Math.min(hi, atFloor(v)))).toFixed(1)}`;
            pen = true;
          });
          // Dots only where there are few enough points to be the story: a sweep's solves, not a 200-point trace.
          const dots = !s.x && s.values.length <= 41;
          return (
            <g key={s.label}>
              <path d={d} className="chart-line" style={{ stroke: s.colour }} strokeDasharray={s.dashed ? '7 5' : undefined} />
              {dots &&
                s.values.map((v, i) =>
                  v === undefined || !Number.isFinite(v) ? null : (
                    <circle key={i} cx={sx(xs[i]!)} cy={sy(v)} r={i === selected ? 6 : 4} className="chart-dot" style={{ fill: s.colour }} />
                  ),
                )}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
