# EMWS - notes for Claude

Public-domain electromagnetic simulation suite for radio amateurs. Static SPA
(React + TypeScript + Vite) hosted on IIS; all computation runs in the browser.
Owner: ZR1JT - credit project work to the callsign, not a real name or email.

## Commands

```sh
npm run dev            # dev server
npm test               # vitest: real decks through the real WASM engine
npm run build          # tsc -b && vite build  -> dist/
npm run preview        # serve dist/ on :4173
npm run smoke          # headless Edge/Chrome solves a model against :4173 (or a URL argument)
npm run build:engine   # recompile nec2c -> WASM; needs Emscripten in .tools/emsdk
```

Before calling a change done: `npm test && npm run build`. For anything touching the
worker, WASM loading, routing, asset URLs or `web.config`, also `npm run preview` +
`npm run smoke` - the Node tests cannot see those paths.

## Hard rules

- **Public domain only.** Code is Unlicense, docs/data are CC0. Never copy from GPL
  projects (xnec2c, nec2++, AntennaSim, ...). Any new third-party code needs a
  provenance record like `engines/nec2c/PROVENANCE.md` *before* it goes in. Prefer an
  existing public-domain engine over writing a new one, but verify its licence at the
  source (README, file headers, Debian's copyright file), not from GitHub's label.
- **`engines/nec2c/upstream/` is never edited.** It is byte-identical to the upstream
  archive and hash-recorded. Adapt with build flags, the `wasm/config.h` shim, or a
  separate patch file.
- **Don't state a number you haven't measured.** Engine regression values in
  `tests/nec2-engine.test.ts` were each checked against antenna theory; keep it that way.

## Architecture

- `src/engine/nec2/run.ts` - environment-neutral runner (browser worker + Node tests).
  nec2c is run-once (globals, `exit()`), so: compile once, fresh instance per run.
  WebAssembly traps (bad decks) become `{ exitCode: TRAPPED, trap }`, not exceptions.
- `nec2.worker.ts` / `client.ts` - worker protocol; `cancel()` kills and replaces the worker.
- `parse-output.ts` - nec2c's text report -> `Nec2Report`. Whitespace-tokenised (every
  printf field upstream is space-separated); the pattern table's SENSE column can be blank.
- `pattern.ts`, `src/lib/rf.ts` - analysis helpers shared by tools.
- `src/tools/<tool>/` - one folder per tool; `src/ui/` - shared SVG plots (no chart library).
- Routing is hash-based and `base: './'` on purpose: no IIS URL Rewrite, works in any sub-folder.
- `src/engine/nec2/wasm/nec2c.{mjs,wasm}` are generated but committed.

## Conventions

- TypeScript strict + `noUncheckedIndexedAccess`. British spelling in prose ("licence", "colour").
- No new runtime dependencies without a good reason; plots are hand-written SVG.
- `public/web.config`: every `<add>`/`<mimeMap>` is preceded by a `<remove>` (IIS 500s on duplicates).
- NEC angles: theta from +Z (zenith), phi from +X. Elevation = 90 - |theta|.
