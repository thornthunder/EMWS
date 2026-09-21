// What the three orthographic views share: one camera, one tool, one rubber band.

import { createContext, useContext } from 'react';
import type { Vec3 } from '../../../engine/nec2/types';
import type { HistoryAction } from '../history';
import type { AntennaModel } from '../model';
import type { MenuState } from './ContextMenu';
import type { Camera, Plane, Size } from './projection';
import type { Scene } from './scene';

export type Tool =
  | { kind: 'select' }
  /** Drawing wires: `from` is where the next wire starts, once the first point is placed. */
  | { kind: 'draw'; from: Vec3 | null };

/** Transient drawing shown in every view at once. */
export interface Overlay {
  /** Wire being drawn. */
  rubberBand?: { from: Vec3; to: Vec3 };
  /** An existing wire end the pointer has snapped to. */
  snapTo?: Vec3;
}

export interface CursorReadout {
  plane: Plane;
  point: Vec3;
}

export interface EditorApi {
  scene: Scene;
  /** Undefined when the geometry is read-only. */
  model: AntennaModel | undefined;
  dispatch: (action: HistoryAction) => void;
  selection: string | null;
  select: (wireId: string | null) => void;
  camera: Camera;
  setCamera: (update: (camera: Camera) => Camera) => void;
  size: Size;
  snap: boolean;
  tool: Tool;
  setTool: (tool: Tool) => void;
  overlay: Overlay;
  setOverlay: (overlay: Overlay) => void;
  setCursor: (cursor: CursorReadout | null) => void;
  openMenu: (menu: MenuState) => void;
  fit: () => void;
  /** Radius for newly drawn wires. */
  newWireRadius: number;
}

export const EditorContext = createContext<EditorApi | null>(null);

export function useEditor(): EditorApi {
  const api = useContext(EditorContext);
  if (!api) throw new Error('useEditor() outside <ViewGrid>');
  return api;
}
