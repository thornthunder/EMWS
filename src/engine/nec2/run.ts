// Runs one NEC2 card deck through the WebAssembly build of nec2c.
//
// Environment-neutral: used by the Web Worker in the browser and directly by the
// Node test suite. nec2c is a run-once command-line program that keeps its state
// in globals and leaves via exit(), so every run gets a fresh module instance.
// Compilation is the expensive part and is shared; instantiation is cheap.

import type { Nec2RawResult } from './types';

const DECK_PATH = '/deck.nec';
const REPORT_PATH = '/deck.out';

/** Nec2RawResult.exitCode when the engine trapped instead of exiting. */
export const TRAPPED = -1;

/** Emscripten's module factory. Both builds export the same one; see wasm/nec2c.d.mts. */
type Nec2Factory = typeof import('./wasm/nec2c.mjs').default;

/**
 * A loaded engine: the compiled WebAssembly and the Emscripten glue that goes with it.
 * The two are built together and must stay together - the SIMD glue will not drive the
 * plain module, or the other way about.
 */
export interface Nec2Engine {
  readonly create: Nec2Factory;
  readonly compiled: WebAssembly.Module;
  /** Whether this is the SIMD build; reported to the user as the engine's 'build'. */
  readonly simd: boolean;
}

/**
 * Can this runtime execute WebAssembly SIMD?
 *
 * These bytes are a complete, tiny module whose one function is
 * `i32.const 0; i8x16.splat; drop`. A runtime without SIMD refuses to validate it,
 * because it does not know the i8x16.splat opcode. Asking this way costs nothing,
 * downloads nothing, and cannot throw - where instantiating a real SIMD module would.
 */
export function supportsWasmSimd(): boolean {
  try {
    return WebAssembly.validate(
      new Uint8Array([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic, version
        0x01, 0x04, 0x01, 0x60, 0x00, 0x00, // type:     () -> ()
        0x03, 0x02, 0x01, 0x00, // function: one, of that type
        0x0a, 0x09, 0x01, 0x07, 0x00, // code:     one body, 7 bytes, no locals
        0x41, 0x00, // i32.const 0
        0xfd, 0x0f, // i8x16.splat   <- the instruction being asked about
        0x1a, // drop
        0x0b, // end
      ]),
    );
  } catch {
    return false;
  }
}

/** The Emscripten glue for one of the two builds. Dynamic, so only one is ever fetched. */
export async function loadNec2cGlue(simd: boolean): Promise<Nec2Factory> {
  const module = simd ? await import('./wasm/nec2c-simd.mjs') : await import('./wasm/nec2c.mjs');
  return module.default as Nec2Factory;
}

export function compileNec2c(wasmBytes: ArrayBuffer | Uint8Array): Promise<WebAssembly.Module> {
  return WebAssembly.compile(wasmBytes as BufferSource);
}

/** Pairs compiled WebAssembly with the glue built alongside it. */
export async function makeEngine(compiled: WebAssembly.Module, simd: boolean): Promise<Nec2Engine> {
  return { create: await loadNec2cGlue(simd), compiled, simd };
}

function exitStatus(e: unknown): number | undefined {
  if (typeof e === 'object' && e !== null && 'status' in e) {
    const status = (e as { status: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

export async function runNec2c(deck: string, engine: Nec2Engine): Promise<Nec2RawResult> {
  const stderr: string[] = [];
  const started = performance.now();
  const { create, compiled } = engine;

  const module = await create({
    instantiateWasm(imports, onSuccess) {
      void WebAssembly.instantiate(compiled, imports).then((instance) => onSuccess(instance, compiled));
      return {};
    },
    print: () => {},
    printErr: (line: string) => stderr.push(line),
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
