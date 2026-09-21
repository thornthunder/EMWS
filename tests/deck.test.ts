import { describe, expect, it } from 'vitest';
import { floatField, formatCard, formatNumber, intField, lexDeck } from '../src/engine/nec2/cards';
import { deckToModel, modelToDeck, planRuns } from '../src/tools/antenna-modeler/deck';
import type { AntennaModel } from '../src/tools/antenna-modeler/model';
import { loadExample, simulate } from './helpers/engine';

const EXAMPLES = [
  'dipole-20m-free-space.nec',
  'dipole-20m-over-ground.nec',
  'dipole-20m-swr-sweep.nec',
  'ocf-dipole-windom.nec',
  'vertical-40m-perfect-ground.nec',
  'yagi-3el-2m.nec',
];

function imported(text: string): AntennaModel {
  const result = deckToModel(text);
  if (!result.ok) throw new Error(result.reason);
  return result.model;
}

describe('card lexer', () => {
  it('reads cards the way nec2c does', () => {
    const { cards, notices } = lexDeck(
      ['cm lower-case mnemonic', 'CE', '# a comment line', '', '  GW 9 9 9 9 9 9 9 9 9', 'gw 1,21\t0 -5 0 0 5 0 .001', 'GE 0', 'EN'].join('\n'),
    );
    expect(cards.map((c) => c.mnemonic)).toEqual(['CM', 'CE', 'GW', 'GE', 'EN']);
    expect(cards.map((c) => c.section)).toEqual(['comment', 'comment', 'geometry', 'geometry', 'program']);
    // nec2c skips a line that starts with a space; we say so rather than silently agreeing.
    expect(notices).toHaveLength(1);
    expect(notices[0]?.line).toBe(5);

    const gw = cards[2]!;
    expect(intField(gw, 0)).toBe(1);
    expect(intField(gw, 1)).toBe(21);
    expect(floatField(gw, 1)).toBe(-5); // y1
    expect(floatField(gw, 4)).toBe(5); // y2
    expect(floatField(gw, 6)).toBe(0.001);
    expect(floatField(gw, 7)).toBe(0); // missing fields read as zero
  });

  it('rejects what nec2c rejects in integer and float fields', () => {
    const { cards } = lexDeck('GW 1 21.0 0 0 0 0 0 1 0.001\nGE 0\nFR 0 1 0 0 14.2x 0\nEN');
    expect(intField(cards[0]!, 1)).toBeUndefined();
    expect(floatField(cards[2]!, 0)).toBeUndefined();
  });

  it('writes numbers that read back exactly and integers without decimals', () => {
    expect(formatNumber(0.1 + 0.2)).toBe('0.3');
    expect(formatNumber(-0)).toBe('0');
    expect(formatNumber(1e-7)).toBe('1e-7');
    expect(formatCard('GW', [1, 21], [0, -5.13, 0, 0, 5.13, 0, 0.001])).toBe('GW 1 21 0 -5.13 0 0 5.13 0 0.001');
    expect(() => formatCard('GW', [1.5], [])).toThrow();
  });
});

describe('deck <-> model', () => {
  it('imports every example', async () => {
    for (const name of EXAMPLES) {
      const result = deckToModel(await loadExample(name));
      expect(result.ok, `${name}: ${result.ok ? '' : result.reason}`).toBe(true);
    }
  });

  it('reads the Yagi into wires, a feed and pattern cards', async () => {
    const model = imported(await loadExample('yagi-3el-2m.nec'));
    expect(model.comments[0]).toBe('3-element Yagi for 2 m (146 MHz) in free space.');
    expect(model.wires.map((w) => w.tag)).toEqual([1, 2, 3]);
    expect(model.wires[1]).toMatchObject({ segments: 11, radius: 0.003, a: { x: 0, y: -0.4855, z: 0 } });
    expect(model.feeds).toHaveLength(1);
    expect(model.feeds[0]).toMatchObject({ wireId: model.wires[1]!.id, segment: 6, voltage: { re: 1, im: 0 } });
    expect(model.frequency).toEqual({ startMHz: 146, stepMHz: 0, steps: 1 });
    expect(model.ground).toEqual({ kind: 'free-space' });
    expect(model.pattern).toEqual({ kind: 'cards', cards: ['RP 0 1 73 1000 90 0 0 5', 'RP 0 73 1 1000 0 0 5 0'] });
  });

  it('reads ground, sweeps and scale cards', async () => {
    expect(imported(await loadExample('dipole-20m-over-ground.nec')).ground).toEqual({
      kind: 'real',
      permittivity: 13,
      conductivity: 0.005,
      method: 'sommerfeld',
    });
    expect(imported(await loadExample('vertical-40m-perfect-ground.nec')).ground).toEqual({ kind: 'perfect' });
    expect(imported(await loadExample('dipole-20m-swr-sweep.nec')).frequency).toEqual({
      startMHz: 13.8,
      stepMHz: 0.05,
      steps: 17,
    });

    // Dimensions in inches, scaled to metres by GS.
    const scaled = imported('CE\nGW 1 11 0 -100 0 0 100 0 0.5\nGS 0 0 0.0254\nGE 0\nFR 0 1 0 0 28 0\nEX 0 1 6 0 1 0\nXQ\nEN');
    expect(scaled.wires[0]!.b.y).toBeCloseTo(2.54, 12);
    expect(scaled.wires[0]!.radius).toBeCloseTo(0.0127, 12);
  });

  it('keeps cards it does not model, and refuses what it cannot represent', () => {
    const loaded = imported('CE\nGW 1 11 0 -1 0 0 1 0 0.001\nGE 0\nLD 5 0 0 0 5.8E7\nFR 0 1 0 0 70 0\nEX 0 1 6 0 1 0\nXQ\nEN');
    expect(loaded.extraCards).toEqual(['LD 5 0 0 0 5.8E7']);
    expect(modelToDeck(loaded)).toContain('LD 5 0 0 0 5.8E7');

    const cases: [string, RegExp][] = [
      ['CE\nGA 1 12 1 0 90 0.001\nGE 0\nEN', /arcs/],
      ['CE\nGW 1 11 0 -1 0 0 1 0 0\nGC 0 0 1 0.001 0.002\nGE 0\nEN', /tapered/],
      ['CE\nGW 1 11 0 -1 0 0 1 0 0.001\nGE 0\nFR 0 1 0 0 70 0\nXQ\nFR 0 1 0 0 71 0\nXQ\nEN', /more than one run/],
      ['CE\nGW 1 11 0 -1 0 0 1 0 0.001\nGE 1\nFR 0 1 0 0 70 0\nXQ\nEN', /no GN card/],
      ['CE\nGW 1 11 0 -1 0 0 1 0 0.001\nGE 0\nEX 1 1 6 0 1 0\nEN', /voltage sources/],
    ];
    for (const [deck, reason] of cases) {
      const result = deckToModel(deck);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(reason);
    }
  });

  it('finds a source given by absolute segment number, and renumbers untagged wires', () => {
    const model = imported('CE\nGW 0 5 0 0 0 0 0 1 0.001\nGW 0 7 0 0 1 0 0 2 0.001\nGE 0\nFR 0 1 0 0 70 0\nEX 0 0 9 0 1 0\nXQ\nEN');
    expect(model.wires.map((w) => w.tag)).toEqual([1, 2]);
    expect(model.feeds[0]).toMatchObject({ wireId: model.wires[1]!.id, segment: 4 });
  });

  it('writes a deck nec2c solves identically to the original, for every example', async () => {
    for (const name of EXAMPLES) {
      const original = await simulate(await loadExample(name));
      const regenerated = await simulate(modelToDeck(imported(await loadExample(name))));
      expect(regenerated.raw.exitCode, name).toBe(0);
      expect(regenerated.report.segments, name).toEqual(original.report.segments);
      expect(regenerated.report.frequencies, name).toEqual(original.report.frequencies);
    }
  });

  it('round-trips a model through its own deck', async () => {
    const model = imported(await loadExample('dipole-20m-over-ground.nec'));
    const again = imported(modelToDeck(model));
    const strip = (m: AntennaModel) => ({
      ...m,
      wires: m.wires.map(({ id: _id, ...w }) => w),
      feeds: m.feeds.map(({ id: _id, wireId: _w, ...f }) => f),
    });
    expect(strip(again)).toEqual(strip(model));
  });

  it('solves a sweep with an automatic pattern as a quick sweep plus one pattern run', async () => {
    const model = { ...imported(await loadExample('dipole-20m-swr-sweep.nec')), pattern: { kind: 'auto' as const } };
    const plan = planRuns(model);
    expect(plan.main).toMatch(/^XQ$/m);
    expect(plan.main).not.toMatch(/^RP/m);

    const sweep = await simulate(plan.main);
    expect(sweep.report.frequencies).toHaveLength(17);
    expect(sweep.report.frequencies.every((f) => f.patterns.length === 0)).toBe(true);

    const pattern = await simulate(plan.patternDeck!(14.2));
    expect(pattern.report.frequencies).toHaveLength(1);
    expect(pattern.report.frequencies[0]!.patterns[0]!.points).toHaveLength(37 * 72);
    // Same antenna, same frequency: the impedance agrees with the sweep's.
    const at142 = sweep.report.frequencies.find((f) => f.frequencyMHz === 14.2)!;
    expect(pattern.report.frequencies[0]!.feeds).toEqual(at142.feeds);
  });
});
