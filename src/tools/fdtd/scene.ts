// What the field sandbox is a picture of: a rectangular world in metres with conductors,
// dielectrics and sources drawn in it, and how that becomes cells for the engine.
//
// The scene is the source of truth, as the AntennaModel is in the modeler: every edit is a
// pure function returning a new scene, and the grid is derived from it. World coordinates
// are metres with y up; the PML sits outside the world, and whatever touches the world's
// edge runs on through it, so a ground or a wall drawn to the edge has no end to reflect from.

import { C0, EPS0, type PlaneWaveSpec, type Polarisation, type Side, type SourceCell, type SourceKind, planeWaveBoundary } from './simulation';

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

/** A plane wave coming in through one side of the world, at the scene's frequency. */
export interface ScenePlaneWave {
  side: Side;
  /** Degrees from square on; positive tilts towards +y (left and right sides) or +x (top and bottom). */
  angleDeg: number;
  kind: SourceKind;
  amplitude: number;
}

export interface Scene {
  fMHz: number;
  widthM: number;
  heightM: number;
  cellsPerWavelength: number;
  pmlCells: number;
  /** Which field points out of the screen: Ez ('tm') or Hz ('te'). */
  polarisation: Polarisation;
  planeWave: ScenePlaneWave | null;
  /**
   * When the frequency changes, scale the world and everything drawn in it with the
   * wavelength, so the picture keeps its size in wavelengths (and its cells). Off, the
   * metres stay and the picture coarsens as the wavelength grows.
   */
  scaleWithFrequency: boolean;
  shapes: Shape[];
  sources: Source[];
}

/** A plane wave's tilt is kept short of grazing, where it would run along its own side. */
export const MAX_PLANE_WAVE_ANGLE = 85;

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
  return { fMHz: 1000, widthM: 3, heightM: 2, cellsPerWavelength: 20, pmlCells: 10, polarisation: 'tm', planeWave: null, scaleWithFrequency: true, shapes: [], sources: [] };
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
  polarisation: Polarisation;
  epsr: Float32Array;
  sigma: Float32Array;
  pec: Uint8Array;
  sources: SourceCell[];
  planeWave?: PlaneWaveSpec;
}

/**
 * Paints the scene's shapes into per-cell materials, later shapes over earlier ones, then
 * carries the world's outermost cells on out through the absorbing edge, so a ground drawn
 * to the edge continues to infinity instead of ending in a step the waves would see.
 */
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
  if (pml > 0) {
    const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (i >= pml && i < nx - pml && j >= pml && j < ny - pml) continue;
        const k = i + j * nx;
        const from = clamp(i, pml, nx - pml - 1) + clamp(j, pml, ny - pml - 1) * nx;
        pec[k] = pec[from]!;
        epsr[k] = epsr[from]!;
        sigma[k] = sigma[from]!;
      }
    }
  }
  const fHz = scene.fMHz * 1e6;
  const sources: SourceCell[] = [];
  for (const source of scene.sources) {
    const cell = cellOf(grid, source.x, source.y);
    if (!cell) continue;
    sources.push({ ...cell, kind: source.kind, fHz, amplitude: source.amplitude, phaseRad: (source.phaseDeg * Math.PI) / 180 });
  }
  const pw = scene.planeWave;
  const planeWave: PlaneWaveSpec | undefined = pw
    ? { side: pw.side, angleDeg: Math.max(-MAX_PLANE_WAVE_ANGLE, Math.min(MAX_PLANE_WAVE_ANGLE, pw.angleDeg)), kind: pw.kind, fHz, amplitude: pw.amplitude }
    : undefined;
  return { grid, polarisation: scene.polarisation, epsr, sigma, pec, sources, planeWave };
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

/** Tidies a scaled length so 3 m × (1000 / 7.1) reads 422.535, not 422.53521126760563. */
const tidy = (v: number) => Number(v.toPrecision(6));

/** A geometry with every length multiplied by a ratio. */
export function scaleGeometry(geometry: Geometry, ratio: number): Geometry {
  switch (geometry.kind) {
    case 'line':
      return { ...geometry, x1: tidy(geometry.x1 * ratio), y1: tidy(geometry.y1 * ratio), x2: tidy(geometry.x2 * ratio), y2: tidy(geometry.y2 * ratio), widthM: tidy(geometry.widthM * ratio) };
    case 'rect':
      return { ...geometry, x: tidy(geometry.x * ratio), y: tidy(geometry.y * ratio), w: tidy(geometry.w * ratio), h: tidy(geometry.h * ratio) };
    case 'disc':
      return { ...geometry, cx: tidy(geometry.cx * ratio), cy: tidy(geometry.cy * ratio), r: tidy(geometry.r * ratio) };
  }
}

/**
 * The scene at a new frequency. With `scaleWithFrequency` on, the world and everything
 * drawn in it grow or shrink with the wavelength, so the picture - in wavelengths, and in
 * cells - is the same as before: conductors and lossless dielectrics behave identically
 * at any frequency once scaled. Materials are untouched: εr is scale-free, but a
 * conductivity in S/m is not, so a lossy ground means something different at each
 * frequency (the tool says so). Off, only the frequency changes.
 */
export function withFrequency(scene: Scene, fMHz: number): Scene {
  if (!(fMHz > 0) || !(scene.fMHz > 0) || !scene.scaleWithFrequency || fMHz === scene.fMHz) return { ...scene, fMHz };
  const ratio = scene.fMHz / fMHz;
  return {
    ...scene,
    fMHz,
    widthM: tidy(scene.widthM * ratio),
    heightM: tidy(scene.heightM * ratio),
    shapes: scene.shapes.map((s) => ({ ...s, geometry: scaleGeometry(s.geometry, ratio) })),
    sources: scene.sources.map((s) => ({ ...s, x: tidy(s.x * ratio), y: tidy(s.y * ratio) })),
  };
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
/** A world narrower than this, in wavelengths, is a few cells across and shows little. */
export const SMALL_WORLD_WAVELENGTHS = 2;

/**
 * How many times shorter a wave is inside a material than in free space: the real part of
 * sqrt(εr - jσ/(ωε0)). A lossy ground at HF is mostly conductivity: average ground (εr 13,
 * 5 mS/m) at 7.1 MHz is 3.95.
 */
export function shortening(material: Pick<Material, 'epsr' | 'sigma'>, fHz: number): number {
  const re = Math.max(1, material.epsr);
  const im = Math.max(0, material.sigma) / (2 * Math.PI * fHz * EPS0);
  const modulus = Math.hypot(re, im);
  return Math.sqrt((modulus + re) / 2);
}

export function limits(scene: Scene, raster?: Raster): Limits {
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
  else {
    // The wave is shorter inside a material, so the grid can be fine in air and coarse there.
    let worst: { n: number; material: Material } | undefined;
    for (const shape of scene.shapes) {
      if (shape.material.kind !== 'dielectric') continue;
      const n = shortening(shape.material, scene.fMHz * 1e6);
      if (!worst || n > worst.n) worst = { n, material: shape.material };
    }
    if (worst && scene.cellsPerWavelength / worst.n < COMFORTABLE_CELLS_PER_WAVELENGTH) {
      const inside = scene.cellsPerWavelength / worst.n;
      const what = worst.material.sigma > 0 ? `εr ${worst.material.epsr}, σ ${worst.material.sigma} S/m` : `εr ${worst.material.epsr}`;
      notes.push({
        severity: 'warning',
        message: `Inside the material of ${what} a wavelength is ${worst.n.toFixed(1)} times shorter - only ${inside.toFixed(1)} cells - so the grid bends the physics there and its reflections drift from the true ones (about ten per cent at five cells a wavelength). About ${Math.ceil(COMFORTABLE_CELLS_PER_WAVELENGTH * worst.n)} cells a wavelength fixes it.`,
      });
    }
  }
  if (cells > COMFORTABLE_CELLS) notes.push({ severity: 'warning', message: `${cells.toLocaleString()} cells will step slowly. A smaller world, a higher frequency or fewer cells a wavelength all help.` });
  if (scene.fMHz > 0 && scene.widthM > 0 && scene.heightM > 0 && Math.min(scene.widthM, scene.heightM) < SMALL_WORLD_WAVELENGTHS * lambdaM) {
    notes.push({
      severity: 'warning',
      message: `The world is only ${(scene.widthM / lambdaM).toFixed(1)} × ${(scene.heightM / lambdaM).toFixed(1)} wavelengths - ${grid.innerNx} × ${grid.innerNy} cells, so the picture is coarse and there is little wave in it to see. Make it bigger in metres, or tick Scale the scene with the frequency and set the frequency again.`,
    });
  }
  if (scene.sources.length === 0 && !scene.planeWave) {
    notes.push({ severity: 'warning', message: 'There is no source yet, so nothing will happen when it runs. Choose the Source tool and click where the wave should start, or bring in a plane wave.' });
  }
  if (scene.planeWave && scene.fMHz > 0 && scene.cellsPerWavelength >= 4) {
    const r = raster ?? rasterise(scene);
    const empty = (k: number) => !r.pec[k] && r.epsr[k] === 1 && r.sigma[k] === 0;
    const boundary = planeWaveBoundary(r.planeWave!, r.grid.nx, r.grid.ny, r.grid.dx, r.grid.pml, empty);
    if (boundary.links === 0) notes.push({ severity: 'error', message: 'The plane wave has no empty space to start in: whatever is drawn fills the sides it comes in by.' });
    else if (boundary.buried > 0) {
      notes.push({
        severity: 'warning',
        message:
          'Something drawn reaches a side the plane wave comes in by. The wave starts in empty space only, so it is left out there - and anything it would have lit by way of that stretch, such as the reflection off a ground near that edge, is missing from a wedge of the world.',
      });
    }
  }
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
    // A scene saved before polarisation and plane waves existed has neither: Ez and none.
    const scene = { ...emptyScene(), ...stored };
    if (![scene.fMHz, scene.widthM, scene.heightM, scene.cellsPerWavelength, scene.pmlCells].every(finite)) return undefined;
    if (!Array.isArray(scene.shapes) || !Array.isArray(scene.sources)) return undefined;
    if (scene.polarisation !== 'tm' && scene.polarisation !== 'te') scene.polarisation = 'tm';
    if (typeof scene.scaleWithFrequency !== 'boolean') scene.scaleWithFrequency = true;
    const pw = scene.planeWave;
    const sides: Side[] = ['left', 'right', 'top', 'bottom'];
    if (pw && !(sides.includes(pw.side) && finite(pw.angleDeg) && finite(pw.amplitude) && (pw.kind === 'sine' || pw.kind === 'pulse'))) scene.planeWave = null;
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
