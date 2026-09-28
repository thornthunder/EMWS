// What the radio sees through one of your baluns: the Antenna Modeler's side of the
// component library.
//
// NEC reports the antenna's own feed impedance. A balun you have designed - and, if you
// measured its core, calibrated - is a two-port the balun tool already knows how to solve
// at any frequency into any load. So: take the modelled impedance at each solved
// frequency as the load, run the balun's chain at exactly those frequencies, and the
// radio-side impedance, the SWR the radio sees and the balun's own loss all follow.
//
// Public domain (The Unlicense). By ZR1JT.

import type { Complex } from '../../lib/complex';
import type { Material } from '../balun/catalog';
import { analyse } from '../balun/circuit';
import { type SavedBalun, loadSavedBaluns, materialFor } from '../balun/library';
import { loadProfiles } from '../balun/profiles';

export interface ThroughOption {
  saved: SavedBalun;
  /** Undefined when the design was wound on a measured core that has since been deleted. */
  material: Material | undefined;
}

/** Every saved balun, with the material it needs looked up now. */
export function throughOptions(): ThroughOption[] {
  const profiles = loadProfiles();
  return loadSavedBaluns().map((saved) => ({ saved, material: materialFor(saved.design, profiles) }));
}

export interface RadioSide {
  fMHz: number;
  /** At the radio's connector. */
  z: Complex;
  /** Inside the balun alone, dB. */
  lossDb: number;
  coreW: number;
  tempRiseC: number;
}

/** The antenna's impedance at each frequency, seen from the radio through the balun. */
export function radioSide(balun: { saved: SavedBalun; material: Material }, points: readonly { fMHz: number; z: Complex }[]): RadioSide[] {
  if (points.length === 0) return [];
  const byFrequency = new Map(points.map((p) => [p.fMHz, p.z]));
  const analysis = analyse(
    balun.saved.design,
    balun.material,
    (fMHz) => byFrequency.get(fMHz) ?? points[0]!.z,
    points.map((p) => p.fMHz),
  );
  return analysis.points.map((p) => ({ fMHz: p.fMHz, z: p.zIn, lossDb: p.lossDb, coreW: p.coreW, tempRiseC: p.tempRiseC }));
}
