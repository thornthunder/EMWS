#!/usr/bin/env node
// Browser smoke test: opens EMWS in a real headless Edge/Chrome, waits for the Antenna
// Modeler to solve its default model, and reports what happened - results, console
// errors, failed requests, and how the .wasm was served.
//
//   node scripts/smoke-browser.mjs [base-url] [--screenshot out.png]
//
//   npm run preview            (in another terminal), then:
//   node scripts/smoke-browser.mjs                          -> http://localhost:4173/
//   node scripts/smoke-browser.mjs https://example.org/emws/   -> a live IIS deployment
//
// This covers what the Node test suite cannot: the Web Worker, WebAssembly streaming
// compilation, relative asset URLs, and the server's MIME types and CSP header.
// No dependencies: it speaks the DevTools protocol over Node's built-in WebSocket.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const valueFlags = ['--screenshot', '--example'];
function flag(name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}
const screenshot = flag('--screenshot');
/** Optional id from src/tools/antenna-modeler/examples.ts, e.g. dipole-20m-swr-sweep. */
const example = flag('--example');
const baseUrl =
  args.find((a, i) => !a.startsWith('--') && !valueFlags.includes(args[i - 1])) ?? 'http://localhost:4173/';
const url = new URL('#/antenna', baseUrl).href;
const TIMEOUT_MS = 45_000;

function findBrowser() {
  const candidates = [
    process.env.BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ];
  return candidates.find((c) => c && existsSync(c));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browserPath = findBrowser();
if (!browserPath) {
  console.error('No Edge or Chrome found. Set BROWSER to the path of a Chromium-based browser.');
  process.exit(2);
}

const port = 9300 + Math.floor(Math.random() * 600);
const profile = mkdtempSync(join(tmpdir(), 'emws-smoke-'));
const browser = spawn(
  browserPath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--window-size=1400,1100',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let exitCode = 1;
try {
  // Wait for the DevTools endpoint, then find the page target.
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch {
      // not up yet
    }
    if (!target) await sleep(250);
  }
  if (!target) throw new Error('The browser did not expose a DevTools page target.');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('Could not connect to the DevTools WebSocket.'));
  });

  let nextId = 1;
  const waiting = new Map();
  const problems = [];
  const consoleLines = [];
  const responses = [];

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id !== undefined) {
      const w = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) w?.reject(new Error(msg.error.message));
      else w?.resolve(msg.result);
      return;
    }
    const p = msg.params;
    switch (msg.method) {
      case 'Runtime.exceptionThrown':
        problems.push(`exception: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`);
        break;
      case 'Runtime.consoleAPICalled':
        consoleLines.push(`${p.type}: ${p.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
        if (p.type === 'error') problems.push(consoleLines.at(-1));
        break;
      case 'Log.entryAdded':
        if (p.entry.level === 'error' || p.entry.source === 'security') {
          problems.push(`${p.entry.source}: ${p.entry.text}${p.entry.url ? ` (${p.entry.url})` : ''}`);
        }
        break;
      case 'Network.responseReceived':
        responses.push({ url: p.response.url, status: p.response.status, mime: p.response.mimeType, headers: p.response.headers });
        if (p.response.status >= 400) problems.push(`HTTP ${p.response.status}: ${p.response.url}`);
        break;
      case 'Network.loadingFailed':
        if (!p.canceled) problems.push(`request failed: ${p.errorText}${p.blockedReason ? ` (${p.blockedReason})` : ''}`);
        break;
    }
  };

  const send = (method, params = {}, sessionId = undefined) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

  // The engine's .wasm is fetched inside the Web Worker, which is a separate DevTools
  // target. Attach to workers as they start (paused, so no request is missed), switch
  // on the same reporting there, then let them run.
  const previousOnMessage = ws.onmessage;
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Target.attachedToTarget') {
      const { sessionId } = msg.params;
      void Promise.all([send('Network.enable', {}, sessionId), send('Runtime.enable', {}, sessionId)])
        .catch(() => {})
        .then(() => send('Runtime.runIfWaitingForDebugger', {}, sessionId))
        .catch(() => {});
      return;
    }
    previousOnMessage(event);
  };
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });

  const probe = `JSON.stringify({
    summary: [...document.querySelectorAll('.summary > div')].map(d =>
      (d.querySelector('dt')?.textContent ?? '').trim() + ' = ' + (d.querySelector('dd')?.textContent ?? '').trim()),
    figures: [...document.querySelectorAll('figcaption')].map(f => f.textContent.trim()),
    lobes: document.querySelectorAll('path.lobe').length,
    wires: document.querySelectorAll('line.wire').length,
    alert: document.querySelector('.alert')?.textContent ?? null,
    status: document.querySelector('.deck-panel .muted')?.textContent ?? null,
    solving: document.querySelector('.deck-panel button.danger') !== null,
  })`;

  const evaluate = async (expression) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;

  let state;
  const waitForResults = async (isFresh = () => true) => {
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      state = JSON.parse(await evaluate(probe));
      // While a run is in flight the page still shows the previous results.
      const settled = state.solving === false && (state.summary.length > 0 || state.alert);
      if (settled && isFresh(state)) return;
      await sleep(250);
    }
    throw new Error(`Timed out after ${TIMEOUT_MS / 1000} s waiting for the simulation to finish.`);
  };
  await waitForResults();

  if (example) {
    const before = JSON.stringify(state);
    const picked = await evaluate(`(() => {
      const select = document.querySelector('.deck-panel select');
      if (![...select.options].some(o => o.value === ${JSON.stringify(example)})) return false;
      select.value = ${JSON.stringify(example)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    if (!picked) throw new Error(`No example with id "${example}".`);
    await waitForResults((s) => JSON.stringify(s) !== before);
  }

  if (screenshot) {
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(screenshot, Buffer.from(data, 'base64'));
  }

  const wasm = responses.find((r) => r.url.endsWith('.wasm'));
  const page = responses.find((r) => r.url.split('#')[0] === new URL(baseUrl).href);
  const header = (r, name) => Object.entries(r?.headers ?? {}).find(([k]) => k.toLowerCase() === name)?.[1];

  console.log(`URL:      ${url}`);
  console.log(`Browser:  ${browserPath}`);
  console.log(`Status:   ${state?.status || '(none)'}`);
  console.log(`Results:  ${state?.summary.length ? '' : '(none)'}`);
  for (const line of state?.summary ?? []) console.log(`            ${line}`);
  console.log(`Figures:  ${state?.figures.join(' | ') || '(none)'}`);
  console.log(`Drawn:    ${state?.wires} wire segments, ${state?.lobes} pattern lobes`);
  console.log(`WASM:     ${wasm ? `HTTP ${wasm.status}, Content-Type ${wasm.mime}` : 'never requested'}`);
  console.log(`CSP:      ${header(page, 'content-security-policy') ?? '(no Content-Security-Policy header - expected on the dev/preview server, not on IIS)'}`);
  if (state?.alert) console.log(`Alert:    ${state.alert}`);
  if (problems.length) {
    console.log('Problems:');
    for (const p of problems) console.log(`  - ${p}`);
  }
  if (screenshot) console.log(`Screenshot: ${screenshot}`);

  const solved = (state?.summary ?? []).some((s) => s.startsWith('Feed impedance'));
  const ok = solved && !state?.alert && problems.length === 0 && wasm?.mime === 'application/wasm';
  console.log(ok ? '\nPASS' : '\nFAIL');
  exitCode = ok ? 0 : 1;
  ws.close();
} catch (e) {
  console.error(`Smoke test error: ${e instanceof Error ? e.message : e}`);
} finally {
  browser.kill();
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    // the browser can hold the profile briefly; it's in the OS temp dir either way
  }
}
process.exit(exitCode);
