// The run of coax between the radio and the feed point (or the balun on it).
//
// NEC reports the antenna and the balun tool reports the balun; this is the last piece of
// the station: a length of real cable. The matched loss comes from the RF toolbox's cable
// model (a calculated floor for a catalogue type, or the datasheet cable typed in there,
// used exactly), and the transform along the run is the ABCD of a lossy line - cosh and
// sinh, never tanh, for the Smith chart's reason: tanh is infinite a quarter wave along a
// lossless line and quietly wrong near it.
//
// Public domain (The Unlicense). By ZR1JT.

import { type Complex, cAdd, cDiv, cMul } from '../../lib/complex';
import { C0 } from '../lc/coil';
import { type Cable, DB_PER_NEPER, matchedLossPer100m } from '../toolbox/coax';
import { savedDatasheetCable } from '../toolbox/model';

export interface LineSide {
  fMHz: number;
  /** At the radio end of the run. */
  z: Complex;
  /** Lost in the cable, dB: the matched loss plus what the standing waves add. */
  lossDb: number;
  /** The matched part alone, dB. */
  matchedDb: number;
}

/**
 * The impedance and loss at the radio end of a run, frequency by frequency, with the
 * modelled impedance (or the balun's radio side) as its load.
 *
 * The power is walked exactly, as the balun tool walks its chain: set the load current to
 * one, take the line's ABCD back to the input, and the loss is P(in) / P(load). For a
 * real Z0 this lands on the classic (a² - ρ²) / (a (1 - ρ²)) to the last digit - a test
 * holds it there - but it also gives the input impedance, which the classic does not.
 */
export function throughLine(cable: Cable, lengthM: number, points: readonly { fMHz: number; z: Complex }[]): LineSide[] {
  return points.map(({ fMHz, z: load }) => {
    const matchedDb = (matchedLossPer100m(cable, fMHz).totalDb * lengthM) / 100;
    const alpha = matchedDb / DB_PER_NEPER; // nepers over the whole run
    const beta = (2 * Math.PI * fMHz * 1e6 * lengthM) / (C0 * cable.velocityFactor); // radians over the run
    const ch: Complex = { re: Math.cosh(alpha) * Math.cos(beta), im: Math.sinh(alpha) * Math.sin(beta) };
    const sh: Complex = { re: Math.sinh(alpha) * Math.cos(beta), im: Math.cosh(alpha) * Math.sin(beta) };
    const z0: Complex = { re: cable.z0, im: 0 };
    // With the load current set to 1: V = Z_L, so V_in = ch·Z_L + Z0·sh and I_in = sh·Z_L/Z0 + ch.
    const vIn = cAdd(cMul(ch, load), cMul(z0, sh));
    const iIn = cAdd(cDiv(cMul(sh, load), z0), ch);
    const pLoad = load.re / 2;
    const pIn = (vIn.re * iIn.re + vIn.im * iIn.im) / 2;
    const z = cDiv(vIn, iIn);
    const lossDb = pLoad > 0 && pIn > 0 ? 10 * Math.log10(pIn / pLoad) : Infinity;
    return { fMHz, z, lossDb, matchedDb };
  });
}

/** The cable typed into the RF toolbox under "From its datasheet" (kept with the toolbox's state). */
export function toolboxDatasheetCable(): Cable {
  return savedDatasheetCable();
}
