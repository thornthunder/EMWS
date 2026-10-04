// The RF toolbox, against closed forms and identities.
//
// Nothing here is a figure copied from a cable or component catalogue. Coax loss is checked
// against its own physics (a lossless geometry, the sqrt(f) and f laws, the classic
// standing-wave formula's limits); attenuators against the circuit analysis of what they
// synthesise; levels against the definitions they rest on.

import { describe, expect, it } from 'vitest';
import { mismatchLossFromRho, returnLossFromRho, rhoFromSwr, swrFromPowers, swrFromRho } from '../src/lib/rf';
import { E24 } from '../src/tools/lc/filter';
import { designPad, evaluatePad, minimumLossDb, minimumLossPad, snapPad } from '../src/tools/toolbox/attenuator';
import {
  type Cable,
  CATALOGUE,
  DB_PER_NEPER,
  ETA0,
  characteristicImpedance,
  epsilonOf,
  fitDatasheet,
  lossOfRun,
  matchedLossPer100m,
  runLoss,
  runPowers,
  surfaceResistanceOhms,
} from '../src/tools/toolbox/coax';
import { DIPOLE_GAIN_DBI, dBmToWatts, dBuV, dbToPowerRatio, dbToVoltageRatio, farFieldFromM, fieldStrength, radiatedPower, sMeter, voltsRms, wattsToDbm } from '../src/tools/toolbox/levels';
import { HALF_WAVE_RULES, electricalLength, frequencyForWavelengthMHz, physicalLengthM, wavelengthM } from '../src/tools/toolbox/wavelength';

describe('wavelengths and wire', () => {
  it('is c / f, scaled by the velocity factor', () => {
    expect(wavelengthM(1)).toBeCloseTo(299.792458, 6);
    expect(wavelengthM(14.2)).toBeCloseTo(21.1121, 3);
    expect(wavelengthM(14.2, 0.66)).toBeCloseTo(21.1121 * 0.66, 3);
    expect(frequencyForWavelengthMHz(wavelengthM(7.1))).toBeCloseTo(7.1, 9);
    expect(wavelengthM(0)).toBeNaN();
  });

  it('turns lengths into degrees and back', () => {
    const quarter = physicalLengthM(0.25, 14.2, 0.66);
    expect(quarter).toBeCloseTo((21.1121 * 0.66) / 4, 3);
    expect(electricalLength(quarter, 14.2, 0.66).degrees).toBeCloseTo(90, 9);
    expect(electricalLength(quarter, 14.2, 0.66).wavelengths).toBeCloseTo(0.25, 12);
  });

  it('gives three half-wave figures in the honest order: free space, measured thin wire, folklore', () => {
    const [free, measured, folklore] = HALF_WAVE_RULES.map((r) => r.metreMHz) as [number, number, number];
    expect(free).toBeCloseTo(149.896, 3);
    // Tune measured 10.247 m at 14.2 MHz for a 2 mm wire in free space.
    expect(measured / 14.2).toBeCloseTo(10.247, 2);
    expect(folklore).toBeCloseTo(142.65, 2);
    expect(free).toBeGreaterThan(measured);
    expect(measured).toBeGreaterThan(folklore);
  });
});

describe('coaxial cable', () => {
  const airLine: Cable = { id: 'air', name: 'air line', z0: 50, velocityFactor: 1, loss: { kind: 'geometry', geometry: { innerMm: 1, dielectricMm: Math.E, dielectric: 'air' } } };

  it('knows Z0 from the geometry: (eta0 / 2 pi) ln(D / d), so D / d = e gives 59.96 ohms in air', () => {
    expect(ETA0).toBeCloseTo(376.73, 2);
    expect(characteristicImpedance(airLine.loss.kind === 'geometry' ? airLine.loss.geometry : (undefined as never))).toBeCloseTo(ETA0 / (2 * Math.PI), 9);
    // Solid polyethylene halves... no: divides by sqrt(2.25) = 1.5.
    expect(characteristicImpedance({ innerMm: 1, dielectricMm: Math.E, dielectric: 'pe' })).toBeCloseTo(ETA0 / (2 * Math.PI) / 1.5, 9);
    expect(characteristicImpedance({ innerMm: 2, dielectricMm: 1, dielectric: 'pe' })).toBeNaN();
  });

  it('has a catalogue whose nominal dimensions are coherent with the nominal impedance', () => {
    // Stranded centre conductors read a few percent low this way; a figure far off would be a typo.
    for (const cable of CATALOGUE) {
      if (cable.loss.kind !== 'geometry') continue;
      const z = characteristicImpedance(cable.loss.geometry, epsilonOf(cable));
      expect(Math.abs(z / cable.z0 - 1), `${cable.name}: ${z.toFixed(1)} ohms from its dimensions`).toBeLessThan(0.12);
      expect(cable.velocityFactor).toBeGreaterThan(0.6);
      expect(cable.velocityFactor).toBeLessThanOrEqual(1);
    }
    expect(new Set(CATALOGUE.map((c) => c.id)).size).toBe(CATALOGUE.length);
    // The LMR entries carry their published velocity factors, and their dimensions agree with 50 ohms closely.
    const lmr400 = CATALOGUE.find((c) => c.id === 'lmr400')!;
    expect(lmr400.velocityFactor).toBe(0.85);
    expect(characteristicImpedance((lmr400.loss as { geometry: Parameters<typeof characteristicImpedance>[0] }).geometry, epsilonOf(lmr400))).toBeCloseTo(50, 0);
    expect(CATALOGUE.filter((c) => c.group === 'LMR, 50 Ω').map((c) => c.id)).toEqual(['lmr195', 'lmr240', 'lmr400', 'lmr600']);
  });

  it('loses nothing in a perfect conductor in air, and follows sqrt(f) for the conductors and f for the dielectric', () => {
    expect(surfaceResistanceOhms(100, 0)).toBe(0);
    // Copper at 1 MHz: sqrt(pi f mu0 rho) = sqrt(pi x 1e6 x 4 pi e-7 x 1.68e-8) = 2.5753e-4 ohms.
    expect(surfaceResistanceOhms(1)).toBeCloseTo(Math.sqrt(Math.PI * 1e6 * 4e-7 * Math.PI * 1.68e-8), 12);
    expect(surfaceResistanceOhms(1)).toBeCloseTo(2.5753e-4, 8);
    const rg213 = CATALOGUE.find((c) => c.id === 'rg213')!;
    const at10 = matchedLossPer100m(rg213, 10);
    const at40 = matchedLossPer100m(rg213, 40);
    expect(at40.conductorDb / at10.conductorDb).toBeCloseTo(2, 9);
    expect(at40.dielectricDb / at10.dielectricDb).toBeCloseTo(4, 9);
    expect(at10.totalDb).toBeCloseTo(at10.conductorDb + at10.dielectricDb, 12);
    // By hand for RG-213 at 100 MHz: R' = (Rs / pi)(1/d + 1/D) = 0.476 ohm/m, alpha = R' / 2 Z0 -> 4.13 dB per 100 m.
    const rs = surfaceResistanceOhms(100);
    const rPerM = (rs / Math.PI) * (1 / 0.00226 + 1 / 0.00724);
    expect(matchedLossPer100m(rg213, 100).conductorDb).toBeCloseTo((rPerM / 100) * DB_PER_NEPER * 100, 9);
    expect(matchedLossPer100m(rg213, 100).conductorDb).toBeCloseTo(4.13, 1);
    // Air dielectric: no dielectric loss at all.
    expect(matchedLossPer100m(airLine, 100).dielectricDb).toBe(0);
  });

  it('ranks the catalogue as the physics must: thinner and solid-dielectric cables lose more', () => {
    const loss = (id: string) => matchedLossPer100m(CATALOGUE.find((c) => c.id === id)!, 30).totalDb;
    expect(loss('rg174')).toBeGreaterThan(loss('rg58'));
    expect(loss('rg58')).toBeGreaterThan(loss('rg213'));
    expect(loss('rg213')).toBeGreaterThan(loss('lmr400'));
    expect(loss('rg59')).toBeGreaterThan(loss('rg11'));
    // The LMR family in size order, and the same-size foam cable below the solid-dielectric one.
    expect(loss('lmr195')).toBeGreaterThan(loss('lmr240'));
    expect(loss('lmr240')).toBeGreaterThan(loss('lmr400'));
    expect(loss('lmr400')).toBeGreaterThan(loss('lmr600'));
    expect(loss('lmr195')).toBeLessThan(loss('rg58'));
  });

  it('fits two datasheet points exactly and uses the fit', () => {
    const points: [{ fMHz: number; dbPer100m: number }, { fMHz: number; dbPer100m: number }] = [
      { fMHz: 10, dbPer100m: 4.6 },
      { fMHz: 100, dbPer100m: 16 },
    ];
    const fit = fitDatasheet(points)!;
    expect(fit.k1 * Math.sqrt(10) + fit.k2 * 10).toBeCloseTo(4.6, 12);
    expect(fit.k1 * Math.sqrt(100) + fit.k2 * 100).toBeCloseTo(16, 12);
    const cable: Cable = { id: 'mine', name: 'mine', z0: 50, velocityFactor: 0.66, loss: { kind: 'datasheet', points } };
    expect(matchedLossPer100m(cable, 10).totalDb).toBeCloseTo(4.6, 12);
    expect(matchedLossPer100m(cable, 100).totalDb).toBeCloseTo(16, 12);
    expect(fitDatasheet([points[0], points[0]])).toBeUndefined();
    expect(fitDatasheet([{ fMHz: 0, dbPer100m: 1 }, points[1]])).toBeUndefined();
  });

  it('adds the standing-wave loss by the classic formula, with its limits', () => {
    // A matched load adds nothing; a lossless line loses nothing whatever the SWR.
    expect(runLoss(3, 1).additionalDb).toBeCloseTo(0, 12);
    expect(runLoss(3, 1).radioSwr).toBe(1);
    expect(runLoss(0, 5).totalDb).toBeCloseTo(0, 12);
    // 1 dB matched, SWR 3 (rho 0.5): (a^2 - rho^2) / (a (1 - rho^2)) with a = 1.2589 -> 1.4138 -> 1.504 dB, half a dB extra.
    const a = 10 ** 0.1;
    expect(runLoss(1, 3).totalDb).toBeCloseTo(10 * Math.log10((a * a - 0.25) / (a * 0.75)), 12);
    expect(runLoss(1, 3).totalDb).toBeCloseTo(1.504, 3);
    expect(runLoss(1, 3).additionalDb).toBeCloseTo(0.504, 3);
    // The radio sees the reflection come back weaker by the round trip: rho / a.
    expect(runLoss(1, 3).radioSwr).toBeCloseTo(swrFromRho(0.5 / a), 12);
    expect(runLoss(1, 3).radioSwr).toBeLessThan(3);
    // Total reflection: everything is lost, and the radio still sees a better SWR than infinity.
    expect(runLoss(1, Infinity).totalDb).toBe(Infinity);
    expect(runLoss(1, Infinity).radioSwr).toBeCloseTo(swrFromRho(1 / a), 12);
    // A very long lossy line hides the mismatch: the extra loss tends to a fixed amount and the radio sees 1:1.
    expect(runLoss(60, 3).radioSwr).toBeCloseTo(1, 5);
    expect(runLoss(60, 3).additionalDb).toBeCloseTo(-10 * Math.log10(0.75), 4);
  });

  it('conserves power: what does not reach the antenna warms the cable', () => {
    const rg58 = CATALOGUE.find((c) => c.id === 'rg58')!;
    const run = lossOfRun(rg58, 28.5, 30, 2);
    expect(run.matchedDb).toBeCloseTo((matchedLossPer100m(rg58, 28.5).totalDb * 30) / 100, 12);
    const { deliveredW, heatW } = runPowers(run.totalDb, 100);
    expect(deliveredW + heatW).toBeCloseTo(100, 12);
    expect(deliveredW).toBeCloseTo(100 * 10 ** (-run.totalDb / 10), 12);
    expect(runPowers(Infinity, 100)).toEqual({ deliveredW: 0, heatW: 100 });
  });
});

describe('attenuators', () => {
  const near = (a: number, b: number, digits = 9) => expect(a).toBeCloseTo(b, digits);

  it('synthesises Pi and T pads that measure exactly what they were asked for, matched both ways', () => {
    for (const topology of ['pi', 'tee'] as const) {
      for (const [dB, z1, z2] of [
        [3, 50, 50],
        [10, 50, 50],
        [20, 75, 75],
        [10, 50, 75],
        [6, 75, 50],
        [40, 50, 600],
      ]) {
        const pad = designPad(topology, dB!, z1!, z2!)!;
        expect(pad, `${topology} ${dB} dB ${z1}->${z2}`).toBeDefined();
        const report = evaluatePad(pad, z1!, z2!, 1);
        near(report.attenuationDb, dB!);
        near(report.zIn, z1!);
        near(report.zOut, z2!);
        expect(report.returnLossInDb).toBeGreaterThan(80);
        const { r1, r2, r3, load } = report.dissipationW;
        near(r1 + r2 + r3 + load, 1);
        near(load, 10 ** (-dB! / 10));
      }
    }
  });

  it('knows the textbook values: a 10 dB 50 ohm Pi is 96.2 / 71.2 / 96.2, a T is 26.0 / 35.1 / 26.0', () => {
    const pi = designPad('pi', 10, 50)!;
    near(pi.r1, 96.25, 2);
    near(pi.r3, 71.15, 2);
    near(pi.r2, pi.r1);
    const tee = designPad('tee', 10, 50)!;
    near(tee.r1, 25.97, 2);
    near(tee.r3, 35.14, 2);
    near(tee.r2, tee.r1);
  });

  it('has a minimum between unequal impedances, where the pad becomes the L pad', () => {
    // 75 -> 50: 5.72 dB, series sqrt(75 x 25) = 43.3, shunt 50 sqrt(3) = 86.6.
    near(minimumLossDb(75, 50), 5.719, 3);
    near(minimumLossDb(50, 75), minimumLossDb(75, 50));
    expect(minimumLossDb(50, 50)).toBe(0);
    const ell = minimumLossPad(75, 50)!;
    near(ell.r1, Math.sqrt(75 * 25), 6);
    near(ell.r3, 50 * Math.sqrt(3), 6);
    expect(ell.r2).toBe(0);
    const report = evaluatePad(ell, 75, 50);
    near(report.zIn, 75, 6);
    near(report.zOut, 50, 6);
    near(report.attenuationDb, minimumLossDb(75, 50), 6);
    // The other way round the series arm is on the output side.
    const other = minimumLossPad(50, 75)!;
    expect(other.r1).toBe(0);
    near(other.r2, Math.sqrt(75 * 25), 6);
    // Ask for less than the minimum and there is no pad.
    expect(designPad('tee', 3, 75, 50)).toBeUndefined();
    expect(designPad('pi', 3, 75, 50)).toBeUndefined();
    expect(minimumLossPad(50, 50)).toBeUndefined();
    // A Pi at the minimum drops the shunt on the high side and is the same L pad: series 43.3, shunt 86.6 on the low side.
    const piMin = designPad('pi', minimumLossDb(75, 50), 75, 50)!;
    expect(piMin.r1).toBe(Infinity);
    near(piMin.r3, Math.sqrt(75 * 25), 6);
    near(piMin.r2, 50 * Math.sqrt(3), 6);
    near(evaluatePad(piMin, 75, 50).zIn, 75, 6);
  });

  it('reports the E24 version honestly: near the design, not at it, with its own match', () => {
    const exact = designPad('pi', 10, 50)!;
    const built = snapPad(exact);
    expect(E24.some((v) => Math.abs(built.r1 / 100 - v) < 1e-12 || Math.abs(built.r1 / 10 - v) < 1e-12)).toBe(true);
    const report = evaluatePad(built, 50, 50, 2);
    expect(Math.abs(report.attenuationDb - 10)).toBeGreaterThan(0.01);
    expect(Math.abs(report.attenuationDb - 10)).toBeLessThan(0.5);
    expect(report.returnLossInDb).toBeGreaterThan(20);
    const { r1, r2, r3, load } = report.dissipationW;
    near(r1 + r2 + r3 + load, 2);
    // Absent arms stay absent.
    expect(snapPad(minimumLossPad(75, 50)!).r2).toBe(0);
    expect(snapPad(designPad('pi', minimumLossDb(75, 50), 75, 50)!).r1).toBe(Infinity);
  });
});

describe('levels', () => {
  it('rests on the definitions: 0 dBm is a milliwatt, 50 µV in 50 ohms is -73 dBm, dBµV is dBm + 107 at 50 ohms', () => {
    expect(dBmToWatts(0)).toBeCloseTo(1e-3, 15);
    expect(wattsToDbm(1)).toBeCloseTo(30, 12);
    expect(wattsToDbm(100)).toBeCloseTo(50, 12);
    // -73 dBm is 50.06 µV: the "50 µV" of the definition is the rounded figure.
    expect(voltsRms(dBmToWatts(-73), 50) / 50e-6).toBeCloseTo(1, 2);
    expect(dBuV(dBmToWatts(0), 50)).toBeCloseTo(106.99, 2);
    expect(dbToPowerRatio(3)).toBeCloseTo(1.995, 3);
    expect(dbToVoltageRatio(6)).toBeCloseTo(1.995, 3);
    expect(dbToPowerRatio(10)).toBeCloseTo(10, 12);
  });

  it('reads the IARU S-meter scale: S9 at -73 dBm on HF and -93 dBm on VHF, 6 dB a unit', () => {
    expect(sMeter(-73, 'hf').reading).toBe('S9');
    expect(sMeter(-93, 'vhf').reading).toBe('S9');
    expect(sMeter(-73 - 12, 'hf').reading).toBe('S7');
    expect(sMeter(-73 - 12, 'hf').units).toBeCloseTo(7, 12);
    expect(sMeter(-53, 'hf').reading).toBe('S9 + 20 dB');
    expect(sMeter(-121, 'hf').reading).toBe('S1');
    expect(sMeter(-140, 'hf').reading).toBe('below S1');
  });

  it('radiates: 100 W less 1 dB into 2.15 dBi is 130 W EIRP and 100 W ERP, and 1 kW EIRP makes 173 mV/m at a kilometre', () => {
    const r = radiatedPower(100, 1, DIPOLE_GAIN_DBI);
    expect(r.eirpW).toBeCloseTo(100 * 10 ** 0.115, 9);
    expect(r.erpW).toBeCloseTo(100 * 10 ** -0.1, 9);
    expect(radiatedPower(100, 0, 0).eirpW).toBe(100);
    const e = fieldStrength(1000, 1000);
    expect(e.voltsPerM).toBeCloseTo(Math.sqrt(30000) / 1000, 12);
    expect(e.voltsPerM).toBeCloseTo(0.1732, 4);
    // Poynting: S = E^2 / eta0 agrees with P / 4 pi d^2 (to the 0.07 % by which sqrt(30 P) takes eta0 as 120 pi).
    expect(e.wattsPerM2 / ((e.voltsPerM * e.voltsPerM) / ETA0)).toBeCloseTo(1, 2);
    expect(fieldStrength(100, 0).voltsPerM).toBeNaN();
    // Far field: at least a wavelength, and 2 D^2 / lambda for a big antenna.
    expect(farFieldFromM(14.2, 1)).toBeCloseTo(21.11, 2);
    expect(farFieldFromM(144, 10)).toBeCloseTo((2 * 100) / 2.0819, 2);
  });
});

describe('SWR arithmetic', () => {
  it('goes round the circle: SWR 2 is |Γ| 1/3, 9.54 dB return loss, 0.51 dB mismatch loss, 11.1 % reflected', () => {
    const rho = rhoFromSwr(2);
    expect(rho).toBeCloseTo(1 / 3, 12);
    expect(swrFromRho(rho)).toBeCloseTo(2, 12);
    expect(returnLossFromRho(rho)).toBeCloseTo(9.542, 3);
    expect(mismatchLossFromRho(rho)).toBeCloseTo(0.512, 3);
    expect(rho * rho).toBeCloseTo(0.1111, 4);
    expect(swrFromPowers(100, 100 / 9)).toBeCloseTo(2, 12);
    expect(swrFromPowers(100, 0)).toBe(1);
    expect(swrFromPowers(100, 100)).toBe(Infinity);
    expect(rhoFromSwr(Infinity)).toBe(1);
    expect(rhoFromSwr(0.5)).toBeNaN();
    expect(returnLossFromRho(0)).toBe(Infinity);
    expect(mismatchLossFromRho(1)).toBe(Infinity);
  });
});
