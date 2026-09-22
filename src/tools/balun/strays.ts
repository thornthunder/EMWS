// The parts of a wound transformer that nobody designs in: wire resistance, leakage
// inductance, the capacitance of the winding, and what kind of line a pair of wires makes.
//
// BE CLEAR ABOUT WHAT THESE ARE. The core's own behaviour (src/lib/ferrite.ts) follows
// from dimensions and permeability and is on firm ground. These do not: they depend on how
// tightly the turns sit, how the leads are dressed, what the core is coated with. Each is
// worked out here from the geometry, with its assumption stated, so that the tool gives a
// sensible answer before you have measured anything - and each can be replaced by a
// measurement in Design.overrides, which is always the better number.
//
// They matter mostly at the TOP of a transformer's range. The bottom of the range - how
// many turns, which mix, how hot it runs on 80 m - is decided by the core, not by these.

import { type FerriteFamily, MU0, type ToroidGeometry } from '../../lib/ferrite';
import { INSULATION, wireOuterMm } from './catalog';
import { type Conductor, type Design, coaxOf, coreOf, summarise, turnWidthMm, wireOf } from './model';

const EPSILON0 = 8.854e-12;
const COPPER_OHM_M = 1.68e-8;
/** Cores are painted or coated, and a turn never sits perfectly flat against one. */
const CORE_GAP_MM = 0.2;
/** Jacket on small coax, mm and permittivity: the shield is what faces the core. */
const COAX_JACKET = { wallMm: 0.3, epsilon: 2.5 };
/** How much of the magnetic field of one turn, in air, also threads its neighbour. */
const AIR_COUPLING = 0.5;

/** Length of wire in one turn, m: round the core's section, one wire radius out. */
export function turnLengthM(design: Design): number {
  const core = coreOf(design);
  const h = core.heightMm * Math.max(1, design.stack);
  const w = (core.odMm - core.idMm) / 2;
  return (2 * (h + w) + Math.PI * turnWidthMm(design.conductor)) / 1000;
}

/**
 * Resistance of round copper at radio frequency, ohms per metre. Current crowds into a
 * skin one depth thick, so the useful area is that annulus once the wire is thicker than
 * two skin depths.
 */
export function copperOhmsPerM(conductorMm: number, fMHz: number): number {
  const d = conductorMm / 1000;
  const skin = Math.sqrt(COPPER_OHM_M / (Math.PI * fMHz * 1e6 * MU0));
  const area = skin < d / 2 ? Math.PI * (d * skin - skin * skin) : (Math.PI * d * d) / 4;
  return COPPER_OHM_M / area;
}

/** The conductor that faces the core, and what separates the two. */
function facing(conductor: Conductor): { radiusMm: number; wallMm: number; epsilon: number } {
  const coax = coaxOf(conductor);
  if (coax) return { radiusMm: coax.outerMm / 2 - COAX_JACKET.wallMm, ...COAX_JACKET };
  const wire = wireOf(conductor)!;
  const cover = INSULATION[wire.insulation];
  return { radiusMm: wire.conductorMm / 2, wallMm: cover.wallMm, epsilon: cover.epsilon };
}

/**
 * Capacitance from one turn to the core, F: a round wire lying along a surface,
 * C' = 2 pi eps / acosh(h/r), over the length of the turn that touches it. The
 * insulation and the gap to the core act as two dielectrics in series.
 */
function turnToCoreF(design: Design): number {
  const { radiusMm, wallMm, epsilon } = facing(design.conductor);
  const gap = wallMm + CORE_GAP_MM;
  const epsilonEff = gap / (wallMm / epsilon + CORE_GAP_MM);
  const core = coreOf(design);
  const contactM = (2 * (core.heightMm * Math.max(1, design.stack) + (core.odMm - core.idMm) / 2)) / 1000;
  return ((2 * Math.PI * EPSILON0 * epsilonEff) / Math.acosh((radiusMm + gap) / radiusMm)) * contactM;
}

/** Relative permittivity of nickel-zinc ferrite, which is a dielectric. Typically 10 to 15. */
const NIZN_EPSILON = 12;

/**
 * Capacitance across the whole winding, F.
 *
 * Two parts. Every turn couples to the core, and with the voltage rising evenly along the
 * winding and the core sitting at its middle, the energy stored comes to N x C_turn / 12.
 * Then, if the winding goes all the way round WITHOUT crossing over, its first and last
 * turns end up side by side with the full voltage between them - which is the capacitance
 * a crossover winding exists to remove.
 *
 * WHAT THE CORE IS MATTERS. Manganese-zinc ferrite conducts well enough at RF to be one
 * equipotential surface, so every turn is coupled to every other through it. Nickel-zinc
 * (#43, #52, #61) does not: it is nearly an insulator, a dielectric body, and the path from
 * a turn to the electrical middle of the winding has to cross the ferrite itself - a second
 * capacitance in series, eps A / (half the span of the winding). Leaving that out makes a
 * 49:1 on #43 look hopeless on 10 m and makes a compensating capacitor appear to make
 * things worse, which everyone who has built one knows is not so.
 */
export function windingCapacitanceF(design: Design, family: FerriteFamily = 'NiZn'): number {
  if (design.overrides.windingPf !== undefined) return design.overrides.windingPf * 1e-12;
  const summary = summarise(design.steps);
  const core = coreOf(design);
  const width = turnWidthMm(design.conductor);
  const fill = (summary.totalTurns * width) / (Math.PI * (core.idMm - width));

  let perTurn = turnToCoreF(design);
  if (family === 'NiZn') {
    const sectionM2 = ((core.heightMm * Math.max(1, design.stack)) / 1000) * ((core.odMm - core.idMm) / 2000);
    const spanM = Math.max(width / 1000, Math.min(1, fill) * Math.PI * ((core.odMm + core.idMm) / 2000));
    const throughFerrite = (EPSILON0 * NIZN_EPSILON * sectionM2) / (spanM / 2);
    perTurn = (perTurn * throughFerrite) / (perTurn + throughFerrite);
  }
  const distributed = (summary.totalTurns * perTurn) / 12;

  // Ends only meet once the winding is nearly all the way round.
  const adjacency = summary.crossoverAt === undefined ? Math.min(1, Math.max(0, (fill - 0.7) / 0.3)) : 0;
  const { radiusMm, wallMm, epsilon } = facing(design.conductor);
  const spacing = 2 * (radiusMm + wallMm);
  const endToEnd =
    ((Math.PI * EPSILON0 * ((1 + epsilon) / 2)) / Math.acosh(spacing / (2 * radiusMm))) * turnLengthM(design);

  return distributed + adjacency * endToEnd;
}

/** Inductance of a straight lead, H. The usual formula for a round wire in free space. */
function leadInductanceH(lengthMm: number, diameterMm: number): number {
  if (lengthMm <= 0) return 0;
  return 0.2e-9 * lengthMm * (Math.log((4 * lengthMm) / diameterMm) - 0.75);
}

/**
 * Leakage inductance of a tapped winding, referred to its input, H.
 *
 * The flux of the input turns that goes round through the AIR, rather than round the core,
 * links those turns and not the rest - that is the leakage. So: the inductance the input
 * turns would have in air (each a loop of mu0 a (ln(8a/r) - 2), adjacent turns sharing
 * about half their flux), times the share of the winding that does not see it. If the
 * input section were the whole winding there would be none, as there should be. The two
 * input leads are added, because on the 50-ohm side they are the same order of size.
 */
export function leakageInductanceH(design: Design, primaryTurns: number, totalTurns: number): number {
  if (design.overrides.leakageUh !== undefined) return design.overrides.leakageUh * 1e-6;
  if (primaryTurns <= 0 || totalTurns <= 0) return 0;
  const { radiusMm } = facing(design.conductor);
  const loopRadiusM = turnLengthM(design) / (2 * Math.PI);
  const loopH = MU0 * loopRadiusM * (Math.log((8 * loopRadiusM) / (radiusMm / 1000)) - 2);
  const inAirH = loopH * primaryTurns * (1 + AIR_COUPLING * (primaryTurns - 1));
  const unshared = 1 - primaryTurns / totalTurns;
  return inAirH * unshared + 2 * leadInductanceH(design.leadMm, 2 * radiusMm);
}

export interface LineProperties {
  z0: number;
  velocityFactor: number;
  /** Conductor loss, ohms per metre of line (both conductors), at this frequency. */
  ohmsPerM(fMHz: number): number;
}

/**
 * The transmission line a current balun is wound with.
 *
 * Coax is what it says on the reel. A pair of wires side by side is a two-wire line,
 * Z0 = (120 / sqrt(eps)) acosh(D/d), and the awkward part is eps: the field between
 * touching insulated wires runs partly through insulation and partly through air, taken
 * here as half each. Measure the pair with a VNA and override it if it matters to you -
 * for a 1:4 balun, which wants 100-ohm line, it does.
 */
export function lineProperties(design: Design): LineProperties {
  const coax = coaxOf(design.conductor);
  let z0: number;
  let velocityFactor: number;
  let ohmsPerM: (fMHz: number) => number;

  if (coax) {
    z0 = coax.z0;
    velocityFactor = 1 / Math.sqrt(coax.epsilon);
    // The shield's inside diameter follows from Z0 = (60 / sqrt(eps)) ln(D/d).
    const shieldMm = coax.innerConductorMm * Math.exp((coax.z0 * Math.sqrt(coax.epsilon)) / 60);
    ohmsPerM = (f) => copperOhmsPerM(coax.innerConductorMm, f) * (1 + coax.innerConductorMm / shieldMm);
  } else {
    const wire = wireOf(design.conductor)!;
    const epsilonEff = 1 + (INSULATION[wire.insulation].epsilon - 1) / 2;
    z0 = (120 / Math.sqrt(epsilonEff)) * Math.acosh(wireOuterMm(wire) / wire.conductorMm);
    velocityFactor = 1 / Math.sqrt(epsilonEff);
    ohmsPerM = (f) => 2 * copperOhmsPerM(wire.conductorMm, f);
  }
  return {
    z0: design.overrides.lineZ0 ?? z0,
    velocityFactor: design.overrides.velocityFactor ?? velocityFactor,
    ohmsPerM,
  };
}

/** Length of the wound line, m: the turns, plus a lead at each end. */
export function lineLengthM(design: Design): number {
  return summarise(design.steps).totalTurns * turnLengthM(design) + (2 * design.leadMm) / 1000;
}

/** Temperature rise of a core shedding this much heat into still air, deg C. */
export function temperatureRiseC(geometry: ToroidGeometry, watts: number): number {
  if (watts <= 0) return 0;
  // The long-standing rule for ferrite in free air: (mW per cm^2) ^ 0.833.
  return ((watts * 1000) / (geometry.surfaceM2 * 1e4)) ** 0.833;
}
