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
  /** Peak flux in the hardest-worked core, as a share of saturation. */
  fluxOfSaturation: number;
}

/**
 * How hard the balun is working, judged the way the card is coloured:
 *   ok   - the core stays comfortably warm and well clear of saturation
 *   hot  - warm enough, or close enough to saturation, that runaway is a real risk:
 *          ferrite's loss and permeability move as it heats, so heat breeds more heat
 *   burn - it will almost certainly overheat or saturate and fail
 * The thresholds are EMWS's rules of thumb, not a datasheet's, and the temperature they
 * are applied to is itself a rough still-air estimate (see the balun tool). They are
 * deliberately set on the RISE, so they hold whatever the day's temperature.
 */
export type Strain = 'ok' | 'hot' | 'burn';

/** Temperature rise above ambient, degrees C, at which the card turns orange and red. */
export const RISE_HOT_C = 40;
export const RISE_BURN_C = 80;
/** Peak flux as a share of saturation at which the card turns orange and red. */
export const FLUX_HOT = 0.5;
export const FLUX_BURN = 0.9;

export function balunStrain(r: Pick<RadioSide, 'tempRiseC' | 'fluxOfSaturation'>): { level: Strain; reason: string } {
  const rise = r.tempRiseC;
  const flux = r.fluxOfSaturation;
  if (!Number.isFinite(rise) || !Number.isFinite(flux)) return { level: 'burn', reason: 'the core would take all the power' };
  if (rise >= RISE_BURN_C) return { level: 'burn', reason: `the core would run about ${rise.toFixed(0)} °C above the air: it will overheat` };
  if (flux >= FLUX_BURN) return { level: 'burn', reason: `the core is at ${(flux * 100).toFixed(0)} % of saturation` };
  if (rise >= RISE_HOT_C) return { level: 'hot', reason: `about ${rise.toFixed(0)} °C above the air: a risk of thermal runaway` };
  if (flux >= FLUX_HOT) return { level: 'hot', reason: `the core is at ${(flux * 100).toFixed(0)} % of saturation` };
  return { level: 'ok', reason: `about ${rise.toFixed(0)} °C above the air, ${(flux * 100).toFixed(0)} % of saturation` };
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
  return analysis.points.map((p) => ({ fMHz: p.fMHz, z: p.zIn, lossDb: p.lossDb, coreW: p.coreW, tempRiseC: p.tempRiseC, fluxOfSaturation: p.fluxOfSaturation }));
}
