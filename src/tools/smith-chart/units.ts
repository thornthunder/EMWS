// Values in henries and farads are unreadable; hams work in µH and pF.

import type { Element } from './model';

const PREFIXES: { factor: number; symbol: string }[] = [
  { factor: 1e-12, symbol: 'p' },
  { factor: 1e-9, symbol: 'n' },
  { factor: 1e-6, symbol: 'µ' },
  { factor: 1e-3, symbol: 'm' },
  { factor: 1, symbol: '' },
  { factor: 1e3, symbol: 'k' },
  { factor: 1e6, symbol: 'M' },
];

export function siPrefix(value: number): { factor: number; symbol: string } {
  const magnitude = Math.abs(value);
  if (magnitude === 0 || !Number.isFinite(magnitude)) return { factor: 1, symbol: '' };
  let chosen = PREFIXES[0]!;
  for (const prefix of PREFIXES) {
    if (magnitude >= prefix.factor) chosen = prefix;
  }
  return chosen;
}

export function formatSi(value: number, unit: string, digits = 4): string {
  if (!Number.isFinite(value)) return `∞ ${unit}`;
  const { factor, symbol } = siPrefix(value);
  return `${Number((value / factor).toPrecision(digits))} ${symbol}${unit}`;
}

/** Ohms, to the precision people read impedances at. */
export function formatOhms(value: number): string {
  if (!Number.isFinite(value)) return '∞';
  const digits = Math.abs(value) >= 100 ? 1 : Math.abs(value) >= 10 ? 2 : 3;
  return value.toFixed(digits);
}

export function formatImpedance(z: { re: number; im: number }): string {
  return `${formatOhms(z.re)} ${z.im < 0 ? '−' : '+'} j${formatOhms(Math.abs(z.im))} Ω`;
}

export function formatMHz(value: number): string {
  return `${Number(value.toPrecision(7))} MHz`;
}

/** The unit a component's value is edited in: nH, pF, ohms, metres. */
export function editUnit(element: Element): { factor: number; label: string } | undefined {
  switch (element.kind) {
    case 'inductor':
      return { factor: 1e-9, label: 'nH' };
    case 'capacitor':
      return { factor: 1e-12, label: 'pF' };
    case 'resistor':
      return { factor: 1, label: 'Ω' };
    default:
      return undefined;
  }
}

/** The reactance a component shows at a frequency; the natural thing to put on a slider. */
export function reactanceOf(element: Element, fMHz: number): number | undefined {
  const omega = 2 * Math.PI * fMHz * 1e6;
  if (element.kind === 'inductor') return omega * element.henries;
  if (element.kind === 'capacitor') return element.farads === 0 ? -Infinity : -1 / (omega * element.farads);
  return undefined;
}

/** The component value that gives this reactance at this frequency. */
export function fromReactance(element: Element, reactance: number, fMHz: number): Partial<Element> {
  const omega = 2 * Math.PI * fMHz * 1e6;
  if (element.kind === 'inductor') return { henries: Math.max(1e-15, reactance / omega) };
  if (element.kind === 'capacitor') return { farads: Math.max(1e-15, 1 / (omega * Math.abs(reactance))) };
  return {};
}

export function elementTitle(element: Element): string {
  const place = 'connection' in element ? (element.connection === 'series' ? 'Series' : 'Shunt') : '';
  switch (element.kind) {
    case 'inductor':
      return `${place} inductor`;
    case 'capacitor':
      return `${place} capacitor`;
    case 'resistor':
      return `${place} resistor`;
    case 'line':
      return 'Transmission line';
    case 'stub':
      return `${place} ${element.termination === 'open' ? 'open' : 'shorted'} stub`;
    case 'transformer':
      return 'Transformer';
  }
}

export function elementValue(element: Element): string {
  switch (element.kind) {
    case 'inductor':
      return formatSi(element.henries, 'H');
    case 'capacitor':
      return formatSi(element.farads, 'F');
    case 'resistor':
      return `${formatOhms(element.ohms)} Ω`;
    case 'line':
    case 'stub':
      return `${Number(element.lengthM.toPrecision(4))} m of ${element.z0} Ω`;
    case 'transformer':
      return `${element.ratio}:1`;
  }
}
