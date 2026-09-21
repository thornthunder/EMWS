# Solving somewhere other than the browser

EMWS solves models in your browser by default, on the same nec2c engine compiled to
WebAssembly. That needs no server, works offline, and is fast enough for almost any
antenna a radio amateur will draw.

It stops being enough when a model gets big. NEC-2 fills a matrix of how every segment
affects every other one and then factorises it, so the work grows with the **cube** of
the segment count — and a sweep pays that for every frequency. A 2000-segment model
swept across thirty frequencies takes minutes on a laptop.

So the Antenna Modeler lets you send the work elsewhere. The *Solve with* box offers:

| Choice | Where the model goes |
|---|---|
| **This browser** | Nowhere. The default. |
| **This site's solver** | To the web server, which forwards it to a NEC service the site operator has configured. The browser never learns that service's address. |
| **A solver on this machine** | Straight to a service you are running yourself, at `http://localhost:<port>` or `http://127.0.0.1:<port>`. |

Only `localhost`, `127.0.0.1` and `[::1]` may be typed in by hand. That is deliberate:
a free-form address would let a page be talked into posting someone's antenna to a
stranger's machine, and a browser's own security policy would block most of them
anyway. Anything further afield goes through the site proxy, which is configured by
whoever runs the server and not by the page.

Whatever solves the model, **only nec2c's report text comes back**. EMWS parses it on
the client, exactly as it parses a local run, so a remote solver cannot change how a
result is interpreted — only how quickly it arrives.

## The protocol

Three endpoints, JSON in and JSON out. Anything that speaks it can serve EMWS.

```
GET  <base>/health
  -> 200 { service?, version?, host?, workers?,
           engines: [{ kind, engine, version, build?, precision? }],
           unavailable?: [{ kind, reason }] }

POST <base>/solve         { kind: "nec2", deck: "<NEC card deck>" }
  -> 200 { output, exitCode, trap?, stderr?, elapsedMs? }

POST <base>/solve-batch   { jobs: [{ kind, ... }, ...] }
  -> 200 { results: [{ output, exitCode, ... }, ...], elapsedMs? }
```

**Every job says what kind of work it is**, and `health` says which kinds the service can
do. Only `nec2` exists today — its job is `{ deck }` — but the antenna modeller will not
be the last EMWS tool that would rather not solve in a browser, and a service that grows
a second engine should not need a second protocol. That is also why the reference
implementation is called `emws-solver` and not `nec-solver`.

- `output` is the report nec2c writes, verbatim. Everything EMWS shows is read from it.
- `exitCode` is nec2c's; a deck NEC-2 rejects is a *result*, not an error. Report
  the exit code and whatever it wrote, and let EMWS explain it. Errors are for things the
  *service* got wrong.
- `health` should be honest about `precision`. EMWS shows it, because a single-precision
  solver will not give quite the same numbers as the browser's double-precision one. A
  service that cannot do `nec2` is told so plainly, rather than being tried and failing.
- A kind the service does not know → **422**, saying what it does know. An engine that is
  configured but not installed → **503**, with the reason.
- `solve-batch` is optional. Answer 404, 405 or 501 and EMWS will send the decks one at
  a time instead, four in flight — it only asks once per session.
- A client that sends a bare `{ deck }` with no kind means NEC-2, which was the whole
  protocol once. Understand it rather than correcting it.

The client side is `src/engine/nec2/solver.ts`; `tests/solver.test.ts` exercises it
against a stub service over real HTTP.

## Running a service

`services/emws-solver/` in this checkout is a working reference implementation: Node, no
dependencies, the same WebAssembly engine the browser uses, one worker per core. It has
its own README. Its acceptance test sends the models in `examples/` and compares the
impedance and gain that come back against values worked out from antenna theory.

**Any solver claiming to serve EMWS should pass that check before its numbers are worth
anything** — including a GPU one, and including someone else's.

```sh
node services/emws-solver/server.mjs --port 8073
node services/emws-solver/check.mjs http://127.0.0.1:8073
```

To put it on a server, `npm run pack` inside that folder builds a self-contained payload
(service, engine and example models, about 140 kB) with a systemd unit and an installer
for Debian or Ubuntu:

```sh
cd services/emws-solver && npm run pack
scp build/emws-solver.tar.gz you@server:
ssh you@server 'tar -xzf emws-solver.tar.gz && sudo emws-solver/deploy/install.sh'
```

The installer assumes the machine is **already busy doing other things**, because a
server usually is:

- **It does not touch the system's Node.** Ubuntu 24.04 ships Node 18, too old, and
  adding a NodeSource repository would change apt for everything on the box. If no
  Node 20+ is present it fetches the official LTS tarball, checks it against the
  published SHA256, and keeps it in `/opt/emws-solver/node` where nothing else sees it.
- **It leaves a quarter of the cores alone** (`EMWS_SOLVER_WORKERS` in
  `/etc/default/emws-solver`), and the unit runs at `Nice=5` / `CPUWeight=50` so
  anything else on the machine gets the CPU first.
- **It writes nothing outside** `/opt/emws-solver`, `/etc/default/emws-solver` and the
  unit file, and runs as a service account with no login and a read-only filesystem.

### The licence boundary

`services/emws-solver/` is deliberately outside this repository. **EMWS contains no
third-party code and links nothing**: it is public domain, it solves in the browser, and
it needs no service at all. The solver is a separate program that talks to it over HTTP,
so anything *it* links is its own business and not EMWS's.

That is what makes an optional **native engine** possible. nec2c's own LU factorisation
is an unblocked elimination; replacing it with LAPACK's `zgetrf`/`zgetrs` is worth a
great deal (see below), but OpenBLAS is BSD-3 rather than public domain. Because it
lives only in `services/emws-solver/engine-native/`, the attribution obligation attaches
to that service's distribution — see its `NOTICE` — and nothing about EMWS's own licence
changes. The service still runs without it, on the same WebAssembly engine the browser
uses, and `EMWS_NEC2_ENGINE=wasm` ignores a native build that is present.

Measured on a Ryzen 7 7700X, 8 cores, against the same models:

| | single 2001-segment solve | 30-frequency sweep at 2001 segments |
|---|---|---|
| Browser, as EMWS ships | — | 305 s (where this began) |
| Service, WebAssembly engine | 2.66 s | 30.1 s |
| Service, native + LAPACK | 0.82 s | **3.8 s** |

Impedance and gain are identical to the last printed digit; the only differences
anywhere in the report are field magnitudes of order 1e-12 at pattern nulls, where the
gain reads -999.99 and there is no field to speak of.

One BLAS thread per solve (`EMWS_BLAS_THREADS`, default 1) — the service already runs
one solve per core, and a multithreaded BLAS inside each of them oversubscribes the
machine so badly that it gives back the whole gain.

If the caller gives up — the user pressed Cancel, or closed the tab — the service
**terminates the job** rather than letting it finish for nobody. Measured on a
single-worker service: a 15.1 s model abandoned after 200 ms freed the worker in 84 ms.

Run any such service behind a firewall or a VPN. It executes whatever model it is
handed, and a large model is a lot of CPU — a token (`--token`) is a lock on the door,
not a substitute for one.

## Setting up the site proxy (IIS)

`public/solver/index.php` is the proxy, and it ships in `dist/`. It is **not** a general
proxy: the destination comes from the server's own environment and is never taken from
the request. Nor does it ever tell the browser where that destination is — when the
solver cannot be reached the visitor gets "this site's solver is not answering" and the
address goes to the web server's error log, where the operator will look for it.

| Variable | Meaning |
|---|---|
| `EMWS_SOLVER_URL` | The NEC service to forward to. Default `http://192.168.0.124:8073`. |
| `EMWS_SOLVER_TOKEN` | Optional; sent as `Authorization: Bearer <token>`. |
| `EMWS_SOLVER_TIMEOUT` | Seconds to wait for a solve. Default 300. |

IIS keys a FastCGI application on the executable **plus its arguments**, which is what
lets one site have environment variables of its own. `scripts/enable-php-proxy.ps1` does
that: it registers a PHP instance for this site, sets the variables on it, and adds a
`*.php` handler ahead of anything the server inherits. Run it from an elevated
PowerShell:

```powershell
.\scripts\enable-php-proxy.ps1 -SiteName emws.local -SolverUrl http://192.168.0.124:8073
curl http://emws.local/solver/index.php?op=health
.\scripts\enable-php-proxy.ps1 -SiteName emws.local -Remove   # undo
```

Then check the whole chain from a browser, which is the only way to see the security
policy, the proxy and the service all working together:

```sh
npm run smoke -- http://emws.local/ --solver
npm run smoke -- http://emws.local/ --solver --solver-url http://127.0.0.1:8073
```

With the service switched off, the first of those is still worth running: it checks
that the page says so in plain words and solves the model in the browser instead.

Everything it writes goes to `applicationHost.config`, not into the site folder, so
rebuilding `dist/` cannot wipe it.

Notes from setting this up:

- PHP 8.5 without the **curl** extension still works — the proxy falls back to PHP's own
  HTTP streams — but the script prefers an install that has curl.
- If `*.php` on the site is being served as plain text or handled by an ancient PHP, an
  inherited handler is winning. The script removes the usual suspects
  (`PHP53_via_FastCGI` and friends) for that site only.
- The site's Content-Security-Policy in `public/web.config` allows `'self'` (which is
  how the proxy is reached) and `http://localhost:*` / `http://127.0.0.1:*` for a
  service on the user's own machine. Nothing else can be connected to, by design.

On other web servers, any means of setting an environment variable for the PHP process
works — `SetEnv` under Apache, `fastcgi_param` under nginx, or app settings on a hosted
platform.

---

Public domain (The Unlicense), like the rest of EMWS. By ZR1JT.
