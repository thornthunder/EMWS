// Web Worker: keeps NEC2 runs off the UI thread.

// Both engine URLs are just strings until one is fetched, so naming them costs nothing.
import plainWasmUrl from './wasm/nec2c.wasm?url';
import simdWasmUrl from './wasm/nec2c-simd.wasm?url';
import { parseNec2Output } from './parse-output';
import { compileNec2c, makeEngine, supportsWasmSimd, type Nec2Engine } from './run';
import { runNec2c } from './run';
import type { Nec2Run } from './types';

export interface Nec2Request {
  id: number;
  deck: string;
}

export type Nec2Response =
  | { id: number; ok: true; run: Nec2Run }
  | { id: number; ok: false; error: string };

let engine: Promise<Nec2Engine> | undefined;

/**
 * The SIMD build is about a third quicker on a large model, and every browser since
 * 2021 (2023 on Apple) can run it. Older ones get the plain build and correct answers,
 * just more slowly - the two were built from the same sources and give identical
 * reports, which tests/engine-builds.test.ts checks deck by deck.
 */
async function load(): Promise<Nec2Engine> {
  const simd = supportsWasmSimd();
  const url = simd ? simdWasmUrl : plainWasmUrl;
  let compiled: WebAssembly.Module;
  try {
    compiled = await WebAssembly.compileStreaming(fetch(url));
  } catch {
    // compileStreaming insists on the application/wasm MIME type. EMWS's web.config
    // sets it, but a re-host on a server that doesn't should still work.
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not load the NEC2 engine (HTTP ${response.status})`);
    compiled = await compileNec2c(await response.arrayBuffer());
  }
  return makeEngine(compiled, simd);
}

self.onmessage = async (event: MessageEvent<Nec2Request>) => {
  const { id, deck } = event.data;
  let response: Nec2Response;
  try {
    engine ??= load();
    const raw = await runNec2c(deck, await engine);
    response = { id, ok: true, run: { raw, report: parseNec2Output(raw.output) } };
  } catch (e) {
    engine = undefined; // let the next run retry a failed download
    response = { id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  self.postMessage(response);
};
