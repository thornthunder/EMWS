// What the loads have to survive: volts across them and heat in them at your power.
//
// NEC solves the antenna for the source voltage the deck gives it (one volt), and
// reports every segment's current and the power that went in. Scale those to the power
// you will really run and the voltage across a trap, the current through a coil and the
// watts it turns into heat all follow - which is what decides whether a capacitor lives
// and a coil stays cool. NEC's phasors are peak amplitudes and its power is the average,
// so peak volts are reported as such, and currents as RMS, the way parts are rated.
//
// Public domain (The Unlicense). By ZR1JT.

import type { FrequencyResult } from '../../engine/nec2/types';
import { type Complex, cAbs } from '../../lib/complex';
import { type AntennaModel, type Load, loadImpedance } from './model';

export interface LoadRating {
  load: Load;
  /** Where it sits, for the person: "Wire 2, segment 1". */
  where: string;
  /** The load's impedance at this frequency. */
  z: Complex;
  ampsRms: number;
  voltsPeak: number;
  heatW: number;
}

/** Peak current amplitude in the segment that carries the load, at the solved power. */
function segmentCurrent(model: AntennaModel, frequency: FrequencyResult, load: Load): number | undefined {
  const wire = model.wires.find((w) => w.id === load.wireId);
  if (!wire) return undefined;
  const onWire = frequency.currents.filter((c) => c.tag === wire.tag);
  return onWire[load.segment - 1]?.magnitude;
}

/**
 * Every load's volts, amps and heat, with the solve scaled to `powerW` into the feed
 * point. The scaling is by the power NEC says went in, not by the feed voltage, so it
 * holds for several feeds and for any excitation the deck used.
 */
export function loadRatings(model: AntennaModel, frequency: FrequencyResult, powerW: number): LoadRating[] {
  const solvedW = frequency.power?.inputW ?? frequency.feeds.reduce((sum, f) => sum + f.powerW, 0);
  if (!(solvedW > 0) || !(powerW >= 0)) return [];
  const k = Math.sqrt(powerW / solvedW);
  const ratings: LoadRating[] = [];
  for (const load of model.loads) {
    const peak = segmentCurrent(model, frequency, load);
    const wire = model.wires.find((w) => w.id === load.wireId);
    if (peak === undefined || !wire) continue;
    const z = loadImpedance(load, frequency.frequencyMHz);
    const amps = k * peak;
    const magnitude = cAbs(z);
    ratings.push({
      load,
      where: `Wire ${wire.tag}, segment ${load.segment}`,
      z,
      ampsRms: amps / Math.SQRT2,
      voltsPeak: Number.isFinite(magnitude) ? amps * magnitude : Infinity,
      heatW: Number.isFinite(z.re) ? 0.5 * amps * amps * z.re : Infinity,
    });
  }
  return ratings;
}

/** A load's name for the person: its label, or what its parts make it. */
export function loadName(load: Load): string {
  if (load.label) return load.label;
  if (load.kind === 'parallel') return 'trap';
  if (load.kind === 'impedance') return 'R + jX';
  const hasL = load.henries > 0;
  const hasC = load.farads > 0;
  if (hasL && !hasC) return 'coil';
  if (hasC && !hasL) return 'capacitor';
  if (!hasL && !hasC) return 'resistor';
  return 'series LC';
}
