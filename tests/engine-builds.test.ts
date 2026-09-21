// EMWS ships two builds of nec2c from the same sources: a plain one, and one using
// WebAssembly SIMD, which is about a third quicker on a large model but needs a browser
// from 2021 (2023 on Apple). The page picks at runtime.
//
// That is only defensible if the two agree. Not "agree to a few decimals" - the report
// is a text file, and it must come out the same, character for character, whichever
// build wrote it. Anything less and a reading would depend on the reader's browser.

import { describe, expect, it } from 'vitest';
import { engineFor, loadExample, preferredBuild, simulate, type Build } from './helpers/engine';
import { supportsWasmSimd } from '../src/engine/nec2/run';

const EXAMPLES = [
  'dipole-20m-free-space.nec',
  'dipole-20m-over-ground.nec',
  'dipole-20m-swr-sweep.nec',
  'ocf-dipole-windom.nec',
  'vertical-40m-perfect-ground.nec',
  'yagi-3el-2m.nec',
];

describe('the two engine builds', () => {
  it('are both present and loadable', async () => {
    for (const build of ['plain', 'simd'] as Build[]) {
      const engine = await engineFor(build);
      expect(engine.compiled).toBeInstanceOf(WebAssembly.Module);
      expect(engine.simd).toBe(build === 'simd');
    }
  });

  it('detects SIMD support without throwing, and Node has it', () => {
    expect(typeof supportsWasmSimd()).toBe('boolean');
    // Every Node this project supports can do SIMD; if this ever fails, the detector
    // is broken rather than the runtime.
    expect(supportsWasmSimd()).toBe(true);
    expect(preferredBuild).toBe('simd');
  });

  it.each(EXAMPLES)('writes an identical report for %s', async (name) => {
    const deck = await loadExample(name);
    const plain = await simulate(deck, 'plain');
    const simd = await simulate(deck, 'simd');

    expect(plain.raw.exitCode).toBe(0);
    expect(simd.raw.exitCode).toBe(plain.raw.exitCode);
    expect(simd.raw.stderr).toBe(plain.raw.stderr);
    // The whole report, verbatim.
    expect(simd.raw.output).toBe(plain.raw.output);
  });

  it('agrees on a model big enough for the optimiser to reorder arithmetic', async () => {
    // 601 segments puts real work through the factorisation, where -O3 and SIMD have
    // the most freedom to change the order of operations.
    const deck = `CM build comparison\nCE\nGW 1 601 0 -20.0 0 0 20.0 0 0.001\nGE 0\nFR 0 1 0 0 7.1 0\nEX 0 1 301 0 1 0\nXQ\nEN\n`;
    const plain = await simulate(deck, 'plain');
    const simd = await simulate(deck, 'simd');

    expect(plain.report.frequencies[0]?.feeds[0]?.impedance).toBeDefined();
    expect(simd.report.frequencies[0]?.feeds[0]?.impedance).toEqual(
      plain.report.frequencies[0]?.feeds[0]?.impedance,
    );
    expect(simd.raw.output).toBe(plain.raw.output);
  });

  it('reports a bad deck the same way in both', async () => {
    const deck = 'CM broken\nCE\nGW 1 0 0 0 0 0 0 1 0.001\nGE 0\nEN\n';
    const plain = await simulate(deck, 'plain');
    const simd = await simulate(deck, 'simd');
    expect(simd.raw.exitCode).toBe(plain.raw.exitCode);
    expect(simd.raw.output).toBe(plain.raw.output);
  });
});
