// What the field sandbox is a picture of: a rectangular world in metres with conductors,
// dielectrics and sources drawn in it, and how that becomes cells for the engine.
//
// The scene is the source of truth, as the AntennaModel is in the modeler: every edit is a
// pure function returning a new scene, and the grid is derived from it. World coordinates
// are metres with y up; the PML sits outside the world, so nothing drawn can touch it.

import { C0, type SourceCell, type SourceKind } from './simulation';

export type MaterialKind = 'conductor' | 'dielectric';

export interface Material {
  kind: MaterialKind;
  /** Relative permittivity; ignored for a conductor. */
  epsr: number;
  /** Conductivity, S/m; ignored for a conductor. */
  sigma: number;
}

export type Geometry =
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; widthM: number }
  | { kind: 'rect'; x: number; y: number; w: number; h: number }
  | { kind: 'disc'; cx: number; cy: number; r: number };

export interface Shape {
  id: string;
  geometry: Geometry;
  material: Material;
}

export interface Source {
  id: string;
  x: number;
  y: number;
  kind: SourceKind;
  amplitude: number;
  phaseDeg: number;
}

export interface Scene {
  fMHz: number;
  widthM: number;
  heightM: number;
  cellsPerWavelength: number;
  pmlCells: number;
  shapes: Shape[];
  sources: Source[];
}

export const CONDUCTOR: Material = { kind: 'conductor', epsr: 1, sigma: 0 };

export function dielectric(epsr: number, sigma = 0): Material {
  return { kind: 'dielectric', epsr, sigma };
}

let counter = 0;
const prefix = Date.now().toString(36);
export function sceneId(kind: string): string {
  counter += 1;
  return `${kind}-${prefix}-${counter}`;
}

/** Three metres by two at 1 GHz: ten wavelengths by six or so, at 20 cells a wavelength. */
export function emptyScene(): Scene {
  return { fMHz: 1000, widthM: 3, heightM: 2, cellsPerWavelength: 20, pmlCells: 10, shapes: [], sources: [] };
}

export interface Grid {
  nx: number;
  ny: number;
  /** Cell size, metres. */
  dx: number;
  pml: number;
  /** Cells across the world itself, inside the PML. */
  innerNx: number;
  innerNy: number;
}

export function wavelengthM(scene: Scene): number {
  return C0 / (scene.fMHz * 1e6);
}

export function gridFor(scene: Scene): Grid {
  const dx = wavelengthM(scene) / scene.cellsPerWavelength;
  const innerNx = Math.max(8, Math.round(scene.widthM / dx));
  const innerNy = Math.max(8, Math.round(scene.heightM / dx));
  const pml = Math.max(0, Math.floor(scene.pmlCells));
  return { nx: innerNx + 2 * pml, ny: innerNy + 2 * pml, dx, pml, innerNx, innerNy };
}

/** The cell under a point of the world, or undefined outside it. */
export function cellOf(grid: Grid, x: number, y: number): { i: number; j: number } | undefined {
  const ci = Math.floor(x / grid.dx);
  const cj = Math.floor(y / grid.dx);
  if (ci < 0 || cj < 0 || ci >= grid.innerNx || cj >= grid.innerNy) return undefined;
  return { i: ci + grid.pml, j: cj + grid.pml };
}

/** World position of a cell's centre. */
export function cellCentre(grid: Grid, i: number, j: number): { x: number; y: number } {
  return { x: (i - grid.pml + 0.5) * grid.dx, y: (j - grid.pml + 0.5) * grid.dx };
}

export function distanceToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length2 = dx * dx + dy * dy;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / length2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Whether a point is inside a geometry; a line counts as at least one cell wide. */
export function contains(geometry: Geometry, x: number, y: number, minWidthM: number): boolean {
  switch (geometry.kind) {
    case 'line':
      return distanceToSegment(x, y, geometry.x1, geometry.y1, geometry.x2, geometry.y2) <= Math.max(geometry.widthM, minWidthM) / 2;
    case 'rect': {
      const x0 = Math.min(geometry.x, geometry.x + geometry.w);
      const x1 = Math.max(geometry.x, geometry.x + geometry.w);
      const y0 = Math.min(geometry.y, geometry.y + geometry.h);
      const y1 = Math.max(geometry.y, geometry.y + geometry.h);
      return x >= x0 && x < x1 && y >= y0 && y < y1;
    }
    case 'disc':
      return Math.hypot(x - geometry.cx, y - geometry.cy) <= geometry.r;
  }
}

export interface Raster {
  grid: Grid;
  epsr: Float32Array;
  sigma: Float32Array;
  pec: Uint8Array;
  sources: SourceCell[];
}

/** Paints the scene's shapes into per-cell materials, later shapes over earlier ones. */
export function rasterise(scene: Scene): Raster {
  const grid = gridFor(scene);
  const { nx, ny, pml, dx } = grid;
  const n = nx * ny;
  const epsr = new Float32Array(n).fill(1);
  const sigma = new Float32Array(n);
  const pec = new Uint8Array(n);
  for (let j = pml; j < ny - pml; j++) {
    for (let i = pml; i < nx - pml; i++) {
      const { x, y } = cellCentre(grid, i, j);
      const k = i + j * nx;
      for (const shape of scene.shapes) {
        if (!contains(shape.geometry, x, y, dx)) continue;
        if (shape.material.kind === 'conductor') {
          pec[k] = 1;
          epsr[k] = 1;
          sigma[k] = 0;
        } else {
          pec[k] = 0;
          epsr[k] = Math.max(1, shape.material.epsr);
          sigma[k] = Math.max(0, shape.material.sigma);
        }
      }
    }
  }
  const sources: SourceCell[] = [];
  for (const source of scene.sources) {
    const cell = cellOf(grid, source.x, source.y);
    if (!cell) continue;
    sources.push({ ...cell, kind: source.kind, fHz: scene.fMHz * 1e6, amplitude: source.amplitude, phaseRad: (source.phaseDeg * Math.PI) / 180 });
  }
  return { grid, epsr, sigma, pec, sources };
}

// ---- editing ----

export function addShape(scene: Scene, geometry: Geometry, material: Material): { scene: Scene; id: string } {
  const id = sceneId('shape');
  return { scene: { ...scene, shapes: [...scene.shapes, { id, geometry, material }] }, id };
}

export function addSource(scene: Scene, x: number, y: number, kind: SourceKind = 'sine', amplitude = 1, phaseDeg = 0): { scene: Scene; id: string } {
  const id = sceneId('source');
  return { scene: { ...scene, sources: [...scene.sources, { id, x, y, kind, amplitude, phaseDeg }] }, id };
}

export function updateShape(scene: Scene, id: string, patch: Partial<Omit<Shape, 'id'>>): Scene {
  return { ...scene, shapes: scene.shapes.map((s) => (s.id === id ? { ...s, ...patch } : s)) };
}

export function updateSource(scene: Scene, id: string, patch: Partial<Omit<Source, 'id'>>): Scene {
  return { ...scene, sources: scene.sources.map((s) => (s.id === id ? { ...s, ...patch } : s)) };
}

export function removeItem(scene: Scene, id: string): Scene {
  return { ...scene, shapes: scene.shapes.filter((s) => s.id !== id), sources: scene.sources.filter((s) => s.id !== id) };
}

export type Hit = { kind: 'source'; id: string } | { kind: 'shape'; id: string };

/** What is under a point: a source within the tolerance first, else the topmost shape there or near its edge. */
export function hitTest(scene: Scene, x: number, y: number, toleranceM: number): Hit | undefined {
  let best: { hit: Hit; distance: number } | undefined;
  for (const s of scene.sources) {
    const distance = Math.hypot(s.x - x, s.y - y);
    if (distance <= toleranceM && (!best || distance < best.distance)) best = { hit: { kind: 'source', id: s.id }, distance };
  }
  if (best) return best.hit;
  for (let n = scene.shapes.length - 1; n >= 0; n--) {
    const shape = scene.shapes[n]!;
    if (contains(shape.geometry, x, y, toleranceM * 2)) return { kind: 'shape', id: shape.id };
  }
  return undefined;
}

// ---- what to expect ----

export interface Limits {
  grid: Grid;
  /** Time step, seconds. */
  dt: number;
  cells: number;
  lambdaM: number;
  notes: { severity: 'warning' | 'error'; message: string }[];
}

export const COURANT = 0.7;
/** Below this many cells a wavelength the grid itself bends the physics noticeably. */
export const COMFORTABLE_CELLS_PER_WAVELENGTH = 10;
/** Above this many cells a laptop stops keeping up. */
export const COMFORTABLE_CELLS = 300_000;

export function limits(scene: Scene): Limits {
  const notes: Limits['notes'] = [];
  const grid = gridFor(scene);
  const lambdaM = wavelengthM(scene);
  const dt = (COURANT * grid.dx) / C0;
  const cells = grid.nx * grid.ny;
  if (!(scene.fMHz > 0)) notes.push({ severity: 'error', message: 'The frequency must be above zero: it sets the scale of everything.' });
  if (!(scene.widthM > 0) || !(scene.heightM > 0)) notes.push({ severity: 'error', message: 'The world needs a width and a height.' });
  if (scene.cellsPerWavelength < 4) notes.push({ severity: 'error', message: 'Fewer than 4 cells a wavelength cannot carry a wave at all.' });
  else if (scene.cellsPerWavelength < COMFORTABLE_CELLS_PER_WAVELENGTH) {
    notes.push({
      severity: 'warning',
      message: `At ${scene.cellsPerWavelength} cells a wavelength the grid itself slows and spreads the waves (numerical dispersion). Use ${COMFORTABLE_CELLS_PER_WAVELENGTH} or more; 20 is comfortable.`,
    });
  }
  if (cells > COMFORTABLE_CELLS) notes.push({ severity: 'warning', message: `${cells.toLocaleString()} cells will step slowly. A smaller world, a higher frequency or fewer cells a wavelength all help.` });
  if (scene.sources.length === 0) notes.push({ severity: 'warning', message: 'There is no source yet, so nothing will happen when it runs. Choose the Source tool and click where the wave should start.' });
  const minWidth = grid.dx;
  for (const source of scene.sources) {
    if (source.x < 0 || source.y < 0 || source.x >= scene.widthM || source.y >= scene.heightM) {
      notes.push({ severity: 'warning', message: 'A source lies outside the world and is ignored.' });
    } else if (scene.shapes.some((s) => s.material.kind === 'conductor' && contains(s.geometry, source.x, source.y, minWidth))) {
      notes.push({ severity: 'warning', message: 'A source sits inside a conductor, where the field is held at zero: it radiates nothing.' });
    }
  }
  for (const shape of scene.shapes) {
    if (shape.material.kind === 'dielectric' && shape.material.epsr < 1) notes.push({ severity: 'error', message: 'A relative permittivity below 1 is not a material this engine knows.' });
  }
  return { grid, dt, cells, lambdaM, notes };
}

// ---- remembering ----

const STORAGE_KEY = 'emws.fdtd.v1';
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function loadScene(): Scene | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const stored = JSON.parse(raw) as Partial<Scene>;
    const scene = { ...emptyScene(), ...stored };
    if (![scene.fMHz, scene.widthM, scene.heightM, scene.cellsPerWavelength, scene.pmlCells].every(finite)) return undefined;
    if (!Array.isArray(scene.shapes) || !Array.isArray(scene.sources)) return undefined;
    return scene;
  } catch {
    return undefined;
  }
}

export function saveScene(scene: Scene): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(scene));
  } catch {
    // Storage can be blocked; the tool still works, it just starts afresh next time.
  }
}
