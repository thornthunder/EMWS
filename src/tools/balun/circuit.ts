// What a wound transformer does, frequency by frequency.
//
// Each design becomes a chain of two-ports between the radio and the load - a capacitor
// across the input, the core's magnetising impedance, copper, leakage, an ideal ratio, the
// winding's own capacitance, or a length of transmission line - and the chain is solved
// the way it is wired.
//
// Two things are done carefully here because everything downstream leans on them:
//
//   1. Losses are found by WALKING THE CHAIN BACK FROM THE LOAD and taking the difference
//      between the power going into each stage and the power coming out. Nothing is
//      estimated separately and added up afterwards, so the books balance by construction:
//      core + copper + line + load = what the radio delivered. The tests hold it to that.
//   2. The core's loss comes from the SAME complex permeability as its inductance. They
//      are not two models that might disagree; they are the two halves of one number.

import { type Complex, cAbs, cAdd, cCosh, cDiv, cInv, cMul, cScale, cSinh, complex } from '../../lib/complex';
import {
  type Permeability,
  type ToroidGeometry,
  coreImpedance,
  debyePermeability,
  interpolatePermeability,
  inductanceFactor,
  snoekRelaxationMHz,
  toroidGeometry,
} from '../../lib/ferrite';
import { type Material, SATURATION_T } from './catalog';
import { type Design, coreOf, summarise, tappedTurns, wireOf } from './model';
import { copperOhmsPerM, leakageInductanceH, lineLengthM, lineProperties, temperatureRiseC, turnLengthM, windingCapacitanceF } from './strays';

const C0 = 299_792_458;

/** A two-port, as the matrix that takes (V, I) at its output to (V, I) at its input. */
interface Abcd {
  a: Complex;
  b: Complex;
  c: Complex;
  d: Complex;
}

const ONE = complex(1);
const NONE = complex(0);
const series = (z: Complex): Abcd => ({ a: ONE, b: z, c: NONE, d: ONE });
const shunt = (y: Complex): Abcd => ({ a: ONE, b: NONE, c: y, d: ONE });
/** n is the voltage step-up, output over input. */
const ideal = (n: number): Abcd => ({ a: complex(1 / n), b: NONE, c: NONE, d: complex(n) });

/** A length of line with conductor loss. cosh and sinh, never tanh: see the Smith chart. */
function line(z0: number, lengthM: number, velocityFactor: number, ohmsPerM: number, fMHz: number): Abcd {
  const gammaL = complex((ohmsPerM / (2 * z0)) * lengthM, ((2 * Math.PI * fMHz * 1e6) / (C0 * velocityFactor)) * lengthM);
  const ch = cCosh(gammaL);
  const sh = cSinh(gammaL);
  return { a: ch, b: cScale(sh, z0), c: cScale(sh, 1 / z0), d: ch };
}

/**
 * Two identical lines with their inputs in parallel and their outputs in series - the
 * heart of a 1:4 Guanella. If one line is [A B; C D], the pair is [A/2 B; C 2D]: half the
 * voltage ratio, twice the current. Its determinant is still 1, as a reciprocal network's
 * must be.
 */
const parallelInSeriesOut = (m: Abcd): Abcd => ({ a: cScale(m.a, 0.5), b: m.b, c: m.c, d: cScale(m.d, 2) });

type Where = 'core' | 'copper' | 'line' | 'lossless';

interface Stage {
  where: Where;
  m: Abcd;
}

export function permeabilityOf(material: Material, fMHz: number): Permeability {
  if (material.curve && material.curve.length > 0) return interpolatePermeability(material.curve, fMHz);
  return debyePermeability(material.muInitial, material.relaxationMHz ?? snoekRelaxationMHz(material.muInitial, material.family), fMHz);
}

export interface Point {
  fMHz: number;
  /** What the radio sees. */
  zIn: Complex;
  swr: number;
  /** Of the transmitter's forward power: what gets past the mismatch, and where it goes. */
  acceptedW: number;
  loadW: number;
  coreW: number;
  copperW: number;
  /** Loss inside the transformer alone, dB - what a perfect match in front would leave. */
  lossDb: number;
  /** Loss including what the mismatch turns back, dB. */
  totalLossDb: number;
  /** Peak flux density in the hardest-worked core, mT, and as a share of saturation. */
  fluxMt: number;
  fluxOfSaturation: number;
  /** Rise of the hottest core in still air at the average power, deg C. A rough guide. */
  tempRiseC: number;
  mu: Permeability;
  /** The core's impedance: magnetising (tapped) or common-mode choking (current balun). */
  zCore: Complex;
}

export interface Analysis {
  points: Point[];
  /** Nominal impedance ratio, output over input. */
  ratio: number;
  geometry: ToroidGeometry;
  /** Inductance per turn squared at the initial permeability, nH - to check against a datasheet. */
  alNh: number;
  /** The estimates that went in, so they can be shown as estimates. */
  strays: { leakageUh?: number; windingPf: number; lineZ0?: number; velocityFactor?: number; lineLengthM?: number; wireLengthM: number };
  /** True when the permeability came from a measurement rather than the built-in estimate. */
  measuredMaterial: boolean;
}

const parallel = (z1: Complex, z2: Complex): Complex => cInv(cAdd(cInv(z1), cInv(z2)));

export function analyse(design: Design, material: Material, loadAt?: (fMHz: number) => Complex): Analysis {
  const core = coreOf(design);
  const geometry = toroidGeometry(core.odMm, core.idMm, core.heightMm, design.stack);
  const summary = summarise(design.steps);
  const turns = summary.totalTurns;
  const windingF = windingCapacitanceF(design, material.family);
  const wireLengthM = turns * turnLengthM(design) + (2 * design.leadMm) / 1000;
  const saturation = SATURATION_T[material.family];
  const duty = Math.min(100, Math.max(0, design.dutyPct)) / 100;

  const tapped = design.topology === 'autotransformer';
  const { primary, total } = tappedTurns(design);
  const stepUp = tapped && primary > 0 ? total / primary : 1;
  const ratio = tapped ? stepUp ** 2 : design.topology === 'guanella-1-4' ? 4 : 1;
  const leakageH = tapped ? leakageInductanceH(design, primary, total) : 0;
  const lineSpec = tapped ? undefined : lineProperties(design);
  const lengthM = tapped ? undefined : lineLengthM(design);

  const points: Point[] = [];
  const { startMHz, stopMHz } = design.sweep;
  const count = Math.max(2, Math.floor(design.sweep.points));
  for (let i = 0; i < count; i++) {
    // Evenly spaced on a log axis: a transformer's life runs from 1.8 to 30 MHz, and the
    // interesting part is as likely to be at the bottom as the top.
    const fMHz = startMHz * (stopMHz / startMHz) ** (i / (count - 1));
    const w = 2 * Math.PI * fMHz * 1e6;
    const mu = permeabilityOf(material, fMHz);
    const zLoad = loadAt?.(fMHz) ?? complex(design.load.ohmsR, design.load.ohmsX);
    const strayY = complex(0, w * windingF);

    const stages: Stage[] = [];
    let zCore: Complex;
    /** Turns that the voltage across the core stage is spread over, for flux density. */
    let fluxTurns: number;
    /** Share of the core loss that lands in the hottest single core. */
    let hottestShare = 1;

    if (tapped) {
      zCore = coreImpedance(geometry, Math.max(1, primary), mu, fMHz);
      fluxTurns = Math.max(1, primary);
      const wire = wireOf(design.conductor);
      const ohms = wire ? copperOhmsPerM(wire.conductorMm, fMHz) * turnLengthM(design) : 0;
      // The input turns carry the difference between input and output current, and the
      // rest carry the output current, so seen from the input the copper comes to this.
      const copper = (1 - 1 / stepUp) ** 2 * ohms * primary + (ohms * (total - primary)) / stepUp ** 2;
      stages.push(
        { where: 'lossless', m: shunt(complex(0, w * design.compensationPf * 1e-12)) },
        { where: 'core', m: shunt(cInv(zCore)) },
        { where: 'copper', m: series(complex(copper)) },
        { where: 'lossless', m: series(complex(0, w * leakageH)) },
        { where: 'lossless', m: ideal(stepUp) },
        { where: 'lossless', m: shunt(strayY) },
      );
    } else {
      // A current balun's core works on the common mode: the whole line, both conductors
      // together, is one winding. Its own capacitance sits across it and sets where the
      // choke resonates.
      const choke = parallel(coreImpedance(geometry, turns, mu, fMHz), cInv(strayY.im === 0 ? complex(0, 1e-30) : strayY));
      zCore = choke;
      fluxTurns = turns;
      const one = line(lineSpec!.z0, lengthM!, lineSpec!.velocityFactor, lineSpec!.ohmsPerM(fMHz), fMHz);

      if (design.topology === 'guanella-1-1') {
        // Into a load that is balanced, or earthed on the same side as the source, there
        // is no common-mode voltage for the core to work against: it costs nothing, and
        // what it is worth is the choking impedance reported alongside.
        stages.push({ where: 'line', m: one });
      } else {
        // Inputs in parallel, outputs in series. Tracing the conductors round shows what
        // common-mode voltage each winding carries, and so what loads the source:
        //   two cores, floating load : half the input each        -> the two in series
        //   two cores, earthed load  : all of it on one, none on the other
        //   one core, floating load  : both windings share a core -> one winding of 2N turns
        let across: Complex;
        if (design.positions === 2 && !design.loadGrounded) {
          across = cScale(choke, 2);
          fluxTurns = 2 * turns;
          hottestShare = 0.5;
        } else if (design.positions === 2) {
          across = choke;
        } else {
          across = cScale(choke, 4);
          fluxTurns = 2 * turns;
        }
        stages.push({ where: 'core', m: shunt(cInv(across)) }, { where: 'line', m: parallelInSeriesOut(one) });
      }
    }

    // Walk back from the load. One volt across it; everything scales afterwards.
    let v: Complex = ONE;
    let current: Complex = cAbs(zLoad) > 1e-12 ? cDiv(ONE, zLoad) : complex(1e12);
    const powerAt = (vv: Complex, ii: Complex) => vv.re * ii.re + vv.im * ii.im; // Re(V I*)
    const loadPower = powerAt(v, current);
    const lost: Record<Where, number> = { core: 0, copper: 0, line: 0, lossless: 0 };
    let coreVolts = 0;
    for (let s = stages.length - 1; s >= 0; s--) {
      const { m, where } = stages[s]!;
      const out = powerAt(v, current);
      const vIn = cAdd(cMul(m.a, v), cMul(m.b, current));
      const iIn = cAdd(cMul(m.c, v), cMul(m.d, current));
      v = vIn;
      current = iIn;
      lost[where] += powerAt(v, current) - out;
      if (where === 'core') coreVolts = cAbs(v); // a shunt branch: its voltage is the node's
    }

    const zIn = cDiv(v, current);
    const gamma = cDiv(cAdd(zIn, complex(-design.z0)), cAdd(zIn, complex(design.z0)));
    const reflected = Math.min(1, cAbs(gamma) ** 2);
    const accepted = design.powerW * (1 - reflected);
    const inPower = powerAt(v, current);
    const scale = inPower > 0 ? accepted / inPower : 0; // power scales; volts by its root

    const loadW = loadPower * scale;
    const coreW = lost.core * scale;
    const copperW = (lost.copper + lost.line) * scale;
    const efficiency = accepted > 0 ? loadW / accepted : 0;
    const fluxT = (Math.SQRT2 * coreVolts * Math.sqrt(scale)) / (w * fluxTurns * geometry.areaM2);

    points.push({
      fMHz,
      zIn,
      swr: reflected >= 1 ? Infinity : (1 + Math.sqrt(reflected)) / (1 - Math.sqrt(reflected)),
      acceptedW: accepted,
      loadW,
      coreW,
      copperW,
      lossDb: efficiency > 0 ? -10 * Math.log10(efficiency) : Infinity,
      totalLossDb: loadW > 0 ? -10 * Math.log10(loadW / design.powerW) : Infinity,
      fluxMt: fluxT * 1000,
      fluxOfSaturation: fluxT / saturation,
      tempRiseC: temperatureRiseC(geometry, coreW * hottestShare * duty),
      mu,
      zCore,
    });
  }

  return {
    points,
    ratio,
    geometry,
    alNh: inductanceFactor(geometry, material.muInitial) * 1e9,
    strays: {
      leakageUh: tapped ? leakageH * 1e6 : undefined,
      windingPf: windingF * 1e12,
      lineZ0: lineSpec?.z0,
      velocityFactor: lineSpec?.velocityFactor,
      lineLengthM: lengthM,
      wireLengthM,
    },
    measuredMaterial: Boolean(material.curve && material.curve.length > 0),
  };
}
