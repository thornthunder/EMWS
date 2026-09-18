// Runs one NEC2 card deck through the WebAssembly build of nec2c.
//
// Environment-neutral: used by the Web Worker in the browser and directly by the
// Node test suite. nec2c is a run-once command-line program that keeps its state
// in globals and leaves via exit(), so every run gets a fresh module instance.
// Compilation is the expensive part and is shared; instantiation is cheap.

import createNec2c from './wasm/nec2c.mjs';
import type { Nec2RawResult } from './types';

const DECK_PATH = '/deck.nec';
const REPORT_PATH = '/deck.out';

/** Nec2RawResult.exitCode when the engine trapped instead of exiting. */
export const TRAPPED = -1;

export function compileNec2c(wasmBytes: ArrayBuffer | Uint8Array): Promise<WebAssembly.Module> {
  return WebAssembly.compile(wasmBytes as BufferSource);
}

function exitStatus(e: unknown): number | undefined {
  if (typeof e === 'object' && e !== null && 'status' in e) {
    const status = (e as { status: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

export async function runNec2c(deck: string, compiled: WebAssembly.Module): Promise<Nec2RawResult> {
  const stderr: string[] = [];
  const started = performance.now();

  const module = await createNec2c({
    instantiateWasm(imports, onSuccess) {
      void WebAssembly.instantiate(compiled, imports).then((instance) => onSuccess(instance, compiled));
      return {};
    },
    print: () => {},
    printErr: (line) => stderr.push(line),
  });

  module.FS.writeFile(DECK_PATH, deck);

  let exitCode: number;
  let trap: string | undefined;
  try {
    exitCode = module.callMain(['-i', DECK_PATH, '-o', REPORT_PATH]);
  } catch (e) {
    const status = exitStatus(e);
    if (status !== undefined) {
      exitCode = status;
    } else if (e instanceof WebAssembly.RuntimeError) {
      // Natively, nec2c's signal handler catches SIGFPE/SIGSEGV from a malformed deck
      // (a zero-segment wire divides by zero, say). In WebAssembly those are traps.
      exitCode = TRAPPED;
      trap = e.message;
    } else {
      throw e;
    }
  }

  let output = '';
  try {
    output = module.FS.readFile(REPORT_PATH, { encoding: 'utf8' });
  } catch {
    // nec2c bailed out before creating the report; stderr says why.
  }

  return { exitCode, trap, output, stderr: stderr.join('\n'), elapsedMs: performance.now() - started };
}
