// What the matching network does to an impedance.
//
// Everything is worked out looking from the radio towards the load: start with the load
// impedance and transform it through each component in turn.

import { type Complex, cAbs, cAdd, cCosh, cDiv, cInv, cMul, cScale, cSinh, complex } from '../../lib/complex';
import { gammaFromImpedance, standingWaveRatio } from '../../lib/touchstone';
import type { Element, Load, Network } from './model';
import { sweepFrequencies } from './model';

/** Metres per second. */
const C = 299792458;
/** Nepers per decibel. */
const NEPERS_PER_DB = 1 / 8.685889638065035;

export function loadImpedance(load: Load, fMHz: number): Complex {
  if (load.kind === 'impedance') {
    if (load.follows === 'fixed' || load.ohmsX === 0 || load.atMHz <= 0) {
      return complex(load.ohmsR, load.ohmsX);
    }
    // Keep the reactance physical: an inductor's rises with frequency, a capacitor's falls.
    const ratio = fMHz / load.atMHz;
    return complex(load.ohmsR, load.ohmsX > 0 ? load.ohmsX * ratio : load.ohmsX / ratio);
  }

  const points = load.points;
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return complex(0, 0);
  if (fMHz <= first.fMHz) return first.z;
  if (fMHz >= last.fMHz) return last.z;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (fMHz <= b.fMHz) {
      const t = b.fMHz === a.fMHz ? 0 : (fMHz - a.fMHz) / (b.fMHz - a.fMHz);
      return complex(a.z.re + (b.z.re - a.z.re) * t, a.z.im + (b.z.im - a.z.im) * t);
    }
  }
  return last.z;
}

/** The impedance of the component itself (before it is put in series or in parallel). */
export function elementImpedance(element: Element, fMHz: number): Complex {
  const omega = 2 * Math.PI * fMHz * 1e6;
  switch (element.kind) {
    case 'inductor': {
      const x = omega * element.henries;
      return complex(element.q && element.q > 0 ? Math.abs(x) / element.q : 0, x);
    }
    case 'capacitor': {
      const x = element.farads === 0 ? -Infinity : -1 / (omega * element.farads);
      return complex(element.q && element.q > 0 ? Math.abs(x) / element.q : 0, x);
    }
    case 'resistor':
      return complex(element.ohms, 0);
    case 'stub': {
      const gl = propagation(element.lengthM, fMHz, element);
      const [top, bottom] =
        element.termination === 'short' ? [cSinh(gl), cCosh(gl)] : [cCosh(gl), cSinh(gl)];
      return cScale(cDiv(top, bottom), element.z0);
    }
    default:
      return complex(0, 0);
  }
}

/** γ·l for a length of line: loss and phase together. */
function propagation(
  lengthM: number,
  fMHz: number,
  line: { velocityFactor: number; lossDb100m: number; lossRefMHz: number },
): Complex {
  const beta = (2 * Math.PI * fMHz * 1e6) / (Math.max(0.01, line.velocityFactor) * C);
  // Matched line loss follows the skin effect, near enough: proportional to the square root of frequency.
  const scaled = line.lossDb100m * Math.sqrt(Math.max(0, fMHz) / Math.max(0.001, line.lossRefMHz));
  const alpha = (scaled / 100) * NEPERS_PER_DB;
  return complex(alpha * lengthM, beta * lengthM);
}

/** The impedance a length of line shows when it is terminated by `z`. */
export function throughLine(
  z: Complex,
  z0: number,
  lengthM: number,
  fMHz: number,
  line: { velocityFactor: number; lossDb100m: number; lossRefMHz: number },
): Complex {
  // Zin = Z0 (ZL cosh γl + Z0 sinh γl) / (Z0 cosh γl + ZL sinh γl). Written with cosh and
  // sinh rather than tanh, which is infinite a quarter wave along a lossless line.
  const gl = propagation(lengthM, fMHz, line);
  const cosh = cCosh(gl);
  const sinh = cSinh(gl);
  const numerator = cAdd(cMul(z, cosh), cScale(sinh, z0));
  const denominator = cAdd(cScale(cosh, z0), cMul(z, sinh));
  return cScale(cDiv(numerator, denominator), z0);
}

/** The impedance looking in through one component at an impedance `z`. */
export function transform(z: Complex, element: Element, fMHz: number): Complex {
  if (element.bypassed) return z;
  switch (element.kind) {
    case 'line':
      return throughLine(z, element.z0, element.lengthM, fMHz, element);
    case 'transformer':
      return cScale(z, 1 / Math.max(1e-9, element.ratio));
    default: {
      const own = elementImpedance(element, fMHz);
      return element.connection === 'series' ? cAdd(z, own) : cInv(cAdd(cInv(z), cInv(own)));
    }
  }
}

/** The impedance at every node, starting at the load and ending at the radio. */
export function chainImpedances(network: Network, fMHz: number): Complex[] {
  const nodes: Complex[] = [loadImpedance(network.load, fMHz)];
  for (const element of network.elements) {
    nodes.push(transform(nodes[nodes.length - 1]!, element, fMHz));
  }
  return nodes;
}

export function inputImpedance(network: Network, fMHz: number): Complex {
  const nodes = chainImpedances(network, fMHz);
  return nodes[nodes.length - 1]!;
}

/**
 * The curve one component draws on the chart, from the impedance it sees to the one it
 * presents: a component's value grown from nothing to its full value, or a line's length
 * from zero to its full length.
 */
export function elementPath(z: Complex, element: Element, fMHz: number, steps = 24): Complex[] {
  if (element.bypassed) return [z];
  const path: Complex[] = [z];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    path.push(partialTransform(z, element, fMHz, t));
  }
  return path;
}

function partialTransform(z: Complex, element: Element, fMHz: number, t: number): Complex {
  switch (element.kind) {
    case 'line':
      return throughLine(z, element.z0, element.lengthM * t, fMHz, element);
    case 'transformer':
      return cScale(z, 1 / Math.max(1e-9, element.ratio ** t));
    default: {
      // A series part adds its impedance, drawing a constant-resistance arc; a shunt part
      // adds its admittance, drawing a constant-conductance arc. Grow it from nothing.
      const own = elementImpedance(element, fMHz);
      return element.connection === 'series'
        ? cAdd(z, cScale(own, t))
        : cInv(cAdd(cInv(z), cScale(cInv(own), t)));
    }
  }
}

export interface SweepPoint {
  fMHz: number;
  z: Complex;
  gamma: Complex;
  swr: number;
}

export function sweepNetwork(network: Network): SweepPoint[] {
  return sweepFrequencies(network.sweep).map((fMHz) => {
    const z = inputImpedance(network, fMHz);
    const gamma = gammaFromImpedance(z, network.z0);
    return { fMHz, z, gamma, swr: standingWaveRatio(gamma) };
  });
}

export interface Bandwidth {
  lowMHz: number;
  highMHz: number;
  widthMHz: number;
}

/** The band around `aroundMHz` where SWR stays under `limit`, interpolated between sweep points. */
export function swrBandwidth(points: readonly SweepPoint[], limit: number, aroundMHz: number): Bandwidth | undefined {
  if (points.length < 2) return undefined;
  let centre = 0;
  for (let i = 1; i < points.length; i++) {
    if (Math.abs(points[i]!.fMHz - aroundMHz) < Math.abs(points[centre]!.fMHz - aroundMHz)) centre = i;
  }
  if (!(points[centre]!.swr <= limit)) return undefined;

  const cross = (a: SweepPoint, b: SweepPoint): number => {
    const span = b.swr - a.swr;
    const t = span === 0 ? 0 : (limit - a.swr) / span;
    return a.fMHz + (b.fMHz - a.fMHz) * Math.min(1, Math.max(0, t));
  };

  let low = points[0]!.fMHz;
  for (let i = centre; i > 0; i--) {
    if (points[i - 1]!.swr > limit) {
      low = cross(points[i]!, points[i - 1]!);
      break;
    }
  }
  let high = points[points.length - 1]!.fMHz;
  for (let i = centre; i < points.length - 1; i++) {
    if (points[i + 1]!.swr > limit) {
      high = cross(points[i]!, points[i + 1]!);
      break;
    }
  }
  return { lowMHz: low, highMHz: high, widthMHz: high - low };
}

/** Power lost between the radio and the load, in dB, at one frequency. */
export function mismatchLossDb(z: Complex, z0: number): number {
  const rho = cAbs(gammaFromImpedance(z, z0));
  return rho >= 1 ? Infinity : -10 * Math.log10(1 - rho * rho);
}
