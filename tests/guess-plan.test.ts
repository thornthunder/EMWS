// The step-by-step guess's judgement: what it asks to wind next, and whether two windings
// agree. Readings are made through the model, as a VNA would see them.

import { describe, expect, it } from 'vitest';
import { coreImpedance, debyePermeability, toroidGeometry } from '../src/lib/ferrite';
import type { MeasuredPoint } from '../src/lib/touchstone';
import { CORES } from '../src/tools/balun/catalog';
import { AGREE_WITHIN, LOW_OHMS, MIN_TRUST_MHZ, type Reading, type Tried, WIZARD_SWEEP, agreement, betterReading, capacitiveAtMHz, commonCrossing, confirmingTurns, judgeNext, judgeReading } from '../src/tools/balun/guess-plan';

const ft240 = CORES.find((c) => c.id === 'FT240')!;
const ft50 = CORES.find((c) => c.id === 'FT50')!;

/** A test winding on a #43 picture, with a capacitance across it as a real winding has. */
function winding(core = ft240, turns = 3, strayPf = 0, scale = 1): Reading {
  const g = toroidGeometry(core.odMm, core.idMm, core.heightMm);
  const points: MeasuredPoint[] = [];
  const { startMHz, stopMHz, points: n } = WIZARD_SWEEP;
  for (let i = 0; i < n; i++) {
    const fMHz = startMHz + ((stopMHz - startMHz) * i) / (n - 1);
    const zCore = coreImpedance(g, turns, debyePermeability(800, 7, fMHz), fMHz);
    const w = 2 * Math.PI * fMHz * 1e6;
    const yr = zCore.re / (zCore.re ** 2 + zCore.im ** 2);
    const yi = -zCore.im / (zCore.re ** 2 + zCore.im ** 2) + w * strayPf * 1e-12;
    const z = { re: (scale * yr) / (yr * yr + yi * yi), im: (scale * -yi) / (yr * yr + yi * yi) };
    points.push({ fMHz, z, gamma: { re: 0, im: 0 } });
  }
  return { turns, points, source: 'test' };
}

describe('judging a test winding', () => {
  it('accepts three turns on a big core', () => {
    const j = judgeReading(winding());
    expect(j.verdict).toBe('good');
    expect(j.ohmsLow).toBeGreaterThan(LOW_OHMS);
    expect(j.trustMHz).toBeUndefined();
    expect(j.nextTurns).toBe(3);
  });

  it('asks for more turns when the reading is too small to be sure of, by the turns squared', () => {
    // One turn on a small core: a few ohms at the bottom of the sweep.
    const one = winding(ft50, 1);
    const j = judgeReading(one);
    expect(j.ohmsLow).toBeLessThan(LOW_OHMS);
    expect(j.verdict).toBe('more-turns');
    expect(j.nextTurns).toBeGreaterThan(1);
    // And the count it asks for does give enough.
    expect(judgeReading(winding(ft50, j.nextTurns)).verdict).toBe('good');
  });

  it('asks for fewer turns when the winding resonates low in the sweep', () => {
    // Enough capacitance to resonate the winding below the minimum.
    const over = winding(ft240, 6, 300);
    const j = judgeReading(over);
    expect(j.trustMHz).toBeLessThan(MIN_TRUST_MHZ);
    expect(j.verdict).toBe('fewer-turns');
    expect(j.nextTurns).toBeLessThan(6);
    expect(j.nextTurns).toBeGreaterThanOrEqual(1);
  });

  it('never asks for fewer than one turn', () => {
    // A single turn with plenty of impedance (a big high-permeability core: ten times the
    // picture) that still resonates low in the sweep: there is nothing fewer to ask for.
    const j = judgeReading(winding(ft240, 1, 2000, 10));
    expect(j.trustMHz).toBeLessThan(MIN_TRUST_MHZ);
    expect(j.verdict).toBe('good');
    expect(j.why).toMatch(/one turn .* core itself/);
  });

  it('asks for a confirming winding with a different count', () => {
    const first = winding();
    const j = judgeReading(first);
    expect(confirmingTurns(first, j)).toBe(4);
    const marginal = winding(ft240, 4, 60);
    const jm = judgeReading(marginal);
    if (jm.trustMHz !== undefined && jm.trustMHz < 2 * MIN_TRUST_MHZ) expect(confirmingTurns(marginal, jm)).toBe(3);
  });
});

describe("the run's history breaks the loops a single reading cannot see", () => {
  /** ZR1JT's #77 in an FT240 size: mu' through zero at 1.7 MHz whatever the count, and a one-turn winding too small to read. */
  const seventySeven = (turns: number): Reading => {
    const r = winding(ft240, turns, 0, 2.5);
    return { ...r, points: r.points.map((p) => (p.fMHz >= 1.7 ? { ...p, z: { re: p.z.re, im: -Math.abs(p.z.im) } } : p)) };
  };

  it("takes a capacitive point an earlier winding also hit as the core's own, and accepts the reading", () => {
    const one = seventySeven(1);
    const first = judgeReading(one);
    expect(first.verdict).toBe('more-turns'); // too little impedance
    expect(first.nextTurns).toBe(2);
    const two = seventySeven(2);
    expect(judgeReading(two).verdict).toBe('fewer-turns'); // on its own, the 1.7 MHz looks like the winding
    const next = judgeNext(two, [{ reading: one, judgement: first }]);
    expect(next.judgement.verdict).toBe('good'); // ...but the one-turn winding crossed there too
    expect(next.coreCrossingMHz).toBeGreaterThan(1.6);
    expect(next.coreCrossingMHz).toBeLessThan(1.85);
    expect(next.judgement.why).toMatch(/core itself/);
    // And the confirming count is not the one already found wanting.
    expect(confirmingTurns(two, next.judgement, [{ reading: one, judgement: first }, { reading: two, judgement: next.judgement }])).toBe(3);
  });

  it('stops asking when the count it would ask for next has been tried and judged the other way', () => {
    // Three turns resonated (the winding), two were good, one is too small: it would ask
    // for three again. Instead the good two-turn reading is used, alone.
    const three = winding(ft240, 3, 300);
    const two = winding(ft240, 2);
    const one = winding(ft240, 1);
    const history: Tried[] = [
      { reading: three, judgement: judgeReading(three) },
      { reading: two, judgement: judgeReading(two) },
    ];
    expect(history[0]!.judgement.verdict).toBe('fewer-turns');
    expect(history[1]!.judgement.verdict).toBe('good');
    expect(judgeReading(one).verdict).toBe('more-turns');
    expect(judgeReading(one).nextTurns).toBe(3);
    const next = judgeNext(one, history);
    expect(next.use).toBe(two);
    expect(next.judgement.why).toMatch(/2-turn reading is used/);
    expect(confirmingTurns(two, history[1]!.judgement, history)).toBe(1); // 3 was found wanting, so 1 was the only count left to try
  });
});

describe('two windings of one core', () => {
  it('agree once the turns are allowed for', () => {
    const a = agreement(winding(ft240, 3), winding(ft240, 4))!;
    expect(a.ratio).toBeCloseTo(1, 3);
    expect(a.agrees).toBe(true);
    expect(a.toMHz).toBeGreaterThan(a.fromMHz);
  });

  it('show a miscounted turn as the square of the count', () => {
    // Four turns wound, three typed: the curve reads (4/3)^2 too high.
    const wrong: Reading = { ...winding(ft240, 4), turns: 3 };
    const a = agreement(wrong, winding(ft240, 3))!;
    expect(a.ratio).toBeCloseTo((4 / 3) ** 2, 2);
    expect(a.agrees).toBe(false);
    expect(Math.abs(Math.log(a.ratio))).toBeGreaterThan(Math.log(1 + AGREE_WITHIN));
  });

  it("tell a winding resonance from the core's own crossing: the first moves with the turns, the second does not", () => {
    // The same capacitance across 3 and 4 turns resonates at different frequencies: the winding.
    const three = winding(ft240, 3, 100);
    const four = winding(ft240, 4, 100);
    expect(capacitiveAtMHz(three.points)).toBeGreaterThan(capacitiveAtMHz(four.points)!);
    expect(commonCrossing(three, four)).toBeUndefined();
    // A core whose mu' goes through zero at 1.7 MHz does it whatever the count: the core.
    const cut = (r: Reading): Reading => ({ ...r, points: r.points.map((p) => (p.fMHz >= 1.7 ? { ...p, z: { re: p.z.re, im: -Math.abs(p.z.im) } } : p)) });
    const crossing = commonCrossing(cut(winding(ft240, 1)), cut(winding(ft240, 2)))!;
    expect(crossing).toBeGreaterThan(1.6);
    expect(crossing).toBeLessThan(1.85);
    // Two readings of the SAME count say nothing either way.
    expect(commonCrossing(cut(winding(ft240, 2)), cut(winding(ft240, 2)))).toBeUndefined();
  });

  it('are compared only where both are the core, and the one that is the core further up is kept', () => {
    const clean = winding(ft240, 3);
    const resonant = winding(ft240, 3, 100);
    const a = agreement(clean, resonant)!;
    expect(a.toMHz).toBeLessThan(WIZARD_SWEEP.stopMHz);
    expect(a.agrees).toBe(true);
    expect(betterReading(resonant, clean)).toBe(clean);
    expect(betterReading(clean, resonant)).toBe(clean);
  });
});
