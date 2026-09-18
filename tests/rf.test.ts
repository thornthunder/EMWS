import { describe, expect, it } from 'vitest';
import { formatImpedance, mismatchLossDb, reflectionCoefficient, returnLossDb, swr } from '../src/lib/rf';

describe('rf', () => {
  it('sees a matched load as SWR 1', () => {
    expect(swr({ re: 50, im: 0 })).toBe(1);
    expect(returnLossDb({ re: 50, im: 0 })).toBe(Infinity);
    expect(mismatchLossDb({ re: 50, im: 0 })).toBeCloseTo(0, 12);
  });

  it('gives SWR = R/Z0 or Z0/R for resistive loads', () => {
    expect(swr({ re: 100, im: 0 })).toBeCloseTo(2, 12);
    expect(swr({ re: 25, im: 0 })).toBeCloseTo(2, 12);
    expect(swr({ re: 75, im: 0 }, 75)).toBe(1);
  });

  it('handles reactive loads', () => {
    // 50 + j50 on 50 ohms: gamma = j50 / (100 + j50) = 0.2 + j0.4, |gamma| = 0.4472, SWR = 2.618
    const gamma = reflectionCoefficient({ re: 50, im: 50 });
    expect(gamma.re).toBeCloseTo(0.2, 12);
    expect(gamma.im).toBeCloseTo(0.4, 12);
    expect(swr({ re: 50, im: 50 })).toBeCloseTo(2.618, 3);
    expect(returnLossDb({ re: 50, im: 50 })).toBeCloseTo(6.99, 2);
  });

  it('reports infinite SWR for lossless reactive, shorted and open loads', () => {
    expect(swr({ re: 0, im: 35 })).toBe(Infinity);
    expect(swr({ re: 0, im: 0 })).toBe(Infinity);
    expect(swr({ re: -50, im: 0 })).toBe(Infinity);
  });

  it('formats impedances the way hams write them', () => {
    expect(formatImpedance({ re: 72.353, im: 1.9898 })).toBe('72.4 + j2.0');
    expect(formatImpedance({ re: 66.079, im: -45.37 })).toBe('66.1 − j45.4');
  });
});
