// The radiation pattern as a solid, with the antenna inside it.
//
// The azimuth and elevation plots are two slices; this is the whole thing, turned by
// dragging like the 3-D view of the wires, and with a small copy of the antenna at its
// centre so you can see which way the lobes point relative to the wires that make them.
//
// The surface is the whole-sphere (or upper-hemisphere) pattern NEC already worked out,
// on the same ARRL log scale as the polar plots: the outer extent is the peak gain, and
// each 2 dB down shrinks the radius by 0.89. It is drawn see-through and painted far to
// near, and the antenna is drawn over it, so the wires show from any side.
//
// Public domain (The Unlicense). By ZR1JT.

import { type PointerEvent, type ReactElement, useMemo, useRef, useState } from 'react';
import type { RadiationPattern, Vec3 } from '../../engine/nec2/types';
import { FLOOR_DB, patternMesh } from './pattern-mesh';
import { type Orientation, project } from './editor/View3D';
import type { SceneLine } from './editor/scene';

const SIZE = 340;
const C = SIZE / 2;
/** The peak's radius on screen. */
const R = 120;
/** The antenna fills this share of the pattern's radius: big enough to read, small enough to sit inside. */
const ANTENNA_SHARE = 0.45;
export interface Pattern3DProps {
  patterns: RadiationPattern[];
  /** The antenna, as the views draw it; its geometry is scaled down into the pattern's centre. */
  lines: SceneLine[];
  ground: boolean;
  frequencyMHz: number;
}

export function Pattern3D({ patterns, lines, ground, frequencyMHz }: Pattern3DProps) {
  const [orientation, setOrientation] = useState<Orientation>({ azimuth: -35, elevation: 22 });
  const drag = useRef<{ x: number; y: number } | undefined>(undefined);
  const mesh = useMemo(() => patternMesh(patterns), [patterns]);

  // The antenna, centred and shrunk to sit inside the lobes. Over ground its height is kept
  // (ground is z = 0 in both), so a low antenna sits low and a mast stands up.
  const antenna = useMemo(() => {
    const pts = lines.flatMap((l) => [l.a, l.b]);
    if (pts.length === 0) return [];
    const lo = { x: Infinity, y: Infinity, z: Infinity };
    const hi = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const p of pts) {
      for (const axis of ['x', 'y', 'z'] as const) {
        lo[axis] = Math.min(lo[axis], p[axis]);
        hi[axis] = Math.max(hi[axis], p[axis]);
      }
    }
    const centre = { x: (lo.x + hi.x) / 2, y: (lo.y + hi.y) / 2, z: ground ? 0 : (lo.z + hi.z) / 2 };
    let extent = 0;
    for (const p of pts) extent = Math.max(extent, Math.hypot(p.x - centre.x, p.y - centre.y, p.z - centre.z));
    const k = extent > 0 ? ANTENNA_SHARE / extent : 1;
    const shrink = (p: Vec3): Vec3 => ({ x: (p.x - centre.x) * k, y: (p.y - centre.y) * k, z: (p.z - centre.z) * k });
    return lines.map((l) => ({ key: l.key, a: shrink(l.a), b: shrink(l.b), colour: l.colour }));
  }, [lines, ground]);

  if (!mesh) {
    return (
      <figure className="plot pattern-3d">
        <figcaption>3-D pattern</figcaption>
        <p className="muted">
          This run solved only cuts through the pattern, not the whole of it. Choose the automatic pattern under Radiation pattern to see it in
          three dimensions.
        </p>
      </figure>
    );
  }

  const place = (p: Vec3): [number, number, number] => {
    const [x, y, depth] = project(p, orientation);
    return [C + x * R, C - y * R, depth];
  };

  // Faces and wires together, far first, so the wires are hidden by exactly the faces in front of them.
  type Item = { depth: number; node: ReactElement };
  const items: Item[] = [];
  const rows = mesh.grid.length;
  const cols = mesh.grid[0]!.length;
  const lastCol = mesh.wraps ? cols : cols - 1;
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < lastCol; j++) {
      const jn = (j + 1) % cols;
      const corners = [mesh.grid[i]![j]!, mesh.grid[i]![jn]!, mesh.grid[i + 1]![jn]!, mesh.grid[i + 1]![j]!];
      const projected = corners.map(place);
      const depth = projected.reduce((s, p) => s + p[2], 0) / 4;
      const rel = Math.max(mesh.relativeDb[i]![j]!, mesh.relativeDb[i]![jn]!, mesh.relativeDb[i + 1]![jn]!, mesh.relativeDb[i + 1]![j]!);
      if (!Number.isFinite(rel)) continue;
      // One hue, light to dark with gain: the strongest directions are the darkest.
      const share = Math.round(20 + 70 * Math.min(1, Math.max(0, (rel - FLOOR_DB) / -FLOOR_DB)));
      items.push({
        depth,
        node: (
          <polygon
            key={`f${i}-${j}`}
            points={projected.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}
            className="lobe-face"
            style={{ fill: `color-mix(in srgb, var(--plot-line) ${share}%, var(--surface))` }}
          />
        ),
      });
    }
  }
  items.sort((p, q) => q.depth - p.depth);
  // The antenna goes on top of the whole surface, not in depth order among the faces: a
  // wire usually lies along a null of its own pattern - a dipole down the hole of its
  // doughnut - where every face in front would hide it, and seeing it is the point.
  const wires = antenna.map((w) => {
    const [x1, y1] = place(w.a);
    const [x2, y2] = place(w.b);
    return { key: w.key, x1, y1, x2, y2, colour: w.colour };
  });

  const [ox, oy] = place({ x: 0, y: 0, z: 0 });
  const [px, py] = place(mesh.peakDirection);
  const groundDisc = ground
    ? Array.from({ length: 48 }, (_, i) => {
        const a = (i / 48) * 2 * Math.PI;
        const [x, y] = place({ x: Math.cos(a), y: Math.sin(a), z: 0 });
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ')
    : undefined;
  const triad = (['x', 'y', 'z'] as const).map((axis) => {
    const [x, y] = project({ x: 0, y: 0, z: 0, [axis]: 1 }, orientation);
    return { axis, x: 26 + x * 18, y: SIZE - 26 - y * 18 };
  });

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
    setOrientation((o) => ({ azimuth: o.azimuth - dx * 0.6, elevation: Math.min(90, Math.max(-90, o.elevation + dy * 0.6)) }));
  };

  return (
    <figure className="plot pattern-3d">
      <figcaption>3-D pattern at {frequencyMHz} MHz, drag to turn</figcaption>
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="img"
        aria-label={`Three-dimensional radiation pattern, peak ${mesh.peakDb.toFixed(2)} dBi, with the antenna at its centre. Drag to rotate.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => (drag.current = undefined)}
        onPointerCancel={() => (drag.current = undefined)}
      >
        {groundDisc && <polygon points={groundDisc} className="ground-disc" />}
        {items.map((i) => i.node)}
        {wires.map((w) => (
          <line key={`h${w.key}`} x1={w.x1} y1={w.y1} x2={w.x2} y2={w.y2} className="lobe-wire-halo" />
        ))}
        {wires.map((w) => (
          <line key={`w${w.key}`} x1={w.x1} y1={w.y1} x2={w.x2} y2={w.y2} className="lobe-wire" style={w.colour ? { stroke: w.colour } : undefined} />
        ))}
        <line x1={ox} y1={oy} x2={px} y2={py} className="peak-line" />
        {triad.map((t) => (
          <g key={t.axis}>
            <line x1={26} y1={SIZE - 26} x2={t.x} y2={t.y} className={`axis axis-${t.axis}`} />
            <text x={t.x + (t.x - 26) * 0.4} y={t.y + (t.y - (SIZE - 26)) * 0.4} className="axis-label" textAnchor="middle" dominantBaseline="central">
              {t.axis.toUpperCase()}
            </text>
          </g>
        ))}
      </svg>
      <p className="plot-note">
        Outer extent = {mesh.peakDb.toFixed(2)} dBi; darker is stronger. The antenna at the centre is drawn to scale with itself, not with the
        pattern.
      </p>
    </figure>
  );
}
