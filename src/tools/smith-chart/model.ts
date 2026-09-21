// The matching network: a load (your antenna), a chain of components, and the radio.
//
// The chain is stored in the order you meet it walking from the load towards the radio,
// which is also the order the impedance is transformed in.

import type { Complex } from '../../lib/complex';

export type Connection = 'series' | 'shunt';

export interface Inductor {
  kind: 'inductor';
  connection: Connection;
  /** Henries. */
  henries: number;
  /** Unloaded Q at the working frequency; 0 or undefined means ideal. */
  q?: number;
}

export interface Capacitor {
  kind: 'capacitor';
  connection: Connection;
  /** Farads. */
  farads: number;
  q?: number;
}

export interface Resistor {
  kind: 'resistor';
  connection: Connection;
  ohms: number;
}

export interface Line {
  kind: 'line';
  /** Characteristic impedance, ohms. */
  z0: number;
  lengthM: number;
  /** Velocity factor, 0 to 1. */
  velocityFactor: number;
  /** Matched loss in dB per 100 m at `lossRefMHz`; scaled as the square root of frequency. */
  lossDb100m: number;
  lossRefMHz: number;
}

export interface Stub extends Omit<Line, 'kind'> {
  kind: 'stub';
  connection: Connection;
  termination: 'open' | 'short';
}

export interface Transformer {
  kind: 'transformer';
  /** Impedance ratio: a 4:1 balun is 4, and turns 200 Ω into 50 Ω. */
  ratio: number;
}

export type ElementSpec = Inductor | Capacitor | Resistor | Line | Stub | Transformer;
export type ElementKind = ElementSpec['kind'];

export type Element = ElementSpec & {
  id: string;
  /** Switched out of circuit, for an instant before-and-after comparison. */
  bypassed?: boolean;
  label?: string;
};

export type Load =
  | {
      kind: 'impedance';
      ohmsR: number;
      ohmsX: number;
      /** The frequency at which R + jX was measured. */
      atMHz: number;
      /**
       * 'fixed' holds R + jX at every frequency (only honest at one frequency);
       * 'reactive' keeps R and lets the reactance follow frequency, as the inductor or
       * capacitor that would have that reactance at `atMHz`.
       */
      follows: 'fixed' | 'reactive';
    }
  | {
      kind: 'measured';
      name: string;
      points: { fMHz: number; z: Complex }[];
    };

export interface SweepPlan {
  startMHz: number;
  stopMHz: number;
  points: number;
}

export interface Network {
  load: Load;
  /** From the load towards the radio. */
  elements: Element[];
  /** System impedance: what the radio wants, and what SWR is measured against. */
  z0: number;
  sweep: SweepPlan;
  /** Where the chart's transformation path is drawn, in MHz. */
  designMHz: number;
}

let counter = 0;
const session = Math.floor(Math.random() * 36 ** 4).toString(36);

export function newElementId(): string {
  counter += 1;
  return `e${session}.${counter.toString(36)}`;
}

export const DEFAULT_LINE: Omit<Line, 'kind'> = {
  z0: 50,
  lengthM: 1,
  velocityFactor: 0.66,
  lossDb100m: 0,
  lossRefMHz: 14,
};

export function defaultElement(kind: ElementKind, connection: Connection = 'series', atMHz = 14.2): Element {
  const id = newElementId();
  // Start every reactive part at roughly 50 Ω of reactance, so the first drag does something visible.
  const omega = 2 * Math.PI * atMHz * 1e6;
  switch (kind) {
    case 'inductor':
      return { id, kind, connection, henries: 50 / omega };
    case 'capacitor':
      return { id, kind, connection, farads: 1 / (50 * omega) };
    case 'resistor':
      return { id, kind, connection, ohms: 50 };
    case 'line':
      return { id, kind, ...DEFAULT_LINE };
    case 'stub':
      return { id, kind, connection: 'shunt', termination: 'open', ...DEFAULT_LINE };
    case 'transformer':
      return { id, kind, ratio: 4 };
  }
}

export function defaultNetwork(): Network {
  return {
    load: { kind: 'impedance', ohmsR: 100, ohmsX: -40, atMHz: 14.2, follows: 'reactive' },
    elements: [],
    z0: 50,
    sweep: { startMHz: 14, stopMHz: 14.35, points: 41 },
    designMHz: 14.175,
  };
}

// ---- edits (pure) ----

export function addElement(network: Network, element: Element, index = network.elements.length): Network {
  const elements = [...network.elements];
  elements.splice(Math.min(Math.max(index, 0), elements.length), 0, element);
  return { ...network, elements };
}

export function updateElement(network: Network, id: string, patch: Partial<Element>): Network {
  return {
    ...network,
    elements: network.elements.map((e) => (e.id === id ? ({ ...e, ...patch } as Element) : e)),
  };
}

export function removeElement(network: Network, id: string): Network {
  return { ...network, elements: network.elements.filter((e) => e.id !== id) };
}

export function moveElement(network: Network, id: string, by: number): Network {
  const from = network.elements.findIndex((e) => e.id === id);
  const to = from + by;
  if (from < 0 || to < 0 || to >= network.elements.length) return network;
  const elements = [...network.elements];
  const [element] = elements.splice(from, 1);
  elements.splice(to, 0, element!);
  return { ...network, elements };
}

export function sweepFrequencies(plan: SweepPlan): number[] {
  const n = Math.max(2, Math.round(plan.points));
  const step = (plan.stopMHz - plan.startMHz) / (n - 1);
  return Array.from({ length: n }, (_, i) => Number((plan.startMHz + i * step).toPrecision(12)));
}
