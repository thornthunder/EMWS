// What the RF toolbox remembers between visits: which tab is open and what was typed in it.

import type { LossPoint } from './coax';
import type { Topology } from './attenuator';
import type { SBand } from './levels';

export type ToolboxTab = 'wire' | 'coax' | 'pad' | 'levels' | 'swr';

export interface WireInputs {
  fMHz: number;
  /** Velocity factor of the line whose electrical length is wanted. */
  velocityFactor: number;
  physicalM: number;
}

export interface CoaxInputs {
  /** A catalogue id, or 'datasheet' for the typed-in cable. */
  cableId: string;
  datasheet: { name: string; z0: number; velocityFactor: number; points: [LossPoint, LossPoint] };
  lengthM: number;
  fMHz: number;
  loadSwr: number;
  powerW: number;
}

export interface PadInputs {
  /** Pi or T of a chosen attenuation, or the minimum-loss L pad between the two impedances. */
  topology: Topology | 'ell';
  attenuationDb: number;
  zIn: number;
  zOut: number;
  powerW: number;
  /** Round the resistors to E24 and report what that pad does. */
  standardValues: boolean;
}

export interface LevelsInputs {
  dBm: number;
  z: number;
  band: SBand;
  dB: number;
  /** For the far-field distance: where the field-strength estimate starts to hold. */
  fMHz: number;
  txW: number;
  feederLossDb: number;
  gainDbi: number;
  distanceM: number;
  antennaSizeM: number;
}

export interface SwrInputs {
  swr: number;
  forwardW: number;
  reflectedW: number;
  r: number;
  x: number;
  z0: number;
}

export interface ToolboxState {
  tab: ToolboxTab;
  wire: WireInputs;
  coax: CoaxInputs;
  pad: PadInputs;
  levels: LevelsInputs;
  swr: SwrInputs;
}

export function defaultState(): ToolboxState {
  return {
    tab: 'wire',
    wire: { fMHz: 14.2, velocityFactor: 0.66, physicalM: 10 },
    coax: {
      cableId: 'rg58',
      datasheet: { name: 'My cable', z0: 50, velocityFactor: 0.66, points: [{ fMHz: 10, dbPer100m: 4.6 }, { fMHz: 100, dbPer100m: 16 }] },
      lengthM: 30,
      fMHz: 28.5,
      loadSwr: 2,
      powerW: 100,
    },
    pad: { topology: 'pi', attenuationDb: 10, zIn: 50, zOut: 50, powerW: 1, standardValues: true },
    levels: { dBm: -73, z: 50, band: 'hf', dB: 3, fMHz: 14.2, txW: 100, feederLossDb: 1, gainDbi: 2.15, distanceM: 10, antennaSizeM: 10 },
    swr: { swr: 2, forwardW: 100, reflectedW: 11.1, r: 72, x: 0, z0: 50 },
  };
}

const STORAGE_KEY = 'emws.toolbox.v1';
const TABS: ToolboxTab[] = ['wire', 'coax', 'pad', 'levels', 'swr'];

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function loadState(): ToolboxState {
  const fallback = defaultState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const stored = JSON.parse(raw) as Partial<ToolboxState>;
    const wire = { ...fallback.wire, ...(stored.wire ?? {}) };
    const coax = { ...fallback.coax, ...(stored.coax ?? {}), datasheet: { ...fallback.coax.datasheet, ...(stored.coax?.datasheet ?? {}) } };
    const pad = { ...fallback.pad, ...(stored.pad ?? {}) };
    const levels = { ...fallback.levels, ...(stored.levels ?? {}) };
    const swr = { ...fallback.swr, ...(stored.swr ?? {}) };
    const numbers = [wire.fMHz, wire.velocityFactor, wire.physicalM, coax.lengthM, coax.fMHz, coax.loadSwr, coax.powerW, pad.attenuationDb, pad.zIn, pad.zOut, levels.dBm, levels.z, levels.txW, swr.swr, swr.forwardW, swr.z0];
    if (!numbers.every(finite)) return fallback;
    if (!Array.isArray(coax.datasheet.points) || coax.datasheet.points.length !== 2) coax.datasheet.points = fallback.coax.datasheet.points;
    const tab = TABS.includes(stored.tab as ToolboxTab) ? (stored.tab as ToolboxTab) : 'wire';
    return { tab, wire, coax, pad, levels, swr };
  } catch {
    return fallback;
  }
}

export function saveState(state: ToolboxState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage can be blocked; the tool still works, it just starts afresh next time.
  }
}
