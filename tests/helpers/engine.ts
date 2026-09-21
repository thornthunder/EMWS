import { readFile } from 'node:fs/promises';
import { parseNec2Output } from '../../src/engine/nec2/parse-output';
import { compileNec2c, makeEngine, runNec2c, supportsWasmSimd, type Nec2Engine } from '../../src/engine/nec2/run';
import type { Nec2Run } from '../../src/engine/nec2/types';

const wasmDir = new URL('../../src/engine/nec2/wasm/', import.meta.url);
const examplesDir = new URL('../../examples/', import.meta.url);

/** EMWS ships two builds of the engine; both have to be right. */
export type Build = 'plain' | 'simd';

const engines = new Map<Build, Promise<Nec2Engine>>();

export function engineFor(build: Build): Promise<Nec2Engine> {
  let engine = engines.get(build);
  if (!engine) {
    const file = new URL(build === 'simd' ? 'nec2c-simd.wasm' : 'nec2c.wasm', wasmDir);
    engine = readFile(file)
      .then(compileNec2c)
      .then((compiled) => makeEngine(compiled, build === 'simd'));
    engines.set(build, engine);
  }
  return engine;
}

/** Whichever build this machine would actually use - what a user gets. */
export const preferredBuild: Build = supportsWasmSimd() ? 'simd' : 'plain';

export async function simulate(deck: string, build: Build = preferredBuild): Promise<Nec2Run> {
  const raw = await runNec2c(deck, await engineFor(build));
  return { raw, report: parseNec2Output(raw.output) };
}

export function loadExample(name: string): Promise<string> {
  return readFile(new URL(name, examplesDir), 'utf8');
}
