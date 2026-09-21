// Rotatable 3-D view: the fourth quadrant of the first-angle layout. Drag to turn it;
// click a wire to select it.

import { type PointerEvent, useMemo, useRef, useState } from 'react';
import type { Vec3 } from '../../../engine/nec2/types';
import type { Scene } from './scene';
import type { Size } from './projection';

const RAD = Math.PI / 180;
const MARGIN = 30;

interface Orientation {
  azimuth: number;
  elevation: number;
}

/** Spin about Z by the azimuth, then tip towards the viewer by the elevation. */
function project(p: Vec3, o: Orientation): [number, number, number] {
  const az = o.azimuth * RAD;
  const el = o.elevation * RAD;
  const x = p.x * Math.cos(az) - p.y * Math.sin(az);
  const depth = p.x * Math.sin(az) + p.y * Math.cos(az);
  return [x, p.z * Math.cos(el) + depth * Math.sin(el), depth * Math.cos(el) - p.z * Math.sin(el)];
}

export interface View3DProps {
  scene: Scene;
  size: Size;
  selection: string | null;
  onSelect: (wireId: string | null) => void;
}

export function View3D({ scene, size, selection, onSelect }: View3DProps) {
  const [orientation, setOrientation] = useState<Orientation>({ azimuth: -35, elevation: 22 });
  const drag = useRef<{ x: number; y: number; moved: boolean } | undefined>(undefined);
  const { width, height } = size;

  // A bounding sphere, not a box, so the scale doesn't breathe as the model turns.
  const bounds = useMemo(() => {
    const pts = scene.lines.flatMap((l) => [l.a, l.b]);
    if (scene.ground && pts.length > 0) pts.push({ ...pts[0]!, z: 0 });
    if (pts.length === 0) return { centre: { x: 0, y: 0, z: 0 }, radius: 1 };
    const lo = { x: Infinity, y: Infinity, z: Infinity };
    const hi = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const p of pts) {
      for (const axis of ['x', 'y', 'z'] as const) {
        lo[axis] = Math.min(lo[axis], p[axis]);
        hi[axis] = Math.max(hi[axis], p[axis]);
      }
    }
    const centre = { x: (lo.x + hi.x) / 2, y: (lo.y + hi.y) / 2, z: (lo.z + hi.z) / 2 };
    let radius = 0;
    for (const p of pts) radius = Math.max(radius, Math.hypot(p.x - centre.x, p.y - centre.y, p.z - centre.z));
    return { centre, radius: radius || 1 };
  }, [scene]);

  const scale = (Math.min(width, height) / 2 - MARGIN) / bounds.radius;
  const place = (p: Vec3): [number, number, number] => {
    const [x, y, depth] = project(
      { x: p.x - bounds.centre.x, y: p.y - bounds.centre.y, z: p.z - bounds.centre.z },
      orientation,
    );
    return [width / 2 + x * scale, height / 2 - y * scale, depth];
  };

  const lines = scene.lines
    .map((l) => {
      const [x1, y1, d1] = place(l.a);
      const [x2, y2, d2] = place(l.b);
      return { line: l, x1, y1, x2, y2, depth: (d1 + d2) / 2 };
    })
    .sort((p, q) => q.depth - p.depth); // far first

  const ground = scene.ground
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
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
  };
  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const from = drag.current;
    if (!from) return;
    const dx = e.clientX - from.x;
    const dy = e.clientY - from.y;
    if (!from.moved && Math.hypot(dx, dy) < 3) return;
    drag.current = { x: e.clientX, y: e.clientY, moved: true };
    setOrientation((o) => ({
      azimuth: o.azimuth - dx * 0.6,
      elevation: Math.min(90, Math.max(-90, o.elevation + dy * 0.6)),
    }));
  };
  const onPointerUp = (e: PointerEvent<SVGSVGElement>) => {
    const from = drag.current;
    drag.current = undefined;
    if (!from || from.moved) return;
    // A click, not a turn: select what is under the pointer.
    const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest<SVGElement>('[data-wire]');
    onSelect(hit?.dataset.wire ?? null);
  };

  // Axis triad: orientation only, pinned to a corner.
  const triad = (['x', 'y', 'z'] as const).map((axis) => {
    const [x, y] = project({ x: 0, y: 0, z: 0, [axis]: 1 }, orientation);
    return { axis, x: 26 + x * 18, y: height - 26 - y * 18 };
  });

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="view-canvas view-3d"
      role="img"
      aria-label={`3-D view of ${scene.lines.length} wire segments. Drag to rotate.`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (drag.current = undefined)}
    >
      {ground && <polygon points={ground} className="ground-disc" />}
      {lines.map(({ line, x1, y1, x2, y2 }) => (
        <line
          key={line.key}
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          className={line.wireId !== undefined && line.wireId === selection ? 'wire wire-selected' : 'wire'}
          style={line.colour ? { stroke: line.colour } : undefined}
          data-wire={line.wireId}
        />
      ))}
      {scene.feeds.map((f) => {
        const [x, y] = place(f.at);
        return <circle key={f.key} cx={x} cy={y} r={5} className="feed" />;
      })}
      {triad.map((t) => (
        <g key={t.axis}>
          <line x1={26} y1={height - 26} x2={t.x} y2={t.y} className={`axis axis-${t.axis}`} />
          <text
            x={t.x + (t.x - 26) * 0.4}
            y={t.y + (t.y - (height - 26)) * 0.4}
            className="axis-label"
            textAnchor="middle"
            dominantBaseline="central"
          >
            {t.axis.toUpperCase()}
          </text>
        </g>
      ))}
    </svg>
  );
}
