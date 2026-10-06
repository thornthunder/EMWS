// Field sandbox: draw conductors, dielectrics and sources, press play, watch the waves.
//
// The scene is the source of truth (history.ts gives undo/redo; a drag is one undo step);
// the grid and the engine are derived from it, so any edit restarts the clock. The engine
// runs on the main thread inside requestAnimationFrame, a few steps a frame, and paints
// into a canvas; a 200 x 130 world keeps up comfortably on a laptop. The probe is NOT part
// of the scene: moving it must not restart the clock.

import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { guideForTool } from '../../guides/registry';
import { type GenericHistory, type GenericHistoryAction, historyReducer, initialHistory } from '../../lib/history';
import { NumberField, formatValue } from '../../ui/NumberField';
import { XYChart } from '../../ui/XYChart';
import { type PaintMode, type Rgb, paintField, parseCssColour } from './colour';
import { PRESETS, presetById } from './presets';
import { type ProbeRecord, type ProbeView, levelsAgainstStrongest, newProbeRecord, probeView, recordProbe } from './probe';
import {
  CONDUCTOR,
  COURANT,
  type Geometry,
  type Grid,
  MAX_PLANE_WAVE_ANGLE,
  type Scene,
  type ScenePlaneWave,
  type Source,
  addShape,
  addSource,
  cellOf,
  dielectric,
  hitTest,
  limits,
  loadScene,
  rasterise,
  removeItem,
  saveScene,
  updateShape,
  updateSource,
  withFrequency,
} from './scene';
import { type FieldEngine, type Polarisation, type Side, type SourceKind, makeEngine, planeWaveDirection } from './simulation';

type Tool = 'conductor' | 'dielectric' | 'source' | 'probe' | 'select';

const TOOLS: { id: Tool; label: string; hint: string }[] = [
  { id: 'conductor', label: 'Conductor', hint: 'Drag to draw a conducting sheet, seen edge-on.' },
  { id: 'dielectric', label: 'Dielectric', hint: 'Drag a rectangle of insulating material.' },
  { id: 'source', label: 'Source', hint: 'Click where a wave should start. Click again for another: each source has its own amplitude and phase.' },
  {
    id: 'probe',
    label: 'Probe',
    hint: 'Click a point to watch the field there against time, with its spectrum - up to six probes, numbered. Drag one to move it, click it to take it away. Probes do not restart the clock.',
  },
  { id: 'select', label: 'Select', hint: 'Click an object to move, edit or delete it.' },
];

const SIDES: { id: Side; label: string }[] = [
  { id: 'left', label: 'left' },
  { id: 'right', label: 'right' },
  { id: 'top', label: 'top' },
  { id: 'bottom', label: 'bottom' },
];

const SPEEDS = [1, 2, 4, 8, 16];
const ENVELOPE_DECAY = 0.998;

/** What each control is for, shown when the pointer rests on it. One place, so the words stay in step. */
const HINTS = {
  startFrom: 'Load a ready-made scene. It replaces what is drawn and starts playing at once.',
  frequency:
    'The frequency of every continuous source and of the plane wave, in MHz. It sets the scale of the whole picture: a cell is a fixed fraction of the wavelength, so a 3 m world is ten wavelengths wide at 1000 MHz and one at 100 MHz.',
  width: 'How wide the world is, in metres. The legend under the picture says how many wavelengths that is.',
  height: 'How tall the world is, in metres.',
  cellsPerWavelength:
    'How finely space is divided: cells per wavelength. 20 is comfortable; below 10 the grid itself bends the waves. More cells cost time steeply - double them and every step is four times the work, and there are twice as many steps.',
  polarisation:
    'Which field points out of the screen, along the infinitely long objects. Ez: the electric field does - a wire antenna seen end-on, and horizontal polarisation if the bottom of the picture is the ground. Hz: the magnetic field does and the electric field lies in the picture - vertical polarisation over a ground, and the only one with a Brewster angle.',
  scaleWithFrequency:
    'When you change the frequency, grow or shrink the world and everything drawn in it with the wavelength, so the picture keeps its size in wavelengths and its detail. Conductivities in S/m do not scale, so a lossy ground means something different at each frequency. Untick to keep the metres instead.',
  tools: 'Choose what a click or a drag on the picture does.',
  sourceList: 'Every source in the scene, numbered as on the picture, with its position, amplitude and phase. Click one to edit it.',
  probeList: 'Every probe, numbered and coloured as on the picture and on the charts, with where it is and where its spectrum peaks.',
  epsr: 'Relative permittivity of the next dielectric drawn. Air 1, PTFE about 2.1, FR-4 about 4.4, fresh water about 80. Waves inside travel slower and are shorter by its square root.',
  sigma: 'Conductivity of the next dielectric drawn, in siemens per metre - 0 for a lossless one. Average ground is about 0.005, sea water about 5.',
  sourceKind: 'A continuous wave at the frequency above, or a single short pulse.',
  sourceAmplitude: 'The strength of this source, relative: everything in the picture is measured against 1.',
  sourcePhase: 'The phase of this continuous source, in degrees. Two sources with different phases make a phased array.',
  thickness: 'How thick this conducting sheet is, in metres. 0 means one cell.',
  shapeEpsr: 'Relative permittivity of this dielectric.',
  shapeSigma: 'Conductivity of this dielectric, in siemens per metre.',
  planeWaveOn: 'A straight wavefront filling the world from one side, as from a transmitter far away - the proper way to see diffraction, scattering and reflection from a ground.',
  planeWaveSide: 'The side of the world the plane wave comes in through.',
  planeWaveTilt: 'Degrees from square on, up to 85. From the top, a positive tilt leans the wave to the right; from the left, upwards. The arrow on the edge of the picture shows the direction of travel.',
  planeWaveKind: 'A continuous wave at the frequency above, or a single pulse.',
  planeWaveAmplitude: 'The strength of the plane wave, relative; 1 is the usual.',
  play: 'Run or pause the clock (space bar).',
  step: 'Advance ten time steps while paused, to watch a wave move slowly.',
  reset: 'Back to the start: the fields are cleared and the clock goes to zero. The scene stays.',
  speed: 'How many time steps are computed for each frame drawn. More is faster, at the cost of a jerkier picture.',
  show: 'The field itself, swinging positive and negative as the wave passes, or its envelope - where the field has been strong recently, which shows standing waves, shadows and lobes.',
  contrast: 'Turns the weak outer waves up. 1 scales the colours to the strongest field in the picture; 4 shows a field a quarter as strong at full colour.',
  statusTime: 'How much time has been simulated, in nanoseconds and in periods of the frequency; and the number of time steps taken.',
  statusPeak: 'The strongest field anywhere in the world right now, relative to a source of 1.',
  statusSpeed: 'How many time steps a second this machine manages, and how many cells each step updates.',
};

/** The field out of the screen, by polarisation. */
const fieldName = (p: Polarisation) => (p === 'te' ? 'Hz' : 'Ez');

interface Status {
  step: number;
  timeS: number;
  peak: number;
  stepsPerSecond: number;
}

type SceneHistory = GenericHistory<Scene>;
const reduce = (h: SceneHistory, a: GenericHistoryAction<Scene>): SceneHistory => historyReducer(h, a);

function translate(geometry: Geometry, dx: number, dy: number): Geometry {
  switch (geometry.kind) {
    case 'line':
      return { ...geometry, x1: geometry.x1 + dx, y1: geometry.y1 + dy, x2: geometry.x2 + dx, y2: geometry.y2 + dy };
    case 'rect':
      return { ...geometry, x: geometry.x + dx, y: geometry.y + dy };
    case 'disc':
      return { ...geometry, cx: geometry.cx + dx, cy: geometry.cy + dy };
  }
}

const cssColour = (name: string, fallback: Rgb): Rgb => parseCssColour(getComputedStyle(document.documentElement).getPropertyValue(name)) ?? fallback;

/** A probe is not part of the scene: it watches, it does not change the simulation. */
interface Probe {
  id: string;
  x: number;
  y: number;
}

/** As many probes as there are series colours to tell them apart by. */
export const MAX_PROBES = 6;
const SERIES_FALLBACK: Rgb[] = [
  [10, 122, 82],
  [11, 110, 168],
  [193, 80, 10],
  [74, 58, 167],
  [232, 123, 164],
  [237, 161, 0],
];
let probeCounter = 0;

const cellIndex = (grid: Grid, x: number, y: number) => {
  const cell = cellOf(grid, x, y);
  return cell ? cell.i + cell.j * grid.nx : undefined;
};

export function FdtdTool() {
  const [history, dispatch] = useReducer(reduce, undefined, () => initialHistory(loadScene() ?? PRESETS[0]!.scene()));
  const scene = history.present;
  useEffect(() => saveScene(scene), [scene]);
  const guide = guideForTool('#/fdtd');

  const [tool, setTool] = useState<Tool>('conductor');
  const [newDielectric, setNewDielectric] = useState({ epsr: 4, sigma: 0 });
  const [newSource, setNewSource] = useState<{ kind: SourceKind; amplitude: number; phaseDeg: number }>({ kind: 'sine', amplitude: 1, phaseDeg: 0 });
  const [selected, setSelected] = useState<string | undefined>();
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(4);
  const [mode, setMode] = useState<PaintMode>('field');
  const [contrast, setContrast] = useState(1);
  const [status, setStatus] = useState<Status>({ step: 0, timeS: 0, peak: 0, stepsPerSecond: 0 });
  const [probes, setProbes] = useState<Probe[]>([]);
  const [probeData, setProbeData] = useState<Map<string, ProbeView>>(new Map());
  const [traceHover, setTraceHover] = useState<number | undefined>();
  const [spectrumHover, setSpectrumHover] = useState<number | undefined>();

  const raster = useMemo(() => rasterise(scene), [scene]);
  const checks = useMemo(() => limits(scene, raster), [scene, raster]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<FieldEngine | null>(null);
  /** One recording per probe, by id. */
  const probeRecords = useRef<Map<string, ProbeRecord>>(new Map());
  const envelopeRef = useRef<Float32Array>(new Float32Array(0));
  const scaleRef = useRef(0);
  const drag = useRef<
    | { kind: 'draw'; id?: string; x: number; y: number }
    | { kind: 'move'; id: string; x: number; y: number }
    | { kind: 'probe'; id: string; x: number; y: number; moved: boolean }
    | null
  >(null);
  const offscreen = useRef<HTMLCanvasElement | null>(null);
  const runningRef = useRef(running);
  runningRef.current = running;
  /** The sample count the charts were last drawn from, so a frame with nothing new redraws nothing. */
  const probeCountRef = useRef(-1);
  const fHzRef = useRef(scene.fMHz * 1e6);
  fHzRef.current = scene.fMHz * 1e6;

  // A new raster is a new engine, from t = 0.
  useEffect(() => {
    simRef.current = makeEngine(raster.polarisation, {
      ...raster.grid,
      pmlCells: raster.grid.pml,
      epsr: raster.epsr,
      sigma: raster.sigma,
      pec: raster.pec,
      sources: raster.sources,
      planeWave: raster.planeWave,
      courant: COURANT,
    });
    envelopeRef.current = new Float32Array(raster.grid.nx * raster.grid.ny);
    scaleRef.current = 0;
    setStatus({ step: 0, timeS: 0, peak: 0, stepsPerSecond: 0 });
  }, [raster]);

  // Each probe records from where the clock is now. A new engine starts every recording
  // afresh; adding, moving or removing one probe touches only its own recording.
  const probeCells = useMemo(() => probes.map((p) => ({ id: p.id, k: cellIndex(raster.grid, p.x, p.y) })), [probes, raster]);
  const recordsFor = useRef<typeof raster | null>(null);
  useEffect(() => {
    const records = probeRecords.current;
    const fresh = recordsFor.current !== raster;
    recordsFor.current = raster;
    const step = simRef.current?.step ?? 0;
    const keep = new Set<string>();
    for (const { id, k } of probeCells) {
      keep.add(id);
      const have = records.get(id);
      if (k === undefined) records.delete(id);
      else if (fresh || !have || have.k !== k) records.set(id, newProbeRecord(k, step));
    }
    for (const id of [...records.keys()]) if (!keep.has(id)) records.delete(id);
    probeCountRef.current = -1;
    setProbeData((old) => {
      const next = new Map<string, ProbeView>();
      for (const [id, view] of old) if (records.get(id)?.count) next.set(id, view);
      return next;
    });
  }, [probeCells, raster]);

  /** Every probe's charts from its recording; called whenever there is something new. */
  const refreshProbes = useCallback((sim: FieldEngine) => {
    const next = new Map<string, ProbeView>();
    let total = 0;
    // All over the same stretch: as far back as the newest recording goes.
    let shortest = Infinity;
    for (const record of probeRecords.current.values()) shortest = Math.min(shortest, record.count);
    for (const [id, record] of probeRecords.current) {
      total += record.count;
      const view = probeView(record, sim.dt, fHzRef.current, undefined, undefined, shortest);
      if (view) next.set(id, view);
    }
    if (total === probeCountRef.current) return;
    probeCountRef.current = total;
    setProbeData(next);
  }, []);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const sim = simRef.current;
    if (!canvas || !sim) return;
    const { innerNx, innerNy } = raster.grid;
    if (!offscreen.current) offscreen.current = document.createElement('canvas');
    const small = offscreen.current;
    if (small.width !== innerNx || small.height !== innerNy) {
      small.width = innerNx;
      small.height = innerNy;
    }
    const surface = cssColour('--surface', [255, 253, 248]);
    const ink = cssColour('--text', [28, 39, 48]);
    const values = mode === 'field' ? sim.field : envelopeRef.current;
    const peak = sim.peak();
    scaleRef.current = Math.max(peak, scaleRef.current * 0.995, 1e-6);
    const image = small.getContext('2d')!.createImageData(innerNx, innerNy);
    paintField(image.data, raster, values, scaleRef.current / contrast, mode, surface, ink);
    small.getContext('2d')!.putImageData(image, 0, 0);

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round((rect.width * scene.heightM) / scene.widthM) * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(small, 0, 0, width, height);

    // Overlays in world coordinates: sources, the selection, a drag in progress.
    const sx = width / scene.widthM;
    const sy = height / scene.heightM;
    const px = (x: number) => x * sx;
    const py = (y: number) => height - y * sy;
    const accent = cssColour('--accent', [181, 97, 10]);
    ctx.lineWidth = 2 * dpr;
    ctx.font = `bold ${11 * dpr}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    /** A number beside a marker, in a colour, with a halo of the paper so it reads over the field. */
    const label = (text: string, x: number, y: number, colour: Rgb) => {
      ctx.textAlign = 'left';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3 * dpr;
      ctx.strokeStyle = `rgb(${surface.join(',')})`;
      ctx.strokeText(text, x, y);
      ctx.fillStyle = `rgb(${colour.join(',')})`;
      ctx.fillText(text, x, y);
      ctx.lineWidth = 2 * dpr;
    };
    scene.sources.forEach((source, n) => {
      ctx.beginPath();
      ctx.arc(px(source.x), py(source.y), 5 * dpr, 0, 2 * Math.PI);
      ctx.fillStyle = `rgb(${ink.join(',')})`;
      ctx.fill();
      ctx.strokeStyle = `rgb(${surface.join(',')})`;
      ctx.stroke();
      if (scene.sources.length > 1) label(String(n + 1), px(source.x) + 8 * dpr, py(source.y) - 8 * dpr, ink);
    });
    // The plane wave: an arrow in from the middle of its side, along its direction.
    if (scene.planeWave) {
      const [ux, uy] = planeWaveDirection({ side: scene.planeWave.side, angleDeg: Math.max(-MAX_PLANE_WAVE_ANGLE, Math.min(MAX_PLANE_WAVE_ANGLE, scene.planeWave.angleDeg)) });
      const side = scene.planeWave.side;
      const startX = side === 'left' ? 0 : side === 'right' ? width : width / 2;
      const startY = side === 'top' ? 0 : side === 'bottom' ? height : height / 2;
      const length = Math.min(width, height) * 0.16;
      const endX = startX + ux * length;
      const endY = startY - uy * length;
      ctx.strokeStyle = `rgb(${ink.join(',')})`;
      ctx.fillStyle = `rgb(${ink.join(',')})`;
      ctx.lineWidth = 3 * dpr;
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.lineTo(endX, endY);
      ctx.stroke();
      const head = 12 * dpr;
      const angle = Math.atan2(endY - startY, endX - startX);
      ctx.beginPath();
      ctx.moveTo(endX, endY);
      ctx.lineTo(endX - head * Math.cos(angle - 0.45), endY - head * Math.sin(angle - 0.45));
      ctx.lineTo(endX - head * Math.cos(angle + 0.45), endY - head * Math.sin(angle + 0.45));
      ctx.closePath();
      ctx.fill();
      ctx.lineWidth = 2 * dpr;
    }
    // The probes: ringed crosses, each in its series colour with its number - the colour
    // of its trace on the charts, and a number so colour is never the only cue.
    probes.forEach((probe, n) => {
      const cx = px(probe.x);
      const cy = py(probe.y);
      const colour = cssColour(`--series-${n + 1}`, SERIES_FALLBACK[n] ?? accent);
      ctx.strokeStyle = `rgb(${surface.join(',')})`;
      ctx.lineWidth = 4 * dpr;
      ctx.beginPath();
      ctx.arc(cx, cy, 7 * dpr, 0, 2 * Math.PI);
      ctx.moveTo(cx - 11 * dpr, cy);
      ctx.lineTo(cx + 11 * dpr, cy);
      ctx.moveTo(cx, cy - 11 * dpr);
      ctx.lineTo(cx, cy + 11 * dpr);
      ctx.stroke();
      ctx.strokeStyle = `rgb(${colour.join(',')})`;
      ctx.lineWidth = 2 * dpr;
      ctx.stroke();
      label(String(n + 1), cx + 10 * dpr, cy - 10 * dpr, colour);
    });
    const chosen = scene.shapes.find((s) => s.id === selected) ?? scene.sources.find((s) => s.id === selected);
    if (chosen) {
      ctx.strokeStyle = `rgb(${accent.join(',')})`;
      ctx.setLineDash([6 * dpr, 4 * dpr]);
      ctx.beginPath();
      if ('geometry' in chosen) {
        const g = chosen.geometry;
        if (g.kind === 'line') {
          ctx.moveTo(px(g.x1), py(g.y1));
          ctx.lineTo(px(g.x2), py(g.y2));
        } else if (g.kind === 'rect') ctx.rect(px(Math.min(g.x, g.x + g.w)), py(Math.max(g.y, g.y + g.h)), Math.abs(g.w) * sx, Math.abs(g.h) * sy);
        else ctx.arc(px(g.cx), py(g.cy), g.r * sx, 0, 2 * Math.PI);
      } else ctx.arc(px(chosen.x), py(chosen.y), 9 * dpr, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [raster, scene, selected, mode, contrast, probes]);

  // The clock: a few steps a frame while running, and one paint per frame regardless.
  useEffect(() => {
    let frame = 0;
    let frames = 0;
    let lastReport = performance.now();
    let stepsSince = 0;
    const tick = () => {
      const sim = simRef.current;
      if (sim && runningRef.current) {
        const env = envelopeRef.current;
        const field = sim.field;
        const records = probeRecords.current;
        for (let s = 0; s < speed; s++) {
          sim.advance();
          for (let k = 0; k < env.length; k++) {
            const v = Math.abs(field[k]!);
            const held = env[k]! * ENVELOPE_DECAY;
            env[k] = v > held ? v : held;
          }
          for (const record of records.values()) recordProbe(record, field);
        }
        stepsSince += speed;
      }
      paint();
      frames++;
      const now = performance.now();
      if (sim && (now - lastReport > 250 || (!runningRef.current && frames % 6 === 0))) {
        // Work the rate out here: a state updater runs later, after the counters are reset.
        const stepsPerSecond = runningRef.current ? Math.round((stepsSince * 1000) / Math.max(1, now - lastReport)) : 0;
        const next = { step: sim.step, timeS: sim.time, peak: sim.peak(), stepsPerSecond };
        setStatus((s) => (s.step === next.step && s.stepsPerSecond === next.stepsPerSecond && s.peak === next.peak ? s : next));
        refreshProbes(sim);
        lastReport = now;
        stepsSince = 0;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [paint, speed, refreshProbes]);

  // ---- editing ----

  const toWorld = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - rect.left) / rect.width) * scene.widthM, y: (1 - (e.clientY - rect.top) / rect.height) * scene.heightM };
  };
  const toleranceM = (raster.grid.dx * 2) as number;

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const { x, y } = toWorld(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    if (tool === 'probe') {
      const near = probes.find((p) => Math.hypot(p.x - x, p.y - y) <= toleranceM * 2);
      if (near) {
        // On a probe: a drag moves it, a plain click (see onPointerUp) takes it away.
        drag.current = { kind: 'probe', id: near.id, x, y, moved: false };
      } else if (probes.length < MAX_PROBES && x >= 0 && y >= 0 && x < scene.widthM && y < scene.heightM) {
        probeCounter += 1;
        setProbes((ps) => [...ps, { id: `probe-${probeCounter}`, x, y }]);
      }
      return;
    }
    if (tool === 'source') {
      const added = addSource(scene, x, y, newSource.kind, newSource.amplitude, newSource.phaseDeg);
      dispatch({ type: 'edit', recipe: () => added.scene });
      setSelected(added.id);
      return;
    }
    if (tool === 'select') {
      const hit = hitTest(scene, x, y, toleranceM);
      setSelected(hit?.id);
      if (hit) {
        drag.current = { kind: 'move', id: hit.id, x, y };
        dispatch({ type: 'gesture-start' });
      }
      return;
    }
    drag.current = { kind: 'draw', x, y };
    dispatch({ type: 'gesture-start' });
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d) return;
    const { x, y } = toWorld(e);
    if (d.kind === 'probe') {
      if (!d.moved && Math.hypot(x - d.x, y - d.y) < raster.grid.dx) return;
      d.moved = true;
      const nx = Math.max(0, Math.min(scene.widthM - raster.grid.dx / 2, x));
      const ny = Math.max(0, Math.min(scene.heightM - raster.grid.dx / 2, y));
      setProbes((ps) => ps.map((p) => (p.id === d.id ? { ...p, x: nx, y: ny } : p)));
      return;
    }
    if (d.kind === 'move') {
      const dx = x - d.x;
      const dy = y - d.y;
      d.x = x;
      d.y = y;
      const shape = scene.shapes.find((s) => s.id === d.id);
      const next = shape
        ? updateShape(scene, d.id, { geometry: translate(shape.geometry, dx, dy) })
        : updateSource(scene, d.id, { x: (scene.sources.find((s) => s.id === d.id)?.x ?? 0) + dx, y: (scene.sources.find((s) => s.id === d.id)?.y ?? 0) + dy });
      dispatch({ type: 'gesture-update', model: next });
      return;
    }
    if (Math.hypot(x - d.x, y - d.y) < raster.grid.dx && !d.id) return;
    const geometry: Geometry = tool === 'conductor' ? { kind: 'line', x1: d.x, y1: d.y, x2: x, y2: y, widthM: 0 } : { kind: 'rect', x: d.x, y: d.y, w: x - d.x, h: y - d.y };
    if (!d.id) {
      const added = addShape(scene, geometry, tool === 'conductor' ? CONDUCTOR : dielectric(newDielectric.epsr, newDielectric.sigma));
      d.id = added.id;
      dispatch({ type: 'gesture-update', model: added.scene });
      setSelected(added.id);
    } else dispatch({ type: 'gesture-update', model: updateShape(scene, d.id, { geometry }) });
  };

  const onPointerUp = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (d.kind === 'probe') {
      if (!d.moved) removeProbe(d.id);
      return;
    }
    dispatch({ type: 'gesture-end' });
  };

  const deleteSelected = useCallback(() => {
    if (!selected) return;
    dispatch({ type: 'edit', recipe: (s) => removeItem(s, selected) });
    setSelected(undefined);
  }, [selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        dispatch({ type: e.shiftKey ? 'redo' : 'undo' });
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        dispatch({ type: 'redo' });
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selected) {
          e.preventDefault();
          deleteSelected();
        }
      } else if (e.key === ' ' && !(target && target.tagName === 'BUTTON')) {
        e.preventDefault();
        setRunning((r) => !r);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, deleteSelected]);

  const setWorld = (patch: Partial<Scene>) => dispatch({ type: 'edit', recipe: (s) => ({ ...s, ...patch }) });
  const setFrequency = (fMHz: number) => {
    // Probes are in metres but not in the scene: scale them too, so they stay where they are in the picture.
    if (scene.scaleWithFrequency && probes.length && fMHz > 0 && scene.fMHz > 0) {
      const ratio = scene.fMHz / fMHz;
      setProbes((ps) => ps.map((p) => ({ ...p, x: p.x * ratio, y: p.y * ratio })));
    }
    dispatch({ type: 'edit', recipe: (s) => withFrequency(s, fMHz) });
  };
  const loadPreset = (id: string) => {
    const preset = presetById(id);
    if (!preset) return;
    dispatch({ type: 'load', model: preset.scene() });
    setSelected(undefined);
    setProbes([]);
    setRunning(true);
  };
  const stepOnce = () => {
    const sim = simRef.current;
    if (!sim) return;
    for (let s = 0; s < 10; s++) {
      sim.advance();
      for (const record of probeRecords.current.values()) recordProbe(record, sim.field);
    }
    setStatus({ step: sim.step, timeS: sim.time, peak: sim.peak(), stepsPerSecond: 0 });
    refreshProbes(sim);
  };
  const reset = () => {
    simRef.current?.reset();
    envelopeRef.current.fill(0);
    scaleRef.current = 0;
    for (const [id, record] of probeRecords.current) probeRecords.current.set(id, newProbeRecord(record.k, 0));
    probeCountRef.current = -1;
    setProbeData(new Map());
    setStatus({ step: 0, timeS: 0, peak: 0, stepsPerSecond: 0 });
  };
  const removeProbe = (id: string) => setProbes((ps) => ps.filter((p) => p.id !== id));
  const setPlaneWave = (patch: Partial<ScenePlaneWave> | null) =>
    dispatch({
      type: 'edit',
      recipe: (s) => {
        if (patch === null) return { ...s, planeWave: null };
        const base: ScenePlaneWave = s.planeWave ?? { side: 'left', angleDeg: 0, kind: 'sine', amplitude: 1 };
        const next = { ...base, ...patch };
        return { ...s, planeWave: { ...next, angleDeg: Math.max(-MAX_PLANE_WAVE_ANGLE, Math.min(MAX_PLANE_WAVE_ANGLE, next.angleDeg)) } };
      },
    });

  const selectedShape = scene.shapes.find((s) => s.id === selected);
  const selectedSource = scene.sources.find((s) => s.id === selected);
  const periodS = 1 / (scene.fMHz * 1e6);
  const { grid } = raster;
  const name = fieldName(scene.polarisation);
  const pw = scene.planeWave;
  // The probes' charts: every probe's trace on one time axis (the longest recording sets it),
  // and every spectrum against the strongest point of any of them.
  const probeViews = probes.map((p, n) => ({ probe: p, n, view: probeData.get(p.id) })).filter((v): v is { probe: Probe; n: number; view: ProbeView } => v.view !== undefined);
  const traceAxis = probeViews.reduce<number[]>((best, v) => (v.view.timeNs.length > best.length ? v.view.timeNs : best), []);
  const spectrumLevels = levelsAgainstStrongest(probeViews.map((v) => v.view));
  const spectrumAxis = probeViews.find((v) => v.view.periods >= 2)?.view.fMHz ?? [];
  const seriesColour = (n: number) => `var(--series-${n + 1})`;

  return (
    <div className="page sandbox">
      <header className="page-header">
        <h1>Field sandbox</h1>
        <p className="muted">
          A two-dimensional world: draw conductors, dielectrics and sources, press play, and watch the waves go.
          {guide && (
            <>
              {' '}
              <a href={`#/guides/${guide.id}`}>How to use this</a>
            </>
          )}
        </p>
      </header>

      <div className="modeler">
        <aside className="panel">
          <section className="form-section">
            <h2>The world</h2>
            <label className="field" title={HINTS.startFrom}>
              <span className="field-label">Start from</span>
              <select className="preset-picker" value="" onChange={(e) => loadPreset(e.target.value)}>
                <option value="">a scene…</option>
                {PRESETS.map((p) => (
                  <option key={p.id} value={p.id} title={p.blurb}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <NumberField label="Frequency" value={scene.fMHz} above={0} unit="MHz" onCommit={setFrequency} hint={HINTS.frequency} />
            <label className="check" title={HINTS.scaleWithFrequency}>
              <input type="checkbox" checked={scene.scaleWithFrequency} onChange={(e) => setWorld({ scaleWithFrequency: e.target.checked })} /> Scale the scene with the frequency
            </label>
            <div className="field-row">
              <NumberField label="Width" value={scene.widthM} above={0} unit="m" onCommit={(v) => setWorld({ widthM: v })} hint={HINTS.width} />
              <NumberField label="Height" value={scene.heightM} above={0} unit="m" onCommit={(v) => setWorld({ heightM: v })} hint={HINTS.height} />
            </div>
            <NumberField label="Cells per wavelength" value={scene.cellsPerWavelength} min={4} integer onCommit={(v) => setWorld({ cellsPerWavelength: v })} hint={HINTS.cellsPerWavelength} />
            <label className="field" title={HINTS.polarisation}>
              <span className="field-label">Polarisation</span>
              <select className="polarisation-picker" value={scene.polarisation} onChange={(e) => setWorld({ polarisation: e.target.value as Polarisation })}>
                <option value="tm">Ez: E out of the screen</option>
                <option value="te">Hz: E in the picture</option>
              </select>
            </label>
            <p className="muted grid-note">
              λ = {(checks.lambdaM * 1000).toFixed(1)} mm · {grid.innerNx} × {grid.innerNy} cells of {(grid.dx * 1000).toFixed(2)} mm · Δt {(checks.dt * 1e12).toFixed(2)} ps
            </p>
          </section>

          <section className="form-section">
            <h2>Draw</h2>
            <div className="tool-buttons" role="group" aria-label="Drawing tool" title={HINTS.tools}>
              {TOOLS.map((t) => (
                <button key={t.id} type="button" className="small" aria-pressed={tool === t.id} title={t.hint} onClick={() => setTool(t.id)}>
                  {t.label}
                </button>
              ))}
            </div>
            <p className="muted">{TOOLS.find((t) => t.id === tool)?.hint}</p>
            {scene.sources.length > 0 && (
              <ul className="item-list source-list" aria-label="Sources" title={HINTS.sourceList}>
                {scene.sources.map((s, n) => (
                  <li key={s.id} className={s.id === selected ? 'is-selected' : undefined}>
                    <button type="button" className="item-pick" onClick={() => setSelected(s.id)} title="Select this source to edit it; its number is drawn beside it on the picture.">
                      <span className="item-number">{n + 1}</span>
                      <span className="item-text">
                        {s.x.toFixed(2)}, {s.y.toFixed(2)} m · {s.kind === 'pulse' ? 'one pulse' : `continuous, ${formatValue(s.amplitude)} ∠ ${formatValue(s.phaseDeg)}°`}
                      </span>
                    </button>
                    <button type="button" className="item-remove" onClick={() => dispatch({ type: 'edit', recipe: (sc) => removeItem(sc, s.id) })} aria-label={`Remove source ${n + 1}`} title="Remove this source.">
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {tool === 'dielectric' && !selectedShape && (
              <div className="field-row">
                <NumberField label="εr" value={newDielectric.epsr} min={1} onCommit={(v) => setNewDielectric((d) => ({ ...d, epsr: v }))} hint={HINTS.epsr} />
                <NumberField label="σ" value={newDielectric.sigma} min={0} unit="S/m" onCommit={(v) => setNewDielectric((d) => ({ ...d, sigma: v }))} hint={HINTS.sigma} />
              </div>
            )}
            {tool === 'source' && !selectedSource && (
              <SourceFields value={newSource} onChange={(p) => setNewSource((s) => ({ ...s, ...p }))} />
            )}
            {selectedShape && (
              <div className="selected-item">
                <p className="muted">
                  Selected: {selectedShape.material.kind === 'conductor' ? 'a conductor' : `a dielectric, εr ${selectedShape.material.epsr}`} ({selectedShape.geometry.kind})
                </p>
                {selectedShape.material.kind === 'dielectric' && (
                  <div className="field-row">
                    <NumberField label="εr" value={selectedShape.material.epsr} min={1} onCommit={(v) => dispatch({ type: 'edit', recipe: (s) => updateShape(s, selectedShape.id, { material: { ...selectedShape.material, epsr: v } }) })} hint={HINTS.shapeEpsr} />
                    <NumberField label="σ" value={selectedShape.material.sigma} min={0} unit="S/m" onCommit={(v) => dispatch({ type: 'edit', recipe: (s) => updateShape(s, selectedShape.id, { material: { ...selectedShape.material, sigma: v } }) })} hint={HINTS.shapeSigma} />
                  </div>
                )}
                {selectedShape.geometry.kind === 'line' && (
                  <NumberField label="Thickness" value={selectedShape.geometry.widthM} min={0} unit="m" onCommit={(v) => dispatch({ type: 'edit', recipe: (s) => updateShape(s, selectedShape.id, { geometry: { ...(selectedShape.geometry as Extract<Geometry, { kind: 'line' }>), widthM: v } }) })} hint={HINTS.thickness} />
                )}
                <button type="button" className="small" onClick={deleteSelected} title="Remove this object from the scene (Delete key).">
                  Delete it
                </button>
              </div>
            )}
            {selectedSource && (
              <div className="selected-item">
                <p className="muted">Selected: a source</p>
                <SourceFields value={selectedSource} onChange={(p) => dispatch({ type: 'edit', recipe: (s) => updateSource(s, selectedSource.id, p) })} />
                <button type="button" className="small" onClick={deleteSelected} title="Remove this source from the scene (Delete key).">
                  Delete it
                </button>
              </div>
            )}
            <div className="button-row">
              <button type="button" className="small" disabled={history.past.length === 0} onClick={() => dispatch({ type: 'undo' })} title="Take back the last edit (Ctrl+Z). A whole drag is one step.">
                Undo
              </button>
              <button type="button" className="small" disabled={history.future.length === 0} onClick={() => dispatch({ type: 'redo' })} title="Put back what Undo took away (Ctrl+Y).">
                Redo
              </button>
              <button type="button" className="small" disabled={scene.shapes.length + scene.sources.length === 0} onClick={() => dispatch({ type: 'edit', recipe: (s) => ({ ...s, shapes: [], sources: [] }) })} title="Remove every object and source. The world, the frequency and the plane wave stay; Undo brings it all back.">
                Clear
              </button>
            </div>
          </section>

          <section className="form-section plane-wave">
            <h2>Plane wave</h2>
            <label className="check" title={HINTS.planeWaveOn}>
              <input type="checkbox" checked={pw !== null} onChange={(e) => setPlaneWave(e.target.checked ? {} : null)} /> A plane wave comes in from outside
            </label>
            {pw && (
              <>
                <div className="field-row">
                  <label className="field" title={HINTS.planeWaveSide}>
                    <span className="field-label">From the</span>
                    <select value={pw.side} onChange={(e) => setPlaneWave({ side: e.target.value as Side })}>
                      {SIDES.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <NumberField label="Tilt" value={pw.angleDeg} unit="°" onCommit={(v) => setPlaneWave({ angleDeg: v })} hint={HINTS.planeWaveTilt} />
                </div>
                <div className="field-row">
                  <label className="field" title={HINTS.planeWaveKind}>
                    <span className="field-label">Wave</span>
                    <select value={pw.kind} onChange={(e) => setPlaneWave({ kind: e.target.value as SourceKind })}>
                      <option value="sine">Continuous</option>
                      <option value="pulse">One pulse</option>
                    </select>
                  </label>
                  <NumberField label="Amplitude" value={pw.amplitude} onCommit={(v) => setPlaneWave({ amplitude: v })} hint={HINTS.planeWaveAmplitude} />
                </div>
              </>
            )}
            <p className="muted">
              A wave from far away, filling the world from one side. Tilt is from square on, up to {MAX_PLANE_WAVE_ANGLE}°; it starts in empty space only.
            </p>
          </section>

          <section className="form-section">
            <h2>Run</h2>
            <div className="button-row run-buttons">
              <button type="button" className={running ? '' : 'primary'} onClick={() => setRunning((r) => !r)} title={HINTS.play}>
                {running ? 'Pause' : 'Play'}
              </button>
              <button type="button" className="small" onClick={stepOnce} disabled={running} title={HINTS.step}>
                Step ×10
              </button>
              <button type="button" className="small" onClick={reset} title={HINTS.reset}>
                Reset
              </button>
            </div>
            <div className="field-row">
              <label className="field" title={HINTS.speed}>
                <span className="field-label">Speed</span>
                <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                  {SPEEDS.map((s) => (
                    <option key={s} value={s}>
                      {s} step{s > 1 ? 's' : ''} a frame
                    </option>
                  ))}
                </select>
              </label>
              <label className="field" title={HINTS.show}>
                <span className="field-label">Show</span>
                <select value={mode} onChange={(e) => setMode(e.target.value as PaintMode)}>
                  <option value="field">The field, {name}</option>
                  <option value="envelope">Its envelope</option>
                </select>
              </label>
            </div>
            <NumberField label="Contrast" value={contrast} min={1} onCommit={setContrast} hint={HINTS.contrast} />
          </section>
        </aside>

        <div className="workspace">
          <figure className="field-figure">
            <canvas
              ref={canvasRef}
              className={`field-canvas tool-${tool}`}
              style={{ aspectRatio: `${scene.widthM} / ${scene.heightM}` }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              aria-label="The field, painted over the world"
            />
            <figcaption className="field-legend">
              <span className="legend-swatch legend-negative" aria-hidden="true" /> {name} negative <span className="legend-swatch legend-positive" aria-hidden="true" /> positive ·{' '}
              <span className="legend-swatch legend-conductor" aria-hidden="true" /> conductor · dielectric tinted · {scene.widthM} × {scene.heightM} m, {(scene.widthM / checks.lambdaM).toFixed(1)} ×{' '}
              {(scene.heightM / checks.lambdaM).toFixed(1)} wavelengths
            </figcaption>
          </figure>

          <dl className="summary field-status">
            <div title={HINTS.statusTime}>
              <dt>Time</dt>
              <dd>
                {(status.timeS * 1e9).toFixed(2)} ns<small>{(status.timeS / periodS).toFixed(1)} periods, step {status.step}</small>
              </dd>
            </div>
            <div title={HINTS.statusPeak}>
              <dt>Peak |{name}|</dt>
              <dd>
                {status.peak.toPrecision(3)}
                <small>relative to a source of 1</small>
              </dd>
            </div>
            <div title={HINTS.statusSpeed}>
              <dt>Speed</dt>
              <dd>
                {status.stepsPerSecond > 0 ? `${status.stepsPerSecond} steps/s` : running ? '…' : 'paused'}
                <small>{(grid.nx * grid.ny).toLocaleString()} cells including the absorbing edge</small>
              </dd>
            </div>
          </dl>

          {checks.notes.length > 0 && (
            <ul className="issues">
              {checks.notes.map((n) => (
                <li key={n.message} className={`issue issue-${n.severity}`}>
                  <span className="issue-mark" aria-hidden="true">
                    {n.severity === 'error' ? '✕' : '!'}
                  </span>
                  <span className="issue-text">{n.message}</span>
                </li>
              ))}
            </ul>
          )}

          {probes.length > 0 && (
            <section className="probe-charts" aria-label="The probes">
              <div className="probe-head">
                <h2>At the probes</h2>
                <p className="muted">
                  {probeViews.length === 0 ? (running ? 'Recording…' : 'Press Play to record.') : `${Math.max(...probeViews.map((v) => v.view.periods)).toFixed(0)} periods recorded`}
                  {probes.length >= MAX_PROBES ? ` · ${MAX_PROBES} is the most` : ''}
                </p>
                <button type="button" className="small" onClick={() => setProbes([])} title="Take every probe off the picture and close these charts.">
                  Remove all
                </button>
              </div>
              <ul className="item-list probe-list" aria-label="Probes" title={HINTS.probeList}>
                {probes.map((p, n) => {
                  const view = probeData.get(p.id);
                  const inside = cellOf(raster.grid, p.x, p.y) !== undefined;
                  return (
                    <li key={p.id}>
                      <span className="item-number" style={{ background: seriesColour(n) }}>{n + 1}</span>
                      <span className="item-text">
                        {p.x.toFixed(2)}, {p.y.toFixed(2)} m ·{' '}
                        {!inside ? 'outside the world' : !view ? 'nothing yet' : view.peakMHz !== undefined ? `strongest at ${view.peakMHz.toPrecision(4)} MHz` : 'silent so far'}
                      </span>
                      <button type="button" className="item-remove" onClick={() => removeProbe(p.id)} aria-label={`Remove probe ${n + 1}`} title="Take this probe off the picture.">
                        ×
                      </button>
                    </li>
                  );
                })}
              </ul>
              {probeViews.length > 0 && (
                <>
                  <XYChart
                    title={`${name} against time`}
                    unit="relative"
                    xLabel="ns"
                    xTitle="Time, ns"
                    x={traceAxis}
                    series={probeViews.map(({ n, view }) => ({ label: `Probe ${n + 1}`, colour: seriesColour(n), values: view.trace, x: view.timeNs }))}
                    format={(v) => v.toFixed(3)}
                    xFormat={(v) => v.toFixed(2)}
                    hover={traceHover}
                    onHover={setTraceHover}
                  />
                  {spectrumAxis.length > 0 ? (
                    <XYChart
                      title={probeViews.length > 1 ? 'Their spectra' : 'Its spectrum'}
                      unit={probeViews.length > 1 ? 'dB below the strongest of any probe' : 'dB below the strongest'}
                      xLabel="MHz"
                      xTitle="Frequency, MHz"
                      x={spectrumAxis}
                      series={probeViews.map(({ n }, i) => ({ label: `Probe ${n + 1}`, colour: seriesColour(n), values: spectrumLevels[i]! }))}
                      format={(v) => v.toFixed(1)}
                      xFormat={(v) => Number(v.toPrecision(4)).toString()}
                      floor={-60}
                      hover={spectrumHover}
                      onHover={setSpectrumHover}
                    />
                  ) : (
                    <p className="muted">The spectrum needs at least two periods of recording.</p>
                  )}
                </>
              )}
            </section>
          )}

          <p className="muted">
            This is a cross-section: everything drawn is infinitely long into the screen, so a dot is a wire end-on and a line is a sheet.{' '}
            {scene.polarisation === 'te'
              ? 'Hz points out of the screen and E lies in the picture - with a ground along the bottom, vertical polarisation. A source here is a magnetic line current, like a long slot seen end-on.'
              : 'Ez points out of the screen - with a ground along the bottom, horizontal polarisation.'}{' '}
            The edges absorb. Fields are relative to the source, not volts per metre.
          </p>
        </div>
      </div>
    </div>
  );
}

function SourceFields({ value, onChange }: { value: Pick<Source, 'kind' | 'amplitude' | 'phaseDeg'>; onChange: (p: Partial<Pick<Source, 'kind' | 'amplitude' | 'phaseDeg'>>) => void }) {
  return (
    <>
      <label className="field" title={HINTS.sourceKind}>
        <span className="field-label">Source</span>
        <select value={value.kind} onChange={(e) => onChange({ kind: e.target.value as SourceKind })}>
          <option value="sine">Continuous, at the frequency above</option>
          <option value="pulse">One pulse</option>
        </select>
      </label>
      <div className="field-row">
        <NumberField label="Amplitude" value={value.amplitude} onCommit={(v) => onChange({ amplitude: v })} hint={HINTS.sourceAmplitude} />
        <NumberField label="Phase" value={value.phaseDeg} unit="°" onCommit={(v) => onChange({ phaseDeg: v })} hint={HINTS.sourcePhase} />
      </div>
    </>
  );
}
