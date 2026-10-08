// What the RF toolbox remembers between visits: which tab is open and what was typed in it.

import type { Cable, LossPoint } from './coax';
import type { Topology } from './attenuator';
import type { SBand } from './levels';

export type ToolboxTab = 'wire' | 'coax' | 'pad' | 'levels' | 'swr' | 'link' | 'imd' | 'path';

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

/** One end's antenna: a dish whose gain is computed, or a gain typed straight in. */
export type LinkAntenna = 'dish' | 'gain';

export interface LinkInputs {
  fMHz: number;
  distanceKm: number;
  txPowerW: number;
  txFeederLossDb: number;
  txAntenna: LinkAntenna;
  txDishM: number;
  txEfficiency: number;
  txGainDbi: number;
  rxAntenna: LinkAntenna;
  rxDishM: number;
  rxEfficiency: number;
  rxGainDbi: number;
  /** Where the preamp sits: at the antenna (true) or at the rig end of the feeder. */
  preampFirst: boolean;
  preampGainDb: number;
  preampNfDb: number;
  rxFeederLossDb: number;
  rigNfDb: number;
  bandwidthHz: number;
  requiredSnrDb: number;
  /** For the radio horizon. */
  h1M: number;
  h2M: number;
}

/** How far up the products are followed; beyond the seventh nobody has a figure anyway. */
export type ImdOrder = 3 | 5 | 7;

export interface ImdInputs {
  /** Transmitters on the site, MHz: two to four of them. */
  transmittersMHz: number[];
  maxOrder: ImdOrder;
  /** Frequencies someone is listening on, MHz: up to four. */
  receiversMHz: number[];
  /** How near a product must land to count as a hit: half a channel, say. */
  toleranceKHz: number;
  /** For the third-order level: two equal tones at this level ... */
  toneDbm: number;
  /** ... into a stage with this input intercept point. */
  iip3Dbm: number;
}

export interface PathInputs {
  fMHz: number;
  /** From your end to the obstacle, and from the obstacle to the far end. */
  d1Km: number;
  d2Km: number;
  /** The obstacle's top relative to the straight line between the antennas, metres; below it is negative. */
  obstacleM: number;
}

export interface ToolboxState {
  tab: ToolboxTab;
  wire: WireInputs;
  coax: CoaxInputs;
  pad: PadInputs;
  levels: LevelsInputs;
  swr: SwrInputs;
  link: LinkInputs;
  imd: ImdInputs;
  path: PathInputs;
}

export const MAX_TRANSMITTERS = 4;
export const MAX_RECEIVERS = 4;

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
    // The club's standing example: a 2.4 GHz uplink to a geostationary satellite.
    link: {
      fMHz: 2400,
      distanceKm: 35786,
      txPowerW: 5,
      txFeederLossDb: 1,
      txAntenna: 'dish',
      txDishM: 1.2,
      txEfficiency: 0.55,
      txGainDbi: 15,
      rxAntenna: 'gain',
      rxDishM: 1,
      rxEfficiency: 0.55,
      rxGainDbi: 0,
      preampFirst: true,
      preampGainDb: 20,
      preampNfDb: 1,
      rxFeederLossDb: 2,
      rigNfDb: 6,
      bandwidthHz: 2700,
      requiredSnrDb: 10,
      h1M: 10,
      h2M: 10,
    },
    // Two 2 m repeaters 100 kHz apart put their third-order product on the FM calling
    // channel: 2 x 145.600 - 145.700 = 145.500, exactly.
    imd: { transmittersMHz: [145.6, 145.7], maxOrder: 5, receiversMHz: [145.5, 145.0], toleranceKHz: 12.5, toneDbm: -30, iip3Dbm: 10 },
    // A ridge 3 km out on a 10 km 2 m path, ten metres below the line of sight: looks
    // clear on the map and is not.
    path: { fMHz: 145, d1Km: 3, d2Km: 7, obstacleM: -10 },
  };
}

const STORAGE_KEY = 'emws.toolbox.v1';
const TABS: ToolboxTab[] = ['wire', 'coax', 'pad', 'levels', 'swr', 'link', 'imd', 'path'];

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const finiteList = (v: unknown, min: number, max: number): v is number[] => Array.isArray(v) && v.length >= min && v.length <= max && v.every(finite);

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
    const link = { ...fallback.link, ...(stored.link ?? {}) };
    const imd = { ...fallback.imd, ...(stored.imd ?? {}) };
    const path = { ...fallback.path, ...(stored.path ?? {}) };
    const numbers = [wire.fMHz, wire.velocityFactor, wire.physicalM, coax.lengthM, coax.fMHz, coax.loadSwr, coax.powerW, pad.attenuationDb, pad.zIn, pad.zOut, levels.dBm, levels.z, levels.txW, swr.swr, swr.forwardW, swr.z0, link.fMHz, link.distanceKm, link.txPowerW, link.bandwidthHz, link.h1M, link.h2M, imd.toleranceKHz, imd.toneDbm, imd.iip3Dbm, path.fMHz, path.d1Km, path.d2Km, path.obstacleM];
    if (!numbers.every(finite)) return fallback;
    if (!Array.isArray(coax.datasheet.points) || coax.datasheet.points.length !== 2) coax.datasheet.points = fallback.coax.datasheet.points;
    if (!finiteList(imd.transmittersMHz, 2, MAX_TRANSMITTERS)) imd.transmittersMHz = fallback.imd.transmittersMHz;
    if (!finiteList(imd.receiversMHz, 0, MAX_RECEIVERS)) imd.receiversMHz = fallback.imd.receiversMHz;
    if (![3, 5, 7].includes(imd.maxOrder)) imd.maxOrder = fallback.imd.maxOrder;
    const tab = TABS.includes(stored.tab as ToolboxTab) ? (stored.tab as ToolboxTab) : 'wire';
    return { tab, wire, coax, pad, levels, swr, link, imd, path };
  } catch {
    return fallback;
  }
}

/**
 * The cable typed in under "From its datasheet", as a cable other tools can use - the
 * modeller's feed line, the LC tool's stubs. Read from the same storage with the same
 * two-point fit, so no two tools can disagree about it.
 */
export function savedDatasheetCable(): Cable {
  const d = loadState().coax.datasheet;
  return { id: 'datasheet', name: d.name || 'My cable', z0: d.z0, velocityFactor: d.velocityFactor, loss: { kind: 'datasheet', points: d.points } };
}

export function saveState(state: ToolboxState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage can be blocked; the tool still works, it just starts afresh next time.
  }
}
