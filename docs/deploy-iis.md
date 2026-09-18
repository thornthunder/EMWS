# Deploying EMWS to IIS

EMWS is a static site. IIS needs nothing beyond its ordinary static-file handling: no
.NET, no application code, no URL Rewrite module, no database.

## 1. Build

```powershell
npm ci
npm run build      # writes dist\
```

`dist\` is the whole site, including the `web.config` IIS needs.

## 2. Create the site (once)

Either a site of its own, or an application / virtual directory under an existing site
(`https://your-server/emws/`). EMWS uses relative URLs, so both work from the same build.

In IIS Manager:

1. Create the folder, for example `C:\inetpub\wwwroot\emws`.
2. *Add Website*, or right-click an existing site and *Add Application*, pointing at it.
3. Application pool: set **.NET CLR version** to **No Managed Code**. EMWS runs no
   server-side code, so this just saves memory.
4. Make sure the **Static Content** feature is installed (*Turn Windows features on or
   off* → Internet Information Services → World Wide Web Services → Common HTTP
   Features). It normally is.
5. Bind HTTPS if the site is public. Browsers restrict some features to secure origins.

## 3. Deploy

```powershell
.\scripts\deploy-iis.ps1 -SitePath C:\inetpub\wwwroot\emws
```

Run it elevated if the folder is under `C:\inetpub`. It builds, stamps the build, and
mirrors `dist\` into the folder. Try `-WhatIf` first to see what it would change.

Mirroring deletes files in the target that are not part of the build. To protect you
from a mistyped path, the script refuses to touch a non-empty folder unless it already
holds an EMWS deployment, or you pass `-Force`.

Doing it by hand is just as good: copy the contents of `dist\` over the site folder.

## 4. Verify

```powershell
node scripts/smoke-browser.mjs https://your-server/emws/
```

This opens the live site in headless Edge, waits for the Antenna Modeler to solve its
default model, and prints the results, any console errors, and how the server delivered
the engine. You want to see:

```
WASM:     HTTP 200, Content-Type application/wasm
CSP:      default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; ...
PASS
```

`https://your-server/emws/emws-build.json` tells you which version and commit is live.

## What web.config does

- Serves `.wasm` as `application/wasm` (older IIS has no mapping, and would answer 404).
- Caches `assets/*` for a year. Vite puts a content hash in those file names, so a new
  build gets new URLs; everything else, `index.html` included, is always revalidated.
- Sends `Content-Security-Policy` (same-origin only, plus permission to compile
  WebAssembly), `X-Content-Type-Options` and `Referrer-Policy`.
- Turns on static compression.

## Optional: compress the engine

IIS only compresses the MIME types on its server-level list, and `application/wasm` is
not on it, so the 259 KB engine goes out uncompressed. Adding it cuts that to about
114 KB. This is a server-wide setting, so it is not in `web.config`; run once, elevated:

```powershell
& "$env:windir\system32\inetsrv\appcmd.exe" set config /section:httpCompression "/+staticTypes.[mimeType='application/wasm',enabled='True']" /commit:apphost
```

## Troubleshooting

| Symptom | Cause |
|---|---|
| **HTTP 500.19** on every request | A section of `web.config` is locked at server level. The error page names the line. The usual suspects are `<httpProtocol>` or `<staticContent>` locked by an administrator; unlock the section in IIS Manager → Configuration Editor, or remove that block. |
| Page loads, simulation fails, **404 for `.wasm`** | `web.config` was not copied, so there is no MIME mapping. |
| Console: *"violates the following Content Security Policy directive"* | You added something the policy does not allow (an external font, script or API). Adjust the `Content-Security-Policy` value in `public/web.config`. |
| Old version still showing | `index.html` is never cached by EMWS's own rules, so look at a proxy or CDN in front of IIS. |

## Later: multi-threaded solving

If EMWS ever uses WebAssembly threads, the site will also need
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.
They are left out for now because nothing needs them.
