// Intermodulation products: the enumeration is checked by counting and by the one example
// every repeater keeper knows, the level formula by its two defining properties.

import { describe, expect, it } from 'vitest';
import { intermodHits, intermodProducts, productLabel, thirdOrderProductDbm, toneForProductAt } from '../src/tools/toolbox/intermod';

describe('the products', () => {
  it('two transmitters to third order give the textbook set', () => {
    const p = intermodProducts([145.6, 145.7], 3);
    const byLabel = Object.fromEntries(p.map((q) => [productLabel(q.coefficients), q.fMHz]));
    expect(byLabel['2A − B']).toBeCloseTo(145.5, 9);
    expect(byLabel['2B − A']).toBeCloseTo(145.8, 9);
    expect(byLabel['A + B']).toBeCloseTo(291.3, 9);
    expect(byLabel['B − A']).toBeCloseTo(0.1, 9);
    expect(byLabel['3A']).toBeCloseTo(436.8, 9);
    expect(byLabel['2A + B']).toBeCloseTo(436.9, 9);
    // Second order: f2 - f1, 2f1, f1 + f2, 2f2. Third: 2f1 - f2, 2f2 - f1, 3f1, 2f1 + f2, f1 + 2f2, 3f2.
    expect(p.filter((q) => q.order === 2)).toHaveLength(4);
    expect(p.filter((q) => q.order === 3)).toHaveLength(6);
  });

  it('counts each product once: a f1 - b f2 and b f2 - a f1 are the same frequency', () => {
    const p = intermodProducts([145.6, 145.7], 5);
    const keys = new Set(p.map((q) => q.coefficients.join(',')));
    expect(keys.size).toBe(p.length);
    expect(p.every((q) => q.fMHz > 0)).toBe(true);
    expect(p.every((q) => q.coefficients.reduce((s, c) => s + Math.abs(c), 0) === q.order)).toBe(true);
  });

  it('names harmonics as such and sorts by order then frequency', () => {
    const p = intermodProducts([145.6, 145.7], 3);
    expect(p.find((q) => productLabel(q.coefficients) === '3A')?.kind).toBe('harmonic');
    expect(p.find((q) => productLabel(q.coefficients) === '2A − B')?.kind).toBe('mix');
    for (let i = 1; i < p.length; i++) {
      const a = p[i - 1]!;
      const b = p[i]!;
      expect(a.order < b.order || (a.order === b.order && a.fMHz <= b.fMHz)).toBe(true);
    }
  });

  it('three transmitters include the A + B − C family', () => {
    const p = intermodProducts([145.6, 145.7, 145.775], 3);
    const q = p.find((x) => productLabel(x.coefficients) === 'A + B − C');
    expect(q?.fMHz).toBeCloseTo(145.6 + 145.7 - 145.775, 9);
    expect(q?.order).toBe(3);
  });

  it('gives nothing for no inputs or an order under two', () => {
    expect(intermodProducts([], 5)).toEqual([]);
    expect(intermodProducts([145.6], 1)).toEqual([]);
  });
});

describe('hits on a protected frequency', () => {
  it('two repeaters at 145.600 and 145.700 put 2A − B on the 145.500 calling channel exactly', () => {
    const hits = intermodHits(intermodProducts([145.6, 145.7], 5), [145.5, 145.0], 12.5);
    expect(hits).toHaveLength(1);
    expect(productLabel(hits[0]!.product.coefficients)).toBe('2A − B');
    expect(hits[0]!.receiver).toBe(0);
    expect(hits[0]!.offsetKHz).toBeCloseTo(0, 6);
  });

  it('respects the tolerance and reports the signed offset, nearest first', () => {
    const p = intermodProducts([145.6, 145.7], 5);
    expect(intermodHits(p, [145.51], 5)).toHaveLength(0);
    const near = intermodHits(p, [145.51, 145.8], 12.5);
    expect(near).toHaveLength(2);
    expect(near[0]!.offsetKHz).toBeCloseTo(0, 6); // 2B - A on 145.800
    expect(near[1]!.offsetKHz).toBeCloseTo(-10, 6); // 2A - B at 145.500, 10 kHz below 145.510
  });
});

describe('third-order level', () => {
  it('equals the tones at the intercept point and climbs 3 dB per dB', () => {
    expect(thirdOrderProductDbm(10, 10)).toBe(10);
    expect(thirdOrderProductDbm(-30, 10) - thirdOrderProductDbm(-31, 10)).toBeCloseTo(3, 12);
    expect(thirdOrderProductDbm(-30, 10)).toBe(-110);
  });

  it('the tone level that puts the product on a floor inverts it', () => {
    const tone = toneForProductAt(-130, 10);
    expect(thirdOrderProductDbm(tone, 10)).toBeCloseTo(-130, 12);
  });
});
