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
`npm run smoke` - the Node tests cannot see those paths. `npm test` goes through
`scripts/test.mjs`, which normalises the drive-letter case first: started from `d:...`
(as VS Code's terminal often is) Vitest collects no tests at all.

**The smoke test spawns a real browser.** On Windows the spawned process is only a
launcher; the browser must be closed over DevTools (`shutDownBrowser` in the script) or it
and its profile are leaked - this machine was once found with 488 orphaned Edge processes
and 23 GB of `%TEMP%emws-smoke-*`. If the script warns it could not remove a profile, the
sandbox this project is often driven from can make some undeletable from inside it;
delete them from a normal shell.

## Hard rules

- **Public domain only.** Code is Unlicense, docs/data are CC0. Never copy from GPL
  projects (xnec2c, nec2++, AntennaSim, ...). Any new third-party code needs a
  provenance record like `engines/nec2c/PROVENANCE.md` *before* it goes in. Prefer an
  existing public-domain engine over writing a new one, but verify its licence at the
  source (README, file headers, Debian's copyright file), not from GitHub's label.
  **EMWS itself links nothing**, and must keep working with no solver service at all -
  that is what lets `services/emws-solver/` (separate program, separate distribution,
  HTTP between them) optionally link BSD code without touching EMWS's licence. See its
  `NOTICE`. Anything permissive-but-not-public-domain belongs on that side of the line.
- **`engines/nec2c/upstream/` is never edited.** It is byte-identical to the upstream
  archive and hash-recorded. Adapt with build flags, the `wasm/config.h` shim, or a
  separate patch file.
- **Don't state a number you haven't measured.** Engine regression values in
  `tests/nec2-engine.test.ts` were each checked against antenna theory; keep it that way.
- **Every tool has a Field Guide, kept in step with it.** Guides live in `src/guides/`
  (registry + one component per tool), shown at `#/guides`. Change a tool's behaviour -
  controls, shortcuts, readouts, checks - and update its guide in the same change; a new
  tool ships with its guide. Write them for radio amateurs, not for developers.

## Architecture

- `src/engine/nec2/run.ts` - environment-neutral runner (browser worker + Node tests).
  nec2c is run-once (globals, `exit()`), so: compile once, fresh instance per run.
  WebAssembly traps (bad decks) become `{ exitCode: TRAPPED, trap }`, not exceptions.
- `nec2.worker.ts` / `client.ts` - worker protocol; `cancel()` kills and replaces the worker.
- `solver.ts` - where a model gets solved: this browser, a service on `127.0.0.1`, or the
  site's proxy (`public/solver/index.php`, address from `EMWS_SOLVER_URL`). A remote solver
  returns nec2c's report *text* only; it is parsed here, so it cannot change a result's
  meaning. **Every job carries a `kind`** (`nec2` today) and `/health` lists the kinds a
  service can do - the protocol is not NEC-specific on purpose, so a later engine needs no
  second service. Protocol and hosting: `docs/solver-service.md`. Reference service:
  `services/emws-solver/` (git-ignored - it will link CUDA, so it stays out of this repo).
- `parse-output.ts` - nec2c's text report -> `Nec2Report`. Whitespace-tokenised (every
  printf field upstream is space-separated); the pattern table's SENSE column can be blank.
- `pattern.ts`, `src/lib/rf.ts` - analysis helpers shared by tools. `mainLobe()` breaks ties
  towards the horizon and never picks a pole unless strictly maximal (a dipole's broadside
  plane is all maxima; an azimuth cut through the zenith is meaningless).
- `cards.ts` - card lexer mirroring nec2c's reader: lines starting with a space or `#` are
  skipped, integer fields reject decimals, 132-char line buffer.
- `src/tools/<tool>/` - one folder per tool; `src/ui/` - shared SVG plots (no chart library).
- Routing is hash-based and `base: './'` on purpose: no IIS URL Rewrite, works in any sub-folder.
- **Two engine builds, picked at runtime.** `build:engine` emits `nec2c.{mjs,wasm}` and
  `nec2c-simd.{mjs,wasm}` from the same sources (`-O3 -fcx-limited-range`, plus `-msimd128`
  for the second); all four are generated but committed. `supportsWasmSimd()` in `run.ts`
  chooses, the worker fetches only that one, and the glue must always travel with its own
  `.wasm`. SIMD is ~1.3-1.7x on a big model and needs a browser from 2021 (2023 on Apple).
  **The two must give byte-identical reports** - `tests/engine-builds.test.ts` asserts it
  deck by deck, because otherwise a reading would depend on the reader's browser.

### Antenna Modeler editor

- **The `AntennaModel` (`model.ts`) is the source of truth**, not the deck text. Every edit is
  a pure function; `history.ts` gives undo/redo, and object identity says whether results are
  current (`solved.model === model`). A drag is one gesture = one undo step.
- `deck.ts` converts model <-> deck. Anything it can't represent (GA/GH/GM/GC, EX≠0, several
  runs, GE -1, GE 1 without GN, ...) makes `deckToModel` return `ok: false` with a reason, and
  the page falls back to running the text verbatim with read-only views. Never approximate.
  Unknown program cards (LD, TL, NT, EK, NE, NH...) pass through verbatim in `extraCards`.
- `planRuns()`: a sweep with the automatic whole-sphere pattern runs as `FR n + XQ` plus a
  separate single-frequency pattern run (measured: full sphere at 17 steps = 1.2 s, 2.8 MB;
  XQ sweep = 11 ms). Keep that split.
- **Sweeps are solved one frequency per worker** (`planRuns().perFrequency` + `Nec2Client.simulateAll`
  + `merge.ts`), above `SPLIT_SWEEP_MS`. Measured in the browser: 601 segments x 17 frequencies,
  6.2 s in one run vs 2.2 s across 8 workers on a 4-core laptop.
  The split decks must reach each frequency by **adding the step repeatedly**, as nec2c does
  (`save.fmhz += delfrq`), and write it with `String(f)` rather than the 10-digit tidy-up, or the
  last digits drift. `tests/parallel-sweep.test.ts` asserts split == combined, frequency by frequency.
- Worker count comes from `recommendedWorkers(jobs, segments)`: cores, jobs, and a memory budget,
  because every worker holds its own copy of the interaction matrix (16 bytes x segments squared).
- Views: first-angle projection (ISO 128 / SANS). Front looks along +Y (X right, Z up); Left
  looks along +X from -X (**+Y points left**, drawn right of front); Top looks down (X right,
  Y up, drawn below front). One shared camera so rows share Z and columns share X.
- Joined ends follow nec2c: L1 distance <= 1e-3 x segment length. Dragging an end moves its
  junction; dragging a wire drags joined ends along (Shift detaches, Alt disables snapping).
- Ids come from `newId()` (session-prefixed counter): `crypto.randomUUID` is unavailable on
  plain-HTTP origins like http://emws.local.
- `npm run smoke -- --edit` drives the editor with real mouse/keyboard via CDP (drag, undo,
  split, draw, element drag, automatic pattern). Run it after any editor change.

### Smith chart (`src/tools/smith-chart/`)

- `model.ts` holds the chain **in load-to-radio order**, which is also the transform order;
  `network.ts` does the physics, `match.ts` solves L networks, `units.ts` does nH/pF.
- Transmission lines use cosh/sinh, never tanh: tanh is infinite a quarter wave along a
  lossless line and quietly returns the wrong answer (a test covers the Z0^2 / ZL case).
- `lMatchSolutions()` returns both topologies and both roots, plus the one-component case
  when the load already sits on the right circle. Every solution is exact at the design
  frequency; a test asserts that.
- Loads: typed R + jX (reactance follows frequency by default), Touchstone `.s1p`
  (`src/lib/touchstone.ts`), or the Antenna Modeler's last run via `src/lib/handoff.ts`.
- Chart series colours are `--series-1..3` + `--series-more`, validated with the dataviz
  skill's palette checker for both surfaces; assign in fixed order, never cycle. Every step
  is also numbered, so colour is never the only cue.
- `npm run smoke -- --smith` builds a match in the browser and checks the numbers, including
  the Antenna Modeler handoff.

### Baluns and ununs (`src/tools/balun/`, `src/lib/ferrite.ts`)

- **The winding recipe (`Design.steps`: wind / tap / crossover) is the source of truth**, as
  the `AntennaModel` is in the modeller. The pad (`WindingPad.tsx`) and the form both edit it
  through pure functions in `model.ts`; a drag is one undo step.
- `circuit.ts` chains ABCD two-ports and finds losses by **walking back from the load**, so
  core + copper + load = accepted power by construction. `tests/balun.test.ts` asserts it, plus
  exact ideal limits and the identity that a single-relaxation core is a fixed R parallel L.
- **No manufacturer data is copied.** Core constants are calculated from dimensions
  (`toroidGeometry`, the C1/C2 method). Built-in mixes are `mu_i` + family, with frequency
  behaviour estimated by a Debye relaxation at the Snoek frequency. Known limit: that gives
  every mix in a family the SAME loss resistance, so built-ins cannot rank mixes on loss -
  the UI says so when two are compared. A measured `.s1p` (`measure.ts`) replaces the estimate.
- `strays.ts` (leakage, winding capacitance, pair-line Z0) are geometry estimates that set
  the TOP of the range and are overridable. NiZn cores are treated as the dielectric they
  are (eps ~12), MnZn as conductors - getting that wrong made a compensation capacitor
  appear to hurt, which is how it was caught. A winding's reactance PEAKING is the ferrite,
  not resonance; only going capacitive is (`trustworthyUpToMHz`).
- **Core profiles** (`profiles.ts`): a measured core is a `CoreProfile` - size + mix + the raw
  VNA sweep + setup - kept in localStorage (`emws.balun.cores.v1`) and exportable as
  `{ emws: 'core-profiles', version: 1 }` JSON. **The sweep is the truth; the curve is a
  cache** and is re-derived on load, on import and on any setup correction. (A stored profile
  with an empty curve once ran the whole tool on an air core - SWR 159,272:1 - because load
  trusted it; a test now plants exactly that and checks the numbers.) A profile pick copies
  its size into `customCore` and sets `profileId`; picking a catalogue core or editing
  dimensions clears `profileId` (`withProfile` / `withCatalogueCore` / `withCustomDimensions`).
- Nothing in it has been checked against a bench measurement yet. Do not claim otherwise.
- `npm run smoke -- --balun` winds with real mouse input, checks single-step undo, comparison
  and the refused design.

### NanoVNA over Web Serial (`src/lib/vna/`, `src/ui/MeasureWithVna.tsx`)

- **Written from the published protocols only.** The NanoVNA firmware, nanovna-saver and the
  V2 desktop apps are all GPL: never read their source for this, let alone copy it. Classic
  NanoVNA = text shell (`scan start stop pts 3`, older firmware `sweep` + `frequencies` +
  `data 0`, prompt `ch> `); NanoVNA-V2 / SAA-2 = binary registers (op 0x0d INDICATE answers
  `'2'`, WRITE/WRITE2/WRITE8, FIFO at 0x30 in 32-byte entries). `identify(link)` sends one
  `\r` and tells them apart by the reply; anything else is "not a NanoVNA".
- **Calibration is not the same on the two families.** The classic instrument applies its
  own calibration and sends corrected data; the V2 sends raw readings, so `calibration.ts`
  does one-port SOL (three-term error model) and `MeasureWithVna` refuses to measure on a V2
  until short, open and load have been taken for the current range. Nothing leaves the
  component uncalibrated.
- Web Serial exists only on secure pages (https:// or localhost) in desktop Chromium.
  `serialUnavailableReason()` says which is missing and the UI shows that instead of a dead
  button; the `.s1p` route is always there. `scripts/enable-https.ps1` gives an IIS site a
  self-signed certificate trusted on that machine - it touches the Trusted Root store, so the
  user runs it, not the assistant.
- One component, three homes: Smith chart load (`ChainPanel`), balun core measurement
  (`DesignPanel`), Antenna Modeler `ComparePanel` (measured SWR dashed over the modelled
  curve in `SweepChart`, `measured` prop). Its range follows the tool's range (`useEffect`
  on the props), because a single-frequency model gave a zero-width sweep before that.
- `tests/vna.test.ts` drives both drivers against scripted links; `npm run smoke -- --vna`
  injects a simulated NanoVNA-H into the page (`Page.addScriptToEvaluateOnNewDocument`, after
  `Page.enable`; the fake port hands out fresh streams on every `open()`, as a real one does)
  and measures from all three tools. **No real instrument has been connected yet**; say so.

## Conventions

- TypeScript strict + `noUncheckedIndexedAccess`. British spelling in prose ("licence", "colour").
- No new runtime dependencies without a good reason; plots are hand-written SVG.
- `public/web.config`: every `<add>`/`<mimeMap>` is preceded by a `<remove>` (IIS 500s on duplicates).
- NEC angles: theta from +Z (zenith), phi from +X. Elevation = 90 - |theta|.
