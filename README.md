# EMWS: Electro Magnetic Works Suite

A public-domain electromagnetics workbench for radio amateurs and experimenters.
Simulate your antenna and RF experiments before you cut wire, in the ham spirit: free
for anyone to use, copy, re-host and change.

EMWS is a **static web application**. The server only hands out files; every
calculation runs in the visitor's own browser. No accounts, no uploads, no server load,
and nothing to abuse. Started by **ZR1JT**.

## What works today

**Antenna Modeler**: wire antennas by the method of moments, on the real NEC2 engine.

- Runs standard NEC2 card decks (`.nec`): open your existing models, save them back.
- Feed impedance, SWR and return loss against any reference impedance.
- Peak gain, front-to-back ratio, efficiency.
- Azimuth and elevation patterns on the ARRL log scale.
- Rotatable 3-D wire view, coloured by current magnitude.
- Frequency sweeps with an SWR curve; click a point to inspect that frequency.
- Free space, perfect ground, and real (Sommerfeld-Norton) ground.
- Solves in a Web Worker, so the page never freezes. A 3-element Yagi solves in well
  under a tenth of a second.

The engine is [nec2c](engines/nec2c/PROVENANCE.md), the public-domain C translation of
NEC2 by 5B4AZ, compiled unmodified to WebAssembly. Its results are checked against
antenna theory by the test suite: a resonant half-wave dipole comes out at 72 Ω and
2.14 dBi, a quarter-wave vertical over perfect ground at 37.6 Ω and 5.16 dBi.

**Planned**: Smith chart and matching networks · RF toolbox (wire lengths, coax loss,
LC, coils, L and Pi networks) · a 2-D FDTD field sandbox · a wire-table editor, so
nobody has to learn card decks.

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
| `npm run smoke` | Opens the built site in headless Edge/Chrome and checks that it solves a model |
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
 NEC2 card deck (text)
        │
        ▼
 src/engine/nec2/client.ts ──postMessage──▶ nec2.worker.ts          (Web Worker)
                                                 │
                                   run.ts: fresh nec2c.wasm instance per run;
                                   deck in, report out, via an in-memory filesystem
                                                 │
                                   parse-output.ts: text report ─▶ typed Nec2Report
        ┌────────────────────────────────────────┘
        ▼
 src/tools/antenna-modeler/  +  src/ui/ (PolarPlot, WireView, SweepChart)
```

```
engines/nec2c/upstream/   nec2c 1.3.1, byte-for-byte as published. Never edited.
engines/nec2c/            PROVENANCE.md (licence evidence, hashes), build shim
src/engine/nec2/          the engine's TypeScript API, and the committed .wasm
src/lib/                  RF maths shared by all tools
src/tools/                one folder per tool
src/ui/                   shared plotting components
examples/                 example antenna models (.nec)
tests/                    engine, parser and maths tests
scripts/                  engine build, IIS deploy, browser smoke test
public/web.config         IIS configuration, copied into dist/
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
