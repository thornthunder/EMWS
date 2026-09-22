// Measuring the core in your hand.
//
// Wind a few turns on the core, sweep it with a VNA, and the impedance you read IS the
// permeability, scaled by the shape and the turns:
//
//     Z = j w L0 (mu' - j mu'')        L0 = mu0 N^2 / C1
//
// so the resistance you measure is the loss and the reactance is the inductance. That is
// better than any table, this tool's included: ferrite varies by a fifth or so from batch
// to batch, and the core on your bench is the one you are going to use.
//
// HOW TO GET A GOOD ONE.
//   - Few turns: five to ten on a big core. More turns means more capacitance across the
//     winding, which resonates with it and wrecks the reading above that frequency.
//   - Spread them out, and keep the leads short.
//   - A one-port measurement is happiest between about 5 and 500 ohms. If the winding runs
//     to kilohms across your sweep, use fewer turns.
//   - If you know the winding's capacitance, give it and it is taken out. If you do not,
//     trust the curve only well below where the reactance turns over.

import { type Complex, cInv, cSub } from '../../lib/complex';
import { type FerriteFamily, type PermeabilityPoint, permeabilityFromImpedance, toroidGeometry } from '../../lib/ferrite';
import type { MeasuredPoint } from '../../lib/touchstone';
import type { CoreSize, Material } from './catalog';

export interface MeasurementSetup {
  core: CoreSize;
  stack: number;
  turns: number;
  /** Capacitance across the test winding, pF, if known. It is removed before reading mu. */
  strayPf?: number;
  family?: FerriteFamily;
}

/** The permeability curve a swept impedance implies. */
export function permeabilityCurve(points: readonly MeasuredPoint[], setup: MeasurementSetup): PermeabilityPoint[] {
  const geometry = toroidGeometry(setup.core.odMm, setup.core.idMm, setup.core.heightMm, setup.stack);
  const curve: PermeabilityPoint[] = [];
  for (const p of points) {
    if (!(p.fMHz > 0)) continue;
    let z: Complex = p.z;
    if (setup.strayPf && setup.strayPf > 0) {
      // The stray sits across the winding, so it comes off as an admittance.
      const y = cSub(cInv(z), { re: 0, im: 2 * Math.PI * p.fMHz * 1e6 * setup.strayPf * 1e-12 });
      z = cInv(y);
    }
    const mu = permeabilityFromImpedance(z, geometry, setup.turns, p.fMHz);
    if (!Number.isFinite(mu.real) || !Number.isFinite(mu.loss)) continue;
    // Noise can push a tiny loss below zero; a passive core cannot have one.
    curve.push({ fMHz: p.fMHz, real: mu.real, loss: Math.max(0, mu.loss) });
  }
  return curve.sort((a, b) => a.fMHz - b.fMHz);
}

/**
 * Where the reading stops being the core and starts being the winding.
 *
 * NOT where the reactance peaks. A lossy ferrite's reactance peaks and falls all by
 * itself - above its relaxation frequency mu' drops faster than the frequency climbs - so
 * a turn-over is the material behaving normally, and a #43 winding does it in the low
 * megahertz with nothing wrong at all. What a bare core can never do is go CAPACITIVE.
 * Reactance passing through zero is the winding resonating with its own capacitance, and
 * that is the honest marker.
 *
 * The damage starts well below it: a capacitance across an inductance inflates the
 * apparent inductance by 1 / (1 - (f/f0)^2), which is about an eighth at a third of the
 * resonant frequency. So a third of it is returned - "trust the curve up to here". It is
 * undefined when the sweep never goes capacitive, which is the good case.
 */
export function trustworthyUpToMHz(points: readonly MeasuredPoint[]): number | undefined {
  const resonance = points.find((p) => p.z.im <= 0);
  return resonance ? resonance.fMHz / 3 : undefined;
}

/** A material built from a measurement, ready to stand in for a catalogue mix. */
export function measuredMaterial(name: string, points: readonly MeasuredPoint[], setup: MeasurementSetup): Material {
  const curve = permeabilityCurve(points, setup);
  return {
    id: `measured-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name,
    family: setup.family ?? 'NiZn',
    // The lowest frequency measured is the nearest thing to the initial permeability.
    muInitial: Math.max(1, Math.round(curve[0]?.real ?? 1)),
    curve,
    note: `measured: ${setup.turns} turns on ${setup.core.name}${setup.stack > 1 ? ` x${setup.stack}` : ''}`,
  };
}
