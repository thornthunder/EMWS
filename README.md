# EMWS: Electro Magnetic Works Suite

A public-domain electromagnetics workbench for radio amateurs and experimenters.
Simulate your antenna and RF experiments before you cut wire, in the ham spirit: free
for anyone to use, copy, re-host and change.

EMWS is a **static web application**. The server only hands out files; every
calculation runs in the visitor's own browser. No accounts, no uploads, no server load,
and nothing to abuse. Started by **ZR1JT**.

## What works today

**Antenna Modeler**: wire antennas by the method of moments, on the real NEC2 engine.

- **Build antennas by drawing them.** Front, left and top views in first-angle
  projection (the ISO/SANS drawing layout), plus a rotatable 3-D view, all sharing one
  scale so they line up like an engineering drawing. Drag wire ends or whole wires;
  joined wires stay joined. Draw new wires with a click at each end. Right-click a wire
  to feed it, split it, duplicate it or delete it; drag a feed point along its wire.
  Snap to the grid and to other wire ends. Undo and redo everything.
- **Or type them in.** Frequency (single, sweep, or one click for any amateur band),
  ground, and every wire's ends, diameter and segments are plain form fields.
- **Re-solves as you edit**, and checks the design against NEC-2's rules as you go:
  segments too long, wires too fat, ends that almost meet, wires that cross, wires
  below ground, all explained in terms of the drawing.
- Reads and writes standard NEC-2 card decks (`.nec`). Decks the visual editor can't
  represent yet (arcs, helices, GM copies, ...) still run, exactly as written.
- Feed impedance, SWR and return loss against any reference impedance; several feeds
  for phased arrays.
- Peak gain, front-to-back ratio, efficiency. Azimuth and elevation patterns on the
  ARRL log scale, cut automatically through the main lobe of the whole-sphere pattern.
- Frequency sweeps with an SWR curve; click a point to inspect that frequency. A sweep is
  shared across your processor's cores - measured 6.2 s down to 2.2 s on a four-core
  laptop - and counts the frequencies off as they come in.
- Free space, perfect ground, and real (Sommerfeld-Norton) ground.
- Solves in a Web Worker, so the page never freezes. A 3-element Yagi solves in well
  under a tenth of a second.
- **Or solve somewhere else.** Big models can go to a solver service instead: one you run
  yourself on `127.0.0.1`, or one the site itself provides. The choice is remembered per
  browser, the service says what engine and precision it is, and if it stops answering
  the run falls back to your browser rather than failing. The protocol tags every job
  with its kind, so the same service can take other EMWS work later. See
  [docs/solver-service.md](docs/solver-service.md).

**Smith chart and matching**: design the network between the radio and the antenna.

- Build the chain component by component - series and shunt L, C and R, coax lines,
  open and shorted stubs, transformers - and watch each one draw its arc on the chart.
- Sliders work in ohms of reactance, which is what decides how far round the circle a
  component moves you. Give an L or C a Q and it gets the loss a real part has.
- **Match it for me**: every two-component L network that brings the load to your system
  impedance, with real component values and the bandwidth each one holds.
- Loads come from typed R + jX, from a NanoVNA `.s1p` file, or straight from the Antenna
  Modeler: model an antenna, then match it without retyping a thing.
- SWR across the band, the impedance after each step, and how much power a mismatch
  turns back.

**Baluns and ununs**: choose a ferrite core, wind it, and see what it does.

- Wind it the way you would describe it - *two turns, tap, five more, cross over, seven
  more* - by dragging the wire round the core on the design pad, or as a list of steps.
  Drop a core from the list to change it; drop the same one again to stack it.
- Tapped transformers (the 49:1 and 9:1 ununs), 1:1 current baluns and 1:4 Guanellas, on
  one engine. It refuses the one design that cannot work - a 1:4 Guanella on a single core
  into an earthed load - and says why.
- Match, loss, **watts of heat in the core**, temperature rise, flux density and choking
  impedance, band by band from 160 m to 10 m. Compare the same winding on two mixes.
- What a core is worth is *calculated* from its dimensions, not looked up. The ferrite's
  behaviour with frequency is an honest estimate from Snoek's law - no manufacturer's
  curves are copied - and **a NanoVNA sweep of your own core replaces it**. Measured cores
  are kept as profiles in the browser, sit in the core bin beside the catalogue ones, can be
  corrected after the fact (the sweep is what is stored, the curve is re-derived), and
  export to a small JSON file to back up, move or share.
- Takes its load from the Antenna Modeler, and passes what the radio sees on to the Smith
  chart.

**Field Guides**: a guide per tool at `#/guides`, written for radio amateurs - what the
readings mean, worked examples, and the honest limits.

The engine is [nec2c](engines/nec2c/PROVENANCE.md), the public-domain C translation of
NEC2 by 5B4AZ, compiled unmodified to WebAssembly. Its results are checked against
antenna theory by the test suite: a resonant half-wave dipole comes out at 72 Ω and
2.14 dBi, a quarter-wave vertical over perfect ground at 37.6 Ω and 5.16 dBi.

**Planned**: Ruthroff transformers and measured ferrite data in the balun tool · RF toolbox (wire lengths, coax loss, LC, coils, L and Pi networks) · a 2-D
FDTD field sandbox · loads and wire materials in the antenna editor · Pi and T networks
and a tuning optimiser in the Smith chart.

## Quick start

Needs [Node.js](https://nodejs.org/) 20 or newer. Nothing else: the WebAssembly engine
is committed to the repository, ready built.

```sh
npm install
npm run dev        # http://localhost:5173
```

| Command | What it does |
|---|---|
| `npm run dev` | Development server with hot reload |
| `npm test` | Runs real antenna models through the real engine and checks the physics |
| `npm run build` | Type-checks, then writes the deployable site to `dist/` |
| `npm run preview` | Serves `dist/` locally, exactly as built |
| `npm run smoke` | Opens the built site in headless Edge/Chrome and checks that it solves a model. `-- --edit` drives the antenna editor with real mouse and keyboard input; `-- --smith` builds a matching network; `-- --balun` winds a transformer by dragging the wire round the core; `-- --solver` sends the model to the site's own solver and checks it comes back the same (add `--solver-url http://127.0.0.1:8073` to test a service on this machine too); `-- --page "#/guides"` checks any other page |
| `npm run build:engine` | Recompiles nec2c to WebAssembly ([needs Emscripten](docs/building-the-engine.md)) |

## Hosting it

`npm run build`, then copy `dist/` to any static web host. It uses relative URLs and
hash routing, so it works at a domain root or in any sub-folder with no rewrite rules.

For **IIS**, `dist/` already contains a `web.config` (WebAssembly MIME type, caching,
security headers), and there is a deploy script:

```powershell
.\scripts\deploy-iis.ps1 -SitePath C:\inetpub\wwwroot\emws
node scripts/smoke-browser.mjs https://your-server/emws/    # check the live site
```

See [docs/deploy-iis.md](docs/deploy-iis.md).

## How it fits together

```
 views and forms ──edits──▶ AntennaModel ◀──deck.ts──▶ NEC-2 card deck (.nec)
 (editor/, ModelPanel)      (model.ts: pure edits,           │
                             history.ts: undo/redo,          │  planRuns(): a sweep with an
                             validate.ts: design checks)     │  automatic pattern is a quick
                                                             ▼  sweep + one far-field run
 src/engine/nec2/solver.ts ── the user's choice of where to solve ──┐
        │                                                          │
        │ "this browser"                      "a solver elsewhere"  │
        ▼                                                          ▼
 client.ts ──postMessage──▶ nec2.worker.ts   POST {kind, deck} ──▶ solver service
                                 │               (site proxy: public/solver/index.php)
               run.ts: fresh nec2c.wasm instance per run;          │
               deck in, report out, via an in-memory filesystem    │
                                 │        nec2c's report text ◀────┘
                                 ▼
                                   parse-output.ts: text report ─▶ typed Nec2Report
        ┌────────────────────────────────────────┘
        ▼
 results: src/ui/ (PolarPlot, SweepChart), currents coloured onto the four views
```

Whoever solves it, only nec2c's own report comes back and `parse-output.ts` reads it
here, so a remote solver cannot change how a result is interpreted.

```
engines/nec2c/upstream/   nec2c 1.3.1, byte-for-byte as published. Never edited.
engines/nec2c/            PROVENANCE.md (licence evidence, hashes), build shim
src/engine/nec2/          the engine's TypeScript API, card-deck lexer, and the two
                          committed .wasm builds (plain and SIMD, chosen at runtime)
src/lib/                  RF and vector maths shared by all tools
src/tools/                one folder per tool
src/tools/antenna-modeler/editor/   the four views, projection maths, context menu
src/tools/smith-chart/    network maths, the matcher, the chart
src/tools/balun/          transformer engine, winding recipe, design pad, core and wire lists
src/lib/ferrite.ts        toroid geometry and complex permeability
src/guides/               one Field Guide per tool (keep them in step with the tools)
src/ui/                   shared plotting components
examples/                 example antenna models (.nec)
tests/                    engine, parser and maths tests
scripts/                  engine build, IIS deploy, browser smoke test
public/web.config         IIS configuration, copied into dist/
public/solver/index.php   optional proxy to a NEC service (docs/solver-service.md)
```

## Know the limits

A model is only as good as its assumptions. NEC2 wants wires of a single diameter,
segments short against the wavelength but long against the wire radius, and horizontal
wires kept well clear of the ground; it cannot model buried radials. "Efficiency" counts
conductor loss only, not ground loss. Treat results as a guide to build and measure by.

## Contributing

Contributions are welcome, from hams especially. By contributing you agree to dedicate
your contribution to the public domain under the same terms as the rest of the project.
Two rules keep EMWS public domain:

1. **No copyleft code.** Do not copy from GPL projects (xnec2c, nec2++, 4nec2's
   helpers, AntennaSim, ...), however tempting. Ideas and published algorithms are
   fine; their source text is not.
2. **New third-party code needs a provenance record** like
   [engines/nec2c/PROVENANCE.md](engines/nec2c/PROVENANCE.md).

Before sending a change: `npm test && npm run build`.

## Licence

EMWS is dedicated to the **public domain**.

- Source code: [The Unlicense](LICENSE).
- Documentation, example antenna models and other data: [CC0 1.0](LICENSE-CC0).

Use it, copy it, host it, sell it, change it. No permission or credit is required, and
there is no warranty of any kind.

Third-party material, and why it is compatible:

- **NEC2** (Burke and Poggio, Lawrence Livermore National Laboratory): a work of the
  US government, in the public domain.
- **nec2c** (Neoklis Kyriazis, 5B4AZ): placed in the public domain by its author. The
  evidence, including why the GPL text found in its archive does not apply, is in
  [engines/nec2c/PROVENANCE.md](engines/nec2c/PROVENANCE.md).
- **Build-time and runtime libraries** (React, Vite, and Emscripten's runtime and C
  library inside the compiled engine) are MIT-licensed. They are not part of this
  repository's source, but their code is included in the built site, so their copyright
  notices must stay with any copy of `dist/` you distribute. That is the only
  obligation, and it does not affect your freedom to do as you like with EMWS itself.

## Credits

Built by ZR1JT. Standing on the shoulders of G. J. Burke and A. J. Poggio (NEC2),
Neoklis Kyriazis 5B4AZ (nec2c), and L. B. Cebik W4RNL, whose
[antenna modelling notes](https://antenna2.github.io/cebik/content/model/nec.html)
pointed the way. 73.
