// What the coil, trap and filter tool remembers: three designs and which one is on show.
//
// The coil is the common part. A trap's inductor and a filter's inductors are coils, so
// the coil tab's former and wire are what "wind it" means everywhere else on the page.

import { bandPairs, bandsUpTo } from '../../lib/bands';
import { INSULATION, awgMm } from '../balun/catalog';
import type { CoilSpec } from './coil';
import type { FilterSpec } from './filter';
import { capacitorFor } from './trap';

export type LcTab = 'coil' | 'trap' | 'filter';

export interface CoilDesign extends CoilSpec {
  /** The frequency the coil is for, MHz. */
  atMHz: number;
  /** A Q known better than the estimate - measured, say. Used by the trap and filter when set. */
  measuredQ?: number;
}

export interface TrapDesign {
  fMHz: number;
  /** Which part is chosen; the other follows from the frequency. */
  given: 'coil' | 'capacitor';
  henries: number;
  farads: number;
  /** The coil's Q at the trap frequency. */
  q: number;
}

export interface FilterDesign extends FilterSpec {
  qInductor: number;
  qCapacitor: number;
  /** Round every capacitor to the E24 series and show the response that gives. */
  standardCapacitors: boolean;
}

export interface LcState {
  tab: LcTab;
  coil: CoilDesign;
  trap: TrapDesign;
  filter: FilterDesign;
}

export interface WireChoice {
  id: string;
  name: string;
  wireMm: number;
  wallMm: number;
}

const bare = (mm: number): WireChoice => ({ id: `bare-${mm}`, name: `${mm.toFixed(1)} mm bare copper`, wireMm: mm, wallMm: 0 });
const enamelled = (awg: number): WireChoice => ({
  id: `awg${awg}`,
  name: `${awg} AWG enamelled (${awgMm(awg).toFixed(2)} mm)`,
  wireMm: Number(awgMm(awg).toFixed(3)),
  wallMm: INSULATION.enamel.wallMm,
});

export const WIRE_CHOICES: WireChoice[] = [bare(0.8), bare(1.0), bare(1.2), bare(1.6), bare(2.0), bare(2.5), bare(3.0), enamelled(22), enamelled(20), enamelled(18), enamelled(16), enamelled(14)];

export const SPACINGS: { value: number; label: string }[] = [
  { value: 1, label: 'close-wound' },
  { value: 1.5, label: 'half a wire apart' },
  { value: 2, label: 'one wire apart' },
  { value: 3, label: 'two wires apart' },
];

/** The bands a trap or filter is built for: HF through 70 cm, from the suite's one band list. */
export const BANDS: [string, number][] = bandPairs(bandsUpTo(450));

export function defaultState(): LcState {
  const henries = 8e-6;
  return {
    tab: 'coil',
    coil: { turns: 12, formerMm: 25, wireMm: 1.0, wallMm: 0, spacing: 1, atMHz: 7.1 },
    trap: { fMHz: 7.1, given: 'coil', henries, farads: capacitorFor(7.1, henries), q: 200 },
    filter: { kind: 'lowpass', family: 'butterworth', order: 5, cutoffMHz: 32, z0: 50, rippleDb: 0.1, first: 'shunt', qInductor: 100, qCapacitor: 1000, standardCapacitors: false },
  };
}

/** The trap's two parts, whichever was given. */
export function trapParts(trap: TrapDesign): { henries: number; farads: number } {
  const w = 2 * Math.PI * trap.fMHz * 1e6;
  if (trap.given === 'coil') return { henries: trap.henries, farads: 1 / (w * w * trap.henries) };
  return { henries: 1 / (w * w * trap.farads), farads: trap.farads };
}

const STORAGE_KEY = 'emws.lc.v1';

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function loadState(): LcState {
  const fallback = defaultState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const stored = JSON.parse(raw) as Partial<LcState>;
    const coil = { ...fallback.coil, ...(stored.coil ?? {}) };
    const trap = { ...fallback.trap, ...(stored.trap ?? {}) };
    const filter = { ...fallback.filter, ...(stored.filter ?? {}) };
    if (![coil.turns, coil.formerMm, coil.wireMm, coil.atMHz, trap.fMHz, trap.henries, trap.farads, filter.cutoffMHz, filter.order].every(finite)) return fallback;
    const tab: LcTab = stored.tab === 'trap' || stored.tab === 'filter' ? stored.tab : 'coil';
    return { tab, coil, trap, filter };
  } catch {
    return fallback;
  }
}

export function saveState(state: LcState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage can be blocked; the tool still works, it just starts afresh next time.
  }
}
