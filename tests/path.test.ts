// The path tab's maths - Fresnel zones, earth bulge, knife-edge diffraction - held to
// closed forms, to tabulated values of the Fresnel integrals, and to the one published
// approximation everybody else uses, never to a remembered figure of our own.

import { describe, expect, it } from 'vitest';
import {
  CLEAR_FRACTION,
  diffractionParameter,
  earthBulgeM,
  fresnelIntegrals,
  fresnelRadiusM,
  knifeEdgeLossDb,
  obstacle,
} from '../src/tools/toolbox/path';
import { EARTH_RADIUS_KM, EFFECTIVE_EARTH } from '../src/tools/toolbox/link';

// 299.792458 MHz puts the wavelength at exactly one metre.
const F_LAMBDA_1M = 299.792458;

describe('Fresnel zones', () => {
  it('first zone at mid-path is half the square root of lambda times the path', () => {
    // r1 = sqrt(lambda d1 d2 / (d1 + d2)); at the middle of D that is sqrt(lambda D / 4).
    expect(fresnelRadiusM(F_LAMBDA_1M, 2, 2)).toBeCloseTo(Math.sqrt(4000 / 4), 9);
  });

  it('agrees with the field form 17.32 sqrt(d1 d2 / (f D)) (km, GHz, m) to its own rounding', () => {
    const field = 17.32 * Math.sqrt((3 * 7) / ((145 / 1000) * 10));
    expect(fresnelRadiusM(145, 3, 7)).toBeCloseTo(field, 0);
    expect(Math.abs(fresnelRadiusM(145, 3, 7) - field) / field).toBeLessThan(1e-3);
  });

  it('the n-th zone is sqrt(n) times the first', () => {
    expect(fresnelRadiusM(432, 5, 12, 3) / fresnelRadiusM(432, 5, 12, 1)).toBeCloseTo(Math.sqrt(3), 12);
  });

  it('refuses a zero distance or frequency', () => {
    expect(fresnelRadiusM(145, 0, 7)).toBeNaN();
    expect(fresnelRadiusM(0, 3, 7)).toBeNaN();
  });
});

describe('earth bulge', () => {
  it('is d1 d2 / 2kR, the folklore d1 d2 / 17 in km and metres', () => {
    expect(earthBulgeM(10, 10)).toBeCloseTo((10e3 * 10e3) / (2 * EFFECTIVE_EARTH * EARTH_RADIUS_KM * 1e3), 9);
    expect(earthBulgeM(10, 10)).toBeCloseTo(100 / 17, 0);
    expect(earthBulgeM(0, 10)).toBe(0);
  });
});

describe('the Fresnel integrals', () => {
  it('reproduce the tabulated values', () => {
    // Abramowitz & Stegun table 7.7: C(0.5) 0.4923, S(0.5) 0.0647; C(1) 0.7799, S(1) 0.4383; C(2) 0.4883, S(2) 0.3434.
    expect(fresnelIntegrals(0.5).c).toBeCloseTo(0.4923, 4);
    expect(fresnelIntegrals(0.5).s).toBeCloseTo(0.0647, 4);
    expect(fresnelIntegrals(1).c).toBeCloseTo(0.7799, 4);
    expect(fresnelIntegrals(1).s).toBeCloseTo(0.4383, 4);
    expect(fresnelIntegrals(2).c).toBeCloseTo(0.4883, 4);
    expect(fresnelIntegrals(2).s).toBeCloseTo(0.3434, 4);
  });

  it('are odd, zero at zero, and tend to a half', () => {
    expect(fresnelIntegrals(0)).toEqual({ c: 0, s: 0 });
    expect(fresnelIntegrals(-1).c).toBeCloseTo(-fresnelIntegrals(1).c, 12);
    expect(fresnelIntegrals(-1).s).toBeCloseTo(-fresnelIntegrals(1).s, 12);
    expect(fresnelIntegrals(10).c).toBeCloseTo(0.5, 2);
    expect(fresnelIntegrals(10).s).toBeCloseTo(0.5, 1);
  });
});

describe('knife-edge diffraction', () => {
  it('is exactly 6.02 dB at grazing: half the field', () => {
    expect(knifeEdgeLossDb(0)).toBeCloseTo(20 * Math.log10(2), 6);
  });

  it('is free space with the edge far below the path, and only ever a dB or so better', () => {
    expect(Math.abs(knifeEdgeLossDb(-6))).toBeLessThan(0.5);
    expect(knifeEdgeLossDb(-20)).toBe(0);
    let best = 0;
    for (let v = -4; v < 0; v += 0.01) best = Math.min(best, knifeEdgeLossDb(v));
    expect(best).toBeLessThan(-1);
    expect(best).toBeGreaterThan(-1.5);
  });

  it('is why the 60 % rule: that much of the first zone clear is within half a dB of free space', () => {
    // h = -0.6 r1 means v = -0.6 sqrt(2).
    expect(Math.abs(knifeEdgeLossDb(-CLEAR_FRACTION * Math.SQRT2))).toBeLessThan(0.5);
  });

  it('agrees with the ITU-R P.526 single-edge approximation within a quarter dB where that holds (v > -0.78)', () => {
    const approximation = (v: number) => 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1);
    for (let v = -0.75; v <= 12; v += 0.05) expect(Math.abs(knifeEdgeLossDb(v) - approximation(v))).toBeLessThan(0.25);
  });

  it('grows as 20 log10(sqrt 2 pi v) in deep shadow, with no step at the handover', () => {
    expect(knifeEdgeLossDb(10)).toBeCloseTo(20 * Math.log10(Math.SQRT2 * Math.PI * 10), 1);
    expect(Math.abs(knifeEdgeLossDb(11.999) - knifeEdgeLossDb(12.001))).toBeLessThan(0.01);
    expect(knifeEdgeLossDb(100)).toBeCloseTo(20 * Math.log10(Math.SQRT2 * Math.PI * 100), 9);
  });
});

describe('an obstacle on the path', () => {
  it('v is sqrt(2) h / r1, so the edge level with the first zone reads v = sqrt 2', () => {
    const r1 = fresnelRadiusM(145, 3, 7);
    expect(diffractionParameter(r1, 145, 3, 7)).toBeCloseTo(Math.SQRT2, 9);
    expect(diffractionParameter(-r1 / 2, 145, 3, 7)).toBeCloseTo(-Math.SQRT2 / 2, 9);
  });

  it('reports the clearance as a fraction of the first zone, and what the 60 % rule needs', () => {
    const r = obstacle({ fMHz: 145, d1Km: 3, d2Km: 7, obstacleM: -10 });
    expect(r.clearanceFraction).toBeCloseTo(10 / r.r1M, 12);
    expect(r.clearanceNeededM).toBeCloseTo(CLEAR_FRACTION * r.r1M, 12);
    expect(r.bulgeM).toBeCloseTo(earthBulgeM(3, 7), 12);
    expect(r.lossDb).toBeCloseTo(knifeEdgeLossDb(r.v), 12);
  });

  it('an edge on the line of sight costs 6 dB whatever the frequency', () => {
    expect(obstacle({ fMHz: 50, d1Km: 1, d2Km: 20, obstacleM: 0 }).lossDb).toBeCloseTo(6.02, 2);
    expect(obstacle({ fMHz: 10_000, d1Km: 1, d2Km: 20, obstacleM: 0 }).lossDb).toBeCloseTo(6.02, 2);
  });
});
