// Guessing what a measured core is. Held to the six built-in pictures fed back through the
// measuring path, to one real core of known identity (ZR1JT's #31), and to the properties
// the method was chosen for: a wrong turn count cannot move the ranking.

import { describe, expect, it } from 'vitest';
import { coreImpedance, debyePermeability, snoekRelaxationMHz, toroidGeometry } from '../src/lib/ferrite';
import { CORES, MATERIALS } from '../src/tools/balun/catalog';
import { FITS_BELOW, identifyCore, nearestSize } from '../src/tools/balun/identify';
import { exportProfiles, importProfiles, makeProfile, rederive } from '../src/tools/balun/profiles';
import { MIX31_2631828302_2_TURNS } from './fixtures/zr1jt-mix31-2631828302';
import { MIX31_3_TURNS } from './fixtures/zr1jt-mix31-3turns';
import { MIX43_2643251002_2_TURNS } from './fixtures/zr1jt-mix43-2643251002';
import { MIX77_FT240_2_TURNS } from './fixtures/zr1jt-mix77-ft240';

const ft240 = CORES.find((c) => c.id === 'FT240')!;
const g = toroidGeometry(ft240.odMm, ft240.idMm, ft240.heightMm);

/** A mix's own picture, swept through the measuring path on an FT240 with 8 turns, with 3 % noise on both parts. */
function pictured(id: string, lo = 1, hi = 30, noise = 0.03) {
  const m = MATERIALS.find((x) => x.id === id)!;
  const fr = snoekRelaxationMHz(m.muInitial, m.family);
  const sweep = Array.from({ length: 60 }, (_, i) => {
    const fMHz = lo * (hi / lo) ** (i / 59);
    const z = coreImpedance(g, 8, debyePermeability(m.muInitial, fr, fMHz), fMHz);
    const nz = 1 + noise * Math.sin(i * 12.9898);
    return { fMHz, r: z.re * nz, x: z.im * (2 - nz) };
  });
  return makeProfile({ name: `picture of ${m.name}`, size: ft240, family: m.family, mix: 'unknown', setup: { turns: 8, strayPf: 0, stack: 1 }, sweep });
}

describe('guessing what a core is', () => {
  it('finds each built-in picture from a noisy sweep of itself', () => {
    for (const m of MATERIALS) {
      const guess = identifyCore(pictured(m.id));
      expect(guess.best?.id).toBe(m.id);
      expect(guess.fit).toBe('fits');
      expect(guess.family).toBe(m.family);
      expect(guess.best!.angleRms).toBeLessThan(0.05);
      expect(guess.best!.levelRatio).toBeCloseTo(1, 1);
    }
  });

  it('ranks on the loss angle, which a wrong turn count cannot move; the level moves by the turns squared', () => {
    const right = identifyCore(pictured('43'));
    const wrong = identifyCore(rederive(pictured('43'), { turns: 9 }));
    expect(wrong.best?.id).toBe('43');
    expect(wrong.best!.angleRms).toBeCloseTo(right.best!.angleRms, 9);
    expect(wrong.best!.levelRatio / right.best!.levelRatio).toBeCloseTo((8 / 9) ** 2, 3);
  });

  it('says when the loss never overtakes the reactance in the sweep, and still knows a #61', () => {
    const guess = identifyCore(pictured('61'));
    expect(guess.crossoverMHz).toBeUndefined();
    expect(guess.best?.id).toBe('61');
    expect(identifyCore(pictured('43')).crossoverMHz).toBeGreaterThan(6);
    expect(identifyCore(pictured('43')).crossoverMHz).toBeLessThan(8);
  });

  it('matches a size to the catalogue within 10 %, and says when none is near', () => {
    const match = nearestSize({ odMm: 61, idMm: 35.6, heightMm: 12.7 });
    expect(match?.core.id).toBe('FT240');
    expect(match!.deviation).toBeLessThan(0.01);
    expect(nearestSize({ odMm: 20, idMm: 10, heightMm: 8 })).toBeUndefined();
  });

  it("recognises ZR1JT's measured #31 by its shape, and with its true height the level sits near the picture", () => {
    const profile = makeProfile({
      name: '#31 2631828302',
      // 61 x 35.55 x 20 mm (ZR1JT, 2026-10-25): the first measurements had been typed 12.7 mm high,
      // which put the level 1.6x above the picture - the shape never noticed.
      size: { id: 'custom', name: 'custom', odMm: 61, idMm: 35.55, heightMm: 20 },
      family: 'MnZn',
      mix: 'unknown',
      setup: { turns: 3, strayPf: 0, stack: 1 },
      sweep: MIX31_3_TURNS,
    });
    const guess = identifyCore(profile);
    expect(guess.best?.id).toBe('31');
    expect(guess.fit).toBe('fits');
    expect(guess.best!.angleRms).toBeLessThan(FITS_BELOW);
    expect(guess.family).toBe('MnZn');
    // With the right height the level is within a third of the picture, and mu' at 1 MHz is
    // under the maker's initial permeability of 1500 - the core is past its knee there.
    expect(guess.best!.levelRatio).toBeGreaterThan(0.8);
    expect(guess.best!.levelRatio).toBeLessThan(1.4);
    expect(guess.muLow).toBeGreaterThan(1200);
    expect(guess.muLow).toBeLessThan(1500);
    expect(guess.crossoverMHz).toBeGreaterThan(2);
    expect(guess.crossoverMHz).toBeLessThan(3.5);
    expect(guess.toMHz).toBeLessThan(4); // the 3-turn winding resonated near 9 MHz
    expect(guess.size).toBeUndefined(); // 20 mm high: no catalogue size
    // And the nickel-zinc pictures are clearly worse than the manganese-zinc ones.
    const rank = guess.candidates.map((c) => c.id);
    expect(rank.indexOf('43')).toBeGreaterThan(rank.indexOf('31'));
    expect(rank.indexOf('52')).toBeGreaterThan(rank.indexOf('77'));
  });

  it("recognises ZR1JT's #31 and #43 measured through the step-by-step guess, 0.2-30 MHz with two turns", () => {
    const thirtyOne = makeProfile({ name: '2631828302', size: { id: 'custom', name: 'custom', odMm: 61, idMm: 35.55, heightMm: 20 }, family: 'MnZn', mix: 'unknown', setup: { turns: 2, strayPf: 0, stack: 1 }, sweep: MIX31_2631828302_2_TURNS });
    const g31 = identifyCore(thirtyOne);
    expect(g31.best?.id).toBe('31');
    expect(g31.fit).toBe('fits');
    expect(g31.family).toBe('MnZn');
    expect(g31.muLow).toBeGreaterThan(1400); // the maker's initial permeability is 1500: at 0.2 MHz the core is on its plateau
    expect(g31.muLow).toBeLessThan(1800);
    expect(g31.cutAtHalf).toBe(true);
    const fortyThree = makeProfile({ name: '2643251002', size: { id: 'custom', name: 'custom', odMm: 39.1, idMm: 16.75, heightMm: 22.2 }, family: 'NiZn', mix: 'unknown', setup: { turns: 2, strayPf: 0, stack: 1 }, sweep: MIX43_2643251002_2_TURNS });
    const g43 = identifyCore(fortyThree);
    expect(g43.best?.id).toBe('43');
    expect(g43.fit).toBe('fits');
    expect(g43.family).toBe('NiZn');
    expect(g43.muLow).toBeGreaterThan(750); // the maker's 800, within a fifth
    expect(g43.muLow).toBeLessThan(1000);
    expect(g43.size).toBeUndefined(); // a cable sleeve, not a catalogue toroid
  });

  it("gives ZR1JT's #77 no false nickel-zinc verdict: flat below the knee, and no close fit above it, but its crossing named", () => {
    const base = { name: 'FT77-240', size: { id: 'custom', name: 'FT240', odMm: 60.96, idMm: 35.56, heightMm: 12.7 }, family: 'MnZn' as const, mix: 'unknown', setup: { turns: 2, strayPf: 0, stack: 1 }, sweep: MIX77_FT240_2_TURNS };
    // Taken as a winding resonance, only 0.2-0.51 MHz is usable: below every knee, where
    // all three nickel-zinc pictures are flat and once "fitted" at 0.05.
    const plain = identifyCore(makeProfile(base));
    expect(plain.best).toBeUndefined();
    expect(plain.undecidable).toMatch(/Flat so far/);
    expect(plain.undecidable).toMatch(/second winding/);
    // Both windings crossed at 1.54 MHz: the core's own. The curve is the core's up to it,
    // nothing fits it closely, and the crossing is named as the manganese-zinc trait it is.
    const withCrossing = makeProfile({ ...base, coreCrossingMHz: 1.541 });
    expect(withCrossing.trustworthyUpToMHz).toBeCloseTo(1.541, 9);
    const known = identifyCore(withCrossing);
    expect(known.coreCrossingMHz).toBeCloseTo(1.541, 9);
    expect(known.fit).toBe('none');
    expect(known.family).toBeUndefined();
    expect(known.undecidable).toBeUndefined();
    expect(known.caveats.some((c) => /core itself/.test(c))).toBe(true);
    // And the crossing survives a save and an import, where the curve and the limit are worked out afresh.
    const back = importProfiles(exportProfiles([withCrossing]))[0]!;
    expect(back.coreCrossingMHz).toBeCloseTo(1.541, 9);
    expect(back.trustworthyUpToMHz).toBeCloseTo(1.541, 9);
  });

  it('says "flat so far" when the usable sweep lies below the knee of every picture', () => {
    // A #61 relaxes at 45 MHz: swept 0.2-10 MHz it has neither fallen by a fifth nor reached 15 degrees of loss.
    const guess = identifyCore(pictured('61', 0.2, 10));
    expect(guess.best).toBeUndefined();
    expect(guess.undecidable).toMatch(/Flat so far/);
    expect(guess.undecidable).toMatch(/Sweep higher/);
  });

  it('prefers one of your own cores when it is the same core measured again', () => {
    const a = pictured('43');
    const twin = { ...a, id: 'twin', name: 'the same core, last week' };
    const guess = identifyCore(a, [twin, a]);
    expect(guess.best?.kind).toBe('core');
    expect(guess.best?.id).toBe('twin');
    expect(guess.suggestedMix?.id).toBe('43'); // and still says which mix to call it
    expect(guess.candidates.some((c) => c.id === a.id)).toBe(false); // never compared with itself
  });

  it('refuses a sliver: less than an octave of usable sweep gives no verdict, and says what would help', () => {
    // ZR1JT's #77 in an FT240 size, 2026-10-25: a one-turn reading went capacitive at 1.7 MHz,
    // the trust rule cut the comparison to 0.50-0.58 MHz, and the loss angle over that sliver
    // read nickel-zinc. Nothing is said over less than an octave.
    const p = pictured('43');
    const sliver = { ...p, trustworthyUpToMHz: p.curve[0]!.fMHz * 1.16 };
    const guess = identifyCore(sliver);
    expect(guess.fit).toBe('none');
    expect(guess.best).toBeUndefined();
    expect(guess.undecidable).toMatch(/less than an octave/);
    expect(guess.undecidable).toMatch(/second winding/);
    // The hint that both windings went capacitive there lifts the limit to the crossing itself.
    const hinted = identifyCore(sliver, [], undefined, undefined, { coreCrossingMHz: 20 });
    expect(hinted.coreCrossingMHz).toBe(20);
    // ... and the comparison then runs up to where mu' has halved (about 7.5 MHz for the
    // #43 picture from 1 MHz): the pictures describe the knee, not the tail.
    expect(hinted.cutAtHalf).toBe(true);
    expect(hinted.toMHz).toBeGreaterThan(6);
    expect(hinted.toMHz).toBeLessThan(9);
    expect(hinted.best?.id).toBe('43');
    expect(hinted.caveats.some((c) => /core itself/.test(c))).toBe(true);
  });

  it('names the family the nearest pictures share when none of them fits closely', () => {
    // A core with a quarter of the picture's loss at the knee: no picture fits, and the
    // useful part of the answer is which family the nearest ones are.
    const p = pictured('77');
    const quieter = makeProfile({ ...p, sweep: p.sweep.map((s) => ({ ...s, r: s.r * 0.25 })) });
    const guess = identifyCore(quieter);
    const nearest = guess.candidates.filter((c) => c.kind === 'mix').slice(0, 3);
    if (guess.fit === 'none' && nearest.every((c) => c.family === nearest[0]!.family)) expect(guess.nearestFamily).toBe(nearest[0]!.family);
    else expect(guess.nearestFamily).toBeUndefined();
    // And never when something does fit.
    expect(identifyCore(pictured('43')).nearestFamily).toBeUndefined();
  });

  it('says so when there is nothing to compare', () => {
    const empty = makeProfile({ name: 'empty', size: ft240, family: 'NiZn', mix: '?', setup: { turns: 8, strayPf: 0, stack: 1 }, sweep: [] });
    const guess = identifyCore(empty);
    expect(guess.best).toBeUndefined();
    expect(guess.fit).toBe('none');
    expect(guess.caveats[0]).toMatch(/Nothing was measured/);
  });
});
