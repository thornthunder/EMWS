// Rotatable orthographic view of the wire structure, coloured by current magnitude.

import { useMemo, useRef, useState, type PointerEvent } from 'react';
import type { Environment, FeedPoint, Segment, SegmentCurrent, Vec3 } from '../engine/nec2/types';

const SIZE = 340;
const C = SIZE / 2;
const MARGIN = 34;
const RAD = Math.PI / 180;

interface View {
  azimuth: number;
  elevation: number;
}

/** Spin about Z by the view azimuth, then tip towards the viewer by the view elevation. */
function project(p: Vec3, view: View): [number, number] {
  const az = view.azimuth * RAD;
  const el = view.elevation * RAD;
  const x = p.x * Math.cos(az) - p.y * Math.sin(az);
  const depth = p.x * Math.sin(az) + p.y * Math.cos(az);
  return [x, p.z * Math.cos(el) + depth * Math.sin(el)];
}

/** Blue (little current) through to orange-red (most current). */
function currentColour(fraction: number): string {
  const hue = 215 - 195 * Math.min(Math.max(fraction, 0), 1);
  return `hsl(${hue.toFixed(0)} 85% 52%)`;
}

export interface WireViewProps {
  segments: Segment[];
  currents: SegmentCurrent[];
  feeds: FeedPoint[];
  environment: Environment;
}

export function WireView({ segments, currents, feeds, environment }: WireViewProps) {
  const [view, setView] = useState<View>({ azimuth: -35, elevation: 22 });
  const drag = useRef<{ x: number; y: number } | undefined>(undefined);
  const hasGround = environment !== 'free-space';

  // A bounding sphere, not a box, so the scale doesn't breathe as the model turns.
  const bounds = useMemo(() => {
    const pts = segments.flatMap((s) => [s.start, s.end]);
    if (pts.length === 0) return { centre: { x: 0, y: 0, z: 0 }, radius: 1 };
    const lo = { x: Infinity, y: Infinity, z: Infinity };
    const hi = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const p of pts) {
      lo.x = Math.min(lo.x, p.x); hi.x = Math.max(hi.x, p.x);
      lo.y = Math.min(lo.y, p.y); hi.y = Math.max(hi.y, p.y);
      lo.z = Math.min(lo.z, p.z); hi.z = Math.max(hi.z, p.z);
    }
    if (hasGround) lo.z = Math.min(lo.z, 0); // keep the ground in shot
    const centre = { x: (lo.x + hi.x) / 2, y: (lo.y + hi.y) / 2, z: (lo.z + hi.z) / 2 };
    let radius = 0;
    for (const p of pts) radius = Math.max(radius, Math.hypot(p.x - centre.x, p.y - centre.y, p.z - centre.z));
    if (hasGround) radius = Math.max(radius, centre.z);
    return { centre, radius: radius || 1 };
  }, [segments, hasGround]);

  const peakCurrent = useMemo(() => currents.reduce((m, c) => Math.max(m, c.magnitude), 0), [currents]);
  const currentBySegment = useMemo(() => new Map(currents.map((c) => [c.segment, c.magnitude])), [currents]);
  const fedSegments = useMemo(() => new Set(feeds.map((f) => f.segment)), [feeds]);

  const scale = (C - MARGIN) / bounds.radius;
  const place = (p: Vec3): [number, number] => {
    const [x, y] = project(
      { x: p.x - bounds.centre.x, y: p.y - bounds.centre.y, z: p.z - bounds.centre.z },
      view,
    );
    return [C + x * scale, C - y * scale];
  };

  const ground = hasGround
    ? Array.from({ length: 48 }, (_, i) => {
        const a = (i / 48) * 2 * Math.PI;
        const [x, y] = place({
          x: bounds.centre.x + bounds.radius * Math.cos(a),
          y: bounds.centre.y + bounds.radius * Math.sin(a),
          z: 0,
        });
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ')
    : undefined;

  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const from = drag.current;
    if (!from) return;
    const dx = e.clientX - from.x;
    const dy = e.clientY - from.y;
    drag.current = { x: e.clientX, y: e.clientY };
    setView((v) => ({
      azimuth: v.azimuth - dx * 0.6,
      elevation: Math.min(90, Math.max(-90, v.elevation + dy * 0.6)),
    }));
  };
  const onPointerUp = () => {
    drag.current = undefined;
  };

  // Axis triad: orientation only, pinned to a corner.
  const triad = (['x', 'y', 'z'] as const).map((axis) => {
    const unit = { x: 0, y: 0, z: 0, [axis]: 1 };
    const [x, y] = project(unit, view);
    return { axis, x: 30 + x * 20, y: SIZE - 30 - y * 20 };
  });

  return (
    <figure className="plot">
      <figcaption>Geometry and current</figcaption>
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="wire-view"
        role="img"
        aria-label={`Wire model with ${segments.length} segments. Drag to rotate.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {ground && <polygon points={ground} className="ground" />}
        {segments.map((s) => {
          const [x1, y1] = place(s.start);
          const [x2, y2] = place(s.end);
          const magnitude = currentBySegment.get(s.index);
          const stroke =
            magnitude !== undefined && peakCurrent > 0 ? currentColour(magnitude / peakCurrent) : undefined;
          return <line key={s.index} x1={x1} y1={y1} x2={x2} y2={y2} className="wire" style={{ stroke }} />;
        })}
        {segments
          .filter((s) => fedSegments.has(s.index))
          .map((s) => {
            const [x, y] = place(s.center);
            return <circle key={s.index} cx={x} cy={y} r={5} className="feed" />;
          })}
        {triad.map((t) => (
          <g key={t.axis}>
            <line x1={30} y1={SIZE - 30} x2={t.x} y2={t.y} className={`axis axis-${t.axis}`} />
            <text x={t.x + (t.x - 30) * 0.35} y={t.y + (t.y - (SIZE - 30)) * 0.35} className="axis-label" textAnchor="middle" dominantBaseline="central">
              {t.axis.toUpperCase()}
            </text>
          </g>
        ))}
      </svg>
      <p className="plot-note">
        Drag to rotate. Colour = current, <span className="swatch swatch-low" /> low to{' '}
        <span className="swatch swatch-high" /> high. <span className="swatch swatch-feed" /> feed point.
      </p>
    </figure>
  );
}
