// Coax stubs and the coupled-resonator band-pass, held to closed forms and to what the
// design promises. Figures in comments were MEASURED (2026-10-05) before being written.

import { describe, expect, it } from 'vitest';
import { cAbs } from '../src/lib/complex';
import { bandpassResponse, cavityLine, db, designBandpass, shuntS21, stubImpedance, stubLengthM, stubResponse } from '../src/tools/lc/stub';
import { type Cable, cableById } from '../src/tools/toolbox/coax';

const lossless: Cable = { id: 'x', name: 'lossless 50', z0: 50, velocityFactor: 0.66, loss: { kind: 'datasheet', points: [{ fMHz: 10, dbPer100m: 0 }, { fMHz: 100, dbPer100m: 0 }] } };

describe('stubs', () => {
  it('are a quarter (or half) wave in the line, velocity factor and all', () => {
    expect(stubLengthM(lossless, 'open-quarter', 145)).toBeCloseTo((299.792458 / 145 / 4) * 0.66, 9);
    expect(stubLengthM(lossless, 'shorted-half', 145)).toBeCloseTo((299.792458 / 145 / 2) * 0.66, 9);
  });

  it('turn a short into an open a quarter wave down a lossless line, and back a half wave down', () => {
    const q = stubLengthM(lossless, 'open-quarter', 145);
    expect(cAbs(stubImpedance(lossless, q, true, 145))).toBeGreaterThan(1e9);
    expect(cAbs(stubImpedance(lossless, q, false, 145))).toBeLessThan(1e-6);
    expect(cAbs(stubImpedance(lossless, 2 * q, true, 145))).toBeLessThan(1e-6);
  });

  it('pass straight through an open circuit and halve the voltage across z0/2', () => {
    expect(cAbs(shuntS21({ re: 1e15, im: 0 }))).toBeCloseTo(1, 9);
    expect(cAbs(shuntS21({ re: 25, im: 0 }))).toBeCloseTo(0.5, 12);
  });

  // MEASURED: open λ/4 at 145 MHz notches -39.8 dB in RG-58, -47.1 in RG-213, -46.8 in
  // LMR-400; at twice the frequency the loss is -0.03 / -0.014 dB; 1 MHz off the notch still
  // takes ~32-33 dB - a plain stub is broad.
  it('notch as deep as the cable loss allows, and pass twice the frequency', () => {
    const notch = (id: string) => {
      const c = cableById(id)!;
      const len = stubLengthM(c, 'open-quarter', 145);
      return { at: db(stubResponse(c, 'open-quarter', len, 145)), twice: db(stubResponse(c, 'open-quarter', len, 290)), near: db(stubResponse(c, 'open-quarter', len, 146)) };
    };
    const thin = notch('rg58');
    const thick = notch('rg213');
    expect(thin.at).toBeLessThan(-35);
    expect(thick.at).toBeLessThan(thin.at);
    expect(thin.twice).toBeGreaterThan(-0.05);
    expect(thin.near).toBeLessThan(-30);
  });
});

describe('the coupled-resonator band-pass', () => {
  // MEASURED with lossless resonators: Butterworth n3 145 ± 1 MHz reads -3.07 / -2.94 dB at
  // the edges; Chebyshev 0.1 dB n3 reads -0.10 / -0.10.
  it('meets its prototype at the band edges with lossless resonators', () => {
    const bw = designBandpass({ centreMHz: 145, bandwidthMHz: 2, order: 3, family: 'butterworth', rippleDb: 0, z0: 50 }, lossless);
    const r = (f: number) => db(bandpassResponse(bw, lossless, f));
    expect(r(145)).toBeGreaterThan(-0.01);
    expect(Math.abs(r(144) + 3.01)).toBeLessThan(0.2);
    expect(Math.abs(r(146) + 3.01)).toBeLessThan(0.2);
    expect(r(140)).toBeLessThan(-35);
    const ch = designBandpass({ centreMHz: 145, bandwidthMHz: 2, order: 3, family: 'chebyshev', rippleDb: 0.1, z0: 50 }, lossless);
    expect(Math.abs(db(bandpassResponse(ch, lossless, 144)) + 0.1)).toBeLessThan(0.03);
    expect(Math.abs(db(bandpassResponse(ch, lossless, 146)) + 0.1)).toBeLessThan(0.03);
  });

  it('shortens each resonator below a quarter wave to carry its capacitors, ends more than the middle', () => {
    const d = designBandpass({ centreMHz: 145, bandwidthMHz: 2, order: 3, family: 'butterworth', rippleDb: 0, z0: 50 }, lossless);
    expect(d.couplingF).toHaveLength(4);
    d.resonatorDeg.forEach((deg) => expect(deg).toBeLessThan(90));
    expect(d.resonatorDeg[0]!).toBeLessThan(d.resonatorDeg[1]!);
    expect(d.couplingF[0]!).toBeGreaterThan(d.couplingF[1]!);
  });

  // MEASURED: the same 2 MHz filter on LMR-400 stubs loses 3.5 dB in the middle; a resonator's
  // Q, not the design, sets that. A cavity of unloaded Q 2000 loses far less.
  it('shows what resonator Q costs, and a cavity of high Q costs little', () => {
    const spec = { centreMHz: 145, bandwidthMHz: 2, order: 3, family: 'butterworth' as const, rippleDb: 0, z0: 50 };
    const coax = cableById('lmr400')!;
    const onCoax = db(bandpassResponse(designBandpass(spec, coax), coax, 145));
    const cavity = cavityLine(70, 2000, 145);
    const onCavity = db(bandpassResponse(designBandpass(spec, cavity), cavity, 145));
    expect(onCoax).toBeLessThan(-2);
    expect(onCavity).toBeGreaterThan(-1);
    expect(onCavity).toBeGreaterThan(onCoax);
  });

  it('gives a cavity line exactly the Q it was asked for', () => {
    // A shorted quarter wave of the cavity line: its unloaded Q = β / (2α) at the design frequency.
    const line = cavityLine(70, 1500, 435);
    const len = stubLengthM(line, 'shorted-quarter', 435);
    const z = stubImpedance(line, len, true, 435);
    // At resonance the shorted quarter wave is a parallel resistance Rp = Z0 · 4Q / π.
    expect(z.re).toBeCloseTo((70 * 4 * 1500) / Math.PI, -1);
  });
});
