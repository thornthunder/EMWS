// One orthographic view (front, left or top) of the first-angle layout, and everything
// you can do in it: drag wire ends and whole wires, slide a feed along its wire, draw new
// wires, right-click for more; wheel to zoom, drag empty space to pan.

import { type MouseEvent, type PointerEvent, useEffect, useId, useRef, useState } from 'react';
import type { Vec3 } from '../../../engine/nec2/types';
import { closestParameter, distance, withAxis } from '../../../lib/vec3';
import {
  type AntennaModel,
  type EndName,
  type EndRef,
  addFeed,
  addWire,
  centreSegment,
  deleteWire,
  duplicateWire,
  endPoint,
  endsMovedWithWire,
  feedPosition,
  junctionOf,
  moveEnds,
  newId,
  removeFeed,
  segmentAt,
  splitWire,
  translateEnds,
  updateFeed,
  wireById,
} from '../model';
import type { MenuEntry } from './ContextMenu';
import { useEditor } from './context';
import { type Camera, type Plane, PLANES, gridStep, panBy, snapValue, toScreen, toWorld, zoomAt } from './projection';

const DRAG_THRESHOLD = 3;
const SNAP_PX = 10;
/** A wire seen end-on is drawn as a dot. */
const COLLAPSED_PX = 1.5;

type Drag =
  | { kind: 'pan'; x0: number; y0: number; start: Camera; moved: boolean }
  | { kind: 'click'; x0: number; y0: number }
  | { kind: 'end'; x0: number; y0: number; started: boolean; start: AntennaModel; moving: EndRef[]; depth: number }
  | {
      kind: 'wire';
      x0: number;
      y0: number;
      started: boolean;
      start: AntennaModel;
      wireId: string;
      moving: EndRef[];
      /** The pointer's world position when the drag began, at the depth of the wire's end a. */
      grab: Vec3;
    }
  | { kind: 'feed'; x0: number; y0: number; started: boolean; start: AntennaModel; feedId: string; wireId: string };

const isMoving = (moving: readonly EndRef[], wireId: string, end: EndName) =>
  moving.some((m) => m.wireId === wireId && m.end === end);

export function OrthoView({ plane }: { plane: Plane }) {
  const api = useEditor();
  const { scene, camera, size, model, tool, overlay } = api;
  const spec = PLANES[plane];
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | undefined>(undefined);
  const [hover, setHover] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  const hatch = `hatch-${useId().replace(/:/g, '')}`;
  const { width, height } = size;
  const grid = gridStep(camera);

  const screen = (p: Vec3) => toScreen(p, plane, camera, size);

  const pointerAt = (e: { clientX: number; clientY: number }): [number, number] => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return [0, 0];
    return [((e.clientX - rect.left) * width) / rect.width, ((e.clientY - rect.top) * height) / rect.height];
  };

  /** Where along a wire (0..1) the pointer is, judged in this view; undefined if the wire is seen end-on. */
  const parameterOnScreen = (a: Vec3, b: Vec3, sx: number, sy: number): number | undefined => {
    const [ax, ay] = screen(a);
    const [bx, by] = screen(b);
    if (Math.hypot(bx - ax, by - ay) < COLLAPSED_PX) return undefined;
    return closestParameter({ x: sx, y: sy, z: 0 }, { x: ax, y: ay, z: 0 }, { x: bx, y: by, z: 0 });
  };

  /** The nearest wire end within SNAP_PX of the pointer, ignoring those `skip` rejects. */
  const nearestEnd = (sx: number, sy: number, skip: (wireId: string, end: EndName) => boolean): Vec3 | undefined => {
    let best: Vec3 | undefined;
    let bestDistance = SNAP_PX;
    for (const w of scene.wires) {
      for (const end of ['a', 'b'] as const) {
        if (skip(w.id, end)) continue;
        const p = endPoint(w, end);
        const [px, py] = screen(p);
        const d = Math.hypot(px - sx, py - sy);
        if (d <= bestDistance) {
          best = p;
          bestDistance = d;
        }
      }
    }
    return best;
  };

  const onGrid = (p: Vec3): Vec3 =>
    withAxis(withAxis(p, spec.u, snapValue(p[spec.u], grid)), spec.v, snapValue(p[spec.v], grid));

  /** The point the pointer means: an existing wire end if one is close, else the grid, else exactly where it is. */
  const pick = (
    sx: number,
    sy: number,
    depth: number,
    free: boolean,
    skip: (wireId: string, end: EndName) => boolean = () => false,
  ): { point: Vec3; snapTo?: Vec3 } => {
    if (!free) {
      const end = nearestEnd(sx, sy, skip);
      if (end) return { point: end, snapTo: end };
    }
    const raw = toWorld(sx, sy, depth, plane, camera, size);
    return { point: api.snap && !free ? onGrid(raw) : raw };
  };

  /** New points go at the depth of the wire being drawn, else of the view's centre. */
  const drawDepth = () =>
    tool.kind === 'draw' && tool.from ? tool.from[spec.depth] : snapValue(camera.center[spec.depth], grid);

  // Wheel zoom needs a non-passive listener, which React's onWheel is not.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const sx = ((e.clientX - rect.left) * width) / rect.width;
      const sy = ((e.clientY - rect.top) * height) / rect.height;
      const lines = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      api.setCamera((c) => zoomAt(c, plane, size, sx, sy, Math.exp(-e.deltaY * lines * 0.0015)));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [api, plane, size, width, height]);

  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    if (e.button === 2) return; // the context menu handles right-clicks
    const [x0, y0] = pointerAt(e);
    e.currentTarget.setPointerCapture(e.pointerId);

    if (e.button === 1) {
      drag.current = { kind: 'pan', x0, y0, start: camera, moved: false };
      return;
    }
    if (tool.kind === 'draw') {
      drag.current = { kind: 'click', x0, y0 };
      return;
    }

    const target = (e.target as Element).closest<SVGElement>('[data-hit]');
    const wireId = target?.dataset.wire;
    if (target && wireId && model) {
      api.select(wireId);
      const wire = wireById(model, wireId);
      if (!wire) return;
      const hit = target.dataset.hit;
      if (hit === 'end') {
        const end = target.dataset.end === 'b' ? 'b' : 'a';
        const ref = { wireId, end } as const;
        drag.current = {
          kind: 'end',
          x0,
          y0,
          started: false,
          start: model,
          moving: e.shiftKey ? [ref] : junctionOf(model, ref),
          depth: endPoint(wire, end)[spec.depth],
        };
      } else if (hit === 'feed' && target.dataset.feed) {
        drag.current = { kind: 'feed', x0, y0, started: false, start: model, feedId: target.dataset.feed, wireId };
      } else {
        drag.current = {
          kind: 'wire',
          x0,
          y0,
          started: false,
          start: model,
          wireId,
          moving: endsMovedWithWire(model, wireId, e.shiftKey),
          grab: toWorld(x0, y0, wire.a[spec.depth], plane, camera, size),
        };
      }
      return;
    }
    drag.current = { kind: 'pan', x0, y0, start: camera, moved: false };
  };

  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const [sx, sy] = pointerAt(e);
    const free = e.altKey;
    const d = drag.current;
    if (!d) setHover((e.target as Element).closest<SVGElement>('[data-wire]')?.dataset.wire ?? null);

    if (tool.kind === 'draw' && (!d || d.kind === 'click')) {
      if (d && Math.hypot(sx - d.x0, sy - d.y0) > DRAG_THRESHOLD) {
        // Dragging while drawing pans instead.
        drag.current = { kind: 'pan', x0: d.x0, y0: d.y0, start: camera, moved: true };
        return;
      }
      const { point, snapTo } = pick(sx, sy, drawDepth(), free);
      api.setCursor({ plane, point });
      api.setOverlay({ rubberBand: tool.from ? { from: tool.from, to: point } : undefined, snapTo });
      return;
    }

    if (!d) {
      api.setCursor({ plane, point: toWorld(sx, sy, camera.center[spec.depth], plane, camera, size) });
      return;
    }
    const moved = Math.hypot(sx - d.x0, sy - d.y0) > DRAG_THRESHOLD;

    if (d.kind === 'pan') {
      if (!moved && !d.moved) return;
      d.moved = true;
      setPanning(true);
      api.setCamera(() => panBy(d.start, plane, sx - d.x0, sy - d.y0));
      return;
    }
    if (d.kind === 'click') return;

    if (!d.started) {
      if (!moved) return;
      d.started = true;
      api.dispatch({ type: 'gesture-start' });
    }

    if (d.kind === 'end') {
      const { point, snapTo } = pick(sx, sy, d.depth, free, (w, end) => isMoving(d.moving, w, end));
      api.dispatch({ type: 'gesture-update', model: moveEnds(d.start, d.moving, point) });
      api.setOverlay({ snapTo });
      api.setCursor({ plane, point });
    } else if (d.kind === 'wire') {
      const wire = wireById(d.start, d.wireId);
      if (!wire) return;
      const cursor = toWorld(sx, sy, wire.a[spec.depth], plane, camera, size);
      // Move end a with the pointer, keep it on the grid, and let either end snap onto another wire's end.
      let target = { ...wire.a, [spec.u]: wire.a[spec.u] + cursor[spec.u] - d.grab[spec.u], [spec.v]: wire.a[spec.v] + cursor[spec.v] - d.grab[spec.v] };
      if (api.snap && !free) target = onGrid(target);
      let delta = { x: target.x - wire.a.x, y: target.y - wire.a.y, z: target.z - wire.a.z };
      let snapTo: Vec3 | undefined;
      if (!free) {
        for (const end of [wire.a, wire.b]) {
          const [mx, my] = screen({ x: end.x + delta.x, y: end.y + delta.y, z: end.z + delta.z });
          const other = nearestEnd(mx, my, (w, e2) => isMoving(d.moving, w, e2));
          if (other) {
            delta = { x: other.x - end.x, y: other.y - end.y, z: other.z - end.z };
            snapTo = other;
            break;
          }
        }
      }
      api.dispatch({ type: 'gesture-update', model: translateEnds(d.start, d.moving, delta) });
      api.setOverlay({ snapTo });
    } else {
      const wire = wireById(d.start, d.wireId);
      const feed = d.start.feeds.find((f) => f.id === d.feedId);
      if (!wire || !feed) return;
      const t = parameterOnScreen(wire.a, wire.b, sx, sy);
      if (t === undefined) return;
      const segment = segmentAt(wire, t);
      const taken = d.start.feeds.some((f) => f.id !== feed.id && f.wireId === wire.id && f.segment === segment);
      if (!taken) api.dispatch({ type: 'gesture-update', model: updateFeed(d.start, feed.id, { segment }) });
    }
  };

  const onPointerUp = (e: PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    drag.current = undefined;
    setPanning(false);
    if (!d) return;
    if (d.kind === 'pan') {
      if (!d.moved && tool.kind === 'select') api.select(null); // a click on empty space
      return;
    }
    if (d.kind === 'click') {
      placeDrawPoint(e);
      return;
    }
    if (d.started) {
      api.dispatch({ type: 'gesture-end' });
      api.setOverlay({});
    }
  };

  const placeDrawPoint = (e: PointerEvent<SVGSVGElement>) => {
    if (tool.kind !== 'draw' || !model) return;
    const [sx, sy] = pointerAt(e);
    const { point } = pick(sx, sy, drawDepth(), e.altKey);
    const from = tool.from;
    if (!from) {
      api.setTool({ kind: 'draw', from: point });
      return;
    }
    if (distance(from, point) === 0) return;
    const id = newId('w');
    const radius = api.newWireRadius;
    api.dispatch({ type: 'edit', recipe: (m) => addWire(m, from, point, { radius, id }).model });
    api.select(id);
    api.setTool({ kind: 'draw', from: point }); // carry on from here; Esc or right-click stops
  };

  const onContextMenu = (e: MouseEvent<SVGSVGElement>) => {
    e.preventDefault();
    if (tool.kind === 'draw') {
      api.setTool({ kind: 'select' });
      api.setOverlay({});
      return;
    }
    const at = { x: e.clientX, y: e.clientY };
    if (!model) {
      api.openMenu({ ...at, entries: [{ label: 'Fit all views', onSelect: api.fit }] });
      return;
    }
    const [sx, sy] = pointerAt(e);
    const target = (e.target as Element).closest<SVGElement>('[data-hit]');
    const wire = target?.dataset.wire ? wireById(model, target.dataset.wire) : undefined;

    if (!wire) {
      const { point } = pick(sx, sy, snapValue(camera.center[spec.depth], grid), e.altKey);
      api.openMenu({
        ...at,
        entries: [
          { label: 'Add wire from here', onSelect: () => api.setTool({ kind: 'draw', from: point }) },
          { label: 'Fit all views', onSelect: api.fit },
        ],
      });
      return;
    }

    api.select(wire.id);
    const t = parameterOnScreen(wire.a, wire.b, sx, sy);
    const segment = t === undefined ? centreSegment(wire) : segmentAt(wire, t);
    const feeds = model.feeds.filter((f) => f.wireId === wire.id);
    const clickedFeed = target?.dataset.feed;
    const edit = (recipe: (m: AntennaModel) => AntennaModel) => api.dispatch({ type: 'edit', recipe });

    // Split on a segment boundary, so both halves keep whole, equal segments.
    const splitAt =
      t === undefined ? undefined
      : wire.segments >= 2 ? Math.min(wire.segments - 1, Math.max(1, Math.round(t * wire.segments))) / wire.segments
      : t > 0.05 && t < 0.95 ? t
      : undefined;

    const offset = withAxis({ x: 0, y: 0, z: 0 }, spec.u, spec.uSign * grid);
    const entries: MenuEntry[] = [];
    if (clickedFeed) {
      entries.push({ label: 'Remove feed point', onSelect: () => edit((m) => removeFeed(m, clickedFeed)) });
    }
    const along = `${(feedPosition(wire, segment).fraction * 100).toFixed(1)}% along`;
    entries.push({
      label:
        t === undefined ? `Feed at the centre (segment ${segment})` : `Feed here: ${along} (segment ${segment})`,
      disabled: feeds.some((f) => f.segment === segment),
      onSelect: () => edit((m) => addFeed(m, wire.id, segment)),
    });
    for (const f of feeds) {
      if (f.id !== clickedFeed) {
        entries.push({ label: `Remove feed on segment ${f.segment}`, onSelect: () => edit((m) => removeFeed(m, f.id)) });
      }
    }
    entries.push(
      'separator',
      {
        label: 'Split wire here',
        disabled: splitAt === undefined,
        onSelect: () => edit((m) => (splitAt === undefined ? m : (splitWire(m, wire.id, splitAt)?.model ?? m))),
      },
      {
        label: 'Duplicate wire',
        onSelect: () => {
          const id = newId('w');
          edit((m) => duplicateWire(m, wire.id, offset, id)?.model ?? m);
          api.select(id);
        },
      },
      'separator',
      {
        label: 'Delete wire',
        hint: 'Del',
        danger: true,
        onSelect: () => {
          edit((m) => deleteWire(m, wire.id));
          api.select(null);
        },
      },
    );
    api.openMenu({ ...at, title: `Wire ${wire.tag}`, entries });
  };

  // ---- drawing ----

  const uAt = (sx: number) => camera.center[spec.u] + (spec.uSign * (sx - width / 2)) / camera.scale;
  const vAt = (sy: number) => camera.center[spec.v] - (sy - height / 2) / camera.scale;
  const xOf = (u: number) => width / 2 + spec.uSign * (u - camera.center[spec.u]) * camera.scale;
  const yOf = (v: number) => height / 2 - (v - camera.center[spec.v]) * camera.scale;

  const gridLines: { key: string; x1: number; y1: number; x2: number; y2: number; axis: boolean }[] = [];
  const [uLo, uHi] = [uAt(0), uAt(width)].sort((a, b) => a - b) as [number, number];
  const [vLo, vHi] = [vAt(height), vAt(0)];
  if ((uHi - uLo) / grid < 400 && (vHi - vLo) / grid < 400) {
    for (let u = Math.ceil(uLo / grid) * grid; u <= uHi; u += grid) {
      const x = xOf(u);
      gridLines.push({ key: `u${u.toPrecision(8)}`, x1: x, y1: 0, x2: x, y2: height, axis: Math.abs(u) < grid / 2 });
    }
    for (let v = Math.ceil(vLo / grid) * grid; v <= vHi; v += grid) {
      const y = yOf(v);
      gridLines.push({ key: `v${v.toPrecision(8)}`, x1: 0, y1: y, x2: width, y2: y, axis: Math.abs(v) < grid / 2 });
    }
  }

  const mid = (a: Vec3, b: Vec3) => spec.farness({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
  const lines = [...scene.lines].sort((p, q) => mid(q.a, q.b) - mid(p.a, p.b));
  const wires = [...scene.wires].sort((p, q) => mid(q.a, q.b) - mid(p.a, p.b));
  const groundY = yOf(0);
  const showGround = scene.ground && plane !== 'top';
  const editing = scene.editable && tool.kind === 'select';

  const origin = { x: spec.uSign === 1 ? 20 : 52, y: height - 20 };
  const classes = ['view-canvas', 'view-ortho', `tool-${tool.kind}`, panning ? 'panning' : ''].join(' ');

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${width} ${height}`}
      className={classes}
      role="application"
      aria-label={`${spec.title} view. Drag wires and their ends to move them; right-click for more.`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => {
        setHover(null);
        if (!drag.current) api.setCursor(null);
      }}
      onContextMenu={onContextMenu}
    >
      <defs>
        <pattern id={hatch} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="8" className="hatch-line" />
        </pattern>
      </defs>

      {gridLines.map((g) => (
        <line key={g.key} x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} className={g.axis ? 'grid-axis' : 'grid-line'} />
      ))}

      {showGround && groundY < height && (
        <g>
          <rect x={0} y={Math.max(0, groundY)} width={width} height={Math.max(0, height - Math.max(0, groundY))} fill={`url(#${hatch})`} className="ground-fill" />
          {groundY >= 0 && <line x1={0} y1={groundY} x2={width} y2={groundY} className="ground-line" />}
        </g>
      )}

      {scene.wires
        .filter((w) => w.id === api.selection || w.id === hover)
        .map((w) => {
          const [x1, y1] = screen(w.a);
          const [x2, y2] = screen(w.b);
          const cls = w.id === api.selection ? 'halo' : 'halo halo-hover';
          return Math.hypot(x2 - x1, y2 - y1) < COLLAPSED_PX ? (
            <circle key={`halo${w.id}`} cx={x1} cy={y1} r={9} className={cls} />
          ) : (
            <line key={`halo${w.id}`} x1={x1} y1={y1} x2={x2} y2={y2} className={cls} />
          );
        })}

      {lines.map((l) => {
        const [x1, y1] = screen(l.a);
        const [x2, y2] = screen(l.b);
        const style = l.colour ? { stroke: l.colour, fill: l.colour } : undefined;
        return Math.hypot(x2 - x1, y2 - y1) < COLLAPSED_PX ? (
          <circle key={l.key} cx={x1} cy={y1} r={3.5} className="wire-dot" style={style} />
        ) : (
          <line key={l.key} x1={x1} y1={y1} x2={x2} y2={y2} className="wire" style={style} />
        );
      })}

      {editing &&
        wires.map((w) => {
          const [x1, y1] = screen(w.a);
          const [x2, y2] = screen(w.b);
          return Math.hypot(x2 - x1, y2 - y1) < COLLAPSED_PX ? (
            <circle key={`hit${w.id}`} cx={x1} cy={y1} r={9} className="hit hit-wire" data-hit="wire" data-wire={w.id} />
          ) : (
            <line key={`hit${w.id}`} x1={x1} y1={y1} x2={x2} y2={y2} className="hit hit-wire" data-hit="wire" data-wire={w.id} />
          );
        })}

      {scene.feeds.map((f) => {
        const [x, y] = screen(f.at);
        return (
          <circle
            key={f.key}
            cx={x}
            cy={y}
            r={5.5}
            className={editing ? 'feed feed-editable' : 'feed'}
            data-hit={editing && f.feedId ? 'feed' : undefined}
            data-wire={f.wireId}
            data-feed={f.feedId}
          >
            <title>Feed point{editing ? ' - drag it along the wire' : ''}</title>
          </circle>
        );
      })}

      {editing &&
        wires.flatMap((w) => {
          // Seen end-on, a wire is grabbed as a whole: its dot moves the element, not one end.
          const [ax, ay] = screen(w.a);
          const [bx, by] = screen(w.b);
          if (Math.hypot(bx - ax, by - ay) < COLLAPSED_PX) return [];
          return (['a', 'b'] as const).map((end) => {
            const [x, y] = screen(endPoint(w, end));
            return (
              <circle
                key={`${w.id}${end}`}
                cx={x}
                cy={y}
                r={4}
                className={w.id === api.selection ? 'handle handle-selected' : 'handle'}
                data-hit="end"
                data-wire={w.id}
                data-end={end}
              />
            );
          });
        })}

      {overlay.rubberBand && (
        <line
          x1={screen(overlay.rubberBand.from)[0]}
          y1={screen(overlay.rubberBand.from)[1]}
          x2={screen(overlay.rubberBand.to)[0]}
          y2={screen(overlay.rubberBand.to)[1]}
          className="rubber-band"
        />
      )}
      {tool.kind === 'draw' && tool.from && (
        <circle cx={screen(tool.from)[0]} cy={screen(tool.from)[1]} r={4} className="draw-anchor" />
      )}
      {overlay.snapTo && <circle cx={screen(overlay.snapTo)[0]} cy={screen(overlay.snapTo)[1]} r={9} className="snap-ring" />}

      <g className="view-axes" aria-hidden="true">
        <line x1={origin.x} y1={origin.y} x2={origin.x + spec.uSign * 26} y2={origin.y} className={`axis axis-${spec.u}`} />
        <line x1={origin.x} y1={origin.y} x2={origin.x} y2={origin.y - 26} className={`axis axis-${spec.v}`} />
        <text x={origin.x + spec.uSign * 34} y={origin.y} className="axis-label" textAnchor="middle" dominantBaseline="central">
          {spec.u.toUpperCase()}
        </text>
        <text x={origin.x} y={origin.y - 34} className="axis-label" textAnchor="middle" dominantBaseline="central">
          {spec.v.toUpperCase()}
        </text>
      </g>
    </svg>
  );
}
