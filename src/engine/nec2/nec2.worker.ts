// Web Worker: keeps NEC2 runs off the UI thread.

import wasmUrl from './wasm/nec2c.wasm?url';
import { parseNec2Output } from './parse-output';
import { runNec2c } from './run';
import type { Nec2Run } from './types';

export interface Nec2Request {
  id: number;
  deck: string;
}

export type Nec2Response =
  | { id: number; ok: true; run: Nec2Run }
  | { id: number; ok: false; error: string };

let compiled: Promise<WebAssembly.Module> | undefined;

async function compile(): Promise<WebAssembly.Module> {
  try {
    return await WebAssembly.compileStreaming(fetch(wasmUrl));
  } catch {
    // compileStreaming insists on the application/wasm MIME type. EMWS's web.config
    // sets it, but a re-host on a server that doesn't should still work.
    const response = await fetch(wasmUrl);
    if (!response.ok) throw new Error(`Could not load the NEC2 engine (HTTP ${response.status})`);
    return WebAssembly.compile(await response.arrayBuffer());
  }
}

self.onmessage = async (event: MessageEvent<Nec2Request>) => {
  const { id, deck } = event.data;
  let response: Nec2Response;
  try {
    compiled ??= compile();
    const raw = await runNec2c(deck, await compiled);
    response = { id, ok: true, run: { raw, report: parseNec2Output(raw.output) } };
  } catch (e) {
    compiled = undefined; // let the next run retry a failed download
    response = { id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  self.postMessage(response);
};
