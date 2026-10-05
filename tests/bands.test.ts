// One band list for the whole suite: well-formed, and the tools' views of it are views.

import { describe, expect, it } from 'vitest';
import { BANDS, bandByName, bandPairs, bandsUpTo } from '../src/lib/bands';
import { BANDS as LC_BANDS } from '../src/tools/lc/model';

describe('the amateur bands', () => {
  it('are in frequency order, each standing frequency inside its own edges, names unique', () => {
    for (let n = 0; n < BANDS.length; n++) {
      const band = BANDS[n]!;
      expect(band.from, band.name).toBeLessThan(band.to);
      expect(band.at, band.name).toBeGreaterThanOrEqual(band.from);
      expect(band.at, band.name).toBeLessThanOrEqual(band.to);
      if (n > 0) expect(band.from, band.name).toBeGreaterThan(BANDS[n - 1]!.to);
    }
    expect(new Set(BANDS.map((b) => b.name)).size).toBe(BANDS.length);
  });

  it('run from 160 m to 3 cm, with the bands the club talks about in between', () => {
    expect(BANDS[0]?.name).toBe('160 m');
    expect(BANDS[BANDS.length - 1]?.name).toBe('3 cm');
    for (const name of ['40 m', '20 m', '6 m', '4 m', '2 m', '70 cm', '23 cm', '13 cm']) expect(bandByName(name), name).toBeDefined();
    expect(bandByName('2 m')?.at).toBe(145);
    expect(bandByName('13 cm')?.at).toBe(2400);
    expect(bandByName('40 m')?.at).toBe(7.1);
  });

  it('gives each tool the slice it asked for', () => {
    expect(bandsUpTo(450).map((b) => b.name)).toContain('70 cm');
    expect(bandsUpTo(450).map((b) => b.name)).not.toContain('23 cm');
    expect(bandsUpTo(1300).map((b) => b.name)).toContain('23 cm');
    expect(bandsUpTo(1300).map((b) => b.name)).not.toContain('13 cm');
    expect(bandPairs(bandsUpTo(10))).toEqual([
      ['160 m', 1.85],
      ['80 m', 3.65],
      ['60 m', 5.36],
      ['40 m', 7.1],
    ]);
    // The coil and filter tool's list is the same list, cut at 70 cm.
    expect(LC_BANDS).toEqual(bandPairs(bandsUpTo(450)));
  });
});
