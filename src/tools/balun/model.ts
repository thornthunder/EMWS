// A transformer design, held the way you would describe winding one:
//
//     take an FT240-43, wind 2 turns, tap, wind 5 more, cross over, wind 7, done.
//
// That list of steps IS the design. The drawing of the toroid edits it and the form
// edits it, but neither owns it - the same arrangement as the Antenna Modeler, and for the
// same reason: every change is a pure function of the design, so undo is free and a saved
// design is exactly what was on the screen.

import { type Coax, type CoreSize, type Wire, COAX, CORES, WIRES, coaxById, coreById, wireById, wireOuterMm } from './catalog';

export type Topology =
  /** One tapped winding: the 49:1 and 9:1 "ununs" fed against the bottom of the winding. */
  | 'autotransformer'
  /** A transmission line wound on a core: the 1:1 current balun, or common-mode choke. */
  | 'guanella-1-1'
  /** Two such lines, inputs in parallel and outputs in series: the 1:4 current balun. */
  | 'guanella-1-4';

export type Step =
  | { id: string; kind: 'wind'; turns: number }
  /** Bring a connection out here. Only meaningful on a tapped winding. */
  | { id: string; kind: 'tap' }
  /** Pass through the middle and carry on winding on the far side of the ring. */
  | { id: string; kind: 'crossover' };

export type Conductor =
  | { kind: 'wire'; wireId: string }
  /** Two of the same wire laid side by side as a transmission line. */
  | { kind: 'pair'; wireId: string }
  | { kind: 'coax'; coaxId: string };

export interface Design {
  topology: Topology;
  coreId: string;
  /** Used when coreId is 'custom'. */
  customCore?: CoreSize;
  /** Cores stacked side by side at each position; they act as one taller core. */
  stack: number;
  /** A 1:4 Guanella is properly built on two cores. One is possible, with a catch. */
  positions: 1 | 2;
  materialId: string;
  conductor: Conductor;
  steps: Step[];
  /** Which tap the radio connects to, counting from the start of the winding. */
  inputTap: number;
  /** Capacitor across the input, pF. The usual cure for a 49:1 that droops on 10 m. */
  compensationPf: number;
  /** Each connecting lead, mm. Short leads matter more than people expect at 28 MHz. */
  leadMm: number;
  /** What is connected to the output. */
  load: { ohmsR: number; ohmsX: number };
  /** True when one side of the load is earthed (an unun); false when it floats. */
  loadGrounded: boolean;
  /** The radio's impedance. */
  z0: number;
  /** Transmitter power, W, and how much of the time it is really there. */
  powerW: number;
  dutyPct: number;
  sweep: { startMHz: number; stopMHz: number; points: number };
  /**
   * Estimates you can replace with measurements. Left undefined, each is worked out from
   * the geometry - see strays.ts - and shown as the estimate it is.
   */
  overrides: { leakageUh?: number; windingPf?: number; lineZ0?: number; velocityFactor?: number };
}

let counter = 0;
const session = Date.now().toString(36);
/** crypto.randomUUID is not available on plain-HTTP origins, where EMWS is often hosted. */
export function newId(): string {
  counter += 1;
  return `${session}-${counter}`;
}

export const wind = (turns: number): Step => ({ id: newId(), kind: 'wind', turns });
export const tap = (): Step => ({ id: newId(), kind: 'tap' });
export const crossover = (): Step => ({ id: newId(), kind: 'crossover' });

/** What the recipe adds up to. */
export interface WindingSummary {
  totalTurns: number;
  /** Turn counts, from the start, at which a connection is brought out. */
  taps: number[];
  /** Turn count at which the winding crosses to the far side, if it does. */
  crossoverAt: number | undefined;
}

export function summarise(steps: readonly Step[]): WindingSummary {
  let turns = 0;
  const taps: number[] = [];
  let crossoverAt: number | undefined;
  for (const step of steps) {
    if (step.kind === 'wind') turns += Math.max(0, step.turns);
    else if (step.kind === 'tap') taps.push(turns);
    else if (crossoverAt === undefined) crossoverAt = turns;
  }
  return { totalTurns: turns, taps, crossoverAt };
}

/**
 * Winds or unwinds the free end of the wire until the winding totals this many turns.
 *
 * Only the last stretch of winding moves: a drag never unwinds back past a tap or a
 * crossover, because those are decisions, and undoing one by overshooting with the mouse
 * would be a nasty surprise. Unwinding a stretch to nothing removes it.
 */
export function windTo(steps: readonly Step[], totalTurns: number): Step[] {
  const last = steps[steps.length - 1];
  const current = summarise(steps).totalTurns;
  if (last?.kind === 'wind') {
    const before = current - last.turns;
    const turns = Math.max(0, Math.round(totalTurns) - before);
    if (turns === last.turns) return [...steps];
    return turns === 0 ? steps.slice(0, -1) : [...steps.slice(0, -1), { ...last, turns }];
  }
  const extra = Math.round(totalTurns) - current;
  return extra > 0 ? [...steps, wind(extra)] : [...steps];
}

export function setStepTurns(steps: readonly Step[], id: string, turns: number): Step[] {
  return steps.map((s) => (s.id === id && s.kind === 'wind' ? { ...s, turns: Math.max(1, Math.round(turns)) } : s));
}

export function removeStep(steps: readonly Step[], id: string): Step[] {
  return steps.filter((s) => s.id !== id);
}

/** A second crossover would mean nothing, and nor would a tap where there already is one. */
export function canAdd(steps: readonly Step[], kind: Step['kind']): boolean {
  const last = steps[steps.length - 1];
  if (kind === 'wind') return true;
  if (kind === 'crossover') return !steps.some((s) => s.kind === 'crossover') && summarise(steps).totalTurns > 0;
  return last?.kind === 'wind';
}

/** Input and whole-winding turns for a tapped winding. */
export function tappedTurns(design: Design): { primary: number; total: number } {
  const summary = summarise(design.steps);
  const inside = summary.taps.filter((t) => t > 0 && t < summary.totalTurns);
  const primary = inside[Math.min(design.inputTap, inside.length - 1)] ?? 0;
  return { primary, total: summary.totalTurns };
}

export function coreOf(design: Design): CoreSize {
  if (design.coreId === 'custom' && design.customCore) return design.customCore;
  return coreById(design.coreId) ?? CORES[CORES.length - 1]!;
}

export function wireOf(conductor: Conductor): Wire | undefined {
  return conductor.kind === 'coax' ? undefined : (wireById(conductor.wireId) ?? WIRES[0]);
}

export function coaxOf(conductor: Conductor): Coax | undefined {
  return conductor.kind === 'coax' ? (coaxById(conductor.coaxId) ?? COAX[0]) : undefined;
}

/** How much of the inside of the ring one turn takes up, mm. */
export function turnWidthMm(conductor: Conductor): number {
  if (conductor.kind === 'coax') return coaxOf(conductor)!.outerMm;
  const outer = wireOuterMm(wireOf(conductor)!);
  return conductor.kind === 'pair' ? 2 * outer : outer;
}

/** Turns that fit in a single layer round the inside of the core. */
export function turnsThatFit(design: Design): number {
  const width = turnWidthMm(design.conductor);
  const core = coreOf(design);
  return Math.floor((Math.PI * (core.idMm - width)) / width);
}

export interface Issue {
  severity: 'error' | 'warning';
  message: string;
}

/** Whether this design can be built and analysed as drawn, and what to know if so. */
export function checkDesign(design: Design): Issue[] {
  const issues: Issue[] = [];
  const error = (message: string) => issues.push({ severity: 'error', message });
  const warn = (message: string) => issues.push({ severity: 'warning', message });
  const summary = summarise(design.steps);

  if (summary.totalTurns < 1) {
    error('Nothing is wound yet. Drag round the core to wind turns, or add a Wind step.');
    return issues;
  }

  const fits = turnsThatFit(design);
  if (summary.totalTurns > fits) {
    error(
      `${summary.totalTurns} turns of this will not fit in one layer: the inside of the core takes about ${fits}. ` +
        `Use thinner wire, fewer turns or a bigger core.`,
    );
  }

  if (design.topology === 'autotransformer') {
    if (design.conductor.kind !== 'wire') error('A tapped winding is wound with a single wire.');
    const { primary, total } = tappedTurns(design);
    if (primary === 0) {
      error('A tapped transformer needs a tap part-way along the winding. Wind the input turns, then add a Tap.');
    } else if (primary === 1) {
      warn(
        'A one-turn input leaves very little inductance across the radio. Expect heavy core loss on the lower bands - ' +
          'two or three turns is usual.',
      );
    }
    if (primary > 0 && total > primary) {
      const ratio = (total / primary) ** 2;
      if (Math.abs(ratio - Math.round(ratio)) > 0.01) {
        warn(`This ratio is ${ratio.toFixed(1)}:1 - not a whole number, which is fine, but check it is what you meant.`);
      }
    }
  } else {
    if (design.conductor.kind === 'wire') error('A current balun is wound with a transmission line: a pair of wires, or coax.');
    if (summary.taps.length > 0) warn('Taps mean nothing on a transmission-line winding and are ignored.');
    if (design.topology === 'guanella-1-4' && design.positions === 1 && design.loadGrounded) {
      error(
        'A 1:4 Guanella on ONE core only works into a load that floats, such as a balanced antenna. With one side of ' +
          'the load earthed the two windings need different voltages on the same core, which it cannot give them. ' +
          'Use two cores, or a floating load.',
      );
    }
  }
  return issues;
}

/** The transformer in the question that started this tool: 2 + 5, cross over, + 7. */
export function efhwDesign(): Design {
  return {
    topology: 'autotransformer',
    coreId: 'FT240',
    stack: 1,
    positions: 1,
    materialId: '43',
    conductor: { kind: 'wire', wireId: 'awg18-ptfe' },
    steps: [wind(2), tap(), wind(5), crossover(), wind(7)],
    inputTap: 0,
    compensationPf: 0,
    leadMm: 25,
    load: { ohmsR: 2450, ohmsX: 0 },
    loadGrounded: true,
    z0: 50,
    powerW: 100,
    dutyPct: 100,
    sweep: { startMHz: 1.8, stopMHz: 30, points: 121 },
    overrides: {},
  };
}

export function chokeDesign(): Design {
  return {
    ...efhwDesign(),
    topology: 'guanella-1-1',
    conductor: { kind: 'coax', coaxId: 'rg316' },
    steps: [wind(12)],
    load: { ohmsR: 50, ohmsX: 0 },
    loadGrounded: false,
  };
}

export function guanella4Design(): Design {
  return {
    ...efhwDesign(),
    topology: 'guanella-1-4',
    positions: 2,
    conductor: { kind: 'pair', wireId: 'awg18-ptfe' },
    steps: [wind(9)],
    load: { ohmsR: 200, ohmsX: 0 },
    loadGrounded: false,
  };
}
