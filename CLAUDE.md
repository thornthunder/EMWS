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
  purpose. `npm run smoke -- --lc` drives all three tabs and checks the numbers.
- Not yet: band-pass filters, coax traps. (Tuning a coil to resonance and load ratings at a
  power now live in the Antenna Modeler.)

### RF toolbox (`src/tools/toolbox/`)

- Five tabs of pure maths, no solver; state in `emws.toolbox.v1`. Each module is held to
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
- Guide `src/guides/ToolboxGuide.tsx`; `npm run smoke -- --toolbox` drives all five tabs.

### Field sandbox (`src/tools/fdtd/`)

- `simulation.ts` is a 2-D FDTD engine, TMz (Ez out of the screen), Yee grid, leapfrog,
  Berenger split-field PML (polynomial grading m = 3, R0 = 1e-8), Courant 0.7 (< 1/√2),
  Float32 arrays, nothing allocated per step. Written from the textbook equations (Yee,
  Berenger, Taflove); no other program's source was read. Sources are soft (added to both
  split halves): a Ricker pulse (zero mean) or a sine ramped over two periods.
- **The scene is the source of truth** (`scene.ts`, metres, y up; `src/lib/history.ts` is
  the generic undo the modeler's `history.ts` now wraps). `rasterise()` paints shapes into
  per-cell εr/σ/PEC, later shapes over earlier; the PML sits OUTSIDE the drawn world. Any
  edit rebuilds the engine from t = 0 - say so in UI text ("the scene is the simulation").
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
- `npm run smoke -- --fdtd` plays a scene, checks both signs are painted and the wall is
  ink, draws a sheet with real mouse input, undoes it with Ctrl+Z, buries a source and reads
  the warning. Guide: `src/guides/FieldSandboxGuide.tsx`.

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
  **No real instrument has been connected yet**; say so.

## Conventions

- TypeScript strict + `noUncheckedIndexedAccess`. British spelling in prose ("licence", "colour").
- No new runtime dependencies without a good reason; plots are hand-written SVG.
- `public/web.config`: every `<add>`/`<mimeMap>` is preceded by a `<remove>` (IIS 500s on duplicates).
- NEC angles: theta from +Z (zenith), phi from +X. Elevation = 90 - |theta|.
- **One band list**: `src/lib/bands.ts` (IARU Region 1 edges + a standing frequency each,
  160 m through 3 cm - ZR1JT's club talks 2 m / 70 cm / 23 cm / QO-100 as much as HF). Tools
  take a slice: modeler picker `bandsUpTo(1300)`, coil/filter `bandsUpTo(450)`, balun and
  toolbox all of it. Never add a second list; `tests/bands.test.ts` checks the slices.
