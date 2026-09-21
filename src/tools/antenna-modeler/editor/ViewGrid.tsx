// The editor: front, left and top views in first-angle projection, plus the 3-D view,
// sharing one camera, one tool and one selection.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HistoryAction } from '../history';
import { type AntennaModel, deleteWire, highestFrequencyMHz, wavelengthM } from '../model';
import { ContextMenu, type MenuState } from './ContextMenu';
import { type CursorReadout, EditorContext, type EditorApi, type Overlay, type Tool } from './context';
import { OrthoView } from './OrthoView';
import { type Camera, type Plane, PLANES, type Size, fitCamera, formatLength, gridStep } from './projection';
import { type Scene, scenePoints } from './scene';
import { View3D } from './View3D';

export interface ViewGridProps {
  scene: Scene;
  /** Undefined when the geometry is read-only. */
  model: AntennaModel | undefined;
  dispatch: (action: HistoryAction) => void;
  canUndo: boolean;
  canRedo: boolean;
  selection: string | null;
  onSelect: (wireId: string | null) => void;
  /** Change it to re-fit the views (a new model was loaded). */
  fitKey: number;
  newWireRadius: number;
}

const VIEW_HINT: Record<Plane, string> = {
  front: 'looking along +Y',
  left: 'from the left, looking along +X',
  top: 'looking down',
};

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** ISO first-angle projection symbol: a truncated cone, and to its right the view from its left. */
function FirstAngleSymbol() {
  return (
    <svg className="projection-symbol" viewBox="0 0 48 26" role="img" aria-label="First-angle projection">
      <title>First-angle projection (ISO 128, SANS 10111)</title>
      <polygon points="3,9 21,4 21,22 3,17" />
      <circle cx="36" cy="13" r="9" />
      <circle cx="36" cy="13" r="4.5" />
      <line x1="1" y1="13" x2="47" y2="13" className="centre-line" />
      <line x1="36" y1="2" x2="36" y2="24" className="centre-line" />
    </svg>
  );
}

export function ViewGrid(props: ViewGridProps) {
  const { scene, model, dispatch, selection, onSelect, fitKey } = props;
  const [camera, setCameraState] = useState<Camera>({ center: { x: 0, y: 0, z: 0 }, scale: 20 });
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const [tool, setToolState] = useState<Tool>({ kind: 'select' });
  const [overlay, setOverlay] = useState<Overlay>({});
  const [cursor, setCursor] = useState<CursorReadout | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [snap, setSnap] = useState(true);
  const cell = useRef<HTMLDivElement>(null);

  // Every view is the same size, so rows and columns line up; measure one.
  useEffect(() => {
    const el = cell.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize((s) => (Math.abs(s.width - width) < 0.5 && Math.abs(s.height - height) < 0.5 ? s : { width, height }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const fallbackSpan = model ? wavelengthM(highestFrequencyMHz(model.frequency)) / 2 : 10;
  const fit = useCallback(() => {
    setCameraState(fitCamera(scenePoints(scene), size, fallbackSpan));
  }, [scene, size, fallbackSpan]);

  // Fit once the views have a size, and whenever a different model is loaded.
  const fitted = useRef<string>('');
  useEffect(() => {
    if (size.width === 0) return;
    const key = `${fitKey}`;
    if (fitted.current === key) return;
    fitted.current = key;
    fit();
  }, [fitKey, size, fit]);

  const setTool = useCallback((next: Tool) => {
    setToolState(next);
    if (next.kind === 'select') setOverlay({});
  }, []);

  const setCamera = useCallback((update: (c: Camera) => Camera) => setCameraState(update), []);
  const closeMenu = useCallback(() => setMenu(null), []);

  // Read-only geometry can't be drawn on.
  useEffect(() => {
    if (!scene.editable) setTool({ kind: 'select' });
  }, [scene.editable, setTool]);

  const selectedRadius = model?.wires.find((w) => w.id === selection)?.radius;
  const api: EditorApi = useMemo(
    () => ({
      scene,
      model: scene.editable ? model : undefined,
      dispatch,
      selection,
      select: onSelect,
      camera,
      setCamera,
      size,
      snap,
      tool,
      setTool,
      overlay,
      setOverlay,
      setCursor,
      openMenu: setMenu,
      fit,
      newWireRadius: selectedRadius ?? props.newWireRadius,
    }),
    [scene, model, dispatch, selection, onSelect, camera, setCamera, size, snap, tool, setTool, overlay, fit, selectedRadius, props.newWireRadius],
  );

  // Keyboard shortcuts, unless the user is typing somewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || menu) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: 'undo' });
      } else if (ctrl && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault();
        dispatch({ type: 'redo' });
      } else if (e.key === 'Escape') {
        if (tool.kind === 'draw') setTool({ kind: 'select' });
        else onSelect(null);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selection && scene.editable) {
        e.preventDefault();
        const id = selection;
        dispatch({ type: 'edit', recipe: (m) => deleteWire(m, id) });
        onSelect(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch, menu, onSelect, scene.editable, selection, setTool, tool.kind]);

  const drawing = tool.kind === 'draw';
  const hint = !scene.editable
    ? 'This deck is shown read-only; it uses cards the visual editor cannot edit yet.'
    : drawing
      ? tool.from
        ? 'Click to end this wire and start the next · Esc or right-click to stop'
        : 'Click where the wire starts'
      : 'Drag wires or their ends · Shift: detach from joined wires · Alt: no snapping · Right-click for more';

  return (
    <EditorContext.Provider value={api}>
      <section className="editor" aria-label="Antenna geometry">
        <div className="editor-toolbar">
          <button type="button" onClick={() => dispatch({ type: 'undo' })} disabled={!props.canUndo} title="Undo (Ctrl+Z)">
            Undo
          </button>
          <button type="button" onClick={() => dispatch({ type: 'redo' })} disabled={!props.canRedo} title="Redo (Ctrl+Y)">
            Redo
          </button>
          <span className="toolbar-gap" />
          <button
            type="button"
            className={drawing ? 'toggle-on' : undefined}
            aria-pressed={drawing}
            disabled={!scene.editable}
            onClick={() => setTool(drawing ? { kind: 'select' } : { kind: 'draw', from: null })}
          >
            Draw wires
          </button>
          <button type="button" onClick={fit}>
            Fit
          </button>
          <label className="check">
            <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} /> Snap to grid
          </label>
          <span className="muted grid-readout">grid {formatLength(gridStep(camera))}</span>
          <span className="muted cursor-readout">
            {cursor
              ? `${PLANES[cursor.plane].u.toUpperCase()} ${formatLength(cursor.point[PLANES[cursor.plane].u])} · ${PLANES[cursor.plane].v.toUpperCase()} ${formatLength(cursor.point[PLANES[cursor.plane].v])}`
              : ''}
          </span>
          <span className="toolbar-spacer" />
          <FirstAngleSymbol />
        </div>

        <div className="view-grid">
          {(['front', 'left', 'top'] as const).map((plane) => (
            <div key={plane} className="view-cell">
              <div className="view-caption">
                <strong>{PLANES[plane].title}</strong> <span>{VIEW_HINT[plane]}</span>
              </div>
              <div className="view-frame" ref={plane === 'front' ? cell : undefined}>
                {size.width > 0 && <OrthoView plane={plane} />}
              </div>
            </div>
          ))}
          <div className="view-cell">
            <div className="view-caption">
              <strong>3-D</strong> <span>drag to turn</span>
            </div>
            <div className="view-frame">
              {size.width > 0 && <View3D scene={scene} size={size} selection={selection} onSelect={onSelect} />}
            </div>
          </div>
        </div>

        <p className="editor-hint muted">
          {hint}
          {scene.showsCurrent && (
            <span className="legend">
              {' '}· current: <span className="swatch swatch-low" /> low <span className="swatch swatch-high" /> high{' '}
              <span className="swatch swatch-feed" /> feed
            </span>
          )}
        </p>
        {menu && <ContextMenu menu={menu} onClose={closeMenu} />}
      </section>
    </EditorContext.Provider>
  );
}
