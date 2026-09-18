import { readFile } from 'node:fs/promises';
import { parseNec2Output } from '../../src/engine/nec2/parse-output';
import { compileNec2c, runNec2c } from '../../src/engine/nec2/run';
import type { Nec2Run } from '../../src/engine/nec2/types';

const wasmFile = new URL('../../src/engine/nec2/wasm/nec2c.wasm', import.meta.url);
const examplesDir = new URL('../../examples/', import.meta.url);

let compiled: Promise<WebAssembly.Module> | undefined;

export async function simulate(deck: string): Promise<Nec2Run> {
  compiled ??= readFile(wasmFile).then(compileNec2c);
  const raw = await runNec2c(deck, await compiled);
  return { raw, report: parseNec2Output(raw.output) };
}

export function loadExample(name: string): Promise<string> {
  return readFile(new URL(name, examplesDir), 'utf8');
}
