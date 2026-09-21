# Rebuilding the NEC2 engine

You only need this if you are changing how nec2c is compiled, or updating nec2c itself.
The built engines (`src/engine/nec2/wasm/nec2c{,-simd}.{wasm,mjs}`) are committed, so
everyday work on EMWS needs only Node.js.

## Install Emscripten

The build script looks for `emcc` in this order: `$EMCC`, `$EMSDK`, a project-local
SDK in `.tools/emsdk`, then your `PATH`.

A project-local SDK is the least intrusive: it touches nothing outside the repository,
changes no environment variables, and `.tools/` is git-ignored. It takes 1.9 GB of disk.

```sh
git clone --depth 1 https://github.com/emscripten-core/emsdk.git .tools/emsdk
cd .tools/emsdk
./emsdk install 6.0.9        # Windows: .\emsdk.bat install 6.0.9
./emsdk activate 6.0.9       # Windows: .\emsdk.bat activate 6.0.9
```

6.0.9 is the version the committed engine was built with. Newer versions should work;
the test suite will tell you.

## Build and check

```sh
npm run build:engine   # compile
npm test               # the engine's numbers, checked against antenna theory
npm run build          # bundle
npm run preview        # serve it, then in another terminal:
npm run smoke          # a real browser solves a real model
```

Then update the hashes and the Emscripten version in
[engines/nec2c/PROVENANCE.md](../engines/nec2c/PROVENANCE.md), and commit the new
engine files together with whatever caused them to change.

## How the build works

`scripts/build-nec2c.mjs` hands every `.c` file in `engines/nec2c/upstream/` to `emcc`.
Each flag is explained in the script. The design decisions behind them:

- **Upstream is never patched.** nec2c normally gets a `config.h` from autotools;
  `engines/nec2c/wasm/config.h` stands in for it, and everything else is done with flags.
- **Two builds from one set of sources.** The script runs `emcc` twice: `nec2c` and
  `nec2c-simd`, the latter adding `-msimd128`. `run.ts` asks the runtime which it can
  execute and the worker fetches only that one, so nobody downloads an engine they
  cannot run and nobody with an older browser is locked out. Each `.wasm` must be paired
  with the `.mjs` built alongside it — the loaders are not interchangeable.
- **`-O3 -fcx-limited-range`, and what they are worth.** Measured on a 2001-segment model:
  `-O3` over `-O2` about 1.34×, and SIMD on top of that about 1.69× in total.
  `-fcx-limited-range` lets the compiler inline complex multiplication instead of calling
  a helper that guards against infinities and NaNs; a NEC-2 impedance matrix contains
  neither. It is worth little in WebAssembly (clang inlines anyway) but 1.8× for a native
  build, so it stays.
- **A faster build that changes an answer is a broken build.** All four variants were
  measured to produce byte-identical reports on every deck in `examples/`, and
  `tests/engine-builds.test.ts` compares the plain and SIMD engines' output character for
  character on each one. Run it after touching any compiler flag.
- **One fresh instance per run.** nec2c is a command-line program: it keeps its state in
  globals and leaves through `exit()`. Rather than patch it into a re-entrant library,
  EMWS compiles the module once and instantiates it anew for each simulation. That is
  cheap: a complete run of a small model, instantiation included, takes about 5 ms. It
  calls `main()` with `-i /deck.nec -o /deck.out` and reads the report from Emscripten's
  in-memory filesystem.
- **Traps are results, not crashes.** Natively, nec2c's signal handler catches the
  SIGFPE from, say, a zero-segment wire. WebAssembly has no signals; that becomes a
  `WebAssembly.RuntimeError`, which `run.ts` turns into a failed run that the UI explains.
- **Browser, worker and Node.** The loader supports all three so that the tests can run
  the real engine under Node. Its Node-only `import('node:module')` sits behind a
  runtime check; browser bundles get a stub for it (see `vite.config.ts`).
