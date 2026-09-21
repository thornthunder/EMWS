// The Smith chart itself: the constant-resistance and constant-reactance grid, the path
// each component draws at the design frequency, and where the radio ends up across the
// whole sweep.

import { type PointerEvent, useState } from 'react';
import type { Complex } from '../../lib/complex';
import { gammaFromImpedance } from '../../lib/touchstone';
import type { SweepPoint } from './network';

const SIZE = 440;
const C = SIZE / 2;
const R = 194;

const RESISTANCE_CIRCLES = [0.2, 0.5, 1, 2, 5];
const REACTANCE_ARCS = [0.2, 0.5, 1, 2, 5];
const SWR_RINGS = [2, 3];

export interface ChartSegment {
  /** Which component drew it, for the legend. */
  label: string;
  colour: string;
  points: Complex[];
}

export interface ChartNode {
  label: string;
  z: Complex;
  colour: string;
}

export interface SmithChartProps {
  z0: number;
  segments: ChartSegment[];
  nodes: ChartNode[];
  sweep: SweepPoint[];
  designMHz: number;
  onHover: (point: SweepPoint | undefined) => void;
  hovered: SweepPoint | undefined;
}

export function SmithChart({ z0, segments, nodes, sweep, designMHz, onHover, hovered }: SmithChartProps) {
  const [cursor, setCursor] = useState<{ x: number; y: number } | undefined>(undefined);

  const at = (z: Complex): [number, number] => {
    const g = gammaFromImpedance(z, z0);
    if (!Number.isFinite(g.re) || !Number.isFinite(g.im)) return [C + R, C];
    // An impedance with negative resistance would fall outside the chart; keep it on the rim.
    const magnitude = Math.hypot(g.re, g.im);
    const scale = magnitude > 1 ? 1 / magnitude : 1;
    return [C + R * g.re * scale, C - R * g.im * scale];
  };

  const polyline = (points: Complex[]): string =>
    points
      .map((z, i) => {
        const [x, y] = at(z);
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');

  const designPoint = sweep.reduce<SweepPoint | undefined>(
    (best, p) => (!best || Math.abs(p.fMHz - designMHz) < Math.abs(best.fMHz - designMHz) ? p : best),
    undefined,
  );

  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const x = ((e.clientX - rect.left) * SIZE) / rect.width;
    const y = ((e.clientY - rect.top) * SIZE) / rect.height;
    setCursor({ x, y });
    let best: SweepPoint | undefined;
    let bestDistance = 26;
    for (const p of sweep) {
      const [px, py] = at(p.z);
      const d = Math.hypot(px - x, py - y);
      if (d < bestDistance) {
        best = p;
        bestDistance = d;
      }
    }
    onHover(best);
  };

  const leave = () => {
    setCursor(undefined);
    onHover(undefined);
  };

  return (
    <svg
      className="smith-chart"
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      role="img"
      aria-label={`Smith chart normalised to ${z0} ohms, showing ${segments.length} component steps and a sweep of ${sweep.length} frequencies.`}
      onPointerMove={onPointerMove}
      onPointerLeave={leave}
    >
      <defs>
        <clipPath id="smith-clip">
          <circle cx={C} cy={C} r={R} />
        </clipPath>
      </defs>

      <circle cx={C} cy={C} r={R} className="smith-face" />

      <g clipPath="url(#smith-clip)" className="smith-grid">
        {RESISTANCE_CIRCLES.map((r) => (
          <circle key={`r${r}`} cx={C + (R * r) / (1 + r)} cy={C} r={R / (1 + r)} />
        ))}
        {REACTANCE_ARCS.flatMap((x) =>
          [1, -1].map((sign) => (
            <circle key={`x${x * sign}`} cx={C + R} cy={C - (R / x) * sign} r={R / x} />
          )),
        )}
        <line x1={C - R} y1={C} x2={C + R} y2={C} className="smith-axis" />
      </g>

      <circle cx={C} cy={C} r={R} className="smith-rim" />

      {SWR_RINGS.map((s) => (
        <g key={s}>
          <circle cx={C} cy={C} r={(R * (s - 1)) / (s + 1)} className="smith-swr" />
          <text x={C} y={C - (R * (s - 1)) / (s + 1) - 4} className="smith-label" textAnchor="middle">
            {s}:1
          </text>
        </g>
      ))}

      {RESISTANCE_CIRCLES.map((r) => (
        <text key={`rl${r}`} x={C + (R * (r - 1)) / (r + 1)} y={C + 13} className="smith-label" textAnchor="middle">
          {r * z0}
        </text>
      ))}
      <text x={C} y={C - R + 16} className="smith-label" textAnchor="middle">
        inductive +jX
      </text>
      <text x={C} y={C + R - 8} className="smith-label" textAnchor="middle">
        capacitive −jX
      </text>

      {/* Where the radio ends up, right across the sweep. */}
      <path d={polyline(sweep.map((p) => p.z))} className="smith-sweep" />

      {/* What each component does at the design frequency. */}
      {segments.map((segment, i) => (
        <path key={`${segment.label}${i}`} d={polyline(segment.points)} className="smith-step" style={{ stroke: segment.colour }} />
      ))}

      {nodes.map((node, i) => {
        const [x, y] = at(node.z);
        return (
          <g key={`${node.label}${i}`}>
            <circle cx={x} cy={y} r={6} className="smith-node" style={{ fill: node.colour }} />
            <text x={x} y={y} className="smith-node-label" textAnchor="middle" dominantBaseline="central">
              {node.label}
            </text>
          </g>
        );
      })}

      {designPoint && !hovered && (
        <circle cx={at(designPoint.z)[0]} cy={at(designPoint.z)[1]} r={5} className="smith-design" />
      )}
      {hovered && (
        <g>
          <circle cx={at(hovered.z)[0]} cy={at(hovered.z)[1]} r={8} className="smith-hover" />
          {cursor && (
            <line x1={at(hovered.z)[0]} y1={at(hovered.z)[1]} x2={cursor.x} y2={cursor.y} className="smith-hover-line" />
          )}
        </g>
      )}
    </svg>
  );
}
