// Two-dimensional FDTD, TM to z: Ez points out of the screen, Hx and Hy lie in it.
//
// A Yee grid stepped leapfrog in time, with Berenger's split-field PML round the edges
// so waves leave instead of bouncing back. Everything is in SI units - the frequency
// sets the scale, so a 3 m world at 1 GHz is ten wavelengths across - but the source
// amplitude is 1, so the fields are relative, never volts per metre. Float32 arrays,
// nothing allocated per step; a 200 x 130 grid steps a few hundred times a second.
//
// What this world is: a cross-section. Every object is infinitely long into the screen,
// so a dot is a wire seen end-on and a line is a sheet. Written from the textbook
// equations (Yee 1966, Berenger 1994, Taflove), not from any program's source.

export const C0 = 299792458;
export const EPS0 = 8.8541878128e-12;
export const MU0 = 4e-7 * Math.PI;
export const ETA0 = Math.sqrt(MU0 / EPS0);

export type SourceKind = 'sine' | 'pulse';

export interface SourceCell {
  i: number;
  j: number;
  kind: SourceKind;
  fHz: number;
  amplitude: number;
  phaseRad: number;
}

export interface SimulationSpec {
  nx: number;
  ny: number;
  /** Cell size, metres (square cells). */
  dx: number;
  /** Courant number c dt / dx; the 2-D limit is 1 / sqrt 2, and 0.7 is used by default. */
  courant?: number;
  /** PML thickness in cells on every side; 0 for a perfectly conducting box. */
  pmlCells?: number;
  /** Relative permittivity per cell, nx * ny, row-major (i + j * nx); 1 where omitted. */
  epsr?: Float32Array;
  /** Conductivity per cell, S/m. */
  sigma?: Float32Array;
  /** 1 where the cell is a perfect conductor. */
  pec?: Uint8Array;
  sources?: SourceCell[];
}

/** Ricker wavelet with centre frequency f, peaking at t0 = 1.5 / f: a clean ping with no DC. */
export function ricker(t: number, fHz: number): number {
  const a = Math.PI * fHz * (t - 1.5 / fHz);
  const a2 = a * a;
  return (1 - 2 * a2) * Math.exp(-a2);
}

/** A sine that comes up smoothly over two periods, so the start does not ring the grid. */
export function rampedSine(t: number, fHz: number, phaseRad: number): number {
  const ramp = Math.min(1, t * fHz / 2);
  const smooth = 0.5 - 0.5 * Math.cos(Math.PI * ramp);
  return smooth * Math.sin(2 * Math.PI * fHz * t + phaseRad);
}

export class Simulation {
  readonly nx: number;
  readonly ny: number;
  readonly dx: number;
  readonly dt: number;
  readonly pmlCells: number;
  readonly sources: SourceCell[];
  /** Ez = ezx + ezy, kept summed here after every step for painting and probing. */
  readonly ez: Float32Array;
  readonly hx: Float32Array;
  readonly hy: Float32Array;
  readonly pec: Uint8Array;
  readonly epsr: Float32Array;
  step = 0;

  private readonly ezx: Float32Array;
  private readonly ezy: Float32Array;
  private readonly caX: Float32Array;
  private readonly cbX: Float32Array;
  private readonly caY: Float32Array;
  private readonly cbY: Float32Array;
  private readonly daX: Float32Array;
  private readonly dbX: Float32Array;
  private readonly daY: Float32Array;
  private readonly dbY: Float32Array;

  constructor(spec: SimulationSpec) {
    const { nx, ny, dx } = spec;
    if (!(nx >= 8) || !(ny >= 8) || !(dx > 0)) throw new Error('A simulation needs at least 8 x 8 cells of a positive size.');
    this.nx = nx;
    this.ny = ny;
    this.dx = dx;
    const courant = spec.courant ?? 0.7;
    if (!(courant > 0) || courant >= Math.SQRT1_2) throw new Error('The Courant number must be below 1 / sqrt 2 in two dimensions.');
    this.dt = (courant * dx) / C0;
    this.pmlCells = Math.max(0, Math.floor(spec.pmlCells ?? 10));
    this.sources = spec.sources ?? [];
    const n = nx * ny;
    this.ez = new Float32Array(n);
    this.ezx = new Float32Array(n);
    this.ezy = new Float32Array(n);
    this.hx = new Float32Array(n);
    this.hy = new Float32Array(n);
    this.caX = new Float32Array(n);
    this.cbX = new Float32Array(n);
    this.caY = new Float32Array(n);
    this.cbY = new Float32Array(n);
    this.daX = new Float32Array(n);
    this.dbX = new Float32Array(n);
    this.daY = new Float32Array(n);
    this.dbY = new Float32Array(n);
    this.pec = spec.pec ? Uint8Array.from(spec.pec) : new Uint8Array(n);
    this.epsr = spec.epsr ? Float32Array.from(spec.epsr) : new Float32Array(n).fill(1);
    this.buildCoefficients(spec.sigma);
  }

  get time(): number {
    return this.step * this.dt;
  }

  /** Polynomial-graded PML conductivity at a depth into the layer, S/m. */
  private pmlSigma(depthCells: number): number {
    const d = this.pmlCells;
    if (d <= 0 || depthCells <= 0) return 0;
    const m = 3;
    const reflection = 1e-8;
    const sigmaMax = (-(m + 1) * Math.log(reflection)) / (2 * ETA0 * d * this.dx);
    return sigmaMax * (depthCells / d) ** m;
  }

  /** Depth into the PML of a position along an axis of n cells (fractional positions for H). */
  private depth(position: number, n: number): number {
    const d = this.pmlCells;
    if (position < d) return d - position;
    const far = n - 1 - d;
    if (position > far) return position - far;
    return 0;
  }

  private buildCoefficients(sigma: Float32Array | undefined): void {
    const { nx, ny, dx, dt } = this;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = i + j * nx;
        const eps = EPS0 * this.epsr[k]!;
        const material = sigma?.[k] ?? 0;
        const sx = material + this.pmlSigma(this.depth(i, nx));
        const sy = material + this.pmlSigma(this.depth(j, ny));
        const ax = (sx * dt) / (2 * eps);
        const ay = (sy * dt) / (2 * eps);
        if (this.pec[k]) {
          this.caX[k] = this.caY[k] = this.cbX[k] = this.cbY[k] = 0;
        } else {
          this.caX[k] = (1 - ax) / (1 + ax);
          this.cbX[k] = dt / eps / (1 + ax) / dx;
          this.caY[k] = (1 - ay) / (1 + ay);
          this.cbY[k] = dt / eps / (1 + ay) / dx;
        }
        // Hy sits at i + 1/2 and sees sigma* graded in x; Hx at j + 1/2 sees it in y.
        const sxStar = (this.pmlSigma(this.depth(i + 0.5, nx)) * MU0) / EPS0;
        const syStar = (this.pmlSigma(this.depth(j + 0.5, ny)) * MU0) / EPS0;
        const bx = (sxStar * dt) / (2 * MU0);
        const by = (syStar * dt) / (2 * MU0);
        this.daX[k] = (1 - bx) / (1 + bx);
        this.dbX[k] = dt / MU0 / (1 + bx) / dx;
        this.daY[k] = (1 - by) / (1 + by);
        this.dbY[k] = dt / MU0 / (1 + by) / dx;
      }
    }
  }

  /** Advances the fields by n time steps. */
  advance(n = 1): void {
    const { nx, ny, ez, ezx, ezy, hx, hy, caX, cbX, caY, cbY, daX, dbX, daY, dbY } = this;
    for (let s = 0; s < n; s++) {
      // H from the curl of E.
      for (let j = 0; j < ny - 1; j++) {
        const row = j * nx;
        for (let i = 0; i < nx - 1; i++) {
          const k = row + i;
          hx[k] = daY[k]! * hx[k]! - dbY[k]! * (ez[k + nx]! - ez[k]!);
          hy[k] = daX[k]! * hy[k]! + dbX[k]! * (ez[k + 1]! - ez[k]!);
        }
      }
      // E from the curl of H, in its two split halves; the outer ring stays zero.
      for (let j = 1; j < ny - 1; j++) {
        const row = j * nx;
        for (let i = 1; i < nx - 1; i++) {
          const k = row + i;
          const x = caX[k]! * ezx[k]! + cbX[k]! * (hy[k]! - hy[k - 1]!);
          const y = caY[k]! * ezy[k]! - cbY[k]! * (hx[k]! - hx[k - nx]!);
          ezx[k] = x;
          ezy[k] = y;
          ez[k] = x + y;
        }
      }
      this.step++;
      const t = this.time;
      for (const source of this.sources) {
        const k = source.i + source.j * nx;
        if (this.pec[k]) continue;
        const value = source.amplitude * (source.kind === 'pulse' ? ricker(t, source.fHz) : rampedSine(t, source.fHz, source.phaseRad));
        ezx[k] = ezx[k]! + value / 2;
        ezy[k] = ezy[k]! + value / 2;
        ez[k] = ezx[k]! + ezy[k]!;
      }
    }
  }

  reset(): void {
    this.ez.fill(0);
    this.ezx.fill(0);
    this.ezy.fill(0);
    this.hx.fill(0);
    this.hy.fill(0);
    this.step = 0;
  }

  /** Largest |Ez| anywhere inside the PML, for scaling the picture. */
  peak(): number {
    const { nx, ny, ez, pmlCells: d } = this;
    let peak = 0;
    for (let j = d; j < ny - d; j++) {
      const row = j * nx;
      for (let i = d; i < nx - d; i++) {
        const v = Math.abs(ez[row + i]!);
        if (v > peak) peak = v;
      }
    }
    return peak;
  }

  /** Electromagnetic energy stored inside the PML, joules per metre of depth. */
  energy(): number {
    const { nx, ny, ez, hx, hy, epsr, pmlCells: d, dx } = this;
    let sum = 0;
    for (let j = d; j < ny - d; j++) {
      const row = j * nx;
      for (let i = d; i < nx - d; i++) {
        const k = row + i;
        sum += 0.5 * EPS0 * epsr[k]! * ez[k]! * ez[k]! + 0.5 * MU0 * (hx[k]! * hx[k]! + hy[k]! * hy[k]!);
      }
    }
    return sum * dx * dx;
  }

  /** Ez at a cell. */
  at(i: number, j: number): number {
    return this.ez[i + j * this.nx] ?? 0;
  }
}
