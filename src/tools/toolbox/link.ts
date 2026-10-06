// Microwave links: path loss, dish gain, the radio horizon, thermal noise and the
// receiver chain - the sums a QO-100 uplink or a 10 GHz contest shot is planned with.
//
// Everything here is textbook arithmetic with the working shown:
//
//   - Friis free-space path loss,  L = (4 pi d / lambda)^2 . Free space means exactly
//     that: no ground gain, no rain, no trees. Terrestrial paths do better and worse.
//   - a parabolic dish,  G = eta (pi D / lambda)^2,  with the efficiency typed in
//     (0.5 to 0.6 is the usual run of amateur dishes; the default is 0.55 and says so),
//     and the common beamwidth approximation  theta_3dB ~ 70 lambda / D  degrees.
//   - the radio horizon over a 4/3 earth,  d = sqrt(2 k R h),  the standard allowance
//     for average refraction - not a guarantee on any given day.
//   - thermal noise,  P = k T B,  with Boltzmann's constant exact by SI definition.
//   - Friis's other formula: noise figures in cascade,
//     F = F1 + (F2 - 1)/G1 + (F3 - 1)/(G1 G2) + ...  - why the preamp belongs at the
//     antenna, in numbers.
//
// Public domain (The Unlicense). By ZR1JT.

import { C0 } from '../lc/coil';
import { dbToPowerRatio, powerRatioToDb, wattsToDbm } from './levels';

/** Boltzmann's constant, J/K - exact, by the SI definition of the kelvin. */
export const BOLTZMANN = 1.380649e-23;
/** The reference temperature noise figures are defined against, kelvin. */
export const T0_K = 290;
/** Mean earth radius, km. */
export const EARTH_RADIUS_KM = 6371;
/** The 4/3-earth factor: standard atmospheric refraction bends radio paths this much. */
export const EFFECTIVE_EARTH = 4 / 3;
/** A geostationary satellite's height above the equator, km (the QO-100 example's floor). */
export const GEO_ALTITUDE_KM = 35_786;
/** The slant range to a geostationary satellite seen right on the horizon, km: pure geometry. */
export const GEO_SLANT_MAX_KM = Math.sqrt((EARTH_RADIUS_KM + GEO_ALTITUDE_KM) ** 2 - EARTH_RADIUS_KM ** 2);

/** Free-space path loss, dB: 20 log10(4 pi d / lambda). */
export function pathLossDb(fMHz: number, distanceKm: number): number {
  if (!(fMHz > 0) || !(distanceKm > 0)) return NaN;
  const lambdaM = C0 / (fMHz * 1e6);
  return 20 * Math.log10((4 * Math.PI * distanceKm * 1000) / lambdaM);
}

/** A parabolic dish's gain, dBi: eta (pi D / lambda)^2. */
export function dishGainDbi(diameterM: number, fMHz: number, efficiency = 0.55): number {
  if (!(diameterM > 0) || !(fMHz > 0) || !(efficiency > 0)) return NaN;
  const lambdaM = C0 / (fMHz * 1e6);
  return powerRatioToDb(efficiency * ((Math.PI * diameterM) / lambdaM) ** 2);
}

/** The usual -3 dB beamwidth approximation for a dish, degrees: about 70 lambda / D. */
export function dishBeamwidthDeg(diameterM: number, fMHz: number): number {
  if (!(diameterM > 0) || !(fMHz > 0)) return NaN;
  const lambdaM = C0 / (fMHz * 1e6);
  return (70 * lambdaM) / diameterM;
}

/** The radio horizon of one antenna over a 4/3 earth, km: sqrt(2 k R h). */
export function radioHorizonKm(heightM: number): number {
  if (!(heightM >= 0)) return NaN;
  return Math.sqrt(2 * EFFECTIVE_EARTH * EARTH_RADIUS_KM * (heightM / 1000));
}

/** How far apart two antennas can be and still see each other over a smooth 4/3 earth, km. */
export function horizonBetweenKm(h1M: number, h2M: number): number {
  return radioHorizonKm(h1M) + radioHorizonKm(h2M);
}

/** Thermal noise in a bandwidth, dBm: k T B. At 290 K this is the -174 dBm/Hz floor. */
export function noiseFloorDbm(bandwidthHz: number, tempK = T0_K): number {
  if (!(bandwidthHz > 0) || !(tempK > 0)) return NaN;
  return wattsToDbm(BOLTZMANN * tempK * bandwidthHz);
}

export interface Stage {
  label: string;
  /** Gain in dB; a loss is a negative gain. */
  gainDb: number;
  /** Noise figure in dB. A passive loss's noise figure IS its loss. */
  nfDb: number;
}

/** A lossy cable or relay as a cascade stage: it loses what it loses, and that is its noise figure. */
export function passiveStage(label: string, lossDb: number): Stage {
  return { label, gainDb: -lossDb, nfDb: lossDb };
}

export interface Cascade {
  /** The whole chain's noise figure, dB, referred to its input. */
  nfDb: number;
  gainDb: number;
  /** Each stage's share: its contribution to the total noise factor, referred to the input. */
  shares: { label: string; factorShare: number }[];
}

/** Friis's cascade: F = F1 + (F2 - 1)/G1 + (F3 - 1)/(G1 G2) + ... */
export function cascadeNoise(stages: readonly Stage[]): Cascade {
  let factor = 1;
  let gain = 1;
  const shares: Cascade['shares'] = [];
  for (const [i, s] of stages.entries()) {
    const f = dbToPowerRatio(s.nfDb);
    const share = i === 0 ? f : (f - 1) / gain;
    factor += i === 0 ? f - 1 : share;
    shares.push({ label: s.label, factorShare: share });
    gain *= dbToPowerRatio(s.gainDb);
  }
  return { nfDb: powerRatioToDb(factor), gainDb: powerRatioToDb(gain), shares };
}

export interface LinkBudget {
  eirpDbm: number;
  pathLossDb: number;
  receivedDbm: number;
  /** Thermal floor in the bandwidth, before the receiver's own noise. */
  noiseFloorDbm: number;
  /** The receiver chain's noise figure, dB. */
  systemNfDb: number;
  /** Signal-to-noise in the bandwidth, dB. */
  snrDb: number;
  /** What is left over the SNR the mode needs, dB. */
  marginDb: number;
}

export interface LinkInputsPure {
  txPowerW: number;
  txFeederLossDb: number;
  txGainDbi: number;
  fMHz: number;
  distanceKm: number;
  rxGainDbi: number;
  /** The receive chain, antenna first. */
  rxChain: readonly Stage[];
  bandwidthHz: number;
  requiredSnrDb: number;
}

/** The whole budget: watts out, dB by dB, to the margin over what the mode needs. */
export function linkBudget(i: LinkInputsPure): LinkBudget {
  const eirpDbm = wattsToDbm(i.txPowerW) - i.txFeederLossDb + i.txGainDbi;
  const path = pathLossDb(i.fMHz, i.distanceKm);
  const receivedDbm = eirpDbm - path + i.rxGainDbi;
  const floor = noiseFloorDbm(i.bandwidthHz);
  const chain = cascadeNoise(i.rxChain);
  const snrDb = receivedDbm - (floor + chain.nfDb);
  return {
    eirpDbm,
    pathLossDb: path,
    receivedDbm,
    noiseFloorDbm: floor,
    systemNfDb: chain.nfDb,
    snrDb,
    marginDb: snrDb - i.requiredSnrDb,
  };
}
