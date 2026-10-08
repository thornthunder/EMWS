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

Before calling a change done: `npm test && npm run build` (CI runs the same two on every
push and PR - `.github/workflows/ci.yml`; the browser smokes stay manual). For anything touching the
worker, WASM loading, routing, asset URLs or `web.config`, also `npm run preview` +
`npm run smoke` - the Node tests cannot see those paths. `npm test` goes through
`scripts/test.mjs`, which normalises the drive-letter case first: started from `d:...`
(as VS Code's terminal often is) Vitest collects no tests at all.

**The smoke test spawns a real browser.** On Windows the spawned process is only a
launcher; the browser must be closed over DevTools (`shutDownBrowser` in the script) or it
is leaked - this machine was once found with 488 orphaned Edge processes and 23 GB of
`%TEMP%emws-smoke-*`. **Every run reuses ONE profile folder**, `%TEMP%\emws-smoke-profile`
(`SMOKE_PROFILE_DIR` moves it), and wipes the site's storage, cache and cookies over
DevTools before navigating, so a run is as clean as a fresh profile (the `--pwa` offline
test depends on that wipe). A second smoke running at the same time gets a throwaway
`emws-smoke-*` folder and says so. Why fixed (2026-10-06): a fresh folder per run could
not be deleted by ANYONE on ZR1JT's machine - not the sandbox's doing, as was believed, but
ESET Internet Security's browser-data protection, which refuses every process but the
browser access to the profile's data files whatever the ACLs say (takeown/icacls change
nothing); 183 folders, 4.3 GB. To delete leftovers: ESET → Browser Privacy & Security →
Secure all browsers OFF for a minute, `Remove-Item "$env:TEMP\emws-smoke-*" -Recurse -Force`.

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
  site's proxy (`public/solver/index.php`, address from `EMWS_SOLVER_URL`).
  Three lessons a 2026-09-29 review taught, each now under test in `tests/solver.test.ts`:
  `SolveOptions.workers` carries the modeller's memory-aware limit into `LocalSolver`
  (recomputing it there knows no segment count and once overshot 2 workers as 16); a
  cancelled remote fetch throws `SimulationCancelled`, NEVER `SolverUnavailable`, because
  the page falls back to a local solve on the latter - cancelling once STARTED a solve;
  and the page's Cancel/cleanup goes through `cancelSolvers()`, which stops the chosen
  solver AND the local one a fallback may have running. A remote solver
  returns nec2c's report *text* only; it is parsed here, so it cannot change a result's
  meaning. **Every job carries a `kind`** (`nec2` today) and `/health` lists the kinds a
  service can do - the protocol is not NEC-specific on purpose, so a later engine needs no
  second service. Protocol and hosting: `docs/solver-service.md`. Reference service:
  `services/emws-solver/` (git-ignored - it will link CUDA, so it stays out of this repo).
- `parse-output.ts` - nec2c's text report -> `Nec2Report`. Whitespace-tokenised (every
  printf field upstream is space-separated); the pattern table's SENSE column can be blank.
- **3-D pattern** (`antenna-modeler/Pattern3D.tsx`, maths in `pattern-mesh.ts`): a surface only
  from a COMPLETE theta x phi grid - the free-space dipole example's two crossed RP cuts once
  produced 140 phantom faces from their union; now it shows a note instead. Same ARRL scale as
  the polar plots (`src/ui/polar-scale.ts`), grid thinned to <= 40 a side for smooth dragging,
  peak line from `mainLobe()` (a dipole's maximum is a ring; the first max found was the zenith).
  The antenna is drawn OVER the surface, not depth-sorted among the faces: a wire lies along a
  null of its own pattern, so every face in front hid it. Shares `project()` with View3D.
- `pattern.ts`, `src/lib/rf.ts` - analysis helpers shared by tools. `mainLobe()` breaks ties
  towards the horizon and never picks a pole unless strictly maximal (a dipole's broadside
  plane is all maxima; an azimuth cut through the zenith is meaningless).
- `cards.ts` - card lexer mirroring nec2c's reader: lines starting with a space or `#` are
  skipped, integer fields reject decimals, 132-char line buffer.
- `src/tools/<tool>/` - one folder per tool; `src/ui/` - shared SVG plots (no chart library).
- Routing is hash-based and `base: './'` on purpose: no IIS URL Rewrite, works in any sub-folder.
- **Tools are lazy chunks** (`App.tsx`: `React.lazy` + one `Suspense`). The main bundle is
  React + home + guides; each tool is fetched on first open. Measured 2026-10-04: main chunk
  579 -> 322 kB, modeler 129 kB, balun 49 kB, toolbox 35 kB, and the 500 kB warning is gone.
  The fallback renders no `h1`: the smoke waits for `h1` to know a page is up. **After a
  hash navigation the old page stays on screen until the new chunk arrives**, so a smoke
  step must wait for the destination's own `h1` (or a selector only it has), never for
  something both pages have - `--vna` once passed its "modeler solved" wait on the Smith
  chart's summary cards.
- **Installable + offline** (2026-10-05): `public/manifest.webmanifest` (+ `icon-maskable.svg`
  in the safe zone), and `dist/sw.js` GENERATED after `vite build` by `scripts/build-sw.mjs`
  (hand-written, no workbox): precache every built file except PHP, `.map`, `web.config`;
  cache-first for assets, network-first for navigations (a deploy shows on the next online
  reload); `/solver/` and `/community/` never cached. **The worker caches ONE engine pair** -
  it runs the same `i8x16.splat` validate probe as `supportsWasmSimd()` - because "a visitor
  fetches only the engine they run" is a rule the default smoke enforces; the generator
  fails the build if either engine pair is not exactly one .js + one .wasm. Registered in
  `main.tsx` only in a real build on a secure page, so http://emws.local is untouched.
  `npm run smoke -- --pwa` cuts the network, reloads, and SOLVES a model from the cache.
  **Harness lesson, earned:** the smoke auto-attaches every target paused
  (`waitForDebuggerOnStart`); it once released a target only after `Network.enable` and
  `Runtime.enable` answered - a service worker paused at start never answers, so `register()`
  hung forever with no error. Release unconditionally; never gate `runIfWaitingForDebugger`.
- **Print** (`@media print` in `styles.css`): Ctrl+P on any tool prints results only - panels,
  buttons, pickers hidden; inputs inside readouts flattened to text; light palette pinned.
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
- **Loads** (`model.loads`) sit on one segment of a wire exactly as feeds do (1-based
  `segment`), and every cascade that moves feeds moves loads: `setWireGeometry` remaps,
  `deleteWire` drops, `splitWire` re-homes (`tests/loads.test.ts`). Kinds map to LD cards: series
  RLC = LD 0 (a coil is L with its loss as R), parallel RLC = LD 1 (a trap; R is the parallel loss,
  Q x wL), fixed R + jX = LD 4. A zero part is absent, as NEC reads it - so an all-zero
  *parallel* load is an open circuit, and `validate.ts` says so. `deckToModel` adopts only
  single-segment LD 0/1/4 cards; ranged, per-metre (2/3), conductivity (5) and `LD -1` stay
  verbatim in `extraCards`. `resolveSegment` does the tag+segment walk for EX and LD alike. Loads
  travel free in per-frequency sweep decks and to remote solvers because they are just cards.
  nec2c's power budget already counts their loss (`structureLossW`), so efficiency is the
  readout; its "STRUCTURE IMPEDANCE LOADING" table is not parsed. Older stored models have no
  `loads` field; the restore path defaults it.
- The trap dipole example (`examples/trap-dipole-40-80m.nec`) was tuned by running the engine:
  87 + j2 Ω and 90.8 % at 7.1 MHz, 47 − j2 Ω and 98.2 % at 3.65 MHz; the tests hold it to those
  within a few ohms and percent, and `npm run smoke -- --lc` sees the same 90.8 % in the browser.
- The coil tool hands a coil or trap over through `emws.handoff.load` (`src/lib/handoff.ts`);
  the panel's Loads section offers it for the selected wire and reads it once per mount.
- **Feed line to the radio** (2026-10-05, `feedline.ts`): a run of coax from the toolbox's
  catalogue (or its datasheet cable, read via `loadState()` so the two tools cannot
  disagree) hangs between the radio and the feed - or the balun, when one is looked
  through: antenna → balun → line → radio. The transform is the lossy-line ABCD with
  cosh/sinh (NEVER tanh - the Smith chart's quarter-wave lesson), the loss an exact power
  walk from the load; for real Z0 it reproduces the classic (a²−ρ²)/(a(1−ρ²)) to the last
  digit and `tests/feedline.test.ts` holds it there, plus the lossless quarter-wave
  Z0²/ZL case. UI: picker row under the Summary, a "Feed line loss" card (matched +
  mismatch split, watts at the ratings power), and with a sweep a "Where the power goes"
  LineChart (reaches antenna / heats cable / heats balun). The SWR at the radio is
  flattered by the loss - the card says so rather than hiding it. LineChart gained a
  narrow-range tick fallback (first/last) for single-band sweeps.
- **Radial screens and materials** (2026-10-04, all MEASURED on nec2c before a word was
  written): nec2c REFUSES a radial screen with Sommerfeld ("MAY NOT BE USED WITH SOMMERFELD
  GROUND OPTION"), so `validate.ts` errors and the panel forces the reflection method. With a
  screen, the feed impedance equals the perfect-ground figure EXACTLY and the screen's count,
  radius and wire radius change nothing at all (1-120 radials, 2-40 m: identical to the last
  digit); the soil moves only the far field. A wire ending at z=0 on real ground WITHOUT a
  screen gives nonsense (267 - j770 Ω): `validate.ts` warns. Never write guide text implying
  NEC-2 can size a radial system. `Ground.real.screen` <-> GN I2 + F3/F4; `Wire.conductivity`
  <-> `LD 5 tag 0 0 σ` (tag 0 = every wire); partial-wire LD 5 stays in extraCards.
  `WIRE_MATERIALS`: copper 5.95e7 (1/COPPER_OHM_M, consistent with the balun and coil tools),
  aluminium 3.5e7, brass 1.5e7, stainless 1.4e6, steel as σ/μr with μr 200 - labelled an
  estimate. Measured efficiencies for the 2 mm vertical: copper 98.43 %, aluminium 97.91 %,
  steel 59.8 %. `tests/ground.test.ts` holds all of it.
- **Tuning** (`tune.ts`): one variable (wire length from an end or about the middle, with
  junctions following; height = min z of all ends; one field of one load), one goal
  (resonance, swr, swr-band over the model's sweep, gain, front-to-back). `minimise1D` is a
  9-point scan then golden section, cached by value - the scan is what survives a goal with
  two dips (tested on paper). Each trial is `deckFor()` = one frequency, no pattern unless
  the goal needs one, and then a 10° sphere. The page runs it through `withSolver`, so remote
  solvers, fallback and Cancel all behave; the result is ONE undo step applied to whatever the
  model is by then. `atEdge` (within 2% of the range) and `truncated` are reported in words,
  never hidden. Engine tests find a 20 m dipole's length and a short dipole's loading coil.
- **"Is the model converged?"** (`convergence.ts`, 2026-10-05): one button under Tune
  solves the model again with every wire at twice the segments (via `setWireGeometry`, so
  feeds and loads keep their place) at the on-screen frequency with tune's 10° sphere, and
  reports the movement of feed Z and peak gain in words. Verdict thresholds (5 % of |Z|,
  0.25 dB) were set AFTER measuring: the shipped 21-seg dipole moves 0.31 Ω (0.43 %) and
  0.00 dB when doubled - `tests/convergence.test.ts` runs the real engine and holds it
  there, and the --edit smoke presses the button. Solves run sequentially on purpose: the
  doubled matrix is 4× the memory.
- **RF exposure map** (`exposure.ts`, `ExposurePanel.tsx`, 2026-10-05): `parse-output.ts` now
  reads NE/NH tables (`nearElectric` / `nearMagnetic` on a FrequencyResult; several cards
  append). `exposureDeck` = the model at one frequency with pattern `{kind:'cards', cards:[NE,
  NH]}` - one solution, no extra XQ, user NE/NH/RP/XQ extra cards stripped so their tables
  cannot merge into the grid. Fields are PEAK phasors; RMS = sqrt(½Σ|Ei|²); scaled by
  sqrt(P_avg / NEC inputW), P_avg = tx × duty × on-air × feed-line/balun delivery. MEASURED
  against theory (`tests/exposure.test.ts`): broadside at 10/15/20 λ, E·r = 0.9979/0.9981/
  0.9982 of sqrt(60 P G) at G = 2.15 dBi (the dipole is 2.14), |E|/|H| = 0.99974→0.99992 of η0;
  works over Sommerfeld ground, a radial screen and perfect ground. Cells nearer a wire than
  its segment length are greyed: EMWS's OWN caution, said so in UI and guide. EMWS states NO
  limits - typed, kept in `emws.exposure.v1`. Colour: reference blue sequential ramp
  (`--exposure-0..6`, flipped in dark), validated monotone/single-hue with the dataviz
  checker; the limit is a STATE (red boundary + ✕/✓ status line + words), never colour
  alone; cells butt together (no gaps on a continuous field). `npm run smoke -- --exposure`
  types limits either side of the found peak, checks SSB scales by sqrt(0.2) exactly.
- **Optimiser + parameter sweep** (`optimise.ts`, `SweepPanel.tsx`, `src/ui/XYChart.tsx`,
  2026-10-05). `variableChoices()` in tune.ts is THE list of tunable things for Tune, the
  optimiser and the sweep; it gained `wire-position` (a horizontal wire's midpoint along the
  axis across it - a Yagi element's place on the boom; joined ends follow, as a drag).
  Nelder-Mead from the paper's rules in the unit cube (each range scaled to [0,1]), clamped
  to the faces, cached, capped; on paper: bowl, Rosenbrock, a minimum outside the box, the
  cap. Score = -wG·gain - wF·min(F/B, 30) + wS·10·max(0, SWR - target) ("0.1 SWR over = 1 dB").
  Starts from the model as it is and only ever improves (`improved: false` = unchanged);
  result = ONE undo step applied to the model as it is by then (as Tune). MEASURED: the 2 m
  Yagi for gain alone 8.73 -> 9.53 dBi, F/B 16.0 -> 8.2 dB (35 trials in Node, 42 in the page
  with its suggested ranges) - the textbook trade, said in the guide. Gain prints to 0.01 dB,
  so near an optimum the score has plateaus: ties shrink the simplex, which is fine. Sweep:
  2°×10° pattern per point (`sweepDeck`); MEASURED take-off angle vs sin(el) = λ/4h over the
  example's real ground: within 2.5° from 12 m (0.57 λ) up; 6 m reads 50 vs 61.6 (real
  ground). XYChart = linear-x sibling of LineChart: ticks ON the solved values, axis decimals
  from the grid step, x title under the axis. `npm run smoke -- --optimise` ticks and runs,
  undoes, sweeps, reads every angle back through the hover readout, and Uses a point.
- **MMANA-GAL .maa in and out** (`maa.ts`, 2026-10-05). Written from MMANA-GAL basic's own
  help (its sample file, wire/source/load tables) and 935 real files (github.com/handiko/
  AntennaFiles-OLD, scratch only - never in the repo); OpenNEC's MIT format notes read for
  orientation, NO text or code taken, and they were WRONG on the load line. Facts: radius in
  the FILE is metres (GUI shows mm); negative R = stepped-diameter taper pointer (refused);
  R = 0 insulator (refused); seg > 0 exact, 0/-1/-2/-3 automatic; pulse W<n><C|B|E>[±k];
  load `pulse, type, …` - 0 = L µH, C pF, Q (L AND C = PARALLEL trap), 1 = R + jX, 2 = Laplace
  "S" (refused); ground line G (0/1/2) / H = add height / M = material (code table
  UNPUBLISHED - never guessed, noted) / R = Z0. Russian edition: windows-1251, Cyrillic
  headers like "* Провода *" - sections are found by POSITION, never by name. MMANA = MININEC,
  not NEC; MMANA's real ground computes impedance over PERFECT ground (its help), so a
  grounded wire on G=2 imports as reflection-method real ground + radial screen (nec2c then
  gives exactly the perfect-ground Z - same split). Auto-segmented wires: λ/20, MIN 3 -
  MEASURED: one segment per wire at a junction (a 160 m tower) stopped nec2c with "memory
  allocation request has failed". Survey: 877/935 open, 877/877 solve and round-trip; the
  58 refusals all have reasons (40 tapers). Export refuses rather than drops (series L+C,
  extra cards); text written in 1251 if Cyrillic else 1252. `npm run smoke -- --maa` feeds a
  cp1251 file to the real Open button and reads Save .maa's bytes back.
  **Deck-writer fix found by this data:** CM lines are wrapped by UTF-8 BYTES now (nec2c's
  buffer is 132 bytes; Cyrillic/µ/Ω/° are two) - a long non-ASCII comment used to stop nec2c
  with "INCORRECT LABEL FOR A COMMENT CARD". `deck.test.ts` holds it.
- **Ratings** (`ratings.ts`): NEC's segment currents are peak phasors and its power is average
  (½ Re V I*), so volts are reported peak and current RMS; everything scales by
  sqrt(P / inputW). A test holds the one-load case to NEC's own structure-loss figure.
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
- **Mouse-wheel fine trim** (2026-10-06, from a user via ZR1JT: the log slider's 0.8 %/notch is
  too coarse at the match). `NumberField wheel` (opt-in; on the six boxes of every component
  card) nudges a FOCUSED box only - Chrome once shipped wheel-on-any-number-input and pulled it
  for accidental edits. `src/ui/number-step.ts`: the slow step is the last digit shown, never
  finer than the 4th significant figure (72.4327 pF -> 0.01), quick (< 120 ms between events,
  by `e.timeStamp` because a slow re-render otherwise hides the spin) = ×10; wheel up raises.
  The step is decided ON FOCUS and kept until blur: following "the last digit shown" as it
  changed made 0.9 + 0.1 = 1 then step by 1, and snapping to the digit's grid escalated 72.44
  -> 72.5 -> 73 (both seen). One wheel EVENT of ≥ 40 px is `round(|Δ| / 100)` notches (a
  Windows click is 100 px and was counted twice at 40; merged clicks are several); touchpad
  moves accumulate. `tests/number-field.test.ts`; the `--smith` smoke clicks a box, rolls one
  notch, spins three (sent back to back) and reads the chain table.
- Chart series colours are `--series-1..3` + `--series-more`, validated with the dataviz
  skill's palette checker for both surfaces; assign in fixed order, never cycle. Every step
  is also numbered, so colour is never the only cue.
- **Match it for me has two modes** (2026-10-08, the FieldFox tester: "Use this ADDS to my
  network - not good"; offers were "finishing touches" on the residual mismatch, which was
  the design but read as nonsense). Empty chain: one list, "Use this". Chain in place:
  says what it leaves the radio seeing; under `MATCHED_SWR` 1.05 offers nothing to add (the
  additions would be a few nH/pF); else "Finish it" = `lMatchSolutions(atRadio)` with "Add
  after mine", plus always "Or start again from the load" = `lMatchSolutions(atLoad)` with
  "Replace mine" (`elements: solution.elements`). `SolutionList` renders both.
- **One sweep, two places**: `MeasureWithVna`/`MeasureTransmission` follow the tool's
  `points` as well as start/stop (the effect's deps), and `useHandoff` sets the sweep to the
  measured count up to `MEASURED_SWEEP_POINTS` 2001 - a tester set 201 in Radio and sweep,
  measured, and watched it snap to the panel's 101. `Instrument.readRange?()` (bridge only:
  `GET /settings`) fills the panel from the instrument's front panel.
- **Wide layout** (the tester's "a wider rather than taller layout" ask; the first try,
  a 820 px panel inside the 1500 px page cap, crushed the readouts to an 80 px strip):
  `main.main-wide` (App.tsx, Smith route only) lifts the page cap to 2000 px; ≥ 1440 px the
  panel is 620-680 px with `.chain-panel` in two grid areas (load + sweep + match |
  components - the components column is the one that grows); ≥ 1900 px 930-1000 px and
  three. `.smith-layout` is grid AREAS too (chart 380-480 px | cards ≥ 250 px, step table
  under the cards) and the workspace is a CONTAINER: ≤ 880 px the table goes under chart
  and cards, ≤ 640 px the cards go under the chart. Those container rules sit LAST in the
  section - a later width rule on `.smith-layout` silently overrode them once. Screenshots
  at 1100/1366/1440/1536/1700/1920 via `--smith --width N --screenshot f.png`
  (`f-matched.png` = chain in place, + page height in the log). The capture is taken AFTER
  the wheel steps: a beyond-the-viewport capture just before them lost the quick spin.
- `npm run smoke -- --smith` builds a match in the browser and checks the numbers, including
  the Antenna Modeler handoff, the two-mode matcher (already matched -> "Replace mine" only,
  replacing not adding) and the wheel; `--vna` checks 201 points in Radio and sweep measure
  201 through the bridge and "Use the instrument's own range".

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
- Bench status (2026-10-05): the MEASUREMENT path (VNA → SOL → profile → μ curve) is
  validated on real hardware - ZR1JT measured a Fair-Rite 2631828302 (#31, 61 mm) at 1/2/3
  turns on their V2_2; the windings scale as N² within ~4 % and agree on μ′/μ″ within ~5 %.
  The same data measured the Debye limit above: the built-in #31 estimate is 1.7-7× LOW on
  that core's 1-turn |Z| over 1-52 MHz (estimate plateaus at 26 Ω; the core reaches 190 Ω).
  The simulator's PREDICTIONS (balun loss, SWR, strain) still have no bench check - do not
  claim otherwise; a measured 49:1 against the tool remains the acceptance test.
- **Component library, first shelf** (`library.ts`): a `SavedBalun` is a name + summary + the
  whole `Design`, in `emws.balun.designs.v1`. A design on a measured core carries only the
  `profileId`; `materialFor(design, profiles)` resolves it at use time (so a corrected
  measurement corrects every design on that core) and returns undefined when the profile is
  gone - callers must show that, never fall back to an estimate. The Antenna Modeler's side is
  `antenna-modeler/through.ts`: `analyse(design, material, loadAt, frequencies)` now takes the
  frequencies from outside, so the balun is evaluated at exactly the solved points with the
  modelled impedance as its load; the Summary's `select.through` swaps the SWR, the sweep and
  adds a "Balun loss" card. The feed-impedance card stays the antenna's own. Saved baluns are
  read once per modeler mount (`throughOptions()`).
- The Balun-loss card is coloured by `balunStrain()` (`through.ts`): green / orange / red on the
  temperature RISE (40 and 80 °C) and flux share of saturation (0.5 and 0.9), whichever is worse.
  These are EMWS's own rules of thumb, stated in the guide as such - not datasheet figures. Tokens
  `--strain-{ok,hot,burn}-{bg,edge}`, light and dark; the card always carries a mark and a word,
  and the words claim no more than the estimate can: "Within expected range", "Risk of thermal
  runaway", "Likely to burn out", with the small print saying "estimated at N W".
- `npm run smoke -- --balun` winds with real mouse input, checks single-step undo, comparison
  and the refused design, then saves the design and looks through it from the modeler.

### Coils, traps and filters (`src/tools/lc/`)

- Three pure-maths modules, each held to closed forms in `tests/lc.test.ts`: `coil.ts`
  (Wheeler 1982 for any shape, checked against Wheeler 1928 over its stated range and against
  the long solenoid with Nagaoka's end correction; skin depth; `turnsFor` by bisection),
  `trap.ts` (parallel LC with the coil's R following sqrt(f) from Q at resonance), `filter.ts`
  (Butterworth / Chebyshev prototypes from formulas - the ripple constant is `40 / ln 10`, not
  17.37, which put the ripple 5e-5 dB over; ABCD chain with any source and load).
- **Q is a range, never a number.** Skin effect alone is the upper bound; Medhurst's 3.4 for a
  long close-wound coil is the lower. No proximity-effect table is transcribed. A measured Q
  (typed, from a NanoVNA sweep, or from an `.s1p`) overrides both, and `coilQ()` is what the
  trap and filter tabs take. Self-resonance is a bound (wire = half a wave), not an estimate.
- Facts the tests taught: a parallel trap is not real at 1/2π√LC (its phase is 1/Q off; |Z| is
  L/RC there exactly); above resonance its equivalent capacitance is C(1 − f0²/f²), less than C;
  a reactive ladder is transparent at DC whatever the load, so an even-order Chebyshev's
  "ripple at DC" only appears with the load it was designed for - the page draws both.
- The coil tab's former and wire are what "wind it" means on the other tabs (`turnsFor`, to the
  nearest half turn). State persists as `emws.lc.v1`. `src/ui/LineChart.tsx` is the shared log-axis
  chart (moved out of the balun tool; `marks` draws vertical guides such as the cutoff and 2×, 3×).
- The guide is `src/guides/CoilsGuide.tsx`; it states no regulatory or voltage figures, on
  purpose. `npm run smoke -- --lc` drives all four tabs and checks the numbers.
- **Stubs & cavities tab** (`stub.ts`, `StubSection.tsx`, 2026-10-05): stub Zin with cosh/sinh
  written out (never tanh/coth), loss from the toolbox cable model (`savedDatasheetCable()`
  now lives in toolbox/model.ts; the modeller's feedline delegates to it); shunt S21 =
  2/(2 + z0/Z). Band-pass = Matthaei-style capacitively coupled shorted-stub resonators: J
  inverters from `prototype()`, end caps sized against 50 Ω (with their effective shunt C),
  each stub shortened until −Yr cot θ = −ω0ΣC, slope b recomputed from the shortened stub
  and iterated to convergence; the CURVE is the exact ABCD of the parts, so the narrow-band
  formulas' limits show (warned > 10 %). `cavityLine(z0, Q, f)` = air line whose loss gives
  exactly that unloaded Q (test: shorted λ/4 Rp = Z0·4Q/π). MEASURED: Butterworth n3 145 ± 1
  MHz lossless edges -3.07/-2.94 dB; Chebyshev 0.1 dB edges -0.10; the same on LMR-400 stubs
  -3.5 dB mid-band (RG-213 -3.4), on Q 1500 cavities -0.8 - the page warns coax is not high-Q
  enough. Open λ/4 notch at 145: RG-58 -39.8, RG-213 -47.1 dB, but 1 MHz off still ~-32 dB:
  a plain stub is BROAD, said in the guide (not for repeater splits). RG-213's VF is
  1/√2.25 = 0.667 from the catalogue's dielectric, not 0.66 - the smoke's 345 mm says so.
  Interdigital/comb-line NOT designed (needs coupling charts we don't carry) - guide says so.
- **S21 / port 2** (`src/lib/vna/transmission.ts`, `src/ui/MeasureTransmission.tsx`): both
  drivers gained `sweepTransmission`: classic = `scan a b n 5` (mask 1 freq | 4 S21), old
  firmware `data 1`; V2 = the same FIFO entries' rev1/fwd0 (the collection loop is shared).
  Two-term response cal S21a = (S21m − iso)/(thru − iso); isolation optional; a V2 will not
  measure before a thru; thru/iso must share frequencies. Overlay: LineChart and XYChart
  series take their own x (`fMHz` / `x`) and draw dashed; XYChart got `floor` (a notch's -∞)
  and round-number ticks for dense traces. `--vna` smoke: the simulated V2's port 2 is raw
  through known leakage + tracking, and the page must read a 145 MHz low-pass at -3.0 dB.
- Not yet: coax traps. (Tuning a coil to resonance and load ratings at a power now live in
  the Antenna Modeler.)

### RF toolbox (`src/tools/toolbox/`)

- Six tabs of pure maths, no solver; state in `emws.toolbox.v1`. Each module is held to
  closed forms in `tests/toolbox.test.ts`: `wavelength.ts` (c/f, electrical length,
  `HALF_WAVE_RULES` - free space 149.9/f, MEASURED 145.5/f for 2 mm wire via Tune, folklore
  142.65/f), `coax.ts`, `attenuator.ts`, `levels.ts`. SWR conversions live in `src/lib/rf.ts`.
- **No cable datasheet is copied.** `CATALOGUE` is nominal MIL-C-17 dimensions + dielectric;
  loss is CALCULATED (skin effect in smooth solid copper + tan δ) and is a FLOOR - a braided,
  stranded cable loses more (RG-213 at 100 MHz computes 4.1 dB/100 m in the conductors; makers
  quote more). The UI says "at least" and offers "From its datasheet": two points fitted
  exactly to k1√f + k2 f. `runLoss()` is the classic (a² − ρ²)/(a(1 − ρ²)): 1 dB matched +
  SWR 3 = 1.504 dB total (a first hand figure of 1.295 was wrong; the test pins the formula).
  Every catalogue entry's geometry must give Z0 within 12 % of nominal (stranded centres read
  low) - that test catches a typo in a dimension. **LMR-195/240/400/600 are listed by name**
  (ZR1JT asked for LMR-400, 2026-10-04): the maker's published nominal dimensions and
  velocity factors (0.83/0.84/0.85/0.87), loss computed like every other entry, never the
  maker's table; `epsilonOf(cable)` = 1/VF² is what Z0 and the dielectric term use, so a cable's
  stated VF and its physics agree. LMR-400's dimensions give 49.5 Ω - the published figures
  are coherent, which is the check that they were remembered right.
- `attenuator.ts`: closed-form Pi/T for any z1→z2; `minimumLossDb` (5.72 dB for 75↔50), at
  which the pad IS the L pad - the Pi drops its HIGH-side shunt, the T its low-side series arm.
  `evaluatePad` analyses the circuit as built, so an E24 pad reports its real dB, match and
  heat (a 10 dB Pi built as 100/68/100 is 9.63 dB). Dissipations + load = power in, by test.
- `levels.ts`: IARU R.1 S-meter (S9 = −73 dBm HF, −93 VHF, 6 dB/unit); −73 dBm is 50.06 µV
  and 50.1 pW. Field strength is √(30P)/d, free-space far field; the page states NO
  regulatory limits, on purpose.
- `link.ts` (2026-10-05): Friis path loss, dish gain η(πD/λ)² with the efficiency TYPED
  (default 0.55, said to be typical not promised), beamwidth ≈ 70λ/D, 4/3-earth horizon
  √(2kRh), kTB from the exact SI Boltzmann constant, and Friis's NF cascade - the
  preamp-at-the-antenna comparison is computed both ways round. GEO altitude 35,786 km is
  a constant; the horizon-slant 41,679 km is DERIVED (`GEO_SLANT_MAX_KM`), not stated. The
  budget's far end is always typed: the page states no satellite's transponder figures and
  no mode's required SNR. Held to identities in `tests/link.test.ts` (path loss 0 dB at
  d = λ/4π, dish 20 dBi at πD/λ=10, −174 dBm/Hz from Boltzmann, two-stage cascade by hand).
- Guide `src/guides/ToolboxGuide.tsx`; `npm run smoke -- --toolbox` drives all six tabs.

### Field sandbox (`src/tools/fdtd/`)

- `simulation.ts` is a 2-D FDTD engine in BOTH polarisations (`makeEngine`): `Simulation`
  = TMz (Ez out of the screen = horizontal over a ground, s-pol, NO Brewster angle) and
  `SimulationTE` = TEz (Hz; Ex at j+½, Ey at i+½ with averaged ε/σ, zeroed beside PEC = vertical,
  p-pol). Both expose `field` (the out-of-screen one). Yee grid, leapfrog, Berenger split-field
  PML (m = 3, R0 = 1e-8, `PML_ORDER`/`PML_REFLECTION`), Courant 0.7, Float32, nothing
  allocated per step. Written from the textbook equations (Yee, Berenger, Taflove); no other
  program's source was read. Point sources are soft (added to both split halves): a Ricker
  pulse or a sine ramped over two periods. The PML's electric loss is scaled by εr (σ/ε =
  σ*/μ), or a ground running into it reflects off it.
- **Plane wave = total-field/scattered-field** (`planeWaveBoundary`), an L along the entry
  side and the side it slants in by, each leg running on out through the PML at its far end;
  analytic free-space incident fields on every link that crosses it, DAMPED inside the PML by
  R^(|cos|(depth/d)^4/2). Links touching anything but empty space stay silent (`planeWaveBuried`
  -> `limits()` warns: a reflection-shadow wedge). Behind the absorbing edges the out-of-screen
  field is MIRRORED (`mirrorWalls`; TM only with a PML - pml 0 stays a PEC box). Every one of
  those was MEASURED wrong first: one line along one side (SWR 8 for 4), soft sources fed half
  and half (40 % lost over 360 cells), a zero wall (same), undamped incident in the PML (±40 %
  ripple at 30°), a soft-source L (±10 % ripple off its corner). Now: flat to ±1.7 %, leakage
  2e-4 square on, PEC −0.996/+0.997, εr 4 ∓1/3 within 0.02, Fresnel within ~0.02 at ≥10 cells
  per wavelength INSIDE the material (5 cells inside = 10 % off: `limits()` warns via
  `shortening()`, the real part of √εc). Measure reflections by DIFFERENCE (with − without the
  ground, max over a period, far along): a vertical SWR line sits in the finite world's
  reflection shadow and read TM 3 where Fresnel says 6.8.
- **The scene is the source of truth** (`scene.ts`, metres, y up; `src/lib/history.ts` is
  the generic undo the modeler's `history.ts` now wraps). `rasterise()` paints shapes into
  per-cell εr/σ/PEC, later shapes over earlier, then copies the world's outermost cells on out
  through the PML (an edge-to-edge ground is endless). Scene has `polarisation` and
  `planeWave` (older stored scenes default to 'tm' / null). Any edit rebuilds the engine from
  t = 0 - say so in UI text ("the scene is the simulation"). The probe (`probe.ts`: ring of
  4096 samples, Hann-windowed DFT DC..3f, dB below its own peak) is NOT in the scene: moving
  it must not restart the clock.
- **The frequency scales the scene** (2026-10-06, ZR1JT saw the picture "lose resolution" at
  a lower frequency: cells are per WAVELENGTH, so a 3 m world at 100 MHz is 20 × 13 cells).
  `withFrequency(scene, f)` multiplies the world, every geometry (incl. line thickness) and
  every source position by f_old/f_new when `scene.scaleWithFrequency` (default true, older
  stored scenes default it), tidied to 6 significant figures; materials untouched - εr is
  scale-free, σ in S/m deliberately is not, and the hint says so. The probe is scaled in the
  tool. Off, `limits()` warns below `SMALL_WORLD_WAVELENGTHS` (2). The frequency field goes
  through `setFrequency`, never `setWorld({ fMHz })`.
- **Many sources, up to six probes** (2026-10-06, ZR1JT asked for n of each). Sources always
  were n (`scene.sources`, each with phase); what was missing was a LIST - `.source-list`,
  numbered as on the canvas (numbers drawn once there are two), click to select, × to remove.
  Probes: `probes: Probe[]` state + `probeRecords: Map<id, ProbeRecord>` reconciled by
  `probeCells` (a new raster restarts every recording; adding/moving one probe touches only
  its own). `MAX_PROBES = 6` = the series colours: `--series-4..6` were ADDED (light
  #4a3aa7/#e87ba4/#eda100, dark #9085e9/#d55181/#c98500) and validated as a set of six with
  the dataviz checker against both surfaces - 5 and 6 are under 3:1 on light, so a probe is
  always numbered (canvas, list, legend), never colour alone. One time chart (every trace,
  own `x`; the longest recording sets the axis), one spectrum chart against `levelsAgainstStrongest`.
  **Earned, twice:** the DFT power is normalised by (Σ window)² (a shorter recording read
  weaker: the test pins A²/4 for a sine at 3000 AND 1500 samples), AND several probes are
  evaluated over the SAME stretch (`probeView(..., limit = shortest count)`) - a wave that
  arrived partway through the older probe's recording averaged −8 dB against a probe added
  after it, with the bigger trace on screen (SEEN in the smoke screenshot).
  Probe tool: click adds, click ON a probe removes, drag moves (`drag.kind === 'probe'`).
  `loadPreset` clears probes. Smoke lesson: typing into a panel field SCROLLS the page, so the
  sandbox smoke re-measures the canvas (scrolled to top) before every mouse gesture.
- **Every control has hover text**: `HINTS` in `FdtdTool.tsx` (one place), `NumberField`'s new
  `hint` prop -> `title` on its label, `title` on every `label.field`/`label.check`, button and
  status card. The `--fdtd` smoke fails on any sandbox label, button or status card without
  one. The polarisation picker is labelled "Polarisation" (was "Out of the screen", which
  ZR1JT could not place); its options stay short, the hint carries the explanation.
- `tests/fdtd.test.ts` holds the engine to physics: pulse peak arrives at d/c (±0.15 ns at
  30 cells/λ), grid wavelength = c/f within 3 %, PEC reflection inverted with the round-trip
  delay, εr = 4 doubles the travel time (±7 %), PML leaves < 1e-4 of the peak energy where a
  PEC box keeps > 0.3, 3000 steps stay finite. Two-dimensional sources spread as 1/√r and
  leave a slow "afterglow" tail - a 2-D fact, not a bug.
- Honest limits the guide states: a cross-section (every object infinitely long into the
  screen), fields relative to a source of 1 (never V/m), numerical dispersion below ~10
  cells/λ (`limits()` warns), no currents/impedances/patterns. Painting: diverging
  series-2 blue ↔ surface ↔ series-3 orange for Ez, one-hue green for the envelope (recent
  peak, decay 0.998/step), conductors in ink, dielectrics tinted. React state updaters run
  LATER: compute a rate before resetting its counters, not inside `setStatus`.
- Presets `mast`, `brewster` (TE, εr 4 at atan 2 = 63.4°) and `ground-40m` (7.1 MHz, εr 13,
  5 mS/m, 70°, 40 cells/λ so the ground has 10): tests hold Brewster (TE < 0.04, TM within 0.03
  of 0.60) and average ground (both within 0.05 of Fresnel at 0° and 77°; pseudo-Brewster 76.7°
  from vertical = 13.3° elevation, |Γ| 0.186).
- `npm run smoke -- --fdtd` checks every control has hover text, types 100 MHz and sees the
  same 200 × 133 cells in a 30 × 20 m world (then 10 MHz with scaling off: 20 × 13 cells and
  the warning; Ctrl+Z ×3 restores - after BLURRING the field, or the box's own undo takes it),
  plays a scene, checks both signs are painted and the wall is
  ink, draws a sheet with real mouse input, undoes it with Ctrl+Z, buries a source and reads
  the warning; then Brewster in Hz (peak < 1.25 after 15 ns), the probe (spectrum peak at
  1000 MHz, moving it keeps the clock), Ez over the same ground (peak > 1.3), and the 40 m
  ground with no resolution warning. `--screenshot x.png` saves x-brewster-hz/-ez/-ground-40m.
  Guide: `src/guides/FieldSandboxGuide.tsx`.

### Community store (`public/community/index.php`, `src/lib/community.ts`)

- **Optional by construction, like the solver proxy**: PHP + FastCGI env vars
  (`EMWS_DB_DSN`/`EMWS_DB_USER`/`EMWS_DB_PASS`, set by `enable-php-proxy.ps1 -DbDsn ...`
  on the SAME registration as the solver's). No DSN → 503 → `probeCommunity()` returns
  undefined → `CommunityPanel` renders NOTHING. The footer's promise depends on this:
  "nothing leaves it unless you sign in and share".
- **The licence line is the point**: shared items are user measurements, and the store
  refuses `public` without `cc0` server-side; the UI's Share button always goes through
  the dedication step first. Never weaken either half.
- Accounts are callsign + password_hash, plus an OPTIONAL email used only for reset codes
  (`EMWS_MAIL_*`; `mail.php` is a hand-written ~100-line SMTP client with STARTTLS/AUTH
  LOGIN, because PHPMailer and friends are LGPL and stay out). No email = no reset, said in
  the UI. Reset: 8 chars from a no-lookalike alphabet, hashed, 15 min, 5 guesses burn it,
  one request a minute, and reset-request answers identically whether the account exists.
  Login throttle 5 tries / 15 min. CSRF = SameSite=Strict cookie AND a required `X-EMWS`
  header on POSTs. Payloads capped at 1 MB, kinds whitelisted (`core-profile` today; saved
  baluns would be a new kind, not a new table).
- **Zero-hand schema**: EMWS_DB_PORT is appended to a portless mysql DSN; an "Unknown
  database" on connect makes the store CREATE DATABASE and reconnect (needs the grant);
  tables are CREATE IF NOT EXISTS and later columns are ensured by probe-and-ALTER, so an
  empty or older database heals on first contact. The MySQL-only branch (database
  creation) is the one piece not covered by the SQLite tests - it runs first on a real site.
- Payload = the owning tool's own export format, so import IS the file-import path
  (validation, fresh ids, sweep-is-truth re-derivation). Imported cores are renamed
  "<name> — <callsign>".
- **Club library** (2026-10-05): KINDS = core-profile, balun-design, antenna-model (same
  table, same CC0 rule, client `CommunityKind` must match). `src/ui/CommunityPanel.tsx` is
  generic: one account UI, then SHELVES ({kind, local items with payload(), takeLabel,
  onTake}); the old balun-only panel is gone. balun-design = `{emws:'balun-design', balun,
  core?}` (library.ts) - a design on a measured core CARRIES the core; import re-points
  profileId/materialId at the freshly imported core. antenna-model = the NEC deck in a JSON
  envelope (`shared-model.ts`, + z0) because the server requires JSON payloads - keep that
  invariant; taking one is `loadDeck`. The --community smoke walks all three shelves and
  now names the exact run's callsign (a reused DB once made "by SMOKE-A" match two runs).
- **Portability trap, earned**: PDO binds integers as strings, and SQLite says '1' = 1 is
  FALSE where MySQL coerces - a CASE on a bound parameter silently never fired. Plain
  UPDATEs, no cleverness in SQL.
- `tests/community.test.ts` runs the real PHP over HTTP against SQLite (php -S spawned;
  v8.4 needs `-d extension=pdo_sqlite`; suite skips loudly with no usable PHP), including
  the whole reset flow against a fake SMTP server in Node (which does NOT offer STARTTLS,
  so the TLS branch only runs against real mail servers). The same PDO code runs MySQL in
  production. `npm run smoke -- --community` needs dist served by
  `php -S` with a DSN and walks two visitors end to end; `--balun` (static preview)
  asserts the section does NOT exist.

### NanoVNA over Web Serial (`src/lib/vna/`, `src/ui/MeasureWithVna.tsx`)

- **Written from the published protocols only.** The NanoVNA firmware, nanovna-saver and the
  V2 desktop apps are all GPL: never read their source for this, let alone copy it. Classic
  NanoVNA = text shell (`scan start stop pts 3`, older firmware `sweep` + `frequencies` +
  `data 0`, prompt `ch> `); NanoVNA-V2 / SAA-2 = binary registers (op 0x0d INDICATE answers
  `'2'`, WRITE/WRITE2/WRITE8, FIFO at 0x30 in 32-byte entries). `identify(link)` sends one
  `\r` and tells them apart by the reply; if nothing answers it sends ten NOPs (a V2 left
  mid-command by another program is deaf until the command is finished) and asks once more.
- **V2 details that were got wrong once:** READFIFO's third byte is a count of *entries*
  (up to 255), not bytes - the first driver asked for 224 entries and read 7. The instrument
  sweeps continuously, so after a FIFO clear the first entry out is whatever point it had
  reached: collect by index until every point is in. Replies can arrive in pieces, so bytes
  left over from one read are stitched onto the next or the 32-byte frame slips. The test
  fake and the smoke simulator both do all three, deliberately. ZR1JT's own instrument is a
  **NanoVNA V2_2, firmware git-20200501-47b2b83** (GD32F303).
- **Calibration is not the same on the two families.** The classic instrument applies its
  own calibration and sends corrected data; the V2 sends raw readings, so `calibration.ts`
  does one-port SOL (three-term error model) and `MeasureWithVna` refuses to measure on a V2
  until short, open and load have been taken for the current range. Nothing leaves the
  component uncalibrated. **The three standards must share their frequencies**, not just
  their length - the terms are solved point by point, and equal-length sweeps over
  different ranges once combined into a "calibration" that meant nothing. `solveTerms`
  refuses them, and `MeasureWithVna` clears collected ticks when the range changes and
  drops any prior standard whose frequencies do not match a fresh sweep.
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
  injects a simulated NanoVNA-H *and* a simulated V2 into the page
  (`Page.addScriptToEvaluateOnNewDocument`, after `Page.enable`; the fake ports hand out fresh
  streams on every `open()`, as real ones do; `window.__emwsVnaPick` chooses the port and
  `window.__emwsVnaAttach` what is on the V2's connector). The V2 sends raw readings through
  known error terms, so the check that it reads the same 75 Ω as the H is a check that the SOL
  calibration works. A hash navigation is not a new document: reset the pick between tools.
- **Validated on the real instrument 2026-10-05**: ZR1JT's V2_2 measured a #31 toroid at
  1/2/3 turns, 1-60 MHz, 1000 points (exports in `D:\Code\Sample Data\mix31`). N² scaling
  within ~4 %, the three windings agree on μ′/μ″ within ~5 %, zero negative resistances in
  3000 SOL-corrected points, self-resonance falls with turns. So driver + calibration work
  on real hardware; what remains unproven is only what hasn't been tried (the classic-H
  family on a real unit, S21, other firmware).

### VNA bridge: a FieldFox on the LAN (`services/emws-vna-bridge/`, `src/lib/vna/bridge.ts`)

- 2026-10-06, for ZR1JT's Keysight N9912A (LAN; their other VNA is HPIB). A page cannot
  open a TCP socket, so `bridge.mjs` (plain Node, no deps, IN the repo - `.gitignore` now
  ignores only `/services/emws-solver/`) speaks SCPI to the instrument and answers HTTP on
  127.0.0.1:8075: `GET /health` (service 'emws-vna-bridge', kinds ['vna'], instruments with
  *IDN?/*OPT?/INST:CAT?) and `POST /sweep` → `{ frequenciesHz, real, imag, corrected,
  method }`. Optional by construction, like the solver. `npm run vna-bridge -- --fieldfox
  <host[:port]>`; `--simulate` runs `fake-fieldfox.mjs`. Protocol + command list:
  `docs/vna-bridge.md`.
- **Commands are from Keysight's FieldFox programming guide, NA mode** (fetched 2026-10-06):
  `INST?` then `INST "NA";*OPC?` ONLY if not already NA (switching resets the mode,
  calibration included); `CALC:PAR1:DEF S11|S21`; `SENS:FREQ:STAR/STOP`, `SENS:SWE:POIN`,
  `SENS:BWID`; `FORM ASC,0`; `INIT:CONT 0`, `INIT:IMM;*OPC?` (the guide: always single
  sweep when programming); `SENS:FREQ:DATA?`; `CALC:DATA:SDATA?` = real,imag pairs,
  corrected when correction is on; `SENS:CORR:USER?`; `SYST:ERR?` after each stage;
  `INIT:CONT` restored. `INST:CAT?` answers `"CAT","NA","SA"` - each quoted (a first parse
  took `CAT"`). Binary blocks are NOT used (plain ASCII; port 5024 forbids them anyway).
- Page side: `BridgeInstrument` implements `Instrument` (kind 'bridge', `maxPoints` 10001 -
  `maxPoints` is now on every Instrument; NanoVNA 401, V2 1024). Its readings are the
  instrument's own correction: NO SOL/thru on the page, and `lastCorrection` lets
  `MeasureWithVna` say when the instrument reports correction OFF. `src/ui/VnaSources.tsx`
  is the shared chooser both measuring panels start from (NanoVNA button if Web Serial,
  plus one button per bridge instrument, plus the "bridge found / not found at" line with
  an editable address in `emws.vna.bridge.v1`). It looks for the bridge ONCE per page load
  (module memo, 30 s): every look at an empty address is a refused connection in the
  console, and the smoke `excuseOptionalProbes()` removes exactly those from its problems
  (the pattern the --pwa test uses for the community probe).
- `tests/vna-bridge.test.ts` runs the real bridge against the fake over real sockets/HTTP
  (75 Ω + 0.5 µH to 4 places; S21 of the 145 MHz low-pass; the command sequence and the
  no-switch-when-already-NA rule; error queue, dead instrument, unknown id; queued sweeps).
  `--vna` smoke spawns `bridge.mjs --simulate`, points the page at it, and measures the
  Smith load (same 75 Ω as the NanoVNAs) and the LC filter's S21 through it.
- **First real FieldFox, 2026-10-07** (a tester's N9914A, firmware A.07.75, options
  210/010/310/235/233/211, modes CPM/SA/NA/CAT; report in `D:\Code\Sample Data\VNA_Report.txt`):
  found and identified; run 1 died at `CALC:PAR1:DEF` with `-113,"Undefined
  header;CALC:PAR1:DEF<Err>"`; run 2 (with `--log`, `D:\Code\Sample Data\VNA.txt`) showed
  `INST?` = "NA" and BOTH `CALC:PAR1:DEF` and `CALC:PAR:DEF` refused alike. The command is
  NOT new: Keysight's A.08.15/A.09.15 guide (fetched with `curl -k`, read by inflating the
  PDF's streams - `scratchpad/pdfgrep.mjs`; no PDF renderer here) gives `CALC:PAR1:DEF S11`
  on a 2012-dated page. What differed: the refused commands were argument-carrying WRITES
  sent four to a burst; every success was a lone awaited query. So now: EVERY command
  travels as `cmd;SYST:ERR?` in its own message (`set()`/`ask()`, `splitReply()` parses
  `value;code,"text"`; an unknown query answers only the error instead of silence);
  `PARAMETER_FORMS` tries short numbered, short plain, long numbered, long plain and
  remembers the index; a refused SEL is logged, not fatal; correction-state queries can fail
  without losing the sweep (`corrected: undefined` -> the page says nothing). `enterNaMode`
  re-asks `INST?` until NA. Run 3 (`VNA_Error.txt`): ALL FOUR spellings refused, one message
  each, in NA mode - the burst theory died too; that firmware has no `CALC…:DEF`. So
  `defineParameter` returns `{ set: false }` instead of throwing (`parameterForm = 'none'`,
  reset on a mode switch), the sweep reads the trace SHOWN, the result carries
  `parameterSet`/`parameterNote`, `BridgeInstrument.lastParameterNote` and both measuring
  panels show an orange note (select S11/S21 on the front panel). `--probe` asks ~60 harmless
  queries (incl. `SYST:HELP:HEAD?`, which some Keysight firmware answers with its whole
  command tree) and writes `probe-<id>-<date>.txt` - INSTALL.md step 6. Compound messages
  use `;:SYST:ERR?` with the leading colon (root path). Run 4 (`VNA_Error5.txt`): STAR/STOP/
  POIN/FORM accepted; `INIT:CONT?` -> `-113,"Undefined header;INIT<Err>"` - the `<Err>`
  marker is POSITIONAL (after the first unknown node): no INITiate subsystem on A.07.75, and
  `CALC:PAR1` exists but `DEF` does not. So trigger control is optional (`waitForSweeps`:
  `SENS:SWE:MTIM?`/`TIME?` ×2 + 0.5 s, else 1 s guessed, 60 s cap), `readFrequencies` falls
  back to a linear layout, `readTrace` tries `TRACE_QUERIES` (five spellings) then points at
  `--probe`. The fake's `legacy` mode refuses every define spelling AND all of INIT, answers
  `SENS:SWE:MTIM?` 0.15. **Run 5 MEASURED** (screenshot only, no log): 101 points on the
  Smith chart - the first real FieldFox sweep in EMWS. Its page said "correction OFF" because
  the bridge asked only `SENS:CORR:USER?`; a FieldFox with no user cal is CalReady-corrected
  (factory cal at the port), so now `SENS:CORR?` decides corrected, USER decides the method
  ('CalReady' when off), and the page explains CalReady vs a cal at the cable's end. The
  tester's SITE was an older build (no orange S11 note shown): deploy before the next round.
  **Run 6 (`VNA_Error6.txt`, log + probe):** FREQ:DATA?/SDATA? answer (also CALC:SEL:/CALC1:),
  SWE:TIME? = 0 (auto), no MTIM, no INIT/TRIG/ABOR/SWE:MODE in any spelling, no CORR queries
  but IMP? (50), STAT:OPER:COND? 0. The trace was IDENTICAL to 7 figures in every read ->
  the unit is on Hold and cannot be triggered from this firmware: the no-trigger path now
  reads twice a sweep apart and adds a note when nothing moved (`notes[]` in the reply,
  `BridgeInstrument.lastNotes`, shown by both panels in the bridge's own words; the
  hard-coded S11 wording is gone). `SYST:HELP:HEAD?` ANSWERS with a 10,121-byte definite
  block (`#510121…`) - the bridge had read only its header; `ScpiSocket.query(cmd, ms,
  { block: true })` reads IEEE 488.2 blocks whole and the probe prints every header. The
  fake has `hold` (frozen trace), last-digit noise otherwise, and a block answer.
  **Run 7 (`VNA_Error7.txt`): the measurement is RIGHT** (calibrated 50 Ω load, |S11| ≈
  0.003, FieldFox screen 49.9 − j0) and the 325-header list came. A.07.75 NA mode has NO
  CALC:PAR, NO INIT/TRIG/ABOR, NO CORR state (only EXT/IMP/MED/RVEL/WGC), no MTIM; it has
  CALC[:SEL]:DATA:SDAT/FDAT, FREQ:DATA?, SWE:POIN/TIME, DISP:WIND:SPL, MMEM:STOR:SNP,
  STAT:OPER:COND?, *OPC/*WAI. So the bridge LEARNS THE VOCABULARY first (`learnVocabulary`
  -> `parseHeaders` Set; `knows()`/`has()` via `normaliseHeader` + `shortForm`, SCPI's
  first-four-drop-vowel rule, both forms of `[optional]` nodes, suffix digits stripped) and
  skips what the list lacks: no refusals in the log, `notes` are `{ level: 'info' |
  'warning', text }` (info = how this firmware is, shown muted; warning = red), the
  "no command for choosing the measurement" note is info. The fake's legacy list is the real
  shape (`LEGACY_HEADERS`), `CURRENT_HEADERS` adds PAR/INIT/CORR/MTIM. **Run 8
  (`VNA_ReadData.txt`): VALIDATED** - three loads read as the instrument's screen shows
  them: 50 Ω (|S11| 0.014), open (0.955), series 29 − j100 Ω (EMWS 29.63 − j102.0 at
  145 MHz); clean log, list fetched once per process, grey note on the page (the site was
  deployed). Bridge VERSION 1.1.0. The current-firmware path (PAR/INIT/CORR) has still met
  only the fake. CAT-only units stay unsupported.

## Conventions

- TypeScript strict + `noUncheckedIndexedAccess`. British spelling in prose ("licence", "colour").
- No new runtime dependencies without a good reason; plots are hand-written SVG.
- `public/web.config`: every `<add>`/`<mimeMap>` is preceded by a `<remove>` (IIS 500s on duplicates).
- NEC angles: theta from +Z (zenith), phi from +X. Elevation = 90 - |theta|.
- **One band list**: `src/lib/bands.ts` (IARU Region 1 edges + a standing frequency each,
  160 m through 3 cm - ZR1JT's club talks 2 m / 70 cm / 23 cm / QO-100 as much as HF). Tools
  take a slice: modeler picker `bandsUpTo(1300)`, coil/filter `bandsUpTo(450)`, balun and
  toolbox all of it. Never add a second list; `tests/bands.test.ts` checks the slices.
