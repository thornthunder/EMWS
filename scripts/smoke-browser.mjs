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
//   node scripts/smoke-browser.mjs http://emws.local/ --solver  -> also use the site's solver
//
// This covers what the Node test suite cannot: the Web Worker, WebAssembly streaming
// compilation, relative asset URLs, and the server's MIME types and CSP header.
// No dependencies: it speaks the DevTools protocol over Node's built-in WebSocket.
//
// HOUSEKEEPING. Each run makes a throwaway browser profile in the OS temp folder and
// closes the browser properly afterwards (see shutDownBrowser at the bottom - the how and
// the why are both there). A profile that cannot be removed is reported with its path;
// stale ones are swept on the next run. If you see the warning repeatedly, look in
// %TEMP% for emws-smoke-* folders - a few hundred megabytes each - and delete them.

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const valueFlags = ['--screenshot', '--example', '--width', '--page', '--solver-url'];
function flag(name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}
const screenshot = flag('--screenshot');
/** Optional id from src/tools/antenna-modeler/examples.ts, e.g. dipole-20m-swr-sweep. */
const example = flag('--example');
/** Also drive the editor with real mouse and keyboard input: drag, undo, split, draw. */
const editTest = args.includes('--edit');
/** Viewport width in CSS pixels (default 1400); try 400 for a phone. */
const viewportWidth = Number(flag('--width') ?? 1400);
/** Render with the dark colour scheme. */
const dark = args.includes('--dark');
/** Drive the Smith chart tool: add a component, use an automatic match, check the numbers. */
const smithTest = args.includes('--smith');
/** Wind a transformer in the balun tool with real mouse input, and check what it reports. */
const balunTest = args.includes('--balun');
/** Send the model to this site's own solver and check it comes back the same. */
const solverTest = args.includes('--solver');
/** Also point the page straight at a service on this machine, e.g. http://127.0.0.1:8073. */
const ownSolver = flag('--solver-url')?.replace(/\/+$/, '');
/** Check another page instead of the modeler, e.g. --page "#/guides/antenna-modeler". */
const pagePath = flag('--page') ?? (smithTest ? '#/smith' : balunTest ? '#/balun' : undefined);
const baseUrl =
  args.find((a, i) => !a.startsWith('--') && !valueFlags.includes(args[i - 1])) ?? 'http://localhost:4173/';
const url = new URL(pagePath ?? '#/antenna', baseUrl).href;
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

/** "72.4 − j3.2 Ω" -> { re: 72.4, im: -3.2 } */
function parseImpedance(text) {
  const m = /^([\d.]+) ([+−]) j([\d.]+)/.exec(text ?? '');
  return m ? { re: Number(m[1]), im: (m[2] === '−' ? -1 : 1) * Number(m[3]) } : undefined;
}

/** Builds a matching network in the Smith chart tool and checks what it reports. */
async function runSmithTest({ evaluate, send, log }) {
  const probe = `JSON.stringify({
    summary: Object.fromEntries([...document.querySelectorAll('.summary > div')].map((d) =>
      [(d.querySelector('dt')?.textContent ?? '').trim(), (d.querySelector('dd')?.textContent ?? '').trim()])),
    components: document.querySelectorAll('.element-card').length,
    matches: [...document.querySelectorAll('.match-list li strong')].map((e) => e.textContent),
    steps: document.querySelectorAll('.chain-table tbody tr').length,
    chartSteps: document.querySelectorAll('path.smith-step').length,
    nodes: document.querySelectorAll('circle.smith-node').length,
  })`;
  const state = async () => JSON.parse(await evaluate(probe));
  const check = (ok, message) => {
    if (!ok) throw new Error(`Smith chart test failed: ${message}`);
    log(`ok  ${message}`);
  };
  const clickText = async (selector, text) => {
    const clicked = await evaluate(
      `(() => { const b = [...document.querySelectorAll('${selector}')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)})); if (!b) return false; b.click(); return true; })()`,
    );
    await sleep(250);
    return clicked;
  };

  let now = await state();
  const startSwr = now.summary.SWR;
  check(now.components === 0 && startSwr.startsWith('2.4'), `starts with the example load, SWR ${startSwr}`);
  check(now.matches.length >= 2, `it offers matches for it: ${now.matches.join(' | ')}`);

  check(await clickText('.add-buttons button', '+ Series L'), 'adds a series inductor');
  now = await state();
  check(now.components === 1 && now.chartSteps === 1, 'the component appears in the chain and on the chart');
  check(now.summary.SWR !== startSwr, `and changes the match: SWR ${startSwr} -> ${now.summary.SWR}`);

  check(await clickText('.element-buttons button[aria-label^="Remove"]', ''), 'removes it again');
  now = await state();
  check(now.components === 0 && now.summary.SWR === startSwr, 'which puts the SWR back');

  const first = now.matches[0];
  check(await clickText('.match-list button', 'Use this'), `uses the suggested match: ${first}`);
  now = await state();
  const matched = Number.parseFloat(now.summary.SWR);
  check(now.components === 2, 'two components land in the chain');
  check(matched < 1.02, `and the radio sees ${now.summary.SWR} at the design frequency`);
  check(now.steps === 3 && now.nodes === 3, 'the step table and the chart nodes agree with the chain');
  check(now.summary['Under 2:1'] !== '—', `with a usable bandwidth: ${now.summary['Under 2:1']}`);

  // The two tools talk to each other: model an antenna, then match it here.
  await send('Page.navigate', { url: new URL('#/antenna', baseUrl).href });
  const deadline = Date.now() + 30_000;
  let solved = false;
  while (Date.now() < deadline && !solved) {
    await sleep(500);
    solved = await evaluate(`document.querySelectorAll('.summary > div').length > 2`);
  }
  check(solved, 'the Antenna Modeler solves its example');
  await send('Page.navigate', { url: new URL('#/smith', baseUrl).href });
  await sleep(1500);
  const handoff = await evaluate(
    `[...document.querySelectorAll('.button-row button')].map((b) => b.textContent).find((t) => t.startsWith('Use ')) ?? null`,
  );
  check(handoff !== null, `and its impedance is offered here: "${handoff}"`);
}

/**
 * Winds a transformer in the balun tool the way a person would: clicks a core, drags the
 * free end of the wire round the ring with a real mouse, undoes it, compares two mixes,
 * and walks into the one design the tool must refuse.
 */
async function runBalunTest({ evaluate, send, log, screenshot }) {
  /** With --screenshot out.png, also saves out-compare.png and out-guanella.png along the way. */
  const snap = async (suffix) => {
    if (!screenshot) return;
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(screenshot.replace(/.png$/i, `-${suffix}.png`), Buffer.from(data, 'base64'));
  };
  const check = (ok, message) => {
    if (!ok) throw new Error(`Balun test failed: ${message}`);
    log(`ok  ${message}`);
  };
  const state = async () =>
    JSON.parse(
      await evaluate(`JSON.stringify({
        title: document.querySelector('.results-title')?.textContent ?? null,
        summary: Object.fromEntries([...document.querySelectorAll('.summary > div')].map((d) =>
          [(d.querySelector('dt')?.textContent ?? '').trim(), (d.querySelector('dd')?.textContent ?? '').trim()])),
        caption: document.querySelector('.pad-caption')?.textContent ?? '',
        turnsDrawn: document.querySelectorAll('.pad polyline.pad-wire').length,
        charts: document.querySelectorAll('figure.chart').length,
        legends: document.querySelectorAll('.chart-legend').length,
        issues: [...document.querySelectorAll('.issue-text')].map((e) => e.textContent),
        bands: document.querySelectorAll('.band-table tbody tr').length,
        note: document.querySelector('.results-title + p')?.textContent ?? '',
      })`),
    );
  const click = async (selector, text) => {
    const done = await evaluate(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${text === undefined ? 'true' : `e.textContent.trim().startsWith(${JSON.stringify(text)})`});
      if (!el) return false;
      el.click();
      return true;
    })()`);
    await sleep(250);
    return done;
  };
  const choose = async (label, value) => {
    const done = await evaluate(`(() => {
      const select = [...document.querySelectorAll('select')].find((s) => s.closest('label')?.textContent.includes(${JSON.stringify(label)}) || s.getAttribute('aria-label') === ${JSON.stringify(label)});
      if (!select) return false;
      const option = [...select.options].find((o) => o.textContent.includes(${JSON.stringify(value)}));
      if (!option) return false;
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(250);
    return done;
  };

  // Start from the shipped design whatever an earlier visit left behind.
  await evaluate(`(localStorage.removeItem('emws.balun.v1'), location.reload())`);
  await sleep(1500);

  let now = await state();
  check(now.title === '49:1 · 2 : 14 turns', `opens on the end-fed transformer: ${now.title}`);
  check(now.turnsDrawn === 14, `and draws its ${now.turnsDrawn} turns on the core`);
  check(now.charts >= 4 && now.bands === 9, `with ${now.charts} charts and ${now.bands} bands in the table`);
  check(/built-in estimate/.test(now.note), 'and says plainly that the ferrite is an estimate');
  const lossOn43 = now.summary['Lost inside'];
  check(lossOn43?.endsWith('dB'), `80 m on #43 loses ${lossOn43}, ${now.summary['Heat in the core']} in the core`);

  check(await click('.core-chip[aria-label="FT240 in #61"]'), 'a click puts the same winding on #61');
  now = await state();
  check(now.summary['Lost inside'] !== lossOn43, `and the loss changes with the ferrite: ${now.summary['Lost inside']}`);
  check(await click('.core-chip[aria-label="FT240 in #43"]'), 'back to #43');

  // Wind more turns by dragging the free end of the wire round the ring, with a real mouse.
  const geometry = JSON.parse(
    await evaluate(`(() => {
      const handle = document.querySelector('.pad-handle').getBoundingClientRect();
      const core = document.querySelector('.pad-core').getBoundingClientRect();
      return JSON.stringify({ hx: handle.x + handle.width / 2, hy: handle.y + handle.height / 2,
        cx: core.x + core.width / 2, cy: core.y + core.height / 2, r: core.width / 2 });
    })()`),
  );
  const mouse = (type, x, y, buttons) =>
    send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
  await mouse('mousePressed', geometry.hx, geometry.hy, 1);
  // The second half of this winding runs anticlockwise from the bottom right; take the
  // end up to about one o'clock, in steps, as a hand would.
  const radius = geometry.r * 0.8;
  for (let degrees = 0; degrees >= -60; degrees -= 6) {
    const a = (degrees * Math.PI) / 180;
    await mouse('mouseMoved', geometry.cx + radius * Math.cos(a), geometry.cy + radius * Math.sin(a), 1);
    await sleep(30);
  }
  await mouse('mouseReleased', geometry.cx + radius * Math.cos(-Math.PI / 3), geometry.cy + radius * Math.sin(-Math.PI / 3), 0);
  await sleep(400);
  now = await state();
  check(now.turnsDrawn > 14, `dragging the wire round the core winds it: ${now.turnsDrawn} turns, ${now.title}`);
  const wound = now.turnsDrawn;

  check(await click('.button-row button', 'Undo'), 'Undo');
  now = await state();
  check(now.turnsDrawn === 14, `takes the whole drag back in one step, not turn by turn: ${now.turnsDrawn} turns`);
  check(wound !== 14, 'so the drag really was one gesture');

  check(await choose('Compare with', '#52'), 'comparing with the same winding on #52');
  now = await state();
  check(now.legends >= 3, `puts both on every chart, with a legend (${now.legends} legends)`);
  await snap('compare');
  await choose('Compare with', 'nothing');

  // The trap: a 1:4 Guanella on one core, into a load with one side earthed.
  check(await click('.segmented button', '1:4 Guanella'), 'switching to a 1:4 Guanella');
  now = await state();
  check(now.title?.startsWith('1:4 Guanella') && now.issues.length === 0, `gives a working two-core design: ${now.title}`);
  await snap('guanella');
  await choose('Cores', 'One');
  await click('label.check input');
  now = await state();
  check(now.issues.some((i) => i.includes('ONE core')), 'one core with an earthed load is refused, and the reason given');
  check(now.title === null, 'and nothing is analysed while the design cannot work');

  check(await click('.segmented button', '1:1 current'), 'switching to a 1:1 current balun');
  now = await state();
  check('Chokes with' in now.summary, `reports what matters for a choke: ${now.summary['Chokes with']}`);


  // Your cores. A file picker cannot be driven from here, so a profile is put into storage
  // exactly as the tool saves one, and the page is reloaded - which is the persistence
  // being tested anyway: does a measured core come back next time, and can it be used?
  await evaluate(`(() => {
    // Eight turns on an FT240: the impedance a mu_i = 800 core relaxing at 7 MHz would show.
    const mu0 = 4e-7 * Math.PI, od = 0.06096, id = 0.03556, h = 0.0127;
    const c1 = (2 * Math.PI) / (h * Math.log(od / id));
    const sweep = [];
    for (let i = 0; i < 40; i++) {
      const f = 1 * 30 ** (i / 39), x = f / 7, span = 799;
      const real = 1 + span / (1 + x * x), loss = (span * x) / (1 + x * x);
      const wL0 = 2 * Math.PI * f * 1e6 * mu0 * 64 / c1;
      sweep.push({ fMHz: f, r: wL0 * loss, x: wL0 * real });
    }
    const profile = {
      id: 'core-smoke-1', name: 'Smoke-test FT240', family: 'NiZn', mix: '#43',
      size: { id: 'custom', name: 'FT240', odMm: 60.96, idMm: 35.56, heightMm: 12.7 },
      measuredAt: new Date().toISOString(), setup: { turns: 8, strayPf: 0, stack: 1 },
      sweep, curve: [], sourceFile: 'smoke.s1p', notes: 'planted by the smoke test',
    };
    localStorage.setItem('emws.balun.cores.v1', JSON.stringify([profile]));
    localStorage.removeItem('emws.balun.v1');
    location.reload();
  })()`);
  await sleep(1500);
  now = await state();
  const bin = await evaluate(`[...document.querySelectorAll('.bin .core-chip-name')].map((e) => e.textContent)`);
  check(bin.includes('Smoke-test FT240'), `a kept core comes back after a reload, in the bin: ${bin.join(', ')}`);

  check(await click('.bin .core-chip', undefined), 'clicking it puts it under the design');
  now = await state();
  const padName = await evaluate(`document.querySelector('.pad-core-name')?.textContent ?? ''`);
  check(padName.startsWith('Smoke-test FT240'), `the pad names your core, not a catalogue one: ${padName}`);
  check(/your measurement/.test(now.note), `and the results say they come from your measurement: ${now.note.slice(0, 60)}...`);
  // The planted profile carries NO curve, only the sweep. If the tool did not re-derive it
  // from the sweep it would be running on an air core, with an SWR in the hundreds of
  // thousands - which is exactly what an earlier version did while this check only asked
  // whether charts existed. So: ask for the numbers.
  const swr = Number.parseFloat(now.summary.SWR);
  check(swr > 1 && swr < 5, `and it analyses on a curve re-derived from the sweep: SWR ${now.summary.SWR}, ${now.summary['Heat in the core']} in the core`);

  // Open the library so a screenshot shows it, and check the profile's card is there.
  await evaluate(`[...document.querySelectorAll('details')].find((d) => d.textContent.includes('Your core library'))?.setAttribute('open', '')`);
  await sleep(200);
  const facts = await evaluate(`document.querySelector('.profile-facts')?.textContent ?? ''`);
  // Two backslashes: this is a template literal, and the browser must receive \d, not d.
  const muStart = await evaluate(`(document.querySelector('.profile-facts')?.textContent.match(/μ′ starts at (\\d+)/) ?? [])[1] ?? null`);
  check(muStart !== null && Number(muStart) > 700 && Number(muStart) < 800, `with μ′ starting at ${muStart} (the planted core relaxes at 7 MHz, so 784 at 1 MHz)`);

  check(/8 turns/.test(facts) && /40 points/.test(facts), `the library shows how it was measured: ${facts.trim().slice(0, 70)}...`);
  await snap('library');

  check(await click('.core-chip[aria-label="FT240 in #43"]'), 'a catalogue core leaves the profile behind');
  now = await state();
  check(/built-in estimate/.test(now.note), 'and the results say so');

  await evaluate(`localStorage.removeItem('emws.balun.cores.v1')`);

  // Leave the next visitor the shipped design, not this test's leftovers.
  await evaluate(`localStorage.removeItem('emws.balun.v1')`);
}

/**
 * Sends the model to a solver other than this browser, and checks the answer is the
 * same one. This is a path the Node tests cannot see: it needs the real page, the real
 * security policy, and a real server that forwards to a real service.
 */
async function runSolverTest({ evaluate, waitForResults, getState, responses, problems, ownSolver, log }) {
  const check = (ok, message) => {
    if (!ok) throw new Error(`Solver test failed: ${message}`);
    log(`ok  ${message}`);
  };
  const impedance = () => getState().summary.find((s) => s.startsWith('Feed impedance'))?.split(' = ')[1];
  const solverState = async () =>
    JSON.parse(
      await evaluate(`JSON.stringify({
        choice: document.querySelector('.solver-picker select')?.value ?? null,
        options: [...(document.querySelector('.solver-picker select')?.options ?? [])].map((o) => o.textContent),
        ready: document.querySelector('.solver-ready')?.textContent ?? null,
        trouble: document.querySelector('.solver-trouble')?.textContent ?? null,
        fallback: document.querySelector('.solver-fallback')?.textContent ?? null,
      })`),
    );

  const inBrowser = impedance();
  let now = await solverState();
  check(now.choice === 'local', `starts in this browser, having solved ${inBrowser}`);
  check(now.options.length === 3, `and offers the alternatives: ${now.options.join(' | ')}`);

  // Choose the site's own solver, and wait for it to say what it is.
  await evaluate(`(() => {
    const select = document.querySelector('.solver-picker select');
    select.value = 'site';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    now = await solverState();
    if (now.ready || now.trouble) break;
    await sleep(250);
  }
  check(now.ready !== null || now.trouble !== null, 'the site says whether it has a solver');

  // Solve again with that chosen. Either the site has a service and the answer must
  // match, or it has not and the page must say so and quietly solve it here instead -
  // both are correct, and which one this site does is not the script's business.
  const before = JSON.stringify(getState());
  await evaluate(
    `[...document.querySelectorAll('.run-bar button')].find((b) => b.textContent.startsWith('Run'))?.click()`,
  );
  await waitForResults((s) => JSON.stringify(s) !== before || true);

  const proxied = responses.filter((r) => r.url.includes('solver/index.php'));
  const solves = proxied.filter((r) => r.url.includes('op=solve'));
  const after = await solverState();

  if (now.ready) {
    check(/nec2c/i.test(now.ready), `the site's solver answers, and names its engine: ${now.ready}`);
    check(impedance() === inBrowser, `the same model solved there gives the same answer: ${impedance()}`);
    check(getState().alert === null && after.trouble === null, 'with nothing gone wrong, and no fallback');
    const ops = [...new Set(solves.map((r) => r.url.split('op=')[1]))];
    check(solves.length > 0, `it really went through the site: ${solves.length} request(s), ${ops.join(' + ')}`);
    check(
      proxied.every((r) => r.status === 200),
      `every one answered 200 (${[...new Set(proxied.map((r) => r.status))].join(', ')})`,
    );
  } else {
    check(true, `this site has no solver running: ${now.trouble.trim()}`);
    check(
      proxied.length > 0 && proxied.every((r) => r.status >= 400),
      `the proxy said so properly (HTTP ${[...new Set(proxied.map((r) => r.status))].join(', ')}), not with a broken page`,
    );
    check(impedance() === inBrowser, `and the model still solved, in this browser: ${impedance()}`);
    check(getState().alert === null, 'without an error being shown as a failed run');
    check(
      /could not be reached/i.test(after.fallback ?? ''),
      `the page explains the fallback: ${(after.fallback ?? '(nothing said)').trim()}`,
    );
    check(
      !/\d+\.\d+\.\d+\.\d+|:\d{4,5}\b/.test(`${after.trouble ?? ''} ${after.fallback ?? ''}`),
      "and does not tell the browser the solver's address",
    );
    // Those 502s are the thing being tested, so they are not loose problems.
    const expected = problems.filter((p) => p.includes('solver/index.php'));
    for (const p of expected) problems.splice(problems.indexOf(p), 1);
    log(`ok  ${expected.length} failed request(s) accounted for by the test itself`);
  }

  if (!ownSolver) return;

  // And the third option: this browser talking straight to a service on this machine.
  // Worth doing for real - it is the site's Content-Security-Policy that decides
  // whether the page may open that connection at all, and no Node test can see it.
  await evaluate(`(() => {
    const select = document.querySelector('.solver-picker select');
    select.value = 'url';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(300);
  await evaluate(`(() => {
    const input = document.querySelector('.solver-picker input[type="text"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(ownSolver)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.blur();
  })()`);
  const ownDeadline = Date.now() + 15_000;
  let direct = await solverState();
  while (Date.now() < ownDeadline && !direct.ready && !direct.trouble) {
    await sleep(250);
    direct = await solverState();
  }
  check(direct.choice === 'url', `a solver on this machine can be named: ${ownSolver}`);
  check(direct.trouble === null, `and the page is allowed to reach it: ${direct.ready ?? direct.trouble}`);

  const wasBefore = JSON.stringify(getState());
  await evaluate(
    `[...document.querySelectorAll('.run-bar button')].find((b) => b.textContent.startsWith('Run'))?.click()`,
  );
  await waitForResults((s) => JSON.stringify(s) !== wasBefore || true);
  check(impedance() === inBrowser, `and it solves the same model the same way: ${impedance()}`);
  check(
    responses.some((r) => r.url.startsWith(ownSolver) && r.status === 200),
    'with the request going straight there, not through the site',
  );
}

/**
 * Uses the editor the way a person would, with real (synthesised) mouse and keyboard
 * input: drag a wire end in the top view, undo, split a wire from the right-click menu,
 * draw a wire in the front view. Throws on the first thing that doesn't happen.
 */
async function runEditTest({ send, evaluate, loadExample, waitForResults, getState, readState, log }) {
  const impedance = () => getState().summary.find((s) => s.startsWith('Feed impedance'))?.split(' = ')[1];
  const wireCount = () => getState().modelWires.length;
  const check = (ok, message) => {
    if (!ok) throw new Error(`Editor test failed: ${message}`);
    log(`ok  ${message}`);
  };
  const changed = async (action) => {
    const before = JSON.stringify(getState());
    await action();
    await waitForResults((s) => JSON.stringify(s) !== before);
  };
  const move = (x, y, buttons = 0) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: buttons ? 'left' : 'none', buttons });
  const press = (type, x, y, button = 'left') =>
    send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button,
      buttons: type === 'mousePressed' ? (button === 'left' ? 1 : 2) : 0,
      clickCount: 1,
    });
  const click = async ({ x, y }, button = 'left') => {
    await move(x, y);
    await press('mousePressed', x, y, button);
    await press('mouseReleased', x, y, button);
  };
  const drag = async (from, to) => {
    await move(from.x, from.y);
    await press('mousePressed', from.x, from.y);
    for (let i = 1; i <= 8; i++) await move(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8, 1);
    await press('mouseReleased', to.x, to.y);
  };
  const key = async (keyName, code, keyCode, modifiers = 0) => {
    const base = { key: keyName, code, windowsVirtualKeyCode: keyCode, modifiers };
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };
  const centreOf = (selector) =>
    evaluate(`(() => { const el = ${selector}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  const clickButton = (container, text) =>
    evaluate(`(() => { const b = [...document.querySelectorAll('${container} button')].find((b) => b.textContent.startsWith(${JSON.stringify(text)})); if (!b || b.disabled) return false; b.click(); return true; })()`);

  const TOP = `document.querySelectorAll('svg.view-ortho')[2]`;
  const FRONT = `document.querySelectorAll('svg.view-ortho')[0]`;

  await loadExample('dipole-20m-free-space');
  const original = impedance();
  check(original === '72.4 + j2.0 Ω' && wireCount() === 1, `the dipole example loads and solves: ${original}`);
  check(getState().views.join(',') === 'Front,Left,Top,3-D', `four views: ${getState().views.join(', ')}`);

  // 1. Drag the dipole's end outwards in the top view (screen-up is +Y there).
  const handle = await centreOf(`${TOP}.querySelector('circle.handle[data-end="b"]')`);
  check(handle !== null, 'the top view shows grab handles on the wire ends');
  await changed(() => drag(handle, { x: handle.x, y: handle.y - 25 }));
  const longer = parseImpedance(impedance());
  check(longer !== undefined && longer.im > 2.0, `dragging the end lengthens the dipole and re-solves: ${impedance()}`);
  check(!getState().modelWires[0]?.includes('10.26 m'), `the wire list follows: ${getState().modelWires[0]}`);

  // 2. Ctrl+Z puts it back.
  await changed(() => key('z', 'KeyZ', 90, 2));
  check(impedance() === original, `Ctrl+Z undoes the drag: ${impedance()}`);

  // 3. Right-click the middle of the wire in the top view and split it there.
  const middle = await centreOf(`${TOP}.querySelector('line.hit-wire')`);
  await click(middle, 'right');
  const menu = await evaluate(`[...document.querySelectorAll('.context-menu button')].map((b) => b.textContent)`);
  check(menu.some((t) => t.startsWith('Split wire here')), `right-click opens the wire menu: ${menu.join(' | ')}`);
  await changed(() => clickButton('.context-menu', 'Split wire here'));
  check(wireCount() === 2, 'Split wire here makes two joined wires');
  check(impedance() === original, `splitting on a segment boundary leaves the physics alone: ${impedance()}`);
  check(getState().issues.length === 0, 'and the design checks stay clean');

  // 4. Draw a new wire in the front view: two clicks, then Esc.
  check(await clickButton('.editor-toolbar', 'Draw wires'), 'Draw wires switches on');
  const box = await evaluate(`(() => { const r = ${FRONT}.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  await changed(async () => {
    await click({ x: box.x + box.w * 0.3, y: box.y + box.h * 0.25 });
    await click({ x: box.x + box.w * 0.7, y: box.y + box.h * 0.25 });
    await key('Escape', 'Escape', 27);
  });
  check(wireCount() === 3, `two clicks in the front view draw a wire: ${getState().modelWires.at(-1)}`);
  const stillDrawing = await evaluate(`document.querySelector('.editor-toolbar button[aria-pressed="true"]') !== null`);
  check(!stillDrawing, 'Esc stops drawing');

  // 5. The Yagi's elements are seen end-on in the front view: dragging a dot moves the whole element.
  await loadExample('yagi-3el-2m');
  const feedNote = await evaluate(`document.querySelectorAll('.summary small')[1]?.textContent`);
  check(feedNote === 'wire 2, segment 6', `the feed is named by its segment along the wire: ${feedNote}`);
  const yagi = impedance();
  const lengths = getState().modelWires.join('|');
  const director = await centreOf(`[...${FRONT}.querySelectorAll('circle.hit-wire')].sort((a, b) => b.getBoundingClientRect().x - a.getBoundingClientRect().x)[0]`);
  check(director !== null, 'the front view shows the elements end-on, as dots');
  await changed(() => drag(director, { x: director.x + 30, y: director.y }));
  check(getState().modelWires.join('|') === lengths, 'dragging a dot moves the element without changing its length');
  check(impedance() !== yagi, `moving the director along the boom changes the match: ${yagi} -> ${impedance()}`);

  // 6. An off-centre feed: type where it goes instead of hunting for it with the pointer.
  await loadExample('ocf-dipole-windom');
  let ocf = await readState();
  check(ocf.feeds[0]?.includes('segment 27 of 79'), `the Windom example is fed off centre: ${ocf.feeds[0]}`);
  check(ocf.feedFields['From end 1'].startsWith('13.7'), `and says where that is: ${ocf.feedFields['From end 1']} m`);

  const before = ocf.summary.find((line) => line.startsWith('Feed impedance'));
  const alongBox = `[...document.querySelectorAll('.feed-row .field')].find((f) => f.textContent.startsWith('Along')).querySelector('input')`;
  await changed(async () => {
    await evaluate(`(() => { const el = ${alongBox}; el.focus(); el.select(); return true; })()`);
    await send('Input.insertText', { text: '25' });
    await key('Enter', 'Enter', 13);
  });
  ocf = await readState();
  check(Number.parseFloat(ocf.feedFields['Along the wire']) < 25.5, `typing 25% moves the feed there: ${ocf.feedFields['Along the wire']}%`);
  check(ocf.feeds[0]?.includes('segment 20 of 79'), `onto the nearest segment: ${ocf.feeds[0]}`);
  check(ocf.feedFields['From end 1'].startsWith('10.1'), `which is ${ocf.feedFields['From end 1']} m along a 41.1 m wire`);
  const after = ocf.summary.find((line) => line.startsWith('Feed impedance'));
  check(after !== before, `and it re-solves there: ${before} -> ${after}`);

  // 7. A sweep big enough to be worth splitting runs on several cores, with progress.
  await loadExample('dipole-20m-swr-sweep');
  const segmentsBoxFor = `[...document.querySelectorAll('.wire-properties .field')].find((f) => f.textContent.startsWith('Segments')).querySelector('input')`;
  await evaluate(`document.querySelector('.wire-list button').click()`);
  await sleep(200);
  await evaluate(`(() => { const el = ${segmentsBoxFor}; el.focus(); el.select(); return true; })()`);
  await send('Input.insertText', { text: '601' });
  await key('Enter', 'Enter', 13);

  // Watch the status line while it works: a split sweep counts frequencies off.
  let sawProgress = '';
  const watchUntil = Date.now() + 40_000;
  while (Date.now() < watchUntil) {
    const seen = JSON.parse(
      await evaluate(
        `JSON.stringify({ status: document.querySelector('.run-status')?.textContent ?? '', wires: document.querySelector('.wire-list button')?.textContent ?? '' })`,
      ),
    );
    if (seen.status.includes('frequencies')) {
      sawProgress = seen.status;
      break;
    }
    // Stop once the new model's own results are in - not on the previous run's status.
    if (!seen.status.startsWith('Solving') && seen.wires.includes('601 seg') && seen.status.includes('601 segments')) break;
    await sleep(80);
  }
  await waitForResults((s) => s.modelWires[0]?.includes('601 seg') ?? false);
  const swept = await readState();
  check(sawProgress !== '', `a big sweep reports progress while it runs: "${sawProgress.trim()}"`);
  const points = await evaluate(`document.querySelectorAll('.plot rect.hit').length`);
  check(points === 17, `and comes back with every frequency: ${points} points on the SWR curve`);
  check(
    swept.summary.some((line) => line.startsWith('Feed impedance')),
    `solved: ${swept.summary.find((line) => line.startsWith('Feed impedance'))}`,
  );
  check(swept.status.includes('601 segments'), `status: ${swept.status}`);
  await changed(async () => {
    await evaluate(`document.activeElement?.blur()`);
    await key('z', 'KeyZ', 90, 2);
  });
  check((await readState()).modelWires[0]?.includes('21 seg') ?? false, 'and Ctrl+Z puts the segment count back');

  // 8. A model heavy enough to take minutes must say so, not just sit there solving.
  await loadExample('dipole-20m-free-space');
  await evaluate(`document.querySelector('.wire-list button').click()`);
  await sleep(200);
  const segmentsBox = `[...document.querySelectorAll('.wire-properties .field')].find((f) => f.textContent.startsWith('Segments')).querySelector('input')`;
  await evaluate(`(() => { const el = ${segmentsBox}; el.focus(); el.select(); return true; })()`);
  await send('Input.insertText', { text: '2000' });
  await key('Enter', 'Enter', 13);
  await sleep(1200);
  const heavy = await readState();
  const warning = heavy.issues.find((t) => t.includes('to solve'));
  check(warning !== undefined, `a heavy model warns first: "${warning}"`);
  check(heavy.runButton.includes('min') || heavy.runButton.includes('s)'), `the Run button says how long: "${heavy.runButton}"`);
  check(heavy.autoRunPaused, 'and auto-run holds off instead of starting a five-minute solve');
  check(!heavy.solving, 'nothing was started behind our back');
  // Undo puts the model back exactly as it was, so there is nothing to wait for a change
  // in: step out of the field, undo, and check what came back.
  await evaluate(`document.activeElement?.blur()`);
  await key('z', 'KeyZ', 90, 2);
  await sleep(800);
  const undone = await readState();
  check(undone.issues.every((t) => !t.includes('to solve')), 'undoing the segment count clears the warning');
  check(undone.modelWires[0]?.includes('21 seg') ?? false, `and restores the model: ${undone.modelWires[0]}`);

  // 9. A sweep with the automatic pattern: a quick sweep, then the far field at the chosen frequency.
  await loadExample('dipole-20m-swr-sweep');
  await changed(() =>
    evaluate(`[...document.querySelectorAll('.radio-list label')].find((l) => l.textContent.includes('Automatic')).querySelector('input').click()`),
  );
  const cuts = getState().figures.filter((f) => f.includes('pattern'));
  check(cuts.length === 2, `the automatic pattern plots two cuts through the main lobe: ${cuts.join(' | ')}`);
  check(getState().figures.some((f) => f.startsWith('SWR')), 'and the sweep keeps its SWR curve');
}

const browserPath = findBrowser();
if (!browserPath) {
  console.error('No Edge or Chrome found. Set BROWSER to the path of a Chromium-based browser.');
  process.exit(2);
}

// Earlier runs that could not clean up leave their browser profiles here; each is a few
// hundred megabytes. Sweep any older than an hour before adding another. Best effort:
// one that is still locked, or that this process is not allowed to touch, is left alone.
for (const name of readdirSync(tmpdir())) {
  if (!name.startsWith('emws-smoke-')) continue;
  const dir = join(tmpdir(), name);
  try {
    if (Date.now() - statSync(dir).mtimeMs < 60 * 60 * 1000) continue;
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // still in use, or not ours to remove
  }
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
const editLog = [];
/** The DevTools connection, once up; shutdown needs it after the try block. */
let ws;
let send;
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

  ws = new WebSocket(target.webSocketDebuggerUrl);
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

  send = (method, params = {}, sessionId = undefined) =>
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
  await send('Emulation.setDeviceMetricsOverride', {
    width: viewportWidth,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: viewportWidth < 600,
  });
  if (dark) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await send('Page.navigate', { url });

  const probe = `JSON.stringify({
    summary: [...document.querySelectorAll('.summary > div')].map(d =>
      (d.querySelector('dt')?.textContent ?? '').trim() + ' = ' + (d.querySelector('dd')?.textContent ?? '').trim()),
    figures: [...document.querySelectorAll('figcaption')].map(f => f.textContent.trim()),
    views: [...document.querySelectorAll('.view-caption strong')].map(e => e.textContent),
    lobes: document.querySelectorAll('path.lobe').length,
    wires: document.querySelectorAll('.view-3d line.wire').length,
    modelWires: [...document.querySelectorAll('.wire-list button')].map(b => b.textContent),
    issues: [...document.querySelectorAll('.issue-text')].map(e => e.textContent),
    feeds: [...document.querySelectorAll('.feed-head .link')].map(e => e.textContent),
    feedFields: Object.fromEntries([...document.querySelectorAll('.feed-row .field')].map(f =>
      [f.querySelector('.field-label')?.textContent ?? '?', f.querySelector('input')?.value ?? ''])),
    alert: document.querySelector('.alert')?.textContent ?? null,
    status: document.querySelector('.run-status')?.textContent ?? null,
    runButton: [...document.querySelectorAll('.run-bar button')].map((b) => b.textContent).join('|'),
    autoRunPaused: (document.querySelector('.run-bar .check')?.textContent ?? '').includes('paused'),
    solving: document.querySelector('.modeler')?.dataset.busy === 'true'
      || document.querySelector('.pattern-pending') !== null,
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
      if (settled && isFresh(state)) {
        // Auto-run waits a moment after an edit; make sure nothing new has started.
        await sleep(600);
        const again = JSON.parse(await evaluate(probe));
        if (!again.solving && JSON.stringify(again) === JSON.stringify(state)) return;
        continue;
      }
      await sleep(250);
    }
    throw new Error(`Timed out after ${TIMEOUT_MS / 1000} s waiting for the simulation to finish.`);
  };
  if (pagePath) {
    // Wait for the page itself rather than for a guess at how long it takes: straight
    // after a build, on a busy machine, a fixed pause is sometimes not enough and the tool
    // tests then start on an empty page. A tool is ready when its readout has figures in it.
    const ready = smithTest || balunTest ? `document.querySelectorAll('.summary > div').length > 0` : `document.querySelector('h1') !== null`;
    const pageDeadline = Date.now() + 20_000;
    while (Date.now() < pageDeadline && !(await evaluate(ready))) await sleep(150);
    await sleep(300); // let the first paint settle
    if (smithTest) await runSmithTest({ evaluate, send, log: (l) => editLog.push(l) });
    if (balunTest) await runBalunTest({ evaluate, send, log: (l) => editLog.push(l), screenshot });
    const info = JSON.parse(
      await evaluate(
        `JSON.stringify({ title: document.querySelector('h1')?.textContent ?? null, headings: [...document.querySelectorAll('h2')].map((h) => h.textContent), links: document.querySelectorAll('a').length })`,
      ),
    );
    if (screenshot) {
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      writeFileSync(screenshot, Buffer.from(data, 'base64'));
    }
    console.log(`URL:      ${url}`);
    console.log(`Title:    ${info.title ?? '(none)'}`);
    console.log(`Sections: ${info.headings.join(' · ') || '(none)'}`);
    console.log(`Links:    ${info.links}`);
    if (editLog.length) {
      console.log('Tool:');
      for (const line of editLog) console.log(`  ${line}`);
    }
    if (problems.length) {
      console.log('Problems:');
      for (const p of problems) console.log(`  - ${p}`);
    }
    if (screenshot) console.log(`Screenshot: ${screenshot}`);
    const pageOk = info.title !== null && problems.length === 0;
    console.log(pageOk ? '\nPASS' : '\nFAIL');
    exitCode = pageOk ? 0 : 1;
    // This early exit used to call browser.kill() and leave: every page-mode run leaked a
    // whole browser, because killing the launcher does nothing. Close it properly.
    await shutDownBrowser();
    process.exit(exitCode);
  }

  await waitForResults();

  const loadExample = async (id) => {
    const before = JSON.stringify(state);
    const picked = await evaluate(`(() => {
      const select = document.querySelector('.example-picker');
      if (![...select.options].some(o => o.value === ${JSON.stringify(id)})) return false;
      select.value = ${JSON.stringify(id)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    if (!picked) throw new Error(`No example with id "${id}".`);
    await waitForResults((s) => JSON.stringify(s) !== before);
  };

  if (example) await loadExample(example);

  if (solverTest) {
    await runSolverTest({
      evaluate,
      waitForResults,
      getState: () => state,
      responses,
      problems,
      ownSolver,
      log: (l) => editLog.push(l),
    });
  }

  if (editTest) {
    await runEditTest({
      send,
      evaluate,
      loadExample,
      waitForResults,
      getState: () => state,
      readState: async () => JSON.parse(await evaluate(probe)),
      log: (l) => editLog.push(l),
    });
  }

  if (screenshot) {
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(screenshot, Buffer.from(data, 'base64'));
  }

  // EMWS ships a plain and a SIMD engine and picks one at runtime. Fetching both would
  // mean the detection is broken and every visitor pays for an engine they never run.
  // A sweep starts a worker per core and each asks for the engine, so count distinct
  // engines rather than requests - several requests for the same one are expected.
  const wasmFetched = responses.filter((r) => r.url.endsWith('.wasm'));
  const wasmEngines = [...new Set(wasmFetched.map((r) => r.url))];
  const wasm = wasmFetched[0];
  const page = responses.find((r) => r.url.split('#')[0] === new URL(baseUrl).href);
  const header = (r, name) => Object.entries(r?.headers ?? {}).find(([k]) => k.toLowerCase() === name)?.[1];

  console.log(`URL:      ${url}`);
  console.log(`Browser:  ${browserPath}`);
  console.log(`Status:   ${state?.status || '(none)'}`);
  console.log(`Results:  ${state?.summary.length ? '' : '(none)'}`);
  for (const line of state?.summary ?? []) console.log(`            ${line}`);
  console.log(`Figures:  ${state?.figures.join(' | ') || '(none)'}`);
  console.log(`Drawn:    ${state?.wires} wire segments, ${state?.lobes} pattern lobes`);
  const wasmName = wasm ? wasm.url.split('/').pop() : '';
  console.log(
    `WASM:     ${wasm ? `${wasmName} — HTTP ${wasm.status}, Content-Type ${wasm.mime}` : 'never requested'}` +
      `${wasmEngines.length > 1 ? `  ** ${wasmEngines.length} different engines fetched, expected 1: ${wasmEngines.map((u) => u.split('/').pop()).join(', ')} **` : ''}` +
      `${wasmFetched.length > 1 ? `  (${wasmFetched.length} requests, one per worker)` : ''}`,
  );
  console.log(`CSP:      ${header(page, 'content-security-policy') ?? '(no Content-Security-Policy header - expected on the dev/preview server, not on IIS)'}`);
  if (state?.alert) console.log(`Alert:    ${state.alert}`);
  if (problems.length) {
    console.log('Problems:');
    for (const p of problems) console.log(`  - ${p}`);
  }
  if (screenshot) console.log(`Screenshot: ${screenshot}`);
  if (editLog.length) {
    console.log('Editor:');
    for (const line of editLog) console.log(`  ${line}`);
  }

  const solved = (state?.summary ?? []).some((s) => s.startsWith('Feed impedance'));
  const ok =
    solved &&
    !state?.alert &&
    problems.length === 0 &&
    wasm?.mime === 'application/wasm' &&
    wasmEngines.length === 1;
  console.log(ok ? '\nPASS' : '\nFAIL');
  exitCode = ok ? 0 : 1;
  ws.close();
} catch (e) {
  if (editLog.length) {
    console.log('Got as far as:');
    for (const line of editLog) console.log(`  ${line}`);
  }
  console.error(`Smoke test error: ${e instanceof Error ? e.message : e}`);
} finally {
  await shutDownBrowser();
}
process.exit(exitCode);

/**
 * Closing the browser properly, and saying so if it cannot be done.
 *
 * Three things were learnt the hard way, after this machine was found with 95 abandoned
 * profiles, 488 orphaned Edge processes and 23 GB of a full system drive:
 *
 *   - The process spawned above is only a LAUNCHER. It starts the real browser and exits
 *     with code 0, so browser.pid is nobody, browser.kill() kills nobody, and waiting for
 *     its exit proves nothing. The browser's real process id has to come from the browser
 *     itself, over DevTools (SystemInfo.getProcessInfo).
 *   - Browser.close is a browser-level command and is ignored on a page session. It has to
 *     go over the browser-level socket from /json/version.
 *   - The only liveness test worth having is whether the DevTools port still answers.
 *
 * So: ask the browser its pid; ask it to close; wait for the port to go quiet; if it does
 * not, kill the real process tree; then remove the profile with patience, and if it is
 * STILL there, say so, loudly, with the path.
 */
async function shutDownBrowser() {
  const endpoint = `http://127.0.0.1:${port}/json/version`;
  const alive = async () => {
    try {
      await fetch(endpoint, { signal: AbortSignal.timeout(800) });
      return true;
    } catch {
      return false;
    }
  };
  /** One browser-level DevTools call on a socket of its own. */
  const browserLevel = async (method) => {
    const version = await (await fetch(endpoint, { signal: AbortSignal.timeout(2000) })).json();
    const sock = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      sock.onopen = resolve;
      sock.onerror = () => reject(new Error('no browser socket'));
    });
    try {
      return await Promise.race([
        new Promise((resolve, reject) => {
          sock.onmessage = (e) => {
            const m = JSON.parse(e.data);
            if (m.id !== 1) return;
            m.error ? reject(new Error(m.error.message)) : resolve(m.result);
          };
          sock.send(JSON.stringify({ id: 1, method }));
        }),
        sleep(2000).then(() => undefined),
      ]);
    } finally {
      try {
        sock.close();
      } catch {
        // already gone
      }
    }
  };

  let realPid;
  try {
    const info = await browserLevel('SystemInfo.getProcessInfo');
    realPid = info?.processInfo?.find((x) => x.type === 'browser')?.id;
  } catch {
    // the port may already be down, which is the good case
  }
  try {
    ws?.close();
  } catch {
    // already closed
  }
  try {
    await browserLevel('Browser.close');
  } catch {
    // gone already, or refused; the fallback handles it
  }

  let quiet = false;
  for (let i = 0; i < 20 && !(quiet = !(await alive())); i++) await sleep(250);

  if (!quiet) {
    const pid = realPid ?? browser.pid;
    if (process.platform === 'win32') {
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        // refused, or already gone
      }
    } else {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    for (let i = 0; i < 12 && !(quiet = !(await alive())); i++) await sleep(250);
  }

  // The browser is gone by now, but Windows can take a while to let go of a profile a
  // long run wrote heavily to. Keep trying for a good twenty seconds before giving up.
  for (let attempt = 0; attempt < 40 && existsSync(profile); attempt++) {
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      await sleep(500);
    }
  }
  if (process.env.SMOKE_DEBUG) console.error(`shutdown: launcher pid=${browser.pid} browser pid=${realPid} port quiet=${quiet}`);
  if (existsSync(profile)) {
    console.error(
      `\nWARNING: could not remove the browser profile ${profile}\n` +
        `         (the browser ${quiet ? 'has exited' : 'is STILL RUNNING'}). ` +
        'Each one is a few hundred megabytes; delete emws-smoke-* from the temp folder by hand.',
    );
  }
}
