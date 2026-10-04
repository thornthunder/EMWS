// Resistive attenuators: Pi and T pads between any two impedances, the minimum-loss L pad
// as the limiting case, and what the pad really does once its resistors are rounded to
// values you can buy.
//
// Design is by the closed forms; the report is by circuit analysis of the resistors as
// given, so the two agree exactly for the designed pad and the E24 version shows its true
// attenuation and match. Dissipation is found from the same analysis, so the resistors'
// powers and the load's add up to the power going in.

import { E24, nearestStandard } from '../lc/filter';

export type Topology = 'pi' | 'tee';

export interface Pad {
  topology: Topology;
  /** Pi: the shunt resistor at the input. T: the series resistor at the input. */
  r1: number;
  /** Pi: the shunt resistor at the output. T: the series resistor at the output. */
  r2: number;
  /** Pi: the series resistor between the two. T: the shunt resistor between the two. */
  r3: number;
}

/** A shunt that is not there is infinite; a series arm that is not there is zero. */
const par = (a: number, b: number): number => (!Number.isFinite(a) ? b : !Number.isFinite(b) ? a : a + b === 0 ? 0 : (a * b) / (a + b));

/** The least a resistive pad can lose between two impedances: zero when they are equal. */
export function minimumLossDb(z1: number, z2: number): number {
  if (!(z1 > 0) || !(z2 > 0)) return NaN;
  if (z1 === z2) return 0;
  const k = Math.max(z1, z2) / Math.min(z1, z2);
  return 10 * Math.log10(2 * k - 1 + 2 * Math.sqrt(k * (k - 1)));
}

/**
 * A Pi or T pad of the given attenuation between z1 (input) and z2 (output), or undefined
 * when that attenuation is below the minimum for the pair. At exactly the minimum one
 * resistor vanishes and the pad is the L pad.
 */
export function designPad(topology: Topology, attenuationDb: number, z1: number, z2 = z1): Pad | undefined {
  if (!(attenuationDb > 0) || !(z1 > 0) || !(z2 > 0)) return undefined;
  if (attenuationDb < minimumLossDb(z1, z2) - 1e-9) return undefined;
  const n = 10 ** (attenuationDb / 10);
  const tidy = (r: number) => (Math.abs(r) < 1e-9 ? 0 : r);
  if (topology === 'tee') {
    const r3 = (2 * Math.sqrt(n * z1 * z2)) / (n - 1);
    return { topology, r1: tidy((z1 * (n + 1)) / (n - 1) - r3), r2: tidy((z2 * (n + 1)) / (n - 1) - r3), r3 };
  }
  const r3 = ((n - 1) / 2) * Math.sqrt((z1 * z2) / n);
  const shunt = (z: number) => {
    const g = (n + 1) / ((n - 1) * z) - 1 / r3;
    return g <= 1e-12 ? Infinity : 1 / g;
  };
  return { topology, r1: shunt(z1), r2: shunt(z2), r3 };
}

/** The minimum-loss L pad between two impedances: a series arm on the high side, a shunt on the low. */
export function minimumLossPad(z1: number, z2: number): Pad | undefined {
  if (z1 === z2) return undefined;
  return designPad('tee', minimumLossDb(z1, z2), z1, z2);
}

export interface PadReport {
  /** Available power at the input to power in the load, dB: the loss a wattmeter sees. */
  attenuationDb: number;
  zIn: number;
  zOut: number;
  returnLossInDb: number;
  returnLossOutDb: number;
  /** Watts in each resistor and in the load, for `inputW` going into the pad. */
  dissipationW: { r1: number; r2: number; r3: number; load: number };
}

const returnLoss = (z: number, z0: number): number => {
  const rho = Math.abs(z - z0) / (z + z0);
  return rho === 0 ? Infinity : -20 * Math.log10(rho);
};

/** Analyses a pad as built, between a source of impedance z1 and a load of z2. */
export function evaluatePad(pad: Pad, z1: number, z2: number, inputW = 1): PadReport {
  // A 2 V Thevenin source behind z1: its available power is 1 / z1.
  const pAvailable = 1 / z1;
  let zIn: number;
  let zOut: number;
  let vIn: number;
  let iIn: number;
  let vOut: number;
  let heat: { r1: number; r2: number; r3: number };
  if (pad.topology === 'tee') {
    const tail = pad.r2 + z2;
    const mid = par(pad.r3, tail);
    zIn = pad.r1 + mid;
    iIn = 2 / (z1 + zIn);
    vIn = iIn * zIn;
    const vMid = iIn * mid;
    vOut = (vMid * z2) / tail;
    const iOut = vOut / z2;
    heat = { r1: iIn * iIn * pad.r1, r2: iOut * iOut * pad.r2, r3: Number.isFinite(pad.r3) ? (vMid * vMid) / pad.r3 : 0 };
    zOut = pad.r2 + par(pad.r3, pad.r1 + z1);
  } else {
    const outNode = par(pad.r2, z2);
    const branch = pad.r3 + outNode;
    zIn = par(pad.r1, branch);
    iIn = 2 / (z1 + zIn);
    vIn = iIn * zIn;
    vOut = (vIn * outNode) / branch;
    heat = {
      r1: Number.isFinite(pad.r1) ? (vIn * vIn) / pad.r1 : 0,
      r2: Number.isFinite(pad.r2) ? (vOut * vOut) / pad.r2 : 0,
      r3: ((vIn - vOut) * (vIn - vOut)) / pad.r3,
    };
    zOut = par(pad.r2, pad.r3 + par(pad.r1, z1));
  }
  const pLoad = (vOut * vOut) / z2;
  const scale = inputW / (vIn * iIn);
  return {
    attenuationDb: 10 * Math.log10(pAvailable / pLoad),
    zIn,
    zOut,
    returnLossInDb: returnLoss(zIn, z1),
    returnLossOutDb: returnLoss(zOut, z2),
    dissipationW: { r1: heat.r1 * scale, r2: heat.r2 * scale, r3: heat.r3 * scale, load: pLoad * scale },
  };
}

/** The same pad with every resistor rounded to the nearest preferred value; absent ones stay absent. */
export function snapPad(pad: Pad, series: readonly number[] = E24): Pad {
  const snap = (r: number) => (r === 0 || !Number.isFinite(r) ? r : nearestStandard(r, series));
  return { topology: pad.topology, r1: snap(pad.r1), r2: snap(pad.r2), r3: snap(pad.r3) };
}
