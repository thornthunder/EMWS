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
import { NumberField } from '../../ui/NumberField';
import { XYChart } from '../../ui/XYChart';
import { type PaintMode, type Rgb, paintField, parseCssColour } from './colour';
import { PRESETS, presetById } from './presets';
import { type ProbeRecord, type ProbeView, newProbeRecord, probeView, recordProbe } from './probe';
import {
  CONDUCTOR,
  COURANT,
  type Geometry,
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
} from './scene';
import { type FieldEngine, type Polarisation, type Side, type SourceKind, makeEngine, planeWaveDirection } from './simulation';

type Tool = 'conductor' | 'dielectric' | 'source' | 'probe' | 'select';

const TOOLS: { id: Tool; label: string; hint: string }[] = [
  { id: 'conductor', label: 'Conductor', hint: 'Drag to draw a conducting sheet, seen edge-on.' },
  { id: 'dielectric', label: 'Dielectric', hint: 'Drag a rectangle of insulating material.' },
  { id: 'source', label: 'Source', hint: 'Click where a wave should start.' },
  { id: 'probe', label: 'Probe', hint: 'Click a point to watch the field there against time, with its spectrum. Moving it does not restart the clock.' },
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
  const [probe, setProbe] = useState<{ x: number; y: number } | undefined>();
  const [probeData, setProbeData] = useState<ProbeView | undefined>();
  const [traceHover, setTraceHover] = useState<number | undefined>();
  const [spectrumHover, setSpectrumHover] = useState<number | undefined>();

  const raster = useMemo(() => rasterise(scene), [scene]);
  const checks = useMemo(() => limits(scene, raster), [scene, raster]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<FieldEngine | null>(null);
  const probeRef = useRef<ProbeRecord | null>(null);
  const envelopeRef = useRef<Float32Array>(new Float32Array(0));
  const scaleRef = useRef(0);
  const drag = useRef<{ kind: 'draw'; id?: string; x: number; y: number } | { kind: 'move'; id: string; x: number; y: number } | null>(null);
  const offscreen = useRef<HTMLCanvasElement | null>(null);
  const runningRef = useRef(running);
  runningRef.current = running;
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

  // The probe records from where the clock is now; a new engine or a moved probe starts afresh.
  const probeCell = useMemo(() => (probe ? cellOf(raster.grid, probe.x, probe.y) : undefined), [probe, raster]);
  useEffect(() => {
    probeRef.current = probeCell ? newProbeRecord(probeCell.i + probeCell.j * raster.grid.nx, simRef.current?.step ?? 0) : null;
    probeCountRef.current = -1;
    setProbeData(undefined);
  }, [probeCell, raster]);

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
    for (const source of scene.sources) {
      ctx.beginPath();
      ctx.arc(px(source.x), py(source.y), 5 * dpr, 0, 2 * Math.PI);
      ctx.fillStyle = `rgb(${ink.join(',')})`;
      ctx.fill();
      ctx.strokeStyle = `rgb(${surface.join(',')})`;
      ctx.stroke();
    }
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
    // The probe: a ringed cross.
    if (probe) {
      const cx = px(probe.x);
      const cy = py(probe.y);
      ctx.strokeStyle = `rgb(${accent.join(',')})`;
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.arc(cx, cy, 7 * dpr, 0, 2 * Math.PI);
      ctx.moveTo(cx - 11 * dpr, cy);
      ctx.lineTo(cx + 11 * dpr, cy);
      ctx.moveTo(cx, cy - 11 * dpr);
      ctx.lineTo(cx, cy + 11 * dpr);
      ctx.stroke();
    }
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
  }, [raster, scene, selected, mode, contrast, probe]);

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
        const record = probeRef.current;
        for (let s = 0; s < speed; s++) {
          sim.advance();
          for (let k = 0; k < env.length; k++) {
            const v = Math.abs(field[k]!);
            const held = env[k]! * ENVELOPE_DECAY;
            env[k] = v > held ? v : held;
          }
          if (record) recordProbe(record, field);
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
        const record = probeRef.current;
        if (record && record.count !== probeCountRef.current) {
          probeCountRef.current = record.count;
          setProbeData(probeView(record, sim.dt, fHzRef.current));
        }
        lastReport = now;
        stepsSince = 0;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [paint, speed]);

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
      if (x >= 0 && y >= 0 && x < scene.widthM && y < scene.heightM) setProbe({ x, y });
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
    if (!drag.current) return;
    drag.current = null;
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
  const loadPreset = (id: string) => {
    const preset = presetById(id);
    if (!preset) return;
    dispatch({ type: 'load', model: preset.scene() });
    setSelected(undefined);
    setRunning(true);
  };
  const stepOnce = () => {
    const sim = simRef.current;
    if (!sim) return;
    const record = probeRef.current;
    for (let s = 0; s < 10; s++) {
      sim.advance();
      if (record) recordProbe(record, sim.field);
    }
    setStatus({ step: sim.step, timeS: sim.time, peak: sim.peak(), stepsPerSecond: 0 });
    if (record) setProbeData(probeView(record, sim.dt, scene.fMHz * 1e6));
  };
  const reset = () => {
    simRef.current?.reset();
    envelopeRef.current.fill(0);
    scaleRef.current = 0;
    if (probeRef.current) probeRef.current = newProbeRecord(probeRef.current.k, 0);
    probeCountRef.current = -1;
    setProbeData(undefined);
    setStatus({ step: 0, timeS: 0, peak: 0, stepsPerSecond: 0 });
  };
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
            <label className="field">
              <span className="field-label">Start from</span>
              <select className="preset-picker" value="" onChange={(e) => loadPreset(e.target.value)}>
                <option value="">a scene…</option>
                {PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <NumberField label="Frequency" value={scene.fMHz} above={0} unit="MHz" onCommit={(v) => setWorld({ fMHz: v })} />
            <div className="field-row">
              <NumberField label="Width" value={scene.widthM} above={0} unit="m" onCommit={(v) => setWorld({ widthM: v })} />
              <NumberField label="Height" value={scene.heightM} above={0} unit="m" onCommit={(v) => setWorld({ heightM: v })} />
            </div>
            <NumberField label="Cells per wavelength" value={scene.cellsPerWavelength} min={4} integer onCommit={(v) => setWorld({ cellsPerWavelength: v })} />
            <label className="field">
              <span className="field-label">Out of the screen</span>
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
            <div className="tool-buttons" role="group" aria-label="Drawing tool">
              {TOOLS.map((t) => (
                <button key={t.id} type="button" className="small" aria-pressed={tool === t.id} title={t.hint} onClick={() => setTool(t.id)}>
                  {t.label}
                </button>
              ))}
            </div>
            <p className="muted">{TOOLS.find((t) => t.id === tool)?.hint}</p>
            {tool === 'dielectric' && !selectedShape && (
              <div className="field-row">
                <NumberField label="εr" value={newDielectric.epsr} min={1} onCommit={(v) => setNewDielectric((d) => ({ ...d, epsr: v }))} />
                <NumberField label="σ" value={newDielectric.sigma} min={0} unit="S/m" onCommit={(v) => setNewDielectric((d) => ({ ...d, sigma: v }))} />
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
                    <NumberField label="εr" value={selectedShape.material.epsr} min={1} onCommit={(v) => dispatch({ type: 'edit', recipe: (s) => updateShape(s, selectedShape.id, { material: { ...selectedShape.material, epsr: v } }) })} />
                    <NumberField label="σ" value={selectedShape.material.sigma} min={0} unit="S/m" onCommit={(v) => dispatch({ type: 'edit', recipe: (s) => updateShape(s, selectedShape.id, { material: { ...selectedShape.material, sigma: v } }) })} />
                  </div>
                )}
                {selectedShape.geometry.kind === 'line' && (
                  <NumberField label="Thickness" value={selectedShape.geometry.widthM} min={0} unit="m" onCommit={(v) => dispatch({ type: 'edit', recipe: (s) => updateShape(s, selectedShape.id, { geometry: { ...(selectedShape.geometry as Extract<Geometry, { kind: 'line' }>), widthM: v } }) })} />
                )}
                <button type="button" className="small" onClick={deleteSelected}>
                  Delete it
                </button>
              </div>
            )}
            {selectedSource && (
              <div className="selected-item">
                <p className="muted">Selected: a source</p>
                <SourceFields value={selectedSource} onChange={(p) => dispatch({ type: 'edit', recipe: (s) => updateSource(s, selectedSource.id, p) })} />
                <button type="button" className="small" onClick={deleteSelected}>
                  Delete it
                </button>
              </div>
            )}
            <div className="button-row">
              <button type="button" className="small" disabled={history.past.length === 0} onClick={() => dispatch({ type: 'undo' })} title="Ctrl+Z">
                Undo
              </button>
              <button type="button" className="small" disabled={history.future.length === 0} onClick={() => dispatch({ type: 'redo' })} title="Ctrl+Y">
                Redo
              </button>
              <button type="button" className="small" disabled={scene.shapes.length + scene.sources.length === 0} onClick={() => dispatch({ type: 'edit', recipe: (s) => ({ ...s, shapes: [], sources: [] }) })}>
                Clear
              </button>
            </div>
          </section>

          <section className="form-section plane-wave">
            <h2>Plane wave</h2>
            <label className="check">
              <input type="checkbox" checked={pw !== null} onChange={(e) => setPlaneWave(e.target.checked ? {} : null)} /> A plane wave comes in from outside
            </label>
            {pw && (
              <>
                <div className="field-row">
                  <label className="field">
                    <span className="field-label">From the</span>
                    <select value={pw.side} onChange={(e) => setPlaneWave({ side: e.target.value as Side })}>
                      {SIDES.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <NumberField label="Tilt" value={pw.angleDeg} unit="°" onCommit={(v) => setPlaneWave({ angleDeg: v })} />
                </div>
                <div className="field-row">
                  <label className="field">
                    <span className="field-label">Wave</span>
                    <select value={pw.kind} onChange={(e) => setPlaneWave({ kind: e.target.value as SourceKind })}>
                      <option value="sine">Continuous</option>
                      <option value="pulse">One pulse</option>
                    </select>
                  </label>
                  <NumberField label="Amplitude" value={pw.amplitude} onCommit={(v) => setPlaneWave({ amplitude: v })} />
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
              <button type="button" className={running ? '' : 'primary'} onClick={() => setRunning((r) => !r)} title="Space">
                {running ? 'Pause' : 'Play'}
              </button>
              <button type="button" className="small" onClick={stepOnce} disabled={running}>
                Step ×10
              </button>
              <button type="button" className="small" onClick={reset}>
                Reset
              </button>
            </div>
            <div className="field-row">
              <label className="field">
                <span className="field-label">Speed</span>
                <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                  {SPEEDS.map((s) => (
                    <option key={s} value={s}>
                      {s} step{s > 1 ? 's' : ''} a frame
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">Show</span>
                <select value={mode} onChange={(e) => setMode(e.target.value as PaintMode)}>
                  <option value="field">The field, {name}</option>
                  <option value="envelope">Its envelope</option>
                </select>
              </label>
            </div>
            <NumberField label="Contrast" value={contrast} min={1} onCommit={setContrast} />
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
            <div>
              <dt>Time</dt>
              <dd>
                {(status.timeS * 1e9).toFixed(2)} ns<small>{(status.timeS / periodS).toFixed(1)} periods, step {status.step}</small>
              </dd>
            </div>
            <div>
              <dt>Peak |{name}|</dt>
              <dd>
                {status.peak.toPrecision(3)}
                <small>relative to a source of 1</small>
              </dd>
            </div>
            <div>
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

          {probe && (
            <section className="probe-charts" aria-label="The probe">
              <div className="probe-head">
                <h2>At the probe</h2>
                <p className="muted">
                  {probeData
                    ? `${probeData.periods.toFixed(0)} periods recorded${probeData.peakMHz !== undefined ? ` · strongest at ${probeData.peakMHz.toPrecision(4)} MHz` : ' · silent so far'}`
                    : probeCell
                      ? running
                        ? 'Recording…'
                        : 'Press Play to record.'
                      : 'The probe is outside the world.'}
                </p>
                <button type="button" className="small" onClick={() => setProbe(undefined)}>
                  Remove the probe
                </button>
              </div>
              {probeData && (
                <>
                  <XYChart
                    title={`${name} against time`}
                    unit="relative"
                    xLabel="ns"
                    xTitle="Time, ns"
                    x={probeData.timeNs}
                    series={[{ label: name, colour: 'var(--series-2)', values: probeData.trace }]}
                    format={(v) => v.toFixed(3)}
                    xFormat={(v) => v.toFixed(2)}
                    hover={traceHover}
                    onHover={setTraceHover}
                  />
                  {probeData.periods >= 2 ? (
                    <XYChart
                      title="Its spectrum"
                      unit="dB below the strongest"
                      xLabel="MHz"
                      xTitle="Frequency, MHz"
                      x={probeData.fMHz}
                      series={[{ label: 'Level', colour: 'var(--series-1)', values: probeData.levelDb }]}
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
      <label className="field">
        <span className="field-label">Source</span>
        <select value={value.kind} onChange={(e) => onChange({ kind: e.target.value as SourceKind })}>
          <option value="sine">Continuous, at the frequency above</option>
          <option value="pulse">One pulse</option>
        </select>
      </label>
      <div className="field-row">
        <NumberField label="Amplitude" value={value.amplitude} onCommit={(v) => onChange({ amplitude: v })} />
        <NumberField label="Phase" value={value.phaseDeg} unit="°" onCommit={(v) => onChange({ phaseDeg: v })} />
      </div>
    </>
  );
}
