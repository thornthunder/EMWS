# Rebuilding the NEC2 engine

You only need this if you are changing how nec2c is compiled, or updating nec2c itself.
The built engine (`src/engine/nec2/wasm/nec2c.wasm` and `nec2c.mjs`) is committed, so
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
`nec2c.wasm` and `nec2c.mjs` together with whatever caused them to change.

## How the build works

`scripts/build-nec2c.mjs` hands every `.c` file in `engines/nec2c/upstream/` to `emcc`.
Each flag is explained in the script. The design decisions behind them:

- **Upstream is never patched.** nec2c normally gets a `config.h` from autotools;
  `engines/nec2c/wasm/config.h` stands in for it, and everything else is done with flags.
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
