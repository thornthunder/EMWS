// The feed-line transform the Antenna Modeler hangs between the radio and the feed point.
//
// Held to the identities that matter: a matched load costs exactly the matched loss; a
// lossless quarter wave inverts the impedance (the case tanh gets silently wrong, which
// is why the maths uses cosh and sinh); and for a real Z0 the exact ABCD walk lands on
// the classic (a² - ρ²) / (a (1 - ρ²)) and its radio-side SWR to the last digit.

import { describe, expect, it } from 'vitest';
import { throughLine, toolboxDatasheetCable } from '../src/tools/antenna-modeler/feedline';
import { type Cable, cableById, lossOfRun, matchedLossPer100m, runLoss } from '../src/tools/toolbox/coax';
import { C0 } from '../src/tools/lc/coil';
import { swr } from '../src/lib/rf';

const lmr400 = cableById('lmr400')!;

/** A lossless 50-ohm line: two zero datasheet points fit k1 = k2 = 0 exactly. */
const lossless: Cable = {
  id: 'ideal',
  name: 'Lossless 50 Ω',
  z0: 50,
  velocityFactor: 0.66,
  loss: { kind: 'datasheet', points: [{ fMHz: 10, dbPer100m: 0 }, { fMHz: 100, dbPer100m: 0 }] },
};

describe('the feed line', () => {
  it('costs exactly the matched loss into a matched load, and does not move the impedance', () => {
    const [p] = throughLine(lmr400, 30, [{ fMHz: 14.2, z: { re: 50, im: 0 } }]);
    const matched = (matchedLossPer100m(lmr400, 14.2).totalDb * 30) / 100;
    expect(p!.lossDb).toBeCloseTo(matched, 9);
    expect(p!.matchedDb).toBeCloseTo(matched, 12);
    expect(p!.z.re).toBeCloseTo(50, 6);
    expect(p!.z.im).toBeCloseTo(0, 6);
  });

  it('inverts the impedance a quarter wave along a lossless line (where tanh is infinite)', () => {
    const fMHz = 10;
    const quarter = (C0 * lossless.velocityFactor) / (4 * fMHz * 1e6);
    const [p] = throughLine(lossless, quarter, [{ fMHz, z: { re: 100, im: 0 } }]);
    expect(p!.lossDb).toBeCloseTo(0, 9);
    expect(p!.z.re).toBeCloseTo(50 * 50 / 100, 9);
    expect(p!.z.im).toBeCloseTo(0, 6);
  });

  it('reproduces the classic mismatched-run loss and the radio-side SWR to the last digit', () => {
    const load = { re: 20, im: -35 };
    const fMHz = 28.5;
    const lengthM = 42;
    const [p] = throughLine(lmr400, lengthM, [{ fMHz, z: load }]);
    const classic = runLoss((matchedLossPer100m(lmr400, fMHz).totalDb * lengthM) / 100, swr(load, lmr400.z0));
    expect(p!.lossDb).toBeCloseTo(classic.totalDb, 9);
    expect(swr(p!.z, lmr400.z0)).toBeCloseTo(classic.radioSwr, 9);
    // And the toolbox's one-call form agrees with its own pieces.
    expect(lossOfRun(lmr400, fMHz, lengthM, swr(load, lmr400.z0)).totalDb).toBeCloseTo(classic.totalDb, 12);
  });

  it('calls a purely reactive load what it is: nothing delivered, infinite loss', () => {
    const [p] = throughLine(lmr400, 30, [{ fMHz: 14.2, z: { re: 0, im: 120 } }]);
    expect(p!.lossDb).toBe(Infinity);
  });

  it('scales the matched loss with the length', () => {
    const [a] = throughLine(lmr400, 10, [{ fMHz: 14.2, z: { re: 50, im: 0 } }]);
    const [b] = throughLine(lmr400, 20, [{ fMHz: 14.2, z: { re: 50, im: 0 } }]);
    expect(b!.matchedDb).toBeCloseTo(2 * a!.matchedDb, 9);
  });

  it('falls back to the toolbox default datasheet cable where no browser storage exists', () => {
    const cable = toolboxDatasheetCable();
    expect(cable.id).toBe('datasheet');
    expect(cable.z0).toBe(50);
    expect(cable.loss.kind).toBe('datasheet');
  });
});
