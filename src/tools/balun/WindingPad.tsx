// The design pad: the toroid from above, wound the way the recipe says.
//
// It is a view of the design and an editor of it, never its owner (see model.ts). Two
// gestures live here: dropping a core from the list, and dragging the free end of the wire
// round the ring to wind or unwind turns. Everything else is done in the recipe beside it,
// which is also how anyone without a mouse does all of it.
//
// What is drawn is what the model can honestly use: how many turns, where the taps are,
// whether the winding crosses over, and whether it fits. The exact position of each turn
// is for the eye - the analysis does not pretend to depend on it.

import { type DragEvent, type PointerEvent as ReactPointerEvent, useRef, useState } from 'react';
import { type Design, coreOf, summarise, tappedTurns, turnWidthMm, turnsThatFit } from './model';

const WIDTH = 640;
const HEIGHT = 400;
/** Bottom-left of the ring, where winding starts; angles run clockwise from 3 o'clock. */
const START = (135 * Math.PI) / 180;
/** Bottom-right, where the second half of a crossover winding starts - and runs the other way. */
const CROSSED_START = (45 * Math.PI) / 180;
const TAU = 2 * Math.PI;

export const CORE_DRAG_TYPE = 'application/x-emws-core';

export interface WindingPadProps {
  design: Design;
  materialName: string;
  onDropCore: (coreId: string, materialId: string) => void;
  /** One of the user's own measured cores was dropped. */
  onDropProfile: (profileId: string) => void;
  /** The wire's free end has been dragged to where this many turns, in all, are wound. */
  onWindTo: (totalTurns: number) => void;
  onGesture: (active: boolean) => void;
}

interface Turn {
  angle: number;
  /** Which stretch of the winding it belongs to, for colour: 0 is the input section. */
  section: number;
}

function layOut(design: Design): { turns: Turn[]; pitch: number; freeEnd: number; direction: 1 | -1 } {
  const summary = summarise(design.steps);
  const core = coreOf(design);
  const width = turnWidthMm(design.conductor);
  const pitch = width / (core.idMm / 2 - width / 2);
  const inputTurns = design.topology === 'autotransformer' ? tappedTurns(design).primary : summary.totalTurns;
  const crossed = summary.crossoverAt;

  const turns: Turn[] = [];
  for (let k = 0; k < summary.totalTurns; k++) {
    const angle = crossed === undefined || k < crossed ? START + (k + 0.5) * pitch : CROSSED_START - (k - crossed + 0.5) * pitch;
    turns.push({ angle, section: k < inputTurns ? 0 : 1 });
  }
  const onSecondHalf = crossed !== undefined;
  const freeEnd = onSecondHalf ? CROSSED_START - (summary.totalTurns - crossed) * pitch : START + summary.totalTurns * pitch;
  return { turns, pitch, freeEnd, direction: onSecondHalf ? -1 : 1 };
}

const SECTION_COLOUR = ['var(--series-1)', 'var(--series-2)'];

export function WindingPad({ design, materialName, onDropCore, onDropProfile, onWindTo, onGesture }: WindingPadProps) {
  const svg = useRef<SVGSVGElement>(null);
  const [over, setOver] = useState(false);
  const [winding, setWinding] = useState(false);

  const core = coreOf(design);
  const summary = summarise(design.steps);
  const { turns, pitch, freeEnd, direction } = layOut(design);
  const two = design.topology === 'guanella-1-4' && design.positions === 2;
  const outerPx = two ? 108 : 150;
  const scale = outerPx / (core.odMm / 2);
  const innerPx = (core.idMm / 2) * scale;
  const centres = two ? [WIDTH * 0.27, WIDTH * 0.73] : [WIDTH / 2];
  const cy = HEIGHT / 2;
  const strokePx = Math.max(2.2, Math.min(9, turnWidthMm(design.conductor) * scale * 0.8));
  const tapped = design.topology === 'autotransformer';
  const fits = turnsThatFit(design);

  const point = (cx: number, r: number, a: number) => `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;

  /** Where the pointer is, as an angle round the first core. */
  const pointerAngle = (e: ReactPointerEvent) => {
    const matrix = svg.current?.getScreenCTM();
    if (!matrix) return undefined;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
    return Math.atan2(p.y - cy, p.x - centres[0]!);
  };

  const dragTo = (e: ReactPointerEvent) => {
    const angle = pointerAngle(e);
    if (angle === undefined) return;
    const crossed = summary.crossoverAt;
    // How far round from the start of this half the pointer is, in the winding direction.
    const from = crossed === undefined ? START : CROSSED_START;
    let swept = (direction * (angle - from)) % TAU;
    if (swept < 0) swept += TAU;
    if (swept > TAU - 0.35) swept = 0; // a little behind the start counts as none
    const inThisHalf = Math.round(swept / pitch);
    onWindTo(Math.min(fits, (crossed ?? 0) + inThisHalf));
  };

  const accept = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes(CORE_DRAG_TYPE)) return;
    e.preventDefault();
    setOver(true);
  };
  const drop = (e: DragEvent) => {
    setOver(false);
    const raw = e.dataTransfer.getData(CORE_DRAG_TYPE);
    if (!raw) return;
    e.preventDefault();
    try {
      const payload = JSON.parse(raw) as { coreId?: string; materialId?: string; profileId?: string };
      if (payload.profileId) onDropProfile(payload.profileId);
      else if (payload.coreId && payload.materialId) onDropCore(payload.coreId, payload.materialId);
    } catch {
      // not one of ours
    }
  };

  const label = (cx: number, a: number, text: string, r: number) => {
    const side = Math.cos(a);
    return (
      <text
        className="pad-label"
        x={cx + r * Math.cos(a) + (side < -0.2 ? -6 : side > 0.2 ? 6 : 0)}
        y={cy + r * Math.sin(a) + (Math.sin(a) > 0.5 ? 14 : Math.sin(a) < -0.5 ? -6 : 4)}
        textAnchor={side < -0.2 ? 'end' : side > 0.2 ? 'start' : 'middle'}
      >
        {text}
      </text>
    );
  };

  const leadOut = outerPx + 26;
  const startAngle = START - pitch * 0.15;
  const taps = tapped ? summary.taps.filter((t) => t > 0 && t < summary.totalTurns) : [];
  const chosenTap = tappedTurns(design).primary;
  const names = tapped
    ? { start: 'common', end: 'antenna' }
    : design.topology === 'guanella-1-1'
      ? { start: 'radio', end: 'antenna' }
      : { start: 'radio (in parallel)', end: 'load (in series)' };

  return (
    <div className={`pad${over ? ' pad-over' : ''}`} onDragOver={accept} onDragLeave={() => setOver(false)} onDrop={drop}>
      <svg
        ref={svg}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`${core.name} ${materialName}${design.stack > 1 ? `, ${design.stack} stacked` : ''}, ${summary.totalTurns} turns${
          summary.crossoverAt !== undefined ? ', crossing over' : ''
        }`}
      >
        {centres.map((cx, which) => (
          <g key={cx}>
            {/* The ferrite: a ring, drawn as one path so the hole is really a hole. */}
            <path
              className="pad-core"
              fillRule="evenodd"
              d={`M${cx + outerPx},${cy} A${outerPx},${outerPx} 0 1 0 ${cx - outerPx},${cy} A${outerPx},${outerPx} 0 1 0 ${cx + outerPx},${cy} Z M${cx + innerPx},${cy} A${innerPx},${innerPx} 0 1 1 ${cx - innerPx},${cy} A${innerPx},${innerPx} 0 1 1 ${cx + innerPx},${cy} Z`}
            />
            <text className="pad-core-name" x={cx} y={cy - 2} textAnchor="middle">
              {design.profileId ? core.name : `${core.name}-${materialName.replace('#', '')}`}
              {design.stack > 1 ? ` ×${design.stack}` : ''}
            </text>
            <text className="pad-label" x={cx} y={cy + 16} textAnchor="middle">
              {two ? (which === 0 ? 'core A' : 'core B') : `${core.odMm} × ${core.idMm} × ${(core.heightMm * design.stack).toFixed(1)} mm`}
            </text>

            {/* Across the hole, from the last turn of one half to the first of the other. */}
            {summary.crossoverAt !== undefined && summary.crossoverAt > 0 && summary.crossoverAt < summary.totalTurns && (
              <line
                className="pad-wire"
                style={{ stroke: SECTION_COLOUR[turns[summary.crossoverAt]!.section], strokeWidth: strokePx }}
                x1={cx + (innerPx - 2) * Math.cos(turns[summary.crossoverAt - 1]!.angle)}
                y1={cy + (innerPx - 2) * Math.sin(turns[summary.crossoverAt - 1]!.angle)}
                x2={cx + (innerPx - 2) * Math.cos(turns[summary.crossoverAt]!.angle)}
                y2={cy + (innerPx - 2) * Math.sin(turns[summary.crossoverAt]!.angle)}
              />
            )}

            {turns.map((t, k) =>
              design.conductor.kind === 'pair' ? (
                <g key={k}>
                  {[-0.27, 0.27].map((offset) => (
                    <polyline
                      key={offset}
                      className="pad-wire"
                      style={{ stroke: SECTION_COLOUR[offset < 0 ? 0 : 1], strokeWidth: strokePx * 0.42 }}
                      points={`${point(cx, innerPx - 4, t.angle + offset * pitch)} ${point(cx, outerPx + 4, t.angle + offset * pitch)}`}
                    />
                  ))}
                </g>
              ) : (
                <polyline
                  key={k}
                  className="pad-wire"
                  style={{ stroke: SECTION_COLOUR[t.section], strokeWidth: strokePx }}
                  points={`${point(cx, innerPx - 4, t.angle)} ${point(cx, outerPx + 4, t.angle)}`}
                />
              ),
            )}

            {/* Connections: where the winding starts, each tap, and where it ends. */}
            {turns.length > 0 && (
              <g>
                <polyline className="pad-lead" points={`${point(cx, outerPx + 4, startAngle)} ${point(cx, leadOut, startAngle)}`} />
                {label(cx, startAngle, names.start, leadOut + 4)}
                <polyline className="pad-lead" points={`${point(cx, outerPx + 4, freeEnd)} ${point(cx, leadOut, freeEnd)}`} />
                {label(cx, freeEnd, names.end, leadOut + 4)}
                {taps.map((t) => {
                  const a = START + t * pitch;
                  return (
                    <g key={t}>
                      <polyline className="pad-lead" points={`${point(cx, outerPx + 4, a)} ${point(cx, leadOut, a)}`} />
                      {label(cx, a, t === chosenTap ? `radio · tap at ${t}` : `tap at ${t}`, leadOut + 4)}
                    </g>
                  );
                })}
              </g>
            )}
          </g>
        ))}

        {/* The free end of the wire: drag it round the ring to wind or unwind. */}
        <circle
          className={`pad-handle${winding ? ' pad-handle-active' : ''}`}
          cx={centres[0]! + ((outerPx + innerPx) / 2) * Math.cos(freeEnd + direction * pitch * 0.5)}
          cy={cy + ((outerPx + innerPx) / 2) * Math.sin(freeEnd + direction * pitch * 0.5)}
          r={11}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            setWinding(true);
            onGesture(true);
          }}
          onPointerMove={(e) => winding && dragTo(e)}
          onPointerUp={() => {
            setWinding(false);
            onGesture(false);
          }}
          onPointerCancel={() => {
            setWinding(false);
            onGesture(false);
          }}
        >
          <title>Drag round the core to wind or unwind turns</title>
        </circle>
      </svg>
      <p className="pad-caption">
        {summary.totalTurns === 0
          ? 'Drag the dot round the core to wind turns, or drop a different core here from the list.'
          : `${summary.totalTurns} of the ${fits} turns this core takes in one layer. Drag the dot to wind; drop a core here to change it, or the same one again to stack it.`}
      </p>
    </div>
  );
}
