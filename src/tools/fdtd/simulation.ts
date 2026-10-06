// Two-dimensional FDTD, in either polarisation.
//
//   TMz: Ez points out of the screen, Hx and Hy lie in it - a horizontal wire seen
//        end-on, when the screen is a vertical plane over the ground.
//   TEz: Hz points out of the screen, Ex and Ey lie in it - vertical polarisation in the
//        same picture, and the only one with a Brewster angle (reflection of p-polarised
//        light vanishes at tan θ = n; s-polarised, which TMz is, never does).
//
// A Yee grid stepped leapfrog in time, with Berenger's split-field PML round the edges
// so waves leave instead of bouncing back. TEz is TMz's exact dual - E and H swap roles,
// ε and μ swap with them - so the two share their grading and their PML. Everything is in
// SI units - the frequency sets the scale, so a 3 m world at 1 GHz is ten wavelengths
// across - but sources have amplitude 1, so the fields are relative, never volts per
// metre. Float32 arrays, nothing allocated per step.
//
// Point sources are soft (added to the field, so a wave passes through them). A PLANE WAVE
// comes in through a total-field / scattered-field boundary along the side it enters by
// (see planeWaveBoundary): free-space incident fields added on one side of it and taken off
// the other, which launches the wave one way only and lets everything the scene sends back
// pass out through it.
//
// What this world is: a cross-section. Every object is infinitely long into the screen,
// so a dot is a wire seen end-on and a line is a sheet. Written from the textbook
// equations (Yee 1966, Berenger 1994, Taflove), not from any program's source.

export const C0 = 299792458;
export const EPS0 = 8.8541878128e-12;
export const MU0 = 4e-7 * Math.PI;
export const ETA0 = Math.sqrt(MU0 / EPS0);

/** The absorbing edge's grading: polynomial order, and its reflection at normal incidence. */
const PML_ORDER = 3;
const PML_REFLECTION = 1e-8;

export type SourceKind = 'sine' | 'pulse';
export type Polarisation = 'tm' | 'te';
export type Side = 'left' | 'right' | 'top' | 'bottom';

export interface SourceCell {
  i: number;
  j: number;
  kind: SourceKind;
  fHz: number;
  amplitude: number;
  phaseRad: number;
}

/** A plane wave entering from one side, tilted by an angle from that side's normal. */
export interface PlaneWaveSpec {
  side: Side;
  /** Degrees from the side's inward normal; positive tilts towards +y (left/right sides) or +x (top/bottom). */
  angleDeg: number;
  kind: SourceKind;
  fHz: number;
  amplitude: number;
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
  planeWave?: PlaneWaveSpec;
}

/** Ricker wavelet with centre frequency f, peaking at t0 = 1.5 / f: a clean ping with no DC. */
export function ricker(t: number, fHz: number): number {
  const a = Math.PI * fHz * (t - 1.5 / fHz);
  const a2 = a * a;
  return (1 - 2 * a2) * Math.exp(-a2);
}

/** A sine that comes up smoothly over two periods, so the start does not ring the grid. */
export function rampedSine(t: number, fHz: number, phaseRad: number): number {
  if (t <= 0) return 0;
  const ramp = Math.min(1, (t * fHz) / 2);
  const smooth = 0.5 - 0.5 * Math.cos(Math.PI * ramp);
  return smooth * Math.sin(2 * Math.PI * fHz * t + phaseRad);
}

const waveform = (kind: SourceKind, t: number, fHz: number, phaseRad: number) => (kind === 'pulse' ? ricker(t, fHz) : rampedSine(t, fHz, phaseRad));

/** What the tool needs of an engine, whichever polarisation it runs. */
export interface FieldEngine {
  readonly nx: number;
  readonly ny: number;
  readonly dx: number;
  readonly dt: number;
  readonly polarisation: Polarisation;
  /** The component out of the screen: Ez in TMz, Hz in TEz. */
  readonly field: Float32Array;
  step: number;
  readonly time: number;
  advance(n?: number): void;
  reset(): void;
  peak(): number;
  energy(): number;
  at(i: number, j: number): number;
}

/** The grid, the PML grading and the sources: what the two polarisations share. */
abstract class Grid2D {
  readonly nx: number;
  readonly ny: number;
  readonly dx: number;
  readonly dt: number;
  readonly pmlCells: number;
  readonly sources: SourceCell[];
  readonly pec: Uint8Array;
  readonly epsr: Float32Array;
  step = 0;
  protected readonly planeWave?: PlaneWaveSpec;
  /** The plane wave's boundary, or an empty one. */
  protected readonly boundary: PlaneWaveBoundary;

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
    this.pec = spec.pec ? Uint8Array.from(spec.pec) : new Uint8Array(n);
    this.epsr = spec.epsr ? Float32Array.from(spec.epsr) : new Float32Array(n).fill(1);
    this.planeWave = spec.planeWave;
    const empty = (k: number) => !this.pec[k] && this.epsr[k] === 1 && (spec.sigma?.[k] ?? 0) === 0;
    this.boundary = spec.planeWave ? planeWaveBoundary(spec.planeWave, nx, ny, dx, this.pmlCells, empty) : emptyBoundary();
  }

  /** How much of the plane wave's boundary lies in something other than empty space, 0 to 1. */
  get planeWaveBuried(): number {
    const b = this.boundary;
    return b.links + b.buried > 0 ? b.buried / (b.links + b.buried) : 0;
  }

  /**
   * The plane wave's incident field at time t for each entry of one of the boundary's lists
   * (the waveform only: the engine applies the direction factor and its own coefficients).
   */
  protected incident(t: number, delays: Float64Array, scales: Float32Array, out: Float32Array): void {
    const pw = this.planeWave;
    if (!pw) return;
    for (let n = 0; n < delays.length; n++) out[n] = pw.amplitude * scales[n]! * waveform(pw.kind, t - delays[n]!, pw.fHz, 0);
  }

  /**
   * The wall behind the absorbing edges, for the out-of-screen field: a mirror (its
   * neighbour's value), so a front running along the wall - a plane wave square on to a
   * side - meets nothing there. Held at zero instead, it pulled the field down beside it and
   * a plane wave in empty space lost almost 40 % of its strength over 360 cells (MEASURED). With
   * no absorbing edge the wall is the conducting box the spec promises: zero for Ez, and the
   * mirror for Hz, which is what a conductor does to it.
   */
  protected mirrorWalls(f: Float32Array): void {
    const { nx, ny } = this;
    const top = (ny - 1) * nx;
    for (let i = 0; i < nx; i++) {
      f[i] = f[i + nx]!;
      f[top + i] = f[top - nx + i]!;
    }
    for (let j = 0; j < ny; j++) {
      const row = j * nx;
      f[row] = f[row + 1]!;
      f[row + nx - 1] = f[row + nx - 2]!;
    }
  }

  get time(): number {
    return this.step * this.dt;
  }

  /** Polynomial-graded PML conductivity at a depth into the layer, S/m. */
  protected pmlSigma(depthCells: number): number {
    const d = this.pmlCells;
    if (d <= 0 || depthCells <= 0) return 0;
    const m = PML_ORDER;
    const sigmaMax = (-(m + 1) * Math.log(PML_REFLECTION)) / (2 * ETA0 * d * this.dx);
    return sigmaMax * (depthCells / d) ** m;
  }

  /** Depth into the PML of a position along an axis of n cells (fractional positions for staggered components). */
  protected depth(position: number, n: number): number {
    const d = this.pmlCells;
    if (position < d) return d - position;
    const far = n - 1 - d;
    if (position > far) return position - far;
    return 0;
  }

  /** Adds every source's value at time t to the out-of-screen field, split evenly over its two halves. */
  protected inject(a: Float32Array, b: Float32Array, sum: Float32Array): void {
    const t = this.time;
    for (const source of this.sources) {
      const k = source.i + source.j * this.nx;
      if (this.pec[k]) continue;
      const value = source.amplitude * waveform(source.kind, t, source.fHz, source.phaseRad);
      a[k] = a[k]! + value / 2;
      b[k] = b[k]! + value / 2;
      sum[k] = a[k]! + b[k]!;
    }
  }
}

/**
 * Where a plane wave comes in: a total-field / scattered-field boundary (Taflove, ch. 5).
 * Inside it the grid holds the whole field, incident wave included; outside it only what
 * the scene sends back. Each link of the grid that crosses the boundary gets the incident
 * field added on one side and taken off the other, which launches the wave one way only.
 *
 * Its shape is an L, along the side the wave comes from and the adjacent side it slants in
 * from, each leg running on out through the absorbing edge at its far end, so every point
 * of the world is inside and the front has no end to diffract from. MEASURED on the way:
 * a single line along one side lit the far corner from inside the absorbing edge (standing
 * wave 8 above a dielectric where theory says 4); an L of plain sources, which radiate
 * backwards as well, diffracted ±10 % ripples off its corner.
 *
 * The incident wave is free space's, so links touching anything else stay silent: the
 * wave is launched into empty space only. A ground running into the side it comes from is
 * left out there, which `planeWaveBuried` reports.
 */
export interface PlaneWaveBoundary {
  /** Direction of travel, a unit vector (x, y). */
  readonly dir: readonly [number, number];
  /** The link's lower cell: the in-plane component sits between it and the next cell in x (axis 0) or y (axis 1). */
  readonly k: Int32Array;
  readonly axis: Uint8Array;
  /** 1 when the inside cell is the upper one of the link. */
  readonly plus: Uint8Array;
  /** Delay of the incident wave at the inside cell, and at the link's midpoint, seconds. */
  readonly nodeDelay: Float64Array;
  readonly midDelay: Float64Array;
  /** How much the absorbing edge has already damped the incident wave there, 1 outside it. */
  readonly nodeScale: Float32Array;
  readonly midScale: Float32Array;
  /** Scratch for the incident values, one per link, so a step allocates nothing. */
  readonly nodeValue: Float32Array;
  readonly midValue: Float32Array;
  readonly links: number;
  /** Links left silent because they touch something other than empty space. */
  readonly buried: number;
}

function emptyBoundary(): PlaneWaveBoundary {
  return {
    dir: [1, 0],
    k: new Int32Array(0),
    axis: new Uint8Array(0),
    plus: new Uint8Array(0),
    nodeDelay: new Float64Array(0),
    midDelay: new Float64Array(0),
    nodeScale: new Float32Array(0),
    midScale: new Float32Array(0),
    nodeValue: new Float32Array(0),
    midValue: new Float32Array(0),
    links: 0,
    buried: 0,
  };
}

/** The direction a plane wave travels in, from the side it enters by and its tilt. */
export function planeWaveDirection(pw: Pick<PlaneWaveSpec, 'side' | 'angleDeg'>): [number, number] {
  const a = (pw.angleDeg * Math.PI) / 180;
  const along = Math.sin(a);
  const across = Math.cos(a);
  switch (pw.side) {
    case 'top':
      return [along, -across];
    case 'bottom':
      return [along, across];
    case 'left':
      return [across, along];
    case 'right':
      return [-across, along];
  }
}

export function planeWaveBoundary(pw: PlaneWaveSpec, nx: number, ny: number, dx: number, pml: number, empty: (k: number) => boolean): PlaneWaveBoundary {
  const d = planeWaveDirection(pw);
  const tiny = 1e-9;
  const left = pml + 1;
  const right = nx - pml - 2;
  const bottom = pml + 1;
  const top = ny - pml - 2;
  const inside = (i: number, j: number) =>
    (d[0] > tiny ? i >= left : d[0] < -tiny ? i <= right : true) && (d[1] > tiny ? j >= bottom : d[1] < -tiny ? j <= top : true);
  const delay = (x: number, y: number) => ((x * d[0] + y * d[1]) * dx) / C0;
  // Where the legs run on through an absorbing edge, the incident wave there is the one that
  // edge has already damped: R^(|cos| (depth / thickness)^(m + 1) / 2) for the grading below.
  // Undamped, the legs fed it a wave the grid no longer held and the front rippled ±40 %
  // at 30° (MEASURED).
  const depth = (p: number, n: number) => (p < pml ? pml - p : p > n - 1 - pml ? p - (n - 1 - pml) : 0);
  const damping = (x: number, y: number) =>
    pml > 0 ? Math.exp((Math.log(PML_REFLECTION) / 2) * (Math.abs(d[0]) * (depth(x, nx) / pml) ** (PML_ORDER + 1) + Math.abs(d[1]) * (depth(y, ny) / pml) ** (PML_ORDER + 1))) : 1;
  const ks: number[] = [];
  const axes: number[] = [];
  const pluses: number[] = [];
  const nodes: number[] = [];
  const mids: number[] = [];
  const nodeScales: number[] = [];
  const midScales: number[] = [];
  let buried = 0;
  const link = (i: number, j: number, axis: 0 | 1) => {
    const i2 = axis === 0 ? i + 1 : i;
    const j2 = axis === 0 ? j : j + 1;
    const a = inside(i, j);
    if (a === inside(i2, j2)) return;
    const k = i + j * nx;
    if (!empty(k) || !empty(i2 + j2 * nx)) {
      buried++;
      return;
    }
    ks.push(k);
    axes.push(axis);
    pluses.push(a ? 0 : 1);
    nodes.push(a ? delay(i, j) : delay(i2, j2));
    nodeScales.push(a ? damping(i, j) : damping(i2, j2));
    const mx = axis === 0 ? i + 0.5 : i;
    const my = axis === 0 ? j : j + 0.5;
    mids.push(delay(mx, my));
    midScales.push(damping(mx, my));
  };
  // The outer ring is the wall, never updated, so links reach no further than it.
  for (let j = 1; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) link(i, j, 0);
  for (let j = 0; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) link(i, j, 1);
  let first = Infinity;
  for (const t of nodes) first = Math.min(first, t);
  for (const t of mids) first = Math.min(first, t);
  if (!Number.isFinite(first)) first = 0;
  return {
    dir: d,
    k: Int32Array.from(ks),
    axis: Uint8Array.from(axes),
    plus: Uint8Array.from(pluses),
    nodeDelay: Float64Array.from(nodes, (t) => t - first),
    midDelay: Float64Array.from(mids, (t) => t - first),
    nodeScale: Float32Array.from(nodeScales),
    midScale: Float32Array.from(midScales),
    nodeValue: new Float32Array(ks.length),
    midValue: new Float32Array(ks.length),
    links: ks.length,
    buried,
  };
}

/** TMz: Ez out of the screen. */
export class Simulation extends Grid2D implements FieldEngine {
  readonly polarisation = 'tm' as const;
  /** Ez = ezx + ezy, kept summed here after every step for painting and probing. */
  readonly ez: Float32Array;
  readonly hx: Float32Array;
  readonly hy: Float32Array;

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
    super(spec);
    const n = this.nx * this.ny;
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
    this.buildCoefficients(spec.sigma);
  }

  get field(): Float32Array {
    return this.ez;
  }

  private buildCoefficients(sigma: Float32Array | undefined): void {
    const { nx, ny, dx, dt } = this;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = i + j * nx;
        const eps = EPS0 * this.epsr[k]!;
        const material = sigma?.[k] ?? 0;
        // The PML stays matched in a dielectric only if its electric loss scales with εr
        // (Berenger's condition σ / ε = σ* / μ). Unscaled, a ground that runs into the
        // absorbing edge was reflected by it.
        const sx = material + this.pmlSigma(this.depth(i, nx)) * this.epsr[k]!;
        const sy = material + this.pmlSigma(this.depth(j, ny)) * this.epsr[k]!;
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
      this.boundaryH();
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
      this.boundaryE();
      this.step++;
      this.inject(ezx, ezy, ez);
      if (this.pmlCells > 0) this.mirrorWalls(ez);
    }
  }

  /** The plane wave's links, H side: the scattered H beside the boundary sees the incident Ez taken off. */
  private boundaryH(): void {
    const b = this.boundary;
    if (!b.links) return;
    this.incident(this.time, b.nodeDelay, b.nodeScale, b.nodeValue);
    const { hx, hy, dbX, dbY } = this;
    for (let n = 0; n < b.links; n++) {
      const k = b.k[n]!;
      const v = b.nodeValue[n]!;
      if (b.axis[n] === 0) hy[k] = hy[k]! + (b.plus[n] ? -1 : 1) * dbX[k]! * v;
      else hx[k] = hx[k]! + (b.plus[n] ? 1 : -1) * dbY[k]! * v;
    }
  }

  /** The plane wave's links, E side: the total Ez inside sees the incident H added. Incident H = d x z Ez / eta. */
  private boundaryE(): void {
    const b = this.boundary;
    if (!b.links) return;
    this.incident(this.time + this.dt / 2, b.midDelay, b.midScale, b.midValue);
    const { nx, ez, ezx, ezy, cbX, cbY } = this;
    const [d0, d1] = b.dir;
    for (let n = 0; n < b.links; n++) {
      const k = b.k[n]!;
      const plus = b.plus[n]!;
      const v = b.midValue[n]! / ETA0;
      if (b.axis[n] === 0) {
        const m = plus ? k + 1 : k;
        ezx[m] = ezx[m]! + (plus ? -1 : 1) * cbX[m]! * -d0 * v;
        ez[m] = ezx[m]! + ezy[m]!;
      } else {
        const m = plus ? k + nx : k;
        ezy[m] = ezy[m]! + (plus ? 1 : -1) * cbY[m]! * d1 * v;
        ez[m] = ezx[m]! + ezy[m]!;
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
    return peakInside(this.ez, this.nx, this.ny, this.pmlCells);
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

/**
 * TEz: Hz out of the screen, Ex and Ey in it - the dual of TMz. Hz sits at the cell
 * centres, split into the halves that see the x and the y derivative; Ex sits at j + 1/2
 * and Ey at i + 1/2, each with the permittivity and conductivity averaged across the two
 * cells it lies between, and held at zero beside a conductor (tangential E vanishes there).
 */
export class SimulationTE extends Grid2D implements FieldEngine {
  readonly polarisation = 'te' as const;
  /** Hz = hzx + hzy, kept summed after every step. */
  readonly hz: Float32Array;
  readonly ex: Float32Array;
  readonly ey: Float32Array;

  private readonly hzx: Float32Array;
  private readonly hzy: Float32Array;
  private readonly caEx: Float32Array;
  private readonly cbEx: Float32Array;
  private readonly caEy: Float32Array;
  private readonly cbEy: Float32Array;
  private readonly daX: Float32Array;
  private readonly dbX: Float32Array;
  private readonly daY: Float32Array;
  private readonly dbY: Float32Array;

  constructor(spec: SimulationSpec) {
    super(spec);
    const n = this.nx * this.ny;
    this.hz = new Float32Array(n);
    this.hzx = new Float32Array(n);
    this.hzy = new Float32Array(n);
    this.ex = new Float32Array(n);
    this.ey = new Float32Array(n);
    this.caEx = new Float32Array(n);
    this.cbEx = new Float32Array(n);
    this.caEy = new Float32Array(n);
    this.cbEy = new Float32Array(n);
    this.daX = new Float32Array(n);
    this.dbX = new Float32Array(n);
    this.daY = new Float32Array(n);
    this.dbY = new Float32Array(n);
    this.buildCoefficients(spec.sigma);
  }

  get field(): Float32Array {
    return this.hz;
  }

  private buildCoefficients(sigma: Float32Array | undefined): void {
    const { nx, ny, dx, dt, epsr, pec } = this;
    const at = (a: Float32Array | undefined, k: number, fallback: number) => (a ? a[k]! : fallback);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = i + j * nx;
        // Ex at (i, j + 1/2): between this cell and the one above; graded in y.
        const up = j + 1 < ny ? k + nx : k;
        {
          const eps = (EPS0 * (epsr[k]! + epsr[up]!)) / 2;
          // PML loss scaled by εr to stay matched in a dielectric, as in TMz.
          const s = (at(sigma, k, 0) + at(sigma, up, 0)) / 2 + (this.pmlSigma(this.depth(j + 0.5, ny)) * eps) / EPS0;
          const a = (s * dt) / (2 * eps);
          const blocked = pec[k] || pec[up];
          this.caEx[k] = blocked ? 0 : (1 - a) / (1 + a);
          this.cbEx[k] = blocked ? 0 : dt / eps / (1 + a) / dx;
        }
        // Ey at (i + 1/2, j): between this cell and the one to the right; graded in x.
        const right = i + 1 < nx ? k + 1 : k;
        {
          const eps = (EPS0 * (epsr[k]! + epsr[right]!)) / 2;
          const s = (at(sigma, k, 0) + at(sigma, right, 0)) / 2 + (this.pmlSigma(this.depth(i + 0.5, nx)) * eps) / EPS0;
          const a = (s * dt) / (2 * eps);
          const blocked = pec[k] || pec[right];
          this.caEy[k] = blocked ? 0 : (1 - a) / (1 + a);
          this.cbEy[k] = blocked ? 0 : dt / eps / (1 + a) / dx;
        }
        // Hz's halves at the centre: magnetic loss graded in x and in y.
        const sxStar = (this.pmlSigma(this.depth(i, nx)) * MU0) / EPS0;
        const syStar = (this.pmlSigma(this.depth(j, ny)) * MU0) / EPS0;
        const bx = (sxStar * dt) / (2 * MU0);
        const by = (syStar * dt) / (2 * MU0);
        this.daX[k] = (1 - bx) / (1 + bx);
        this.dbX[k] = dt / MU0 / (1 + bx) / dx;
        this.daY[k] = (1 - by) / (1 + by);
        this.dbY[k] = dt / MU0 / (1 + by) / dx;
      }
    }
  }

  advance(n = 1): void {
    const { nx, ny, hz, hzx, hzy, ex, ey, caEx, cbEx, caEy, cbEy, daX, dbX, daY, dbY } = this;
    for (let s = 0; s < n; s++) {
      // E from the curl of Hz: dEx/dt = (1/ε) dHz/dy, dEy/dt = -(1/ε) dHz/dx.
      for (let j = 0; j < ny - 1; j++) {
        const row = j * nx;
        for (let i = 0; i < nx - 1; i++) {
          const k = row + i;
          ex[k] = caEx[k]! * ex[k]! + cbEx[k]! * (hz[k + nx]! - hz[k]!);
          ey[k] = caEy[k]! * ey[k]! - cbEy[k]! * (hz[k + 1]! - hz[k]!);
        }
      }
      this.boundaryE();
      // Hz from the curl of E, in its two split halves: dHz/dt = (1/μ)(dEx/dy - dEy/dx).
      for (let j = 1; j < ny - 1; j++) {
        const row = j * nx;
        for (let i = 1; i < nx - 1; i++) {
          const k = row + i;
          const x = daX[k]! * hzx[k]! - dbX[k]! * (ey[k]! - ey[k - 1]!);
          const y = daY[k]! * hzy[k]! + dbY[k]! * (ex[k]! - ex[k - nx]!);
          hzx[k] = x;
          hzy[k] = y;
          hz[k] = x + y;
        }
      }
      this.boundaryH();
      this.step++;
      this.inject(hzx, hzy, hz);
      this.mirrorWalls(hz);
    }
  }

  /** The plane wave's links, E side: the scattered E beside the boundary sees the incident Hz taken off. */
  private boundaryE(): void {
    const b = this.boundary;
    if (!b.links) return;
    this.incident(this.time, b.nodeDelay, b.nodeScale, b.nodeValue);
    const { ex, ey, cbEx, cbEy } = this;
    for (let n = 0; n < b.links; n++) {
      const k = b.k[n]!;
      const v = b.nodeValue[n]!;
      if (b.axis[n] === 0) ey[k] = ey[k]! + (b.plus[n] ? 1 : -1) * cbEy[k]! * v;
      else ex[k] = ex[k]! + (b.plus[n] ? -1 : 1) * cbEx[k]! * v;
    }
  }

  /** The plane wave's links, H side: the total Hz inside sees the incident E added. Incident E = eta Hz (-d1, d0). */
  private boundaryH(): void {
    const b = this.boundary;
    if (!b.links) return;
    this.incident(this.time + this.dt / 2, b.midDelay, b.midScale, b.midValue);
    const { nx, hz, hzx, hzy, dbX, dbY } = this;
    const [d0, d1] = b.dir;
    for (let n = 0; n < b.links; n++) {
      const k = b.k[n]!;
      const plus = b.plus[n]!;
      const v = b.midValue[n]! * ETA0;
      if (b.axis[n] === 0) {
        const m = plus ? k + 1 : k;
        hzx[m] = hzx[m]! + (plus ? 1 : -1) * dbX[m]! * d0 * v;
        hz[m] = hzx[m]! + hzy[m]!;
      } else {
        const m = plus ? k + nx : k;
        hzy[m] = hzy[m]! + (plus ? -1 : 1) * dbY[m]! * -d1 * v;
        hz[m] = hzx[m]! + hzy[m]!;
      }
    }
  }

  reset(): void {
    this.hz.fill(0);
    this.hzx.fill(0);
    this.hzy.fill(0);
    this.ex.fill(0);
    this.ey.fill(0);
    this.step = 0;
  }

  peak(): number {
    return peakInside(this.hz, this.nx, this.ny, this.pmlCells);
  }

  energy(): number {
    const { nx, ny, hz, ex, ey, epsr, pmlCells: d, dx } = this;
    let sum = 0;
    for (let j = d; j < ny - d; j++) {
      const row = j * nx;
      for (let i = d; i < nx - d; i++) {
        const k = row + i;
        sum += 0.5 * MU0 * hz[k]! * hz[k]! + 0.5 * EPS0 * epsr[k]! * (ex[k]! * ex[k]! + ey[k]! * ey[k]!);
      }
    }
    return sum * dx * dx;
  }

  at(i: number, j: number): number {
    return this.hz[i + j * this.nx] ?? 0;
  }
}

function peakInside(field: Float32Array, nx: number, ny: number, d: number): number {
  let peak = 0;
  for (let j = d; j < ny - d; j++) {
    const row = j * nx;
    for (let i = d; i < nx - d; i++) {
      const v = Math.abs(field[row + i]!);
      if (v > peak) peak = v;
    }
  }
  return peak;
}

/** Either engine, by polarisation. */
export function makeEngine(polarisation: Polarisation, spec: SimulationSpec): FieldEngine {
  return polarisation === 'te' ? new SimulationTE(spec) : new Simulation(spec);
}
