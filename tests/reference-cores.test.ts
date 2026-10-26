// The measured cores shipped with EMWS - ZR1JT's #31, #43 and #77 - and what they do for
// the guess: a real core measured again is matched to the real one, not to a picture.

import { describe, expect, it } from 'vitest';
import { identifyCore } from '../src/tools/balun/identify';
import { makeProfile } from '../src/tools/balun/profiles';
import { copyOfReference, isReference, referenceCores } from '../src/tools/balun/reference-cores';
import { MIX31_2631828302_2_TURNS } from './fixtures/zr1jt-mix31-2631828302';
import { MIX43_2643251002_2_TURNS } from './fixtures/zr1jt-mix43-2643251002';
import { MIX77_FT240_2_TURNS } from './fixtures/zr1jt-mix77-ft240';

describe('the measured cores shipped with EMWS', () => {
  const refs = referenceCores();

  it('are four real cores, credited, labelled with their mix, with their sweeps and provenance', () => {
    expect(refs.length).toBeGreaterThanOrEqual(4);
    for (const p of refs) {
      expect(isReference(p.id)).toBe(true);
      expect(p.name).toMatch(/ZR1JT/);
      expect(p.mix).toMatch(/^#\d+$/);
      expect(p.sweep.length).toBeGreaterThan(100);
      expect(p.curve.length).toBe(p.sweep.length); // worked out from the sweep on load
      expect(p.notes).toMatch(/NanoVNA/);
      expect(p.family).toBe(p.mix === '#43' ? 'NiZn' : 'MnZn');
    }
    const seventySeven = refs.find((p) => p.mix === '#77')!;
    expect(seventySeven.coreCrossingMHz).toBeCloseTo(1.541, 3);
    expect(seventySeven.trustworthyUpToMHz).toBeCloseTo(1.541, 3); // the core's own crossing, not a third of it
    expect(refs.find((p) => p.mix === '#43')!.size.shape).toBe('sleeve');
    expect(refs.filter((p) => p.mix === '#31').every((p) => p.size.heightMm === 20)).toBe(true);
    const copy = copyOfReference(seventySeven);
    expect(isReference(copy.id)).toBe(false);
    expect(copy.sweep).toBe(seventySeven.sweep);
  });

  it('recognise each other: the two #31 readings, weeks apart and with different turns, match', () => {
    const [a, b] = refs.filter((p) => p.mix === '#31');
    const guess = identifyCore(a!, refs);
    expect(guess.best?.id).toBe(b!.id);
    expect(guess.best?.kind).toBe('reference');
    expect(guess.fit).toBe('fits');
    expect(guess.suggestedMix?.callIt).toBe('#31');
  });

  it("match a user's core measured again to the real one, not to a picture - the #77 above all", () => {
    const fixture = (sweep: typeof MIX77_FT240_2_TURNS, mix: string, size: { odMm: number; idMm: number; heightMm: number }, coreCrossingMHz?: number) =>
      makeProfile({ name: `mine, really a ${mix}`, size: { id: 'custom', name: 'custom', ...size }, family: 'NiZn', mix: 'unknown', setup: { turns: 2, strayPf: 0, stack: 1 }, sweep, coreCrossingMHz });
    const cases: [ReturnType<typeof fixture>, string][] = [
      [fixture(MIX43_2643251002_2_TURNS, '#43', { odMm: 39.1, idMm: 16.75, heightMm: 22.2 }), '#43'],
      [fixture(MIX31_2631828302_2_TURNS, '#31', { odMm: 61, idMm: 35.55, heightMm: 20 }), '#31'],
      [fixture(MIX77_FT240_2_TURNS, '#77', { odMm: 60.96, idMm: 35.56, heightMm: 12.7 }, 1.541), '#77'],
    ];
    for (const [mine, mix] of cases) {
      const guess = identifyCore(mine, refs);
      expect(guess.best?.kind).toBe('reference');
      expect(guess.fit).toBe('fits');
      expect(guess.suggestedMix?.callIt).toBe(mix);
      expect(guess.family).toBe(mix === '#43' ? 'NiZn' : 'MnZn');
    }
  });
});
