// The field sandbox's engine, against the physics it must reproduce: light speed, the
// wavelength, reflection from a conductor, slowing in a dielectric, absorption at the
// edges. Then the scene: how metres become cells, and what the checks say.

import { describe, expect, it } from 'vitest';
import { historyReducer, initialHistory } from '../src/lib/history';
import { PRESETS, presetById } from '../src/tools/fdtd/presets';
import { PROBE_SAMPLES, newProbeRecord, probeView, recordProbe, spectrum } from '../src/tools/fdtd/probe';
import { CONDUCTOR, addShape, addSource, cellOf, dielectric, emptyScene, gridFor, hitTest, limits, rasterise, removeItem, shortening, withFrequency } from '../src/tools/fdtd/scene';
import { C0, EPS0, type PlaneWaveSpec, type Polarisation, Simulation, makeEngine, ricker } from '../src/tools/fdtd/simulation';

const F = 1e9;
const DX = 0.01; // 30 cells a wavelength at 1 GHz

/** An open square of free space with a pulse at the centre. */
function open(n = 160, extra: Partial<ConstructorParameters<typeof Simulation>[0]> = {}): Simulation {
  return new Simulation({ nx: n, ny: n, dx: DX, pmlCells: 12, sources: [{ i: n / 2, j: n / 2, kind: 'pulse', fHz: F, amplitude: 1, phaseRad: 0 }], ...extra });
}

/** The field at a cell after every step, for `steps` steps. */
function record(sim: { advance(): void; at(i: number, j: number): number }, i: number, j: number, steps: number): number[] {
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
    // Two 160-cell runs of 600 steps: real work, slow under the whole suite's start-up load.
  }, 20_000);

  it('stays finite for thousands of steps, and refuses an unstable time step', () => {
    const sim = open(96);
    sim.advance(3000);
    expect(Number.isFinite(sim.peak())).toBe(true);
    expect(sim.peak()).toBeLessThan(10);
    expect(() => new Simulation({ nx: 32, ny: 32, dx: DX, courant: 0.8 })).toThrow(/Courant/);
    expect(ricker(1.5 / F, F)).toBe(1);
  });
});

/** |Γ| from Fresnel, for a ground of complex permittivity below free space; θ from the vertical. */
function fresnel(polarisation: Polarisation, thetaDeg: number, epsr: number, sigma: number, fHz: number): number {
  const t = (thetaDeg * Math.PI) / 180;
  const c = Math.cos(t);
  const im = -sigma / (2 * Math.PI * fHz * EPS0);
  // sqrt(εc - sin²θ), principal root.
  const a = epsr - Math.sin(t) ** 2;
  const r = Math.hypot(a, im);
  const sr = Math.sqrt((r + a) / 2);
  const si = Math.sign(im || 1) * Math.sqrt((r - a) / 2);
  const ratio = (nr: number, ni: number, dr: number, di: number) => Math.hypot(nr, ni) / Math.hypot(dr, di);
  // Ez out of the screen is s-polarised: (cos - root) / (cos + root). Hz is p: (εc cos - root) / (εc cos + root).
  if (polarisation === 'tm') return ratio(c - sr, -si, c + sr, si);
  return ratio(epsr * c - sr, im * c - si, epsr * c + sr, im * c + si);
}

/**
 * |Γ| as the engine sees it: a plane wave from the top onto a ground filling the bottom, run
 * twice - with the ground and without - and the difference read just above the ground, far
 * enough along that the reflection there comes from ground inside the world.
 */
function measuredReflection(polarisation: Polarisation, thetaDeg: number, cellsPerWavelength: number, epsr: number, sigma: number, fHz: number): number {
  const dx = C0 / fHz / cellsPerWavelength;
  const pml = 12;
  const wide = 8 * cellsPerWavelength;
  const nx = wide + 2 * pml;
  const ny = 2 * cellsPerWavelength + 2 * pml;
  const top = pml + cellsPerWavelength;
  const ground = { epsr: new Float32Array(nx * ny).fill(1), sigma: new Float32Array(nx * ny) };
  for (let k = 0; k < top * nx; k++) {
    ground.epsr[k] = epsr;
    ground.sigma[k] = sigma;
  }
  const planeWave: PlaneWaveSpec = { side: 'top', angleDeg: thetaDeg, kind: 'sine', fHz, amplitude: 1 };
  const withGround = makeEngine(polarisation, { nx, ny, dx, pmlCells: pml, ...ground, planeWave });
  const without = makeEngine(polarisation, { nx, ny, dx, pmlCells: pml, planeWave });
  const settle = Math.round((wide * 2.5) / 0.7);
  for (let s = 0; s < settle; s++) {
    withGround.advance();
    without.advance();
  }
  const i = pml + Math.round(wide * 0.8);
  const j = top + Math.round(cellsPerWavelength / 8);
  let reflected = 0;
  let incident = 0;
  for (let s = 0; s < Math.ceil(1 / (fHz * withGround.dt)) + 2; s++) {
    withGround.advance();
    without.advance();
    reflected = Math.max(reflected, Math.abs(withGround.at(i, j) - without.at(i, j)));
    incident = Math.max(incident, Math.abs(without.at(i, j)));
  }
  return reflected / incident;
}

describe('the plane wave, and the other polarisation', () => {
  it('fills empty space evenly, square on and at a slant, and stays out of the region behind it', () => {
    for (const [side, angleDeg] of [['top', 0], ['top', 30], ['left', 20]] as const) {
      const pml = 12;
      const nx = 200 + 2 * pml;
      const ny = 140 + 2 * pml;
      const sim = makeEngine('tm', { nx, ny, dx: 0.3 / 20, pmlCells: pml, planeWave: { side, angleDeg, kind: 'sine', fHz: F, amplitude: 1 } });
      sim.advance(2500);
      const envelope = new Float32Array(nx * ny);
      for (let s = 0; s < 60; s++) {
        sim.advance();
        for (let k = 0; k < nx * ny; k++) envelope[k] = Math.max(envelope[k]!, Math.abs(sim.field[k]!));
      }
      let lo = Infinity;
      let hi = 0;
      for (let j = pml + 3; j < ny - pml - 3; j++) {
        for (let i = pml + 3; i < nx - pml - 3; i++) {
          lo = Math.min(lo, envelope[i + j * nx]!);
          hi = Math.max(hi, envelope[i + j * nx]!);
        }
      }
      expect(lo, `${side} ${angleDeg}°`).toBeGreaterThan(0.97);
      expect(hi, `${side} ${angleDeg}°`).toBeLessThan(1.03);
      // The strip between the launching line and the absorbing edge behind it is scattered field only.
      const behind = side === 'top' ? (i: number) => envelope[i + (ny - pml - 1) * nx]! : (i: number) => envelope[pml + i * nx]!;
      let leak = 0;
      for (let n = pml + 3; n < (side === 'top' ? nx : ny) - pml - 3; n++) leak = Math.max(leak, behind(n));
      expect(leak, `${side} ${angleDeg}° behind`).toBeLessThan(0.01);
    }
  }, 30_000);

  it('a conductor sends it back whole: upside down in Ez, the same way up in Hz', () => {
    const gamma = (polarisation: Polarisation, what: 'conductor' | 'dielectric') => {
      const nx = 300;
      const ny = 60;
      const epsr = new Float32Array(nx * ny).fill(1);
      const pec = new Uint8Array(nx * ny);
      for (let j = 0; j < ny; j++) for (let i = 200; i < nx; i++) if (what === 'conductor') pec[i + j * nx] = 1; else epsr[i + j * nx] = 4;
      const sim = makeEngine(polarisation, { nx, ny, dx: DX, pmlCells: 12, epsr, pec, planeWave: { side: 'left', angleDeg: 0, kind: 'pulse', fHz: F, amplitude: 1 } });
      const series = record(sim, 150, 30, 700);
      const incident = series.slice(0, 300);
      const reflected = series.slice(300);
      return { incident: incident[argmaxAbs(incident)]!, gamma: reflected[argmaxAbs(reflected)]! / incident[argmaxAbs(incident)]! };
    };
    const tm = gamma('tm', 'conductor');
    expect(Math.abs(tm.incident - 1)).toBeLessThan(0.01);
    expect(tm.gamma).toBeLessThan(-0.98);
    expect(gamma('te', 'conductor').gamma).toBeGreaterThan(0.98);
    // εr 4 square on: Γ = (1 - 2) / (1 + 2) for E; H reflects with the other sign.
    expect(Math.abs(gamma('tm', 'dielectric').gamma + 1 / 3)).toBeLessThan(0.02);
    expect(Math.abs(gamma('te', 'dielectric').gamma - 1 / 3)).toBeLessThan(0.02);
  }, 30_000);

  it("Brewster's angle: at atan 2 onto εr 4 vertical polarisation goes in whole, horizontal does not", () => {
    const brewster = (Math.atan(2) * 180) / Math.PI;
    const vertical = measuredReflection('te', brewster, 20, 4, 0, F);
    const horizontal = measuredReflection('tm', brewster, 20, 4, 0, F);
    expect(fresnel('te', brewster, 4, 0, F)).toBeLessThan(1e-12);
    expect(vertical).toBeLessThan(0.04);
    expect(Math.abs(horizontal - fresnel('tm', brewster, 4, 0, F))).toBeLessThan(0.03);
    // And at 45°, both as Fresnel says, within a few hundredths at 20 cells a wavelength.
    expect(Math.abs(measuredReflection('te', 45, 20, 4, 0, F) - fresnel('te', 45, 4, 0, F))).toBeLessThan(0.03);
    expect(Math.abs(measuredReflection('tm', 45, 20, 4, 0, F) - fresnel('tm', 45, 4, 0, F))).toBeLessThan(0.03);
  }, 30_000);

  it('average ground on 40 m: vertical polarisation hardly reflects near 13° elevation, horizontal still does', () => {
    const f = 7.1e6;
    // Fresnel's minimum for vertical polarisation over εr 13, 5 mS/m: 76.7° from the vertical.
    let best = 0;
    for (let d = 50; d < 89.9; d += 0.1) if (fresnel('te', d, 13, 0.005, f) < fresnel('te', best, 13, 0.005, f)) best = d;
    expect(best).toBeCloseTo(76.7, 0);
    // The preset's own grid: 40 cells a wavelength in air, ten inside the ground.
    expect(40 / shortening({ epsr: 13, sigma: 0.005 }, f)).toBeGreaterThan(10);
    const verticalLow = measuredReflection('te', 77, 40, 13, 0.005, f);
    const verticalHigh = measuredReflection('te', 0, 40, 13, 0.005, f);
    const horizontalLow = measuredReflection('tm', 77, 40, 13, 0.005, f);
    expect(Math.abs(verticalLow - fresnel('te', 77, 13, 0.005, f))).toBeLessThan(0.05);
    expect(Math.abs(verticalHigh - fresnel('te', 0, 13, 0.005, f))).toBeLessThan(0.05);
    expect(Math.abs(horizontalLow - fresnel('tm', 77, 13, 0.005, f))).toBeLessThan(0.05);
    expect(verticalLow).toBeLessThan(verticalHigh / 2);
  }, 60_000);

  it('Hz in a dielectric travels at c / √εr too, and its absorbing edge swallows what reaches it', () => {
    const n = 160;
    const arrival = (epsr: number) => {
      const sim = makeEngine('te', { nx: n, ny: n, dx: DX, pmlCells: 12, epsr: new Float32Array(n * n).fill(epsr), sources: [{ i: n / 2, j: n / 2, kind: 'pulse', fHz: F, amplitude: 1, phaseRad: 0 }] });
      return (argmaxAbs(record(sim, 80 + 40, 80, 500)) + 1) * sim.dt - 1.5 / F;
    };
    const ratio = arrival(4) / arrival(1);
    expect(ratio).toBeGreaterThan(1.85);
    expect(ratio).toBeLessThan(2.15);
    const sim = makeEngine('te', { nx: n, ny: n, dx: DX, pmlCells: 12, sources: [{ i: n / 2, j: n / 2, kind: 'pulse', fHz: F, amplitude: 1, phaseRad: 0 }] });
    let peak = 0;
    for (let s = 0; s < 600; s++) {
      sim.advance();
      peak = Math.max(peak, sim.energy());
    }
    expect(sim.energy() / peak).toBeLessThan(1e-4);
  }, 20_000);
});

describe('the probe', () => {
  const dt = (0.7 * DX) / C0;

  it('finds a sine at its own frequency, and a pulse at its centre frequency', () => {
    const sine = new Float32Array(3000).map((_, m) => Math.sin(2 * Math.PI * F * (m + 1) * dt));
    const frequencies = Array.from({ length: 241 }, (_, b) => (3 * F * b) / 240);
    const { levelDb, peakIndex } = spectrum(sine, dt, frequencies);
    expect(frequencies[peakIndex!]! / F).toBeCloseTo(1, 1);
    expect(Math.max(...levelDb)).toBe(0);
    expect(levelDb[frequencies.findIndex((f) => f >= 2 * F)]!).toBeLessThan(-40);
    const pulse = new Float32Array(3000).map((_, m) => ricker((m + 1) * dt, F));
    const ping = spectrum(pulse, dt, frequencies);
    expect(Math.abs(frequencies[ping.peakIndex!]! / F - 1)).toBeLessThan(0.05);
    // Nothing recorded yet: no peak, everything on the floor.
    const silent = spectrum(new Float32Array(100), dt, frequencies);
    expect(silent.peakIndex).toBeUndefined();
  });

  it('keeps the last samples in order and says how long it has listened', () => {
    const record = newProbeRecord(5, 100);
    const field = new Float32Array(10);
    for (let m = 0; m < PROBE_SAMPLES + 500; m++) {
      field[5] = Math.sin(2 * Math.PI * F * (100 + m + 1) * dt);
      recordProbe(record, field);
    }
    const view = probeView(record, dt, F)!;
    expect(view.periods).toBeCloseTo(PROBE_SAMPLES * dt * F, 6);
    // The trace ends at the last sample taken, at its own time.
    expect(view.timeNs.at(-1)!).toBeCloseTo((100 + PROBE_SAMPLES + 500) * dt * 1e9, 6);
    expect(view.trace.at(-1)!).toBeCloseTo(field[5]!, 6);
    expect(view.peakMHz! / 1000).toBeCloseTo(1, 1);
    expect(probeView(newProbeRecord(0, 0), dt, F)).toBeUndefined();
  });

  it('records in the engine without disturbing it', () => {
    const a = open(96);
    const b = open(96);
    const record = newProbeRecord(60 + 48 * 96, 0);
    for (let s = 0; s < 200; s++) {
      a.advance();
      b.advance();
      recordProbe(record, a.field);
    }
    expect(record.count).toBe(200);
    expect(record.values[199]).toBe(b.at(60, 48));
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
      expect(notes.some((n) => /no source|inside a conductor|times shorter/.test(n.message)), preset.id).toBe(false);
      const raster = rasterise(scene);
      expect(raster.sources.length > 0 || raster.planeWave !== undefined, preset.id).toBe(true);
      const objects = raster.pec.some((v) => v === 1) || raster.epsr.some((e) => e > 1);
      expect(objects || preset.id === 'ping', preset.id).toBe(true);
    }
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
    // The ground scenes' plane waves slant in over a ground that reaches their side: the checks say what that costs.
    expect(limits(presetById('brewster')!.scene()).notes.some((n) => /starts in empty space only/.test(n.message))).toBe(true);
    expect(presetById('brewster')!.scene().polarisation).toBe('te');
  });

  it('carries whatever touches the edge on through the absorbing layer, and nothing else', () => {
    let scene = addShape(emptyScene(), { kind: 'rect', x: 0, y: 0, w: 3, h: 0.5 }, dielectric(4, 0.01)).scene;
    scene = addShape(scene, { kind: 'disc', cx: 1.5, cy: 1.5, r: 0.2 }, CONDUCTOR).scene;
    const raster = rasterise(scene);
    const { nx, ny, pml } = raster.grid;
    // Below the world, under the ground, and out to both sides: still ground.
    for (const [i, j] of [[0, 0], [nx - 1, 0], [nx / 2, 1], [1, pml + 3]]) {
      expect(raster.epsr[i! + j! * nx], `${i}, ${j}`).toBe(4);
      expect(raster.sigma[i! + j! * nx], `${i}, ${j}`).toBeCloseTo(0.01, 6);
    }
    // Above the world: air. The disc touches no edge, so the layer beside it stays empty.
    expect(raster.epsr[nx / 2 + (ny - 1) * nx]).toBe(1);
    expect(raster.pec.slice((ny - pml) * nx).some((v) => v === 1)).toBe(false);
  });

  it('a plane wave counts as a source, says when it starts inside something, and refuses to start nowhere', () => {
    const messages = (s: ReturnType<typeof emptyScene>) => limits(s).notes.map((n) => `${n.severity}: ${n.message}`);
    const lit = { ...emptyScene(), planeWave: { side: 'left' as const, angleDeg: 0, kind: 'sine' as const, amplitude: 1 } };
    expect(messages(lit).some((m) => /no source/.test(m))).toBe(false);
    expect(messages(lit).some((m) => /empty space only/.test(m))).toBe(false);
    expect(rasterise(lit).planeWave).toMatchObject({ side: 'left', fHz: 1e9 });
    const tilted = { ...lit, planeWave: { ...lit.planeWave, angleDeg: 120 } };
    expect(rasterise(tilted).planeWave!.angleDeg).toBe(85);
    const grounded = { ...addShape(lit, { kind: 'rect', x: 0, y: 0, w: 3, h: 0.5 }, dielectric(4)).scene };
    expect(messages(grounded)).toContainEqual(expect.stringMatching(/warning: .*starts in empty space only/));
    const buried = addShape(lit, { kind: 'rect', x: 0, y: 0, w: 0.5, h: 2 }, dielectric(4)).scene;
    expect(messages(buried)).toContainEqual(expect.stringMatching(/error: The plane wave has no empty space/));
  });

  it('scales the world and everything drawn with the wavelength when the frequency changes', () => {
    let scene = addShape(emptyScene(), { kind: 'line', x1: 1.4, y1: 0, x2: 1.4, y2: 0.78, widthM: 0.03 }, CONDUCTOR).scene;
    scene = addShape(scene, { kind: 'rect', x: 1.6, y: 0, w: 0.5, h: 2 }, dielectric(4, 0.01)).scene;
    scene = addShape(scene, { kind: 'disc', cx: 1.3, cy: 1.0, r: 0.15 }, CONDUCTOR).scene;
    scene = addSource(scene, 0.5, 1.0).scene;
    const before = gridFor(scene);
    // Ten times the wavelength: ten times the metres, the same cells.
    const low = withFrequency(scene, 100);
    expect(low.fMHz).toBe(100);
    expect([low.widthM, low.heightM]).toEqual([30, 20]);
    expect(low.shapes[0]!.geometry).toEqual({ kind: 'line', x1: 14, y1: 0, x2: 14, y2: 7.8, widthM: 0.3 });
    expect(low.shapes[1]!.geometry).toEqual({ kind: 'rect', x: 16, y: 0, w: 5, h: 20 });
    expect(low.shapes[2]!.geometry).toEqual({ kind: 'disc', cx: 13, cy: 10, r: 1.5 });
    expect(low.sources[0]).toMatchObject({ x: 5, y: 10 });
    // Materials are not touched: εr is scale-free and σ deliberately stays as typed.
    expect(low.shapes[1]!.material).toEqual(dielectric(4, 0.01));
    const after = gridFor(low);
    expect([after.innerNx, after.innerNy]).toEqual([before.innerNx, before.innerNy]);
    expect(rasterise(low).pec.filter((v) => v === 1).length).toBe(rasterise(scene).pec.filter((v) => v === 1).length);
    // Back again lands where it started, to six figures; 7.1 MHz reads tidily.
    const back = withFrequency(low, 1000);
    expect(back.widthM).toBe(3);
    expect(back.shapes[0]!.geometry).toEqual(scene.shapes[0]!.geometry);
    expect(withFrequency(scene, 7.1).widthM).toBe(422.535);
    // Off, only the frequency changes - and the world is then a fraction of a wavelength, which is said.
    const held = withFrequency({ ...scene, scaleWithFrequency: false }, 100);
    expect(held.widthM).toBe(3);
    expect(held.shapes).toBe(scene.shapes);
    expect(limits(held).notes.map((n) => n.message)).toContainEqual(expect.stringMatching(/only 1\.0 × 0\.7 wavelengths - 20 × 13 cells/));
    expect(limits(low).notes.some((n) => /wavelengths - /.test(n.message))).toBe(false);
    // The same frequency, or a nonsense one, changes nothing else.
    expect(withFrequency(scene, 1000)).toEqual(scene);
    expect(withFrequency(scene, 0).widthM).toBe(3);
  });

  it('warns when a material is coarse inside even though the air is fine', () => {
    const ground = (cells: number) => ({
      ...addShape({ ...emptyScene(), fMHz: 7.1, widthM: 300, heightM: 150, cellsPerWavelength: cells }, { kind: 'rect', x: 0, y: 0, w: 300, h: 30 }, dielectric(13, 0.005)).scene,
    });
    expect(shortening({ epsr: 13, sigma: 0.005 }, 7.1e6)).toBeCloseTo(3.95, 2);
    expect(shortening({ epsr: 4, sigma: 0 }, 1e9)).toBe(2);
    expect(limits(ground(20)).notes.map((n) => n.message)).toContainEqual(expect.stringMatching(/3\.9 times shorter - only 5\.1 cells.*About 40 cells/));
    expect(limits(ground(40)).notes.some((n) => /times shorter/.test(n.message))).toBe(false);
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
