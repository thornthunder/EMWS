// The field sandbox's engine, against the physics it must reproduce: light speed, the
// wavelength, reflection from a conductor, slowing in a dielectric, absorption at the
// edges. Then the scene: how metres become cells, and what the checks say.

import { describe, expect, it } from 'vitest';
import { historyReducer, initialHistory } from '../src/lib/history';
import { PRESETS } from '../src/tools/fdtd/presets';
import { CONDUCTOR, addShape, addSource, cellOf, dielectric, emptyScene, gridFor, hitTest, limits, rasterise, removeItem } from '../src/tools/fdtd/scene';
import { C0, Simulation, ricker } from '../src/tools/fdtd/simulation';

const F = 1e9;
const DX = 0.01; // 30 cells a wavelength at 1 GHz

/** An open square of free space with a pulse at the centre. */
function open(n = 160, extra: Partial<ConstructorParameters<typeof Simulation>[0]> = {}): Simulation {
  return new Simulation({ nx: n, ny: n, dx: DX, pmlCells: 12, sources: [{ i: n / 2, j: n / 2, kind: 'pulse', fHz: F, amplitude: 1, phaseRad: 0 }], ...extra });
}

/** Ez at a cell after every step, for `steps` steps. */
function record(sim: Simulation, i: number, j: number, steps: number): number[] {
  const out: number[] = [];
  for (let s = 0; s < steps; s++) {
    sim.advance();
    out.push(sim.at(i, j));
  }
  return out;
}

const argmaxAbs = (series: number[]) => series.reduce((best, v, n) => (Math.abs(v) > Math.abs(series[best]!) ? n : best), 0);

describe('the engine', () => {
  it('sends a pulse out at the speed of light', () => {
    const sim = open();
    const distanceM = 50 * DX;
    const series = record(sim, 80 + 50, 80, 300);
    const peakStep = argmaxAbs(series) + 1;
    // The Ricker peaks at 1.5 / f at the source; in two dimensions the received pulse
    // trails a tail, but its peak still arrives a distance / c later.
    const expected = 1.5 / F + distanceM / C0;
    expect(Math.abs(peakStep * sim.dt - expected)).toBeLessThan(0.15e-9);
    expect(sim.dt).toBeCloseTo((0.7 * DX) / C0, 20);
  });

  it('has the right wavelength on the grid', () => {
    const nx = 240;
    const ny = 120;
    const sim = new Simulation({ nx, ny, dx: DX, pmlCells: 12, sources: [{ i: 60, j: ny / 2, kind: 'sine', fHz: F, amplitude: 1, phaseRad: 0 }] });
    sim.advance(Math.round((12 / F) / sim.dt));
    // Zero crossings along the row to the right of the source are half a wavelength apart.
    const crossings: number[] = [];
    for (let i = 80; i < nx - 14; i++) {
      const a = sim.at(i, ny / 2);
      const b = sim.at(i + 1, ny / 2);
      if ((a <= 0 && b > 0) || (a >= 0 && b < 0)) crossings.push(i + a / (a - b));
    }
    expect(crossings.length).toBeGreaterThan(6);
    const spacings = crossings.slice(1).map((c, n) => c - crossings[n]!);
    const mean = spacings.reduce((s, v) => s + v, 0) / spacings.length;
    expect((mean * 2 * DX) / (C0 / F)).toBeCloseTo(1, 1);
    expect(Math.abs((mean * 2 * DX) / (C0 / F) - 1)).toBeLessThan(0.03);
  });

  it('a conductor sends the pulse back upside down', () => {
    const n = 160;
    const pec = new Uint8Array(n * n);
    for (let j = 0; j < n; j++) pec[120 + j * n] = 1; // a wall 40 cells to the right of the source
    const sim = open(n, { pec });
    // A probe 20 cells out: the pulse passes it at about step 93 going out and step 150 coming back.
    const series = record(sim, 100, 80, 400);
    const incidentAt = argmaxAbs(series.slice(0, 120));
    const reflected = series.slice(120);
    const reflectedAt = argmaxAbs(reflected) + 120;
    expect(series[incidentAt]!).toBeGreaterThan(0);
    expect(series[reflectedAt]!).toBeLessThan(0);
    expect(Math.abs(series[reflectedAt]!)).toBeGreaterThan(0.3 * Math.abs(series[incidentAt]!));
    // Out and back: the extra path is twice the 20 cells from probe to wall.
    const extra = (reflectedAt - incidentAt) * sim.dt * C0;
    expect(Math.abs(extra - 40 * DX)).toBeLessThan(6 * DX);
  });

  it('a dielectric slows the wave by the square root of its permittivity', () => {
    const n = 160;
    const arrival = (epsr: number) => {
      const sim = open(n, { epsr: new Float32Array(n * n).fill(epsr) });
      return (argmaxAbs(record(sim, 80 + 40, 80, 500)) + 1) * sim.dt - 1.5 / F;
    };
    const ratio = arrival(4) / arrival(1);
    expect(ratio).toBeGreaterThan(1.85);
    expect(ratio).toBeLessThan(2.15);
  });

  it('the absorbing edge swallows what reaches it, where a conducting box keeps it', () => {
    const settle = (pmlCells: number) => {
      const sim = open(160, { pmlCells });
      let peak = 0;
      for (let s = 0; s < 600; s++) {
        sim.advance();
        peak = Math.max(peak, sim.energy());
      }
      return sim.energy() / peak;
    };
    expect(settle(12)).toBeLessThan(1e-4);
    expect(settle(0)).toBeGreaterThan(0.3);
  });

  it('stays finite for thousands of steps, and refuses an unstable time step', () => {
    const sim = open(96);
    sim.advance(3000);
    expect(Number.isFinite(sim.peak())).toBe(true);
    expect(sim.peak()).toBeLessThan(10);
    expect(() => new Simulation({ nx: 32, ny: 32, dx: DX, courant: 0.8 })).toThrow(/Courant/);
    expect(ricker(1.5 / F, F)).toBe(1);
  });
});

describe('the scene', () => {
  it('maps the world to cells of a twentieth of a wavelength, with the PML outside it', () => {
    const scene = emptyScene();
    const grid = gridFor(scene);
    expect(grid.dx).toBeCloseTo(0.29979 / 20, 5);
    expect(grid.innerNx).toBe(200);
    expect(grid.innerNy).toBe(133);
    expect(grid.nx).toBe(220);
    expect(cellOf(grid, 0, 0)).toEqual({ i: 10, j: 10 });
    expect(cellOf(grid, 2.99, 1.99)).toEqual({ i: 209, j: 142 });
    expect(cellOf(grid, 3, 1)).toBeUndefined();
    expect(cellOf(grid, -0.01, 1)).toBeUndefined();
  });

  it('rasterises lines, rectangles and discs, later shapes over earlier ones', () => {
    let scene = emptyScene();
    scene = addShape(scene, { kind: 'line', x1: 1, y1: 1, x2: 2, y2: 1, widthM: 0 }, CONDUCTOR).scene;
    scene = addShape(scene, { kind: 'rect', x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, dielectric(4, 0.01)).scene;
    scene = addShape(scene, { kind: 'disc', cx: 2.5, cy: 1.5, r: 0.2 }, dielectric(2)).scene;
    scene = addSource(scene, 0.3, 0.3).scene;
    const raster = rasterise(scene);
    const { grid } = raster;
    const count = (test: (k: number) => boolean) => {
      let n = 0;
      for (let k = 0; k < grid.nx * grid.ny; k++) if (test(k)) n++;
      return n;
    };
    // A thin line is one cell thick: about a metre of cells.
    const conductor = count((k) => raster.pec[k] === 1);
    expect(conductor).toBeGreaterThan(60);
    expect(conductor).toBeLessThan(80);
    const glass = count((k) => raster.epsr[k] === 4);
    expect(glass).toBeGreaterThan(30 * 30);
    expect(glass).toBeLessThan(36 * 36);
    expect(count((k) => (raster.sigma[k] ?? 0) > 0)).toBe(glass);
    const disc = count((k) => raster.epsr[k] === 2);
    expect(disc / (Math.PI * (0.2 / grid.dx) ** 2)).toBeCloseTo(1, 1);
    expect(raster.sources).toHaveLength(1);
    const sourceCell = cellOf(grid, 0.3, 0.3)!;
    expect(raster.sources[0]).toMatchObject({ i: sourceCell.i, j: sourceCell.j, fHz: 1e9, kind: 'sine' });
    // A later conductor over the dielectric wins.
    const over = addShape(scene, { kind: 'rect', x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, CONDUCTOR).scene;
    expect(rasterise(over).epsr.filter((e) => e === 4)).toHaveLength(0);
  });

  it('finds what is under the pointer, and removes it', () => {
    let scene = emptyScene();
    const line = addShape(scene, { kind: 'line', x1: 1, y1: 1, x2: 2, y2: 1, widthM: 0 }, CONDUCTOR);
    scene = addSource(line.scene, 1.5, 1.02).scene;
    const sourceId = scene.sources[0]!.id;
    expect(hitTest(scene, 1.5, 1.03, 0.05)).toEqual({ kind: 'source', id: sourceId });
    expect(hitTest(scene, 1.2, 1.01, 0.05)).toEqual({ kind: 'shape', id: line.id });
    expect(hitTest(scene, 1.2, 1.5, 0.05)).toBeUndefined();
    const fewer = removeItem(scene, sourceId);
    expect(fewer.sources).toHaveLength(0);
    expect(fewer.shapes).toHaveLength(1);
  });

  it('says what will go wrong before it runs', () => {
    const messages = (s: ReturnType<typeof emptyScene>) => limits(s).notes.map((n) => `${n.severity}: ${n.message}`);
    expect(messages(emptyScene())).toContainEqual(expect.stringMatching(/warning: There is no source/));
    expect(messages({ ...emptyScene(), cellsPerWavelength: 6 })).toContainEqual(expect.stringMatching(/warning: .*numerical dispersion/));
    expect(messages({ ...emptyScene(), cellsPerWavelength: 3 })).toContainEqual(expect.stringMatching(/error: Fewer than 4/));
    expect(messages({ ...emptyScene(), widthM: 30, heightM: 20 })).toContainEqual(expect.stringMatching(/warning: .*step slowly/));
    const buried = addSource(addShape(emptyScene(), { kind: 'rect', x: 1, y: 1, w: 0.5, h: 0.5 }, CONDUCTOR).scene, 1.2, 1.2).scene;
    expect(messages(buried)).toContainEqual(expect.stringMatching(/warning: A source sits inside a conductor/));
    expect(limits(emptyScene()).dt).toBeCloseTo((0.7 * gridFor(emptyScene()).dx) / C0, 18);
  });

  it('ships presets that rasterise cleanly and have something in them', () => {
    for (const preset of PRESETS) {
      const scene = preset.scene();
      const notes = limits(scene).notes;
      expect(notes.filter((n) => n.severity === 'error'), preset.id).toHaveLength(0);
      expect(notes.some((n) => /no source|inside a conductor/.test(n.message)), preset.id).toBe(false);
      const raster = rasterise(scene);
      expect(raster.sources.length, preset.id).toBeGreaterThan(0);
      const objects = raster.pec.some((v) => v === 1) || raster.epsr.some((e) => e > 1);
      expect(objects || preset.id === 'ping', preset.id).toBe(true);
    }
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
  });
});

describe('undo history, generically', () => {
  it('makes a drag one step and a click that moved nothing no step', () => {
    let h = initialHistory({ n: 0 });
    h = historyReducer(h, { type: 'gesture-start' });
    h = historyReducer(h, { type: 'gesture-update', model: { n: 1 } });
    h = historyReducer(h, { type: 'gesture-update', model: { n: 2 } });
    h = historyReducer(h, { type: 'gesture-end' });
    expect(h.present).toEqual({ n: 2 });
    expect(h.past).toHaveLength(1);
    h = historyReducer(h, { type: 'undo' });
    expect(h.present).toEqual({ n: 0 });
    h = historyReducer(h, { type: 'redo' });
    expect(h.present).toEqual({ n: 2 });
    const same = historyReducer(historyReducer(h, { type: 'gesture-start' }), { type: 'gesture-end' });
    expect(same.past).toHaveLength(h.past.length);
    expect(historyReducer(h, { type: 'edit', recipe: (m) => m }).past).toHaveLength(h.past.length);
  });
});
