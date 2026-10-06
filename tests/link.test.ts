// The microwave & link-budget tab's maths, held to closed forms and identities - never to
// a remembered figure.

import { describe, expect, it } from 'vitest';
import {
  BOLTZMANN,
  EARTH_RADIUS_KM,
  EFFECTIVE_EARTH,
  GEO_ALTITUDE_KM,
  GEO_SLANT_MAX_KM,
  cascadeNoise,
  dishBeamwidthDeg,
  dishGainDbi,
  horizonBetweenKm,
  linkBudget,
  noiseFloorDbm,
  passiveStage,
  pathLossDb,
  radioHorizonKm,
} from '../src/tools/toolbox/link';

// 299.792458 MHz puts the wavelength at exactly one metre.
const F_LAMBDA_1M = 299.792458;

describe('free-space path loss', () => {
  it('is 0 dB where the distance is lambda / 4 pi, by definition', () => {
    expect(pathLossDb(F_LAMBDA_1M, 1 / (4000 * Math.PI))).toBeCloseTo(0, 9);
  });

  it('grows 20 log10(2) with a doubling of distance, and of frequency', () => {
    const base = pathLossDb(F_LAMBDA_1M, 100);
    expect(pathLossDb(F_LAMBDA_1M, 200) - base).toBeCloseTo(20 * Math.log10(2), 9);
    expect(pathLossDb(2 * F_LAMBDA_1M, 100) - base).toBeCloseTo(20 * Math.log10(2), 9);
  });
});

describe('the dish', () => {
  it('gains exactly 20 dBi when pi D / lambda = 10 and nothing is lost', () => {
    expect(dishGainDbi(10 / Math.PI, F_LAMBDA_1M, 1)).toBeCloseTo(20, 9);
  });

  it('pays 10 log10(2) for an efficiency of a half', () => {
    expect(dishGainDbi(1.2, 2400, 1) - dishGainDbi(1.2, 2400, 0.5)).toBeCloseTo(10 * Math.log10(2), 9);
  });

  it('beamwidth follows 70 lambda / D', () => {
    expect(dishBeamwidthDeg(70, F_LAMBDA_1M)).toBeCloseTo(1, 9);
  });
});

describe('the radio horizon', () => {
  it('is sqrt(2 k R h), and two stations add their horizons', () => {
    const h = 100;
    expect(radioHorizonKm(h)).toBeCloseTo(Math.sqrt(2 * EFFECTIVE_EARTH * EARTH_RADIUS_KM * (h / 1000)), 9);
    expect(horizonBetweenKm(100, 25)).toBeCloseTo(radioHorizonKm(100) + radioHorizonKm(25), 12);
    expect(radioHorizonKm(0)).toBe(0);
  });

  it('puts the geostationary slant range at the horizon where geometry puts it', () => {
    expect(GEO_SLANT_MAX_KM).toBeCloseTo(Math.sqrt((EARTH_RADIUS_KM + GEO_ALTITUDE_KM) ** 2 - EARTH_RADIUS_KM ** 2), 6);
    expect(GEO_SLANT_MAX_KM).toBeGreaterThan(GEO_ALTITUDE_KM);
  });
});

describe('thermal noise', () => {
  it('is kTB: the textbook -174 dBm/Hz at 290 K, from Boltzmann, not from memory', () => {
    const oneHz = 10 * Math.log10(BOLTZMANN * 290 * 1 * 1000);
    expect(noiseFloorDbm(1)).toBeCloseTo(oneHz, 9);
    expect(noiseFloorDbm(1)).toBeCloseTo(-174, 0);
  });

  it('grows 10 log10(B) with bandwidth', () => {
    expect(noiseFloorDbm(2700) - noiseFloorDbm(1)).toBeCloseTo(10 * Math.log10(2700), 9);
  });
});

describe("Friis's cascade", () => {
  it('a lone passive loss has a noise figure equal to its loss', () => {
    expect(cascadeNoise([passiveStage('feeder', 3)]).nfDb).toBeCloseTo(3, 9);
  });

  it('matches the formula for two stages, worked by hand', () => {
    const f1 = 10 ** 0.1; // 1 dB
    const f2 = 10 ** 1; // 10 dB
    const g1 = 10; // 10 dB
    const expected = 10 * Math.log10(f1 + (f2 - 1) / g1);
    expect(cascadeNoise([{ label: 'a', gainDb: 10, nfDb: 1 }, { label: 'b', gainDb: 0, nfDb: 10 }]).nfDb).toBeCloseTo(expected, 9);
  });

  it('is why the preamp belongs at the antenna', () => {
    const preamp = { label: 'preamp', gainDb: 20, nfDb: 1 };
    const rig = { label: 'rig', gainDb: 0, nfDb: 6 };
    const atAntenna = cascadeNoise([preamp, passiveStage('feeder', 2), rig]).nfDb;
    const atRig = cascadeNoise([passiveStage('feeder', 2), preamp, rig]).nfDb;
    expect(atAntenna).toBeLessThan(atRig);
    // With the feeder first, its loss lands in full: NF >= the loss plus the preamp's own.
    expect(atRig).toBeGreaterThan(2 + 1 - 0.01);
  });

  it('sums the gains in dB', () => {
    const chain = cascadeNoise([{ label: 'a', gainDb: 20, nfDb: 1 }, passiveStage('feeder', 2), { label: 'rig', gainDb: 7, nfDb: 6 }]);
    expect(chain.gainDb).toBeCloseTo(25, 9);
  });
});

describe('the budget', () => {
  it('adds up, dB by dB', () => {
    const chain = [{ label: 'rig', gainDb: 0, nfDb: 6 }];
    const b = linkBudget({
      txPowerW: 10, // 40 dBm
      txFeederLossDb: 1,
      txGainDbi: 12,
      fMHz: 144.3,
      distanceKm: 200,
      rxGainDbi: 12,
      rxChain: chain,
      bandwidthHz: 500,
      requiredSnrDb: 3,
    });
    expect(b.eirpDbm).toBeCloseTo(40 - 1 + 12, 9);
    expect(b.pathLossDb).toBeCloseTo(pathLossDb(144.3, 200), 12);
    expect(b.receivedDbm).toBeCloseTo(b.eirpDbm - b.pathLossDb + 12, 9);
    expect(b.systemNfDb).toBeCloseTo(6, 9);
    expect(b.snrDb).toBeCloseTo(b.receivedDbm - (noiseFloorDbm(500) + 6), 9);
    expect(b.marginDb).toBeCloseTo(b.snrDb - 3, 9);
  });
});
