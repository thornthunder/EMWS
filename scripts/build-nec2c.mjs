#!/usr/bin/env node
// Compiles the vendored nec2c sources (engines/nec2c/upstream) to WebAssembly.
//
//   npm run build:engine
//
// Output (committed to git, so most contributors never need Emscripten):
//   src/engine/nec2/wasm/nec2c.mjs    Emscripten ES-module loader
//   src/engine/nec2/wasm/nec2c.wasm   the NEC2 engine
//
// emcc is located, in order, via: $EMCC, $EMSDK, ./.tools/emsdk, then PATH.
// See docs/building-the-engine.md.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const upstreamDir = join(root, 'engines', 'nec2c', 'upstream');
const shimDir = join(root, 'engines', 'nec2c', 'wasm');
const outDir = join(root, 'src', 'engine', 'nec2', 'wasm');
const isWindows = process.platform === 'win32';

function findEmcc() {
  const exe = isWindows ? 'emcc.exe' : 'emcc';
  const candidates = [];
  if (process.env.EMCC) candidates.push({ emcc: process.env.EMCC });
  if (process.env.EMSDK) {
    candidates.push({ emcc: join(process.env.EMSDK, 'upstream', 'emscripten', exe) });
  }
  const localSdk = join(root, '.tools', 'emsdk');
  candidates.push({
    emcc: join(localSdk, 'upstream', 'emscripten', exe),
    // A project-local SDK is never "activated" in the shell, so point emcc at its config.
    config: join(localSdk, '.emscripten'),
  });
  for (const c of candidates) {
    if (existsSync(c.emcc)) return c;
  }
  return { emcc: 'emcc' }; // fall back to PATH
}

const { emcc, config } = findEmcc();
const env = { ...process.env };
if (config && !env.EM_CONFIG) env.EM_CONFIG = config;

const sources = readdirSync(upstreamDir)
  .filter((f) => f.endsWith('.c'))
  .sort()
  .map((f) => join(upstreamDir, f));

if (sources.length === 0) {
  console.error(`No C sources found in ${upstreamDir}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

const args = [
  ...sources,
  '-O2',
  '-DHAVE_CONFIG_H',
  `-I${shimDir}`,
  '-o', join(outDir, 'nec2c.mjs'),

  // ES module factory: `import createNec2c from './nec2c.mjs'`.
  '-sMODULARIZE=1',
  '-sEXPORT_ES6=1',
  '-sEXPORT_NAME=createNec2c',
  // Browser main thread, Web Worker, and Node (the latter for the test suite).
  '-sENVIRONMENT=web,worker,node',

  // nec2c is a run-once command-line program: we call main() ourselves, once per
  // module instance, and throw the instance away afterwards.
  '-sINVOKE_RUN=0',
  '-sEXIT_RUNTIME=1',
  '-sEXPORTED_FUNCTIONS=_main',
  '-sEXPORTED_RUNTIME_METHODS=callMain,FS',
  // The deck goes in and the report comes out through Emscripten's in-memory FS.
  '-sFORCE_FILESYSTEM=1',

  // The interaction matrix is N^2 complex doubles; let big models grow the heap.
  '-sALLOW_MEMORY_GROWTH=1',
  '-sINITIAL_MEMORY=33554432', // 32 MiB
  '-sMAXIMUM_MEMORY=2147483648', // 2 GiB
  '-sSTACK_SIZE=4194304', // 4 MiB; FORTRAN-heritage code likes big locals
];

console.log(`emcc:    ${emcc}`);
console.log(`sources: ${sources.length} files from ${upstreamDir}`);

const result = spawnSync(emcc, args, { stdio: 'inherit', env });
if (result.error) {
  console.error(`\nCould not run emcc: ${result.error.message}`);
  console.error('Install the Emscripten SDK - see docs/building-the-engine.md');
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);

console.log('\nBuilt:');
for (const name of ['nec2c.mjs', 'nec2c.wasm']) {
  const file = join(outDir, name);
  const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
  console.log(`  ${name.padEnd(11)} ${String(statSync(file).size).padStart(8)} bytes  sha256 ${sha}`);
}
