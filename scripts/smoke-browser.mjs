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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
/** Map the field around a dipole over ground: limits, duty, the boundary, the hover readout. */
const exposureTest = args.includes('--exposure');
/** Optimise the Yagi's director length and place together, undo it; sweep a dipole's height and use a point. */
const optimiseTest = args.includes('--optimise');
/** Open an MMANA .maa through the real Open button, then save one through Save .maa and read it back. */
const maaTest = args.includes('--maa');
/** Viewport width in CSS pixels (default 1400); try 400 for a phone. */
const viewportWidth = Number(flag('--width') ?? 1400);
/** Render with the dark colour scheme. */
const dark = args.includes('--dark');
/** Drive the Smith chart tool: add a component, use an automatic match, check the numbers. */
const smithTest = args.includes('--smith');
/** Wind a transformer in the balun tool with real mouse input, and check what it reports. */
const balunTest = args.includes('--balun');
/** Drive the coil, trap and filter tabs and check the numbers against the closed forms. */
const lcTest = args.includes('--lc');
/** Drive the five RF toolbox tabs and check the figures against the closed forms. */
const toolboxTest = args.includes('--toolbox');
/** Play a scene in the field sandbox, draw into it with the mouse, undo, and check the checks. */
const fdtdTest = args.includes('--fdtd');
/**
 * Two people sharing a measured core through a site's community store. The base URL must
 * be served by PHP with EMWS_DB_DSN set - e.g. php -S 127.0.0.1:8090 -t dist - because a
 * static server has no store, and the whole point is watching one appear.
 */
const communityTest = args.includes('--community');
/**
 * Plug a simulated NanoVNA into the page and measure with it. Web Serial needs a secure
 * origin (https, or localhost), so this only runs there; on a plain-http origin it checks
 * that the tools say so and stops.
 */
const vnaTest = args.includes('--vna');
/** Send the model to this site's own solver and check it comes back the same. */
const solverTest = args.includes('--solver');
/** The installable app: manifest, service worker, and a full offline reload that still solves. */
const pwaTest = args.includes('--pwa');
/** Also point the page straight at a service on this machine, e.g. http://127.0.0.1:8073. */
const ownSolver = flag('--solver-url')?.replace(/\/+$/, '');
/** Check another page instead of the modeler, e.g. --page "#/guides/antenna-modeler". */
const pagePath = flag('--page') ?? (smithTest ? '#/smith' : balunTest ? '#/balun' : vnaTest ? '#/smith' : lcTest ? '#/lc' : toolboxTest ? '#/toolbox' : fdtdTest ? '#/fdtd' : communityTest ? '#/balun' : pwaTest ? '#/' : undefined);
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

  // This preview is a static server: no store, so no Community section - the standalone
  // promise, checked. The --community mode covers the other side, behind PHP.
  check((await evaluate(`document.querySelector('.community') === null`)) === true, 'no community store here, so no Community section');

  let now = await state();
  check(now.title === '49:1 · 2 : 14 turns', `opens on the end-fed transformer: ${now.title}`);
  check(now.turnsDrawn === 14, `and draws its ${now.turnsDrawn} turns on the core`);
  check(now.charts >= 4 && now.bands === 10, `with ${now.charts} charts and ${now.bands} bands in the table (160 m to 10 m, 60 m included)`);
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
    // A second reading of the same core, for the chips' menu to forget.
    const extra = { ...profile, id: 'core-smoke-2', name: 'Smoke extra reading' };
    localStorage.setItem('emws.balun.cores.v1', JSON.stringify([profile, extra]));
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

  // ---- the chips' right-click menu: forget a reading where it crowds the bin ----
  await evaluate(`document.querySelector('.bin').scrollIntoView({ block: 'center' })`);
  await sleep(300);
  check((await evaluate(`document.querySelectorAll('.bin .core-chip-more').length`)) === 2, 'every chip carries a ⋯ for the same menu');
  const chipBox = JSON.parse(
    await evaluate(`(() => {
      const chip = [...document.querySelectorAll('.bin .core-chip')].find((c) => c.textContent.includes('Smoke extra reading'));
      const r = chip.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`),
  );
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: chipBox.x, y: chipBox.y, button: 'right', buttons: 2, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: chipBox.x, y: chipBox.y, button: 'right', buttons: 0, clickCount: 1 });
  await sleep(300);
  const menuItems = await evaluate(`[...document.querySelectorAll('.context-menu button')].map((b) => b.textContent.trim())`);
  check(menuItems.some((t) => t.startsWith('Export')), `a right-click on the chip opens its menu: ${menuItems.join(' / ')}`);
  check(menuItems.some((t) => t.startsWith('Use on the pad')) && menuItems.some((t) => t.startsWith('Rename')), 'with use and rename to hand');
  check(!menuItems.some((t) => t.includes('Share')), 'and no Share on a site with no community store');
  check(await click('.context-menu button', 'Forget this core'), 'Forget this core…');
  const confirmTitle = await evaluate(`document.querySelector('.context-menu-title')?.textContent ?? ''`);
  check(/Forget .*sweep goes with it/.test(confirmTitle), `asks first: ${confirmTitle}`);
  check(await click('.context-menu button', 'Yes, forget it'), 'Yes, forget it');
  await sleep(300);
  const binAfter = await evaluate(`[...document.querySelectorAll('.bin .core-chip-name')].map((e) => e.textContent)`);
  check(!binAfter.includes('Smoke extra reading') && binAfter.includes('Smoke-test FT240'), `the reading is gone, the good one stays: ${binAfter.join(', ')}`);
  now = await state();
  check(/your measurement/.test(now.note), 'and the design still runs on the kept measurement');

  check(await click('.core-chip[aria-label="FT240 in #43"]'), 'a catalogue core leaves the profile behind');
  now = await state();
  check(/built-in estimate/.test(now.note), 'and the results say so');

  // ---- keep the design, and look through it from the Antenna Modeler ----
  const waitFor = async (expr, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await evaluate(expr)) return true;
      await sleep(150);
    }
    return false;
  };
  const focusedName = await evaluate(`(() => {
    const section = [...document.querySelectorAll('.form-section')].find((s) => s.querySelector('h3')?.textContent.startsWith('Your designs'));
    const input = section?.querySelector('input[type="text"]');
    if (!input) return false;
    input.focus();
    return true;
  })()`);
  check(focusedName, 'Your designs: a name box');
  await send('Input.insertText', { text: 'Smoke choke' });
  check(await click('.form-section button', 'Save this design'), 'Save this design');
  const savedNames = await evaluate(`[...document.querySelectorAll('.saved-list li .link')].map((b) => b.textContent.trim())`);
  check(savedNames.includes('Smoke choke'), `it is on the shelf: ${savedNames.join(', ')}`);
  // The design on the pad at this point is the 49:1 unun on FT240-43; the shelf says so.
  const savedSummary = await evaluate(`document.querySelector('.saved-list li .muted')?.textContent.trim() ?? ''`);
  check(savedSummary.startsWith('49:1'), `described as what it is: ${savedSummary}`);

  await send('Page.navigate', { url: new URL('#/antenna', baseUrl).href });
  check(await waitFor(`document.querySelector('.example-picker') !== null`, 15_000), 'the Antenna Modeler opens');
  await evaluate(`(() => { const s = document.querySelector('.example-picker'); s.value = 'dipole-20m-free-space'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const swrOf = `(() => { const d = [...document.querySelectorAll('.summary > div')].find((x) => x.querySelector('dt')?.textContent.startsWith('SWR at')); return parseFloat(d?.querySelector('dd')?.textContent ?? 'NaN'); })()`;
  // Wait for the dipole itself, not whatever was solved before it: its 14.2 MHz card.
  const onDipole = `[...document.querySelectorAll('.summary > div')].some((d) => d.querySelector('dt')?.textContent === 'Frequency' && d.querySelector('dd')?.textContent.includes('14.2 MHz'))`;
  check(await waitFor(`${onDipole} && document.querySelector('.modeler')?.dataset.busy !== 'true' && Number.isFinite(${swrOf}) && document.querySelector('select.through') !== null`, 45_000), 'the 20 m dipole solves, and the SWR box offers your baluns');
  const atFeed = await evaluate(swrOf);
  const picked = await evaluate(`(() => { const s = document.querySelector('select.through'); const o = [...s.options].find((x) => x.textContent.includes('Smoke choke')); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  check(picked, 'through Smoke choke');
  check(await waitFor(`[...document.querySelectorAll('.summary > div')].some((d) => d.querySelector('dt')?.textContent === 'Balun loss')`), 'a Balun loss card appears');
  const strain = await evaluate(`(() => { const d = document.querySelector('.balun-strain'); return d ? d.dataset.strain + ' | ' + (d.querySelector('.strain-word')?.textContent.trim() ?? '') + ' | ' + getComputedStyle(d).backgroundColor : ''; })()`);
  // The separators must be literal: with them as alternations this regex once matched
  // anything starting "ok", and the check could not fail.
  check(/^(ok|hot|burn) \| . (Within expected range|Risk of thermal runaway|Likely to burn out) \| rgb/.test(strain), `coloured by how hard it works, with a word: ${strain}`);

  // ---- the 3-D pattern: there, with the antenna inside, and it turns ----
  // This example's own RP cards are two cuts, which is no surface: the page says so.
  check(await waitFor(`(document.querySelector('.pattern-3d')?.textContent ?? '').includes('automatic pattern')`, 30_000), 'with only cuts solved, the 3-D panel says to choose the automatic pattern');
  await evaluate(`[...document.querySelectorAll('.radio-list label')].find((l) => l.textContent.includes('Automatic')).querySelector('input').click()`);
  check(await waitFor(`document.querySelector('.pattern-3d polygon.lobe-face') !== null`, 30_000), 'a 3-D pattern beside the polar plots');
  const faces = await evaluate(`document.querySelectorAll('.pattern-3d polygon.lobe-face').length`);
  const wires = await evaluate(`document.querySelectorAll('.pattern-3d line.lobe-wire').length`);
  check(faces > 1000 && wires > 0, `${faces} faces, and the antenna inside as ${wires} segments`);
  const shape = `[...document.querySelectorAll('.pattern-3d polygon.lobe-face')].slice(0, 5).map((p) => p.getAttribute('points')).join('|')`;
  await evaluate(`document.querySelector('.pattern-3d').scrollIntoView({ block: 'center' })`);
  await snap('pattern3d');
  const before3d = await evaluate(shape);
  const box = JSON.parse(await evaluate(`JSON.stringify(document.querySelector('.pattern-3d svg').getBoundingClientRect())`));
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await evaluate(`document.querySelector('.pattern-3d').scrollIntoView({ block: 'center' })`);
  const box2 = JSON.parse(await evaluate(`JSON.stringify(document.querySelector('.pattern-3d svg').getBoundingClientRect())`));
  const mx = box2.x + box2.width / 2;
  const my = box2.y + box2.height / 2;
  const mouse3d = (type, x, y, buttons) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
  await mouse3d('mousePressed', mx, my, 1);
  for (let i = 1; i <= 8; i++) {
    await mouse3d('mouseMoved', mx + i * 10, my + i * 3, 1);
    await sleep(30);
  }
  await mouse3d('mouseReleased', mx + 80, my + 24, 0);
  await sleep(200);
  check((await evaluate(shape)) !== before3d, `dragging turns it (${Math.round(cx)},${Math.round(cy)})`);
  const through = await evaluate(swrOf);
  const loss = await evaluate(`(() => { const d = [...document.querySelectorAll('.summary > div')].find((x) => x.querySelector('dt')?.textContent === 'Balun loss'); return d?.querySelector('dd')?.textContent ?? ''; })()`);
  // A 49:1 into a 72 ohm dipole puts about 1.5 ohms at the radio: a hopeless match, and
  // the tool must say so rather than flatter the design. The loss is the core's, with a
  // low-impedance load pulling current through it.
  check(Number.isFinite(through) && through > 10 && through < 80 && parseFloat(loss) > 0.2 && parseFloat(loss) < 6, `the radio sees SWR ${through} through the 49:1 (${atFeed} at the feed), balun loss ${loss}`);
  await snap('through');
  await evaluate(`(() => { const s = document.querySelector('select.through'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  check(await waitFor(`Math.abs(${swrOf} - ${atFeed}) < 0.01`), `and back at the feed it reads ${atFeed} again`);

  // ---- the feed line: 30 m of LMR-400 between the radio and the feed ----
  check(
    await evaluate(`(() => { const s = document.querySelector('select.feedline-cable'); if (!s) return false; const o = [...s.options].find((x) => x.textContent.includes('LMR-400')); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`),
    'feed line: 30 m of LMR-400',
  );
  check(await waitFor(`[...document.querySelectorAll('.summary > div')].some((d) => d.querySelector('dt')?.textContent === 'Feed line loss')`), 'a Feed line loss card appears');
  const lineLoss = parseFloat(
    await evaluate(`(() => { const d = [...document.querySelectorAll('.summary > div')].find((x) => x.querySelector('dt')?.textContent === 'Feed line loss'); return d?.querySelector('dd')?.textContent ?? ''; })()`),
  );
  // The computed floor for 30 m of LMR-400 at 14.2 MHz is about 0.4 dB; the dipole's mild
  // mismatch adds a few hundredths.
  check(lineLoss > 0.3 && lineLoss < 0.7, `30 m of LMR-400 at 14.2 MHz costs ${lineLoss} dB`);
  const swrAtRadio = await evaluate(swrOf);
  check(swrAtRadio > 1.2 && swrAtRadio < atFeed - 0.01, `the cable's loss flatters the SWR at the radio: ${swrAtRadio} against ${atFeed} at the feed`);
  // A sweep draws the power budget, band-wide.
  await evaluate(`(() => { const s = document.querySelector('.example-picker'); s.value = 'dipole-20m-swr-sweep'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  check(await waitFor(`document.querySelector('.power-budget figure.chart') !== null && document.querySelector('.modeler')?.dataset.busy !== 'true'`, 45_000), 'the sweep example draws Where the power goes');
  const budgetLegend = await evaluate(`document.querySelector('.power-budget .chart-legend')?.textContent ?? ''`);
  check(budgetLegend.includes('reaches the antenna') && budgetLegend.includes('heats the cable'), `with both fates named: ${budgetLegend}`);
  await evaluate(`(() => { const s = document.querySelector('select.feedline-cable'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);

  await evaluate(`localStorage.removeItem('emws.balun.cores.v1')`);

  // Leave the next visitor the shipped design, not this test's leftovers.
  await evaluate(`localStorage.removeItem('emws.balun.v1')`);
}

/**
 * Measures with a (simulated) NanoVNA from each tool that offers it. On an insecure
 * origin there is nothing to plug in, and the honest thing - the tools saying why - is
 * what is checked instead.
 */
/**
 * Coils, traps and filters: the three tabs, driven the way a person would. The numbers
 * checked here are ones the unit tests already hold to closed forms, so what this proves
 * is that the page wires the maths to its controls and to the other tabs.
 */
async function runLcTest({ evaluate, send, log, screenshot }) {
  const check = (ok, message) => {
    if (!ok) throw new Error(`LC test failed: ${message}`);
    log(`ok  ${message}`);
  };
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
      const select = [...document.querySelectorAll('select')].find((s) => s.closest('label')?.textContent.includes(${JSON.stringify(label)}));
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
  const until = async (expr, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await evaluate(expr)) return true;
      await sleep(150);
    }
    return false;
  };
  /** Types into a number field and presses Enter, as a person does. */
  const typeNumber = async (label, text) => {
    const focused = await evaluate(`(() => {
      const input = [...document.querySelectorAll('label.field')].find((l) => l.querySelector('.field-label')?.textContent.trim() === ${JSON.stringify(label)})?.querySelector('input');
      if (!input) return false;
      input.focus();
      input.select();
      return true;
    })()`);
    if (!focused) return false;
    await send('Input.insertText', { text: String(text) });
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    }
    await sleep(250);
    return true;
  };
  const state = async () =>
    JSON.parse(
      await evaluate(`JSON.stringify({
        tab: document.querySelector('.lc-tab[aria-selected="true"]')?.textContent.trim() ?? null,
        title: document.querySelector('.results-title')?.textContent.trim() ?? null,
        summary: Object.fromEntries([...document.querySelectorAll('.summary > div')].map((d) =>
          [(d.querySelector('dt')?.textContent ?? '').trim(), (d.querySelector('dd')?.textContent ?? '').trim()])),
        build: document.querySelector('.build-card')?.textContent ?? '',
        turns: [...document.querySelectorAll('label.field')].find((l) => l.querySelector('.field-label')?.textContent.trim() === 'Turns')?.querySelector('input')?.value ?? null,
        parts: document.querySelectorAll('.parts-table tbody tr').length,
        bands: document.querySelectorAll('.band-table tbody tr').length,
        charts: document.querySelectorAll('figure.chart').length,
        legends: document.querySelectorAll('.chart-legend').length,
        issues: [...document.querySelectorAll('.issue-text')].map((e) => e.textContent),
      })`),
    );

  // Start from the shipped designs whatever an earlier visit left behind.
  await evaluate(`(localStorage.removeItem('emws.lc.v1'), location.reload())`);
  await sleep(1500);

  // ---- the coil ----
  let now = await state();
  check(now.tab === 'A coil' && now.title === '4.05 µH', `opens on the coil tab with the shipped coil: ${now.title}`);
  check(now.build.includes('12 turns') && now.build.includes('25 mm'), 'described as it would be wound: 12 turns on a 25 mm former');
  check(/^up to \d+/.test(now.summary['Q at 7.1 MHz'] ?? ''), `Q given as a range, not a number: ${now.summary['Q at 7.1 MHz']}`);
  check(await typeNumber('Inductance wanted', '8'), 'ask for 8 µH');
  check(await click('.form-section button', 'Find the turns'), 'Find the turns');
  now = await state();
  check(/^(7\.[89]|8\.[012])\d* µH$/.test(now.title ?? ''), `the turns change to give about 8 µH: ${now.turns} turns, ${now.title}`);

  // ---- the trap ----
  check(await click('.lc-tab', 'A trap'), 'A trap');
  check(await click('.band-buttons button', '40 m'), '40 m');
  now = await state();
  check((now.title ?? '').startsWith('7.1 MHz trap: 8 µH across 62.8 pF'), `8 µH at 7.1 MHz wants 62.8 pF: ${now.title}`);
  check((now.summary['Impedance at resonance'] ?? '').startsWith('71.4 kΩ'), `Q 200 makes it 71.4 kΩ at resonance: ${now.summary['Impedance at resonance']}`);
  check(now.charts === 1 && now.bands >= 5, `an impedance chart and ${now.bands} bands in the table`);
  const trapTurns = now.summary['Wind the coil'] ?? '';
  check(await click('.summary button', 'Design that coil'), 'Design that coil');
  now = await state();
  check(now.tab === 'A coil' && trapTurns.startsWith(`${now.turns} turns`), `lands on the coil tab with those turns: ${now.turns}`);

  // ---- the filter ----
  check(await click('.lc-tab', 'A filter'), 'A filter');
  now = await state();
  check(now.title === '5th-order Butterworth low-pass, 32 MHz cutoff', `the shipped filter: ${now.title}`);
  check(now.parts === 5 && now.charts === 2, 'five parts listed, two charts');
  const second = now.summary['Second harmonic, 64.0 MHz'] ?? '';
  check(/^(29|30|31)\.\d dB down$/.test(second), `Butterworth 5th order at twice cutoff: ${second} (30.1 dB lossless)`);
  check(await choose('Shape', 'Chebyshev'), 'Chebyshev');
  check(await typeNumber('Order', '4'), 'order 4');
  now = await state();
  check(now.issues.some((t) => t.includes('even-order Chebyshev')), 'an even order draws the warning about terminations');
  check(now.legends >= 1, 'and the chart shows both responses, with a legend');
  check(await typeNumber('Order', '7'), 'order 7');
  now = await state();
  check(now.issues.length === 0 && now.parts === 7, `an odd order clears it: ${now.parts} parts`);
  check(await evaluate(`document.querySelector('.measure-filter summary')?.textContent === 'Measure the filter you built'`), 'and offers to measure the filter you built, port 1 to port 2');

  // ---- stubs and cavities ----
  check(await click('.lc-tab', 'Stubs & cavities'), 'Stubs & cavities');
  now = await state();
  // λ/4 at 145 MHz in RG-213, whose solid polyethylene (εr 2.25) gives VF 1/1.5 = 0.667 -
  // not the rounded 0.66: 299.792458 / 145 / 4 / 1.5 = 0.3446 m.
  check((now.title ?? '').includes('345 mm'), `the 2 m harmonic trap: a shorted quarter wave, 345 mm of RG-213: ${now.title}`);
  const notchAt = parseFloat(now.summary['Notch at 290.00 MHz'] ?? 'NaN');
  const passAt = parseFloat(now.summary['Passes 145.00 MHz'] ?? 'NaN');
  check(notchAt < -35 && passAt > -0.1, `notches the second harmonic (${notchAt} dB) and passes 145 MHz (${passAt} dB)`);
  check(now.build.includes('short the far end') && now.build.includes('trim'), 'says how to build it, and to cut long and trim while measuring');
  if (screenshot) {
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(screenshot.replace(/.png$/i, '-stub.png'), Buffer.from(data, 'base64'));
  }
  check(await click('.segmented button', 'A band-pass'), 'A band-pass');
  now = await state();
  check(now.parts === 7, `three resonators and four capacitors listed: ${now.parts} rows`);
  const middle = parseFloat(now.summary['At 145 MHz'] ?? 'NaN');
  check(middle > -1, `cavities of Q 1500 pass the middle at ${middle} dB`);
  check(await choose('Resonators made of', 'Coax stubs'), 'make the resonators from coax instead');
  now = await state();
  check(parseFloat(now.summary['At 145 MHz'] ?? 'NaN') < -1, `and coax stubs lose more in the middle: ${now.summary['At 145 MHz']}`);
  check(await until(`document.body.textContent.includes('not high-Q enough')`), 'which the page explains: coax is not high-Q enough for a band this narrow');
  if (screenshot) {
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(screenshot.replace(/.png$/i, '-bandpass.png'), Buffer.from(data, 'base64'));
  }

  // ---- the trap, into an antenna ----
  check(await click('.lc-tab', 'A trap'), 'back to the trap');
  check(await click('.button-row button', 'Put this trap in an antenna'), 'Put this trap in an antenna');
  check(await until(`location.hash === '#/antenna' && [...document.querySelectorAll('h3')].some((h) => h.textContent.startsWith('Loads'))`, 15_000), 'the Antenna Modeler opens, with a Loads section');
  check(await until(`document.querySelector('.handoff-offer')?.textContent.includes('7.1 MHz trap')`), 'which offers the 7.1 MHz trap');
  check(await click('.handoff-offer button', 'Put it on wire'), 'Put it on wire');
  check(await until(`[...document.querySelectorAll('h3')].some((h) => h.textContent.startsWith('Loads (1)'))`), 'one load in the list');
  check(await until(`document.querySelectorAll('rect.load').length >= 1`), 'drawn on the wire as a square');
  const kind = await evaluate(`[...document.querySelectorAll('.load-row select')].map((s) => s.value).join()`);
  check(kind === 'parallel', `as a parallel load: ${kind}`);
  check(await until(`document.querySelector('.modeler')?.dataset.busy !== 'true' && [...document.querySelectorAll('.summary > div')].some((d) => d.querySelector('dt')?.textContent === 'Efficiency')`, 45_000), 'the antenna solves with it in');
  // A 7 MHz trap on the 2 m Yagi is only a small capacitor, so nothing shows in the
  // efficiency there. The example built from two of them does show it.
  await evaluate(`(() => { const s = document.querySelector('.example-picker'); s.value = 'trap-dipole-40-80m'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  check(await until(`[...document.querySelectorAll('h3')].some((h) => h.textContent.startsWith('Loads (2)'))`), 'the trap dipole example comes in with its two traps as loads');
  const efficiencyNow = `(() => { const d = [...document.querySelectorAll('.summary > div')].find((x) => x.querySelector('dt')?.textContent === 'Efficiency'); return parseFloat(d?.querySelector('dd')?.textContent ?? 'NaN'); })()`;
  check(await until(`document.querySelector('.modeler')?.dataset.busy !== 'true' && ${efficiencyNow} < 99`, 45_000), 'and solves with them in');
  const efficiency = await evaluate(efficiencyNow);
  check(efficiency > 88 && efficiency < 93, `the traps' loss is in the efficiency: ${efficiency} % on 40 m (90.8 % when the example was tuned)`);
}


/** Drives the five RF toolbox tabs and checks the figures against the closed forms. */
async function runToolboxTest({ evaluate, send, log }) {
  const check = (ok, message) => {
    if (!ok) throw new Error(`Toolbox test failed: ${message}`);
    log(`ok  ${message}`);
  };
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
      const select = [...document.querySelectorAll('select')].find((s) => s.closest('label')?.textContent.includes(${JSON.stringify(label)}));
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
  const until = async (expr, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await evaluate(expr)) return true;
      await sleep(150);
    }
    return false;
  };
  /** Types into a number field and presses Enter, as a person does. */
  const typeNumber = async (label, text) => {
    const focused = await evaluate(`(() => {
      const input = [...document.querySelectorAll('label.field')].find((l) => l.querySelector('.field-label')?.textContent.trim() === ${JSON.stringify(label)})?.querySelector('input');
      if (!input) return false;
      input.focus();
      input.select();
      return true;
    })()`);
    if (!focused) return false;
    await send('Input.insertText', { text: String(text) });
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    }
    await sleep(250);
    return true;
  };
  const state = async () =>
    JSON.parse(
      await evaluate(`JSON.stringify({
        tab: document.querySelector('.tool-tab[aria-selected="true"]')?.textContent.trim() ?? null,
        panels: [...document.querySelectorAll('.workspace > .panel')].map((p) => ({
          title: p.querySelector('.results-title')?.textContent.trim() ?? null,
          summary: Object.fromEntries([...p.querySelectorAll('.summary > div')].map((d) =>
            [(d.querySelector('dt')?.textContent ?? '').trim(), (d.querySelector('dd')?.textContent ?? '').trim()])),
        })),
        build: document.querySelector('.build-card')?.textContent ?? '',
        rules: document.querySelectorAll('.rules-table tbody tr').length,
        parts: [...document.querySelectorAll('.parts-table tbody tr')].map((r) => [...r.children].map((c) => c.textContent.trim())),
        drawn: document.querySelectorAll('.pad-figure rect.pad-r').length,
        charts: document.querySelectorAll('figure.chart').length,
        issues: [...document.querySelectorAll('.issue-text')].map((e) => e.textContent),
      })`),
    );

  // Start from the shipped figures whatever an earlier visit left behind. The tool is its
  // own chunk now, so wait for it to arrive after the reload.
  await evaluate(`(localStorage.removeItem('emws.toolbox.v1'), location.reload())`);
  check(await until(`document.querySelector('.tool-tab') !== null && document.querySelectorAll('.summary > div').length > 0`, 15_000), 'the toolbox loads');

  // ---- wavelength and wire ----
  let now = await state();
  check(now.tab === 'Wavelength & wire', `opens on the wavelength tab: ${now.tab}`);
  check(now.panels[0]?.title === '21.112 m at 14.2 MHz', `20 m is 21.112 m: ${now.panels[0]?.title}`);
  check(/^3\.48[34] m/.test(now.panels[0]?.summary['Quarter wave of that line'] ?? ''), `a quarter wave of VF 0.66 line: ${now.panels[0]?.summary['Quarter wave of that line']}`);
  check(now.rules === 3, 'three figures for the dipole, not one');
  check(await click('.band-buttons button', '40 m'), '40 m');
  now = await state();
  check(now.panels[0]?.title === '42.224 m at 7.1 MHz', `and 40 m is 42.224 m: ${now.panels[0]?.title}`);

  // ---- coax ----
  check(await click('.tool-tab', 'Coax loss'), 'Coax loss');
  now = await state();
  const coax = now.panels[0];
  check((coax?.title ?? '').startsWith('At least ') && (coax?.title ?? '').includes('lost in 30 m of RG-58'), `the catalogue cable is a floor: ${coax?.title}`);
  const radioSwr = parseFloat(coax?.summary['SWR at the radio'] ?? 'NaN');
  check(radioSwr > 1 && radioSwr < 2, `the radio sees less than the antenna's 2 : 1: ${coax?.summary['SWR at the radio']}`);
  check(now.issues.some((t) => t.includes('floor')), 'and the note says why');
  check(now.charts === 1, 'with a loss-against-frequency chart');
  const rg58Matched = parseFloat(coax?.summary['Matched loss'] ?? 'NaN');
  check(await choose('Cable', 'LMR-400'), 'LMR-400');
  now = await state();
  check((now.panels[0]?.title ?? '').startsWith('At least ') && (now.panels[0]?.title ?? '').includes('LMR-400'), `LMR-400 is in the catalogue, also as a floor: ${now.panels[0]?.title}`);
  const lmrMatched = parseFloat(now.panels[0]?.summary['Matched loss'] ?? 'NaN');
  check(lmrMatched > 0 && lmrMatched < rg58Matched / 2, `and loses well under half what RG-58 does: ${lmrMatched} against ${rg58Matched} dB`);
  check(/VF 0\.85/.test(now.panels[0]?.summary['Electrical length'] ?? ''), `at its published velocity factor: ${now.panels[0]?.summary['Electrical length']}`);
  check(await choose('Cable', 'From its datasheet'), 'From its datasheet…');
  now = await state();
  check(!(now.panels[0]?.title ?? '').startsWith('At least'), `a datasheet cable is not a floor: ${now.panels[0]?.title}`);
  check(/^2\.40 dB/.test(now.panels[0]?.summary['Matched loss'] ?? ''), `4.6 dB at 10 MHz and 16 dB at 100 MHz fit to 8.01 dB/100 m at 28.5 MHz, 2.40 dB for 30 m: ${now.panels[0]?.summary['Matched loss']}`);
  check(/^2\.7[45] dB/.test(now.panels[0]?.summary['Total loss'] ?? ''), `and SWR 2 makes it 2.75 dB: ${now.panels[0]?.summary['Total loss']}`);

  // ---- attenuators ----
  check(await click('.tool-tab', 'Attenuators'), 'Attenuators');
  now = await state();
  check(now.panels[0]?.title === '10 dB Pi pad, 50 → 50 Ω', `the shipped pad: ${now.panels[0]?.title}`);
  check(now.drawn === 3, 'three resistors drawn');
  const shunt = now.parts.find((r) => r[0] === 'Shunt, input side');
  const series = now.parts.find((r) => r[0] === 'Series');
  check(shunt?.[1] === '96.25 Ω' && shunt?.[2] === '100.0 Ω', `textbook shunt 96.25 Ω, E24 100 Ω: ${shunt?.slice(1, 3).join(' / ')}`);
  check(series?.[1] === '71.15 Ω' && series?.[2] === '68.00 Ω', `textbook series 71.15 Ω, E24 68 Ω: ${series?.slice(1, 3).join(' / ')}`);
  check(/^9\.6\d dB/.test(now.panels[0]?.summary['Attenuation as built'] ?? ''), `100 / 68 / 100 is really 9.63 dB: ${now.panels[0]?.summary['Attenuation as built']}`);
  check(await typeNumber('Attenuation', '3'), 'ask for 3 dB');
  check(await typeNumber('Output impedance', '75'), 'into 75 Ω');
  now = await state();
  check(now.issues.some((t) => t.includes('at least 5.72 dB')), 'refused: between 50 and 75 Ω a pad loses at least 5.72 dB');
  check(await choose('Shape', 'Minimum-loss'), 'Minimum-loss L pad');
  now = await state();
  check((now.panels[0]?.title ?? '').startsWith('5.72 dB minimum-loss pad'), `the L pad: ${now.panels[0]?.title}`);
  check(now.drawn === 2, 'two resistors drawn');

  // ---- levels ----
  check(await click('.tool-tab', 'dB, watts'), 'dB, watts & S-units');
  now = await state();
  check((now.panels[0]?.title ?? '').startsWith('-73 dBm is 50.1 pW') && (now.panels[0]?.title ?? '').includes('S9'), `-73 dBm is 50 pW, S9: ${now.panels[0]?.title}`);
  check(await choose('S-meter scale', 'VHF'), 'VHF scale');
  now = await state();
  check((now.panels[0]?.summary['S-meter'] ?? '').startsWith('S9 + 20 dB'), `on VHF that is S9 + 20 dB: ${now.panels[0]?.summary['S-meter']}`);
  check(now.panels[1]?.title === '130 W EIRP, 79.4 W ERP', `100 W less 1 dB into 2.15 dBi: ${now.panels[1]?.title}`);
  check((now.panels[1]?.summary['Field strength'] ?? '').startsWith('6.25 V/m'), `sqrt(30 x 130) / 10 m: ${now.panels[1]?.summary['Field strength']}`);

  // ---- swr ----
  check(await click('.tool-tab', 'SWR'), 'SWR & return loss');
  now = await state();
  check(now.panels[0]?.title === 'SWR 2.00 : 1', `the shipped SWR: ${now.panels[0]?.title}`);
  check(now.panels[0]?.summary['Return loss'] === '9.5 dB', `return loss 9.5 dB: ${now.panels[0]?.summary['Return loss']}`);
  check((now.panels[0]?.summary['Power reflected'] ?? '').startsWith('11.1 %'), `11.1 % reflected: ${now.panels[0]?.summary['Power reflected']}`);
  check(now.panels[1]?.title === 'The wattmeter says 2.00 : 1', `100 W forward, 11.1 W back: ${now.panels[1]?.title}`);
  check((now.panels[2]?.title ?? '').startsWith('72 + j0 Ω in a 50 Ω system: SWR 1.44 : 1'), `72 ohms in 50: ${now.panels[2]?.title}`);
  check(now.panels[2]?.summary['Return loss'] === '14.9 dB', `with a return loss of 14.9 dB: ${now.panels[2]?.summary['Return loss']}`);

  // ---- microwave & link budget ----
  check(await click('.tool-tab', 'Microwave'), 'Microwave & link budget');
  now = await state();
  check((now.panels[0]?.title ?? '').includes('dBm at the receiver'), `the budget headline: ${now.panels[0]?.title}`);
  check((now.panels[0]?.summary['EIRP'] ?? '').startsWith('63.0 dBm'), `5 W less 1 dB into a 1.2 m dish at 2.4 GHz: EIRP ${now.panels[0]?.summary['EIRP']}`);
  check((now.panels[0]?.summary['Path loss'] ?? '').startsWith('191.1 dB'), `35,786 km of free space at 2.4 GHz: ${now.panels[0]?.summary['Path loss']}`);
  check((now.panels[0]?.summary['Received'] ?? '').startsWith('-128.1 dBm'), `received by the typed far end: ${now.panels[0]?.summary['Received']}`);
  check(await evaluate(`document.body.textContent.includes('whose figures this page does not state')`), 'and the page says it states no satellite figures');
  check((now.panels[1]?.summary['Sending, 1.2 m'] ?? '').startsWith('27.0 dBi'), `the dish: ${now.panels[1]?.summary['Sending, 1.2 m']}`);
  check(/about 7\.3°/.test(now.panels[1]?.summary['Sending, 1.2 m'] ?? ''), 'with its 70 λ/D beamwidth');
  check((now.panels[2]?.title ?? '') === "The receiver's noise figure: 1.18 dB", `preamp at the antenna: ${now.panels[2]?.title}`);
  check(await click('label.check input'), 'move the preamp to the rig end of the feeder');
  now = await state();
  check((now.panels[2]?.title ?? '') === "The receiver's noise figure: 3.10 dB", `and the feeder's 2 dB is paid in full: ${now.panels[2]?.title}`);
  check(await click('label.check input'), 'back to the antenna');
  now = await state();
  check(now.panels[3]?.title === 'Radio horizon: 26 km', `two 10 m stations over a 4/3 earth: ${now.panels[3]?.title}`);
  check(await click('.button-row button', 'CW, 500 Hz'), 'CW, 500 Hz');
  now = await state();
  const margin = parseFloat(((now.panels[0]?.title ?? '').match(/([+-][\d.]+) dB margin/) ?? [])[1] ?? 'NaN');
  check(margin > 7 && margin < 9, `narrowing 2.7 kHz to 500 Hz buys 10 log10(5.4) of margin: ${margin} dB`);
}

/**
 * MMANA-GAL files through the page's own buttons. A Russian-edition file (windows-1251,
 * Cyrillic section headers) is handed to the real file input, as a person picking it
 * would; the page must open it, say what it changed, and solve it. Then Save .maa writes
 * a file to a download folder, and its bytes must be the single-byte MMANA format.
 */
async function runMaaTest({ send, evaluate, log, folder }) {
  const check = (ok, message) => {
    if (!ok) throw new Error(`MMANA test failed: ${message}`);
    log(`ok  ${message}`);
  };
  const until = async (expr, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await evaluate(expr)) return true;
      await sleep(200);
    }
    return false;
  };
  mkdirSync(folder, { recursive: true });
  // A 40 m vertical over real ground, from the Russian edition: Cyrillic headers, cp1251.
  const text = ['Вертикал 40 м', '*', '7.1', '* Провода *', '1', '0.0,\t0.0,\t0.0,\t0.0,\t0.0,\t10.3,\t0.001,\t-1', '*** Источ. ***', '1,\t1', 'w1b,\t0.0,\t1.0', '*** Нагрузка ***', '0,\t1', '*** Автосегм ***', '800,\t80,\t2.0,\t1', '*G/H/M/R/AzEl/X*', '2,\t0.0,\t0,\t50.0,\t120,\t60,\t0'].join('\r\n');
  const cp1251 = Buffer.from([...text].map((c) => (c >= 'А' && c <= 'я' ? c.charCodeAt(0) - 0x410 + 0xc0 : c.charCodeAt(0))));
  const file = join(folder, 'vertical.maa');
  writeFileSync(file, cp1251);

  const { root } = await send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '.toolbar input[type="file"]' });
  check(nodeId > 0, 'the Open button has a file input behind it');
  const accept = await evaluate(`document.querySelector('.toolbar input[type="file"]')?.accept ?? ''`);
  check(accept.includes('.maa'), `it accepts .maa files: ${accept}`);
  await send('DOM.setFileInputFiles', { nodeId, files: [file] });
  check(await until(`(document.querySelector('.note')?.textContent ?? '').includes('MMANA')`), 'a Russian-edition .maa opens, and the page says it came from MMANA');
  const note = await evaluate(`document.querySelector('.note')?.textContent ?? ''`);
  check(/radial screen/.test(note) && /average ground/.test(note), 'and says what it did about the ground: average soil, a radial screen under the grounded vertical');
  check(await until(`[...document.querySelectorAll('.summary > div')].some((d) => d.querySelector('dt')?.textContent === 'Frequency' && d.querySelector('dd')?.textContent.includes('7.1 MHz'))`, 45_000), 'it solves at the file\'s 7.1 MHz');
  const comment = await evaluate(`document.querySelector('.model-panel textarea.notes')?.value.includes('Вертикал 40 м') ?? false`);
  check(comment, 'the Russian title survives as the model notes, in Cyrillic');

  // Save it back out through the page's own button.
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: folder });
  check(await evaluate(`(() => { const b = [...document.querySelectorAll('.toolbar button')].find((x) => x.textContent.trim() === 'Save .maa'); if (!b) return false; b.click(); return true; })()`), 'Save .maa');
  const saved = join(folder, 'antenna.maa');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !existsSync(saved)) await sleep(200);
  check(existsSync(saved), 'a file is written');
  const bytes = readFileSync(saved);
  const out = bytes.toString('latin1');
  check(/^\*\*\*Wires\*\*\*$/m.test(out) && /\r\n/.test(out), 'in MMANA\'s layout, with Windows line ends');
  check(/^w1b,\t0,\t1$/m.test(out), `the source back where it was: ${out.match(/^w1[^\r]*/m)?.[0]}`);
  const title = new TextDecoder('windows-1251').decode(bytes).split('\r\n')[0];
  check(title === 'Вертикал 40 м', `the Russian title goes back out in the Russian edition's code page, windows-1251: "${title}"`);
  check(await until(`(document.querySelector('.note')?.textContent ?? '').includes('Saved for MMANA-GAL')`), 'and the page says what it wrote');
}

/**
 * The optimiser and the parameter sweep, driven as a person would. The optimiser runs on
 * the 2 m Yagi for gain alone and must come back better, as ONE undo step; the sweep raises
 * the 20 m dipole from 6 to 24 m and its take-off angle must fall, and a picked point must
 * reach the model. With --screenshot out.png it also saves out-sweep.png.
 */
async function runOptimiseTest({ send, evaluate, loadExample, log, screenshot }) {
  const check = (ok, message) => {
    if (!ok) throw new Error(`Optimise test failed: ${message}`);
    log(`ok  ${message}`);
  };
  const until = async (expr, ms = 60_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await evaluate(expr)) return true;
      await sleep(200);
    }
    return false;
  };
  const typeIn = async (scope, label, text) => {
    const focused = await evaluate(`(() => {
      const input = [...document.querySelectorAll(${JSON.stringify(scope + ' label.field')})].find((l) => l.querySelector('.field-label')?.textContent.trim() === ${JSON.stringify(label)})?.querySelector('input');
      if (!input) return false;
      input.focus();
      input.select();
      return true;
    })()`);
    if (!focused) return false;
    await send('Input.insertText', { text: String(text) });
    for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await sleep(250);
    return true;
  };
  const tick = (label) =>
    evaluate(`(() => { const l = [...document.querySelectorAll('.optimise-list label.check')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!l) return false; l.querySelector('input').click(); return true; })()`);
  const wireLine = (tag) => evaluate(`[...document.querySelectorAll('.wire-list button')].find((b) => b.querySelector('.wire-tag')?.textContent === ${JSON.stringify(String(tag))})?.textContent ?? ''`);
  const gainCard = `parseFloat([...document.querySelectorAll('.summary > div')].find((d) => d.querySelector('dt')?.textContent === 'Peak gain')?.querySelector('dd')?.textContent ?? 'NaN')`;

  // ---- the optimiser, on the Yagi ----
  await loadExample('yagi-3el-2m');
  check(await until(`document.querySelector('.optimise') !== null`), 'the Optimise section is beside Tune');
  const before = await wireLine(3);
  check(await tick('Length of wire 3'), 'tick the length of wire 3 (the director)');
  check(await tick('Position of wire 3 along X'), 'and its place along the boom - a variable Tune never had');
  check(await typeIn('.optimise', 'Front to back, per dB', '0'), 'weigh gain alone: F/B 0');
  check(await typeIn('.optimise', 'SWR weight', '0'), 'SWR 0');
  check(await evaluate(`(() => { const b = [...document.querySelectorAll('.optimise button')].find((x) => x.textContent.trim() === 'Optimise'); if (!b || b.disabled) return false; b.click(); return true; })()`), 'Optimise');
  check(await until(`/Changed|Nothing in those ranges/.test(document.querySelector('.optimise-note')?.textContent ?? '')`, 120_000), 'it finishes and says what it did');
  const note = await evaluate(`document.querySelector('.optimise-note')?.textContent ?? ''`);
  const [gBefore, gAfter] = [...note.matchAll(/([\d.]+) dBi/g)].map((m) => Number(m[1]));
  check(/^Changed/.test(note) && gAfter > gBefore, `more gain: ${note.slice(0, 170)}…`);
  check(await until(`(${JSON.stringify(before)}) !== ([...document.querySelectorAll('.wire-list button')].find((b) => b.querySelector('.wire-tag')?.textContent === '3')?.textContent ?? '')`), `the director changed: ${before} -> ${await wireLine(3)}`);
  check(await until(`Math.abs(${gainCard} - ${gAfter}) < 0.6`, 30_000), `and the re-solved model shows it: ${await evaluate(gainCard)} dBi`);
  // Ctrl+Z in a focused text box is the box's own undo; the app's is for the page.
  await evaluate(`document.activeElement?.blur()`);
  for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90 });
  check(await until(`(${JSON.stringify(before)}) === ([...document.querySelectorAll('.wire-list button')].find((b) => b.querySelector('.wire-tag')?.textContent === '3')?.textContent ?? '')`), 'Ctrl+Z takes the whole optimisation back in one step');

  // ---- the parameter sweep, on the dipole over ground ----
  await loadExample('dipole-20m-over-ground');
  check(await until(`document.querySelector('.sweep-panel') !== null`), 'the Sweep a parameter panel is under the results');
  await evaluate(`document.querySelector('.sweep-panel').setAttribute('open', '')`);
  const chosen = await evaluate(`document.querySelector('.sweep-panel select')?.selectedOptions[0]?.textContent ?? ''`);
  check(chosen === 'Height of the antenna', `it offers the height first: ${chosen}`);
  check(await typeIn('.sweep-panel', 'From', '6'), 'from 6 m');
  check(await typeIn('.sweep-panel', 'to', '24'), 'to 24 m');
  check(await typeIn('.sweep-panel', 'Points', '7'), '7 points');
  check(await evaluate(`(() => { const b = [...document.querySelectorAll('.sweep-panel button')].find((x) => x.textContent.trim() === 'Sweep it'); if (!b) return false; b.click(); return true; })()`), 'Sweep it');
  check(await until(`document.querySelectorAll('.sweep-panel figure.xy-chart').length >= 4 && !document.querySelector('.sweep-panel .danger')`, 90_000), 'the curves are drawn');
  const titles = await evaluate(`[...document.querySelectorAll('.sweep-panel .xy-chart .chart-title')].map((t) => t.textContent)`);
  check(titles.some((t) => t.startsWith('Peak gain')) && titles.some((t) => t.startsWith('Elevation')) && !titles.some((t) => t.startsWith('Front to back')), `gain, take-off angle, SWR and impedance - no F/B for a dipole: ${titles.join(' | ')}`);
  // The take-off angle at each point, read back through the chart's own hover readout.
  const angles = [];
  const elevationChart = `[...document.querySelectorAll('.sweep-panel .xy-chart')].find((f) => f.querySelector('.chart-title')?.textContent.startsWith('Elevation'))`;
  const dots = JSON.parse(await evaluate(`JSON.stringify([...${elevationChart}.querySelectorAll('circle')].map((c) => { const r = c.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }))`));
  check(dots.length === 7, `seven solved points on the elevation curve (${dots.length})`);
  await evaluate(`${elevationChart}.scrollIntoView({ block: 'center' })`);
  await sleep(300);
  const dotsNow = JSON.parse(await evaluate(`JSON.stringify([...${elevationChart}.querySelectorAll('circle')].map((c) => { const r = c.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }))`));
  for (const d of dotsNow) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: d.x, y: d.y });
    await sleep(80);
    const r = await evaluate(`${elevationChart}.querySelector('.chart-readout strong')?.textContent ?? ''`);
    angles.push(Number(r));
  }
  check(angles.every((a, i) => i === 0 || a <= angles[i - 1]) && angles[6] < angles[0] - 20, `the take-off angle falls as it is raised: ${angles.join('°, ')}°`);
  if (screenshot) {
    const box = JSON.parse(await evaluate(`(() => { const r = document.querySelector('.sweep-panel').getBoundingClientRect(); return JSON.stringify({ x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }); })()`));
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...box, scale: 1 } });
    writeFileSync(screenshot.replace(/.png$/i, '-sweep.png'), Buffer.from(data, 'base64'));
  }
  // Pick the 15 m point and use it.
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dotsNow[3].x, y: dotsNow[3].y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dotsNow[3].x, y: dotsNow[3].y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(300);
  const use = await evaluate(`[...document.querySelectorAll('.sweep-panel button')].find((b) => b.textContent.startsWith('Use '))?.textContent ?? ''`);
  check(use === 'Use 15.000 m', `a click picks the point: "${use}"`);
  check(await evaluate(`(() => { const b = [...document.querySelectorAll('.sweep-panel button')].find((x) => x.textContent.startsWith('Use ')); b.click(); return true; })()`), use);
  check(await until(`document.querySelector('.sweep-panel')?.textContent.includes('has changed since this sweep')`), 'the model takes it, and the sweep says it is now out of date');
}

/**
 * The RF exposure map, driven as a person would: a dipole 10 m over real ground, map the
 * field, then type limits either side of what it found and check the verdict and the
 * boundary follow. Value-agnostic on purpose: the physics is held by tests/exposure.test.ts;
 * this checks the page does what the numbers say. With --screenshot out.png it also saves
 * out-exposure.png, for a person to look at.
 */
async function runExposureTest({ send, evaluate, loadExample, log, screenshot }) {
  const check = (ok, message) => {
    if (!ok) throw new Error(`Exposure test failed: ${message}`);
    log(`ok  ${message}`);
  };
  const until = async (expr, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await evaluate(expr)) return true;
      await sleep(200);
    }
    return false;
  };
  const typeNumber = async (label, text) => {
    const focused = await evaluate(`(() => {
      const input = [...document.querySelectorAll('.exposure label.field')].find((l) => l.querySelector('.field-label')?.textContent.trim() === ${JSON.stringify(label)})?.querySelector('input');
      if (!input) return false;
      input.focus();
      input.select();
      return true;
    })()`);
    if (!focused) return false;
    await send('Input.insertText', { text: String(text) });
    for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await sleep(300);
    return true;
  };
  const verdictText = () => evaluate(`(document.querySelector('.exposure-verdict')?.textContent ?? '') + ' ' + (document.querySelector('.exposure-flag')?.textContent ?? '')`);
  /** The figure the verdict states as the peak, in V/m, from text like "reaches 12.3 V/m" or "850 mV/m". */
  const peakOf = (text) => {
    const m = /reaches ([\d.]+) (m|µ|k)?V\/m/.exec(text);
    if (!m) return NaN;
    return Number(m[1]) * ({ m: 1e-3, µ: 1e-6, k: 1e3 }[m[2]] ?? 1);
  };

  await loadExample('dipole-20m-over-ground');
  await evaluate(`localStorage.removeItem('emws.exposure.v1')`);
  check(await until(`document.querySelector('.exposure') !== null`), 'the RF exposure panel is under the results');
  const said = await evaluate(`document.querySelector('.exposure > p.muted')?.textContent ?? ''`);
  check(/no exposure limits/.test(said), 'and says EMWS states no limits');

  check(await evaluate(`(() => { const b = [...document.querySelectorAll('.exposure button')].find((x) => x.textContent.trim() === 'Map the field'); if (!b) return false; b.click(); return true; })()`), 'Map the field');
  check(await until(`document.querySelectorAll('.exposure-map rect.exposure-cell').length === 1681`, 45_000), 'a 41 x 41 map is drawn');
  let text = await verdictText();
  const peak = peakOf(text);
  check(Number.isFinite(peak) && peak > 0, `the verdict states the peak: ${text.replace(/\s+/g, ' ').slice(0, 160)}…`);
  check(/Type your regulator's limit/.test(text), 'and, with no limit typed, asks for one rather than judging');
  // Cells only - the key has a grey swatch of its own, which once made this check pass for
  // the wrong reason. The plane is 8 m below this wire, so nothing on it is too close.
  check((await evaluate(`document.querySelectorAll('.exposure-map rect.exposure-cell.exposure-untrusted').length`)) === 0, 'at 2 m under a 10 m high dipole no cell is too close to trust');

  // A limit at half the peak must be crossed somewhere; twice the peak, nowhere.
  check(await typeNumber('Your limit, electric', (peak / 2).toPrecision(3)), `limit at half the peak: ${(peak / 2).toPrecision(3)} V/m`);
  text = await verdictText();
  check(/Over your/.test(text) && /from the nearest wire/.test(text), `crossed, and how far out: ${text.replace(/\s+/g, ' ').match(/Over your.*$/)?.[0]}`);
  check(await evaluate(`(document.querySelector('.exposure-map path.exposure-boundary')?.getAttribute('d') ?? '').length > 0`), 'the boundary is drawn where it is crossed');
  const legend = await evaluate(`document.querySelector('.exposure-legend')?.textContent ?? ''`);
  check(/where your .* is crossed/.test(legend) && /too close to a wire/.test(legend), 'and the key names both the boundary and the untrusted cells, in words');
  if (screenshot) {
    await evaluate(`document.querySelector('.exposure-map').scrollIntoView({ block: 'center' })`);
    await sleep(300);
    // The clip is in document coordinates; getBoundingClientRect is in the viewport's.
    const box = JSON.parse(await evaluate(`(() => { const r = document.querySelector('.exposure').getBoundingClientRect(); return JSON.stringify({ x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }); })()`));
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...box, scale: 1 } });
    writeFileSync(screenshot.replace(/.png$/i, '-exposure.png'), Buffer.from(data, 'base64'));
  }
  check(await typeNumber('Your limit, electric', (peak * 2).toPrecision(3)), `limit at twice the peak: ${(peak * 2).toPrecision(3)} V/m`);
  text = await verdictText();
  check(/Nowhere on this map over your/.test(text), 'nowhere over it');
  check(await evaluate(`document.querySelector('.exposure-map path.exposure-boundary') === null`), 'and no boundary drawn');

  // SSB's 20 % duty: the field falls by sqrt(0.2).
  await evaluate(`(() => { const s = [...document.querySelectorAll('.exposure select')].find((x) => x.closest('label')?.textContent.includes('Mode')); const o = [...s.options].find((x) => x.textContent.startsWith('SSB')); s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(300);
  const ssb = peakOf(await verdictText());
  check(Math.abs(ssb / peak - Math.sqrt(0.2)) < 0.01, `SSB's 20 % duty scales the field by sqrt(0.2): ${peak} -> ${ssb} V/m (${(ssb / peak).toFixed(4)})`);

  // Hover reads a cell out.
  const box = JSON.parse(await evaluate(`JSON.stringify(document.querySelector('.exposure-map svg').getBoundingClientRect())`));
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + box.width * 0.25, y: box.y + box.height * 0.3 });
  await sleep(200);
  const readout = await evaluate(`document.querySelector('.exposure-map .chart-readout')?.textContent ?? ''`);
  check(/X .* m, Y .* m: .*from the nearest/.test(readout), `hovering reads the cell out: ${readout.replace(/\s+/g, ' ')}`);

  // A changed model makes the map stale, and the page says so.
  await loadExample('dipole-20m-free-space');
  check(await until(`document.querySelector('.exposure') !== null && document.querySelector('.exposure-map') === null`), 'a new model clears the old map rather than showing it as current');
  // In free space the plane runs through the wire: the cells along it must be greyed.
  check(await evaluate(`(() => { const b = [...document.querySelectorAll('.exposure button')].find((x) => x.textContent.trim() === 'Map the field'); if (!b) return false; b.click(); return true; })()`), 'map the free-space dipole, the plane through its wire');
  check(await until(`document.querySelectorAll('.exposure-map rect.exposure-cell').length === 1681`, 45_000), 'drawn');
  const untrusted = await evaluate(`document.querySelectorAll('.exposure-map rect.exposure-cell.exposure-untrusted').length`);
  check(untrusted > 0 && untrusted < 100, `the ${untrusted} cells along the wire are greyed out as too close to trust`);
  await evaluate(`localStorage.removeItem('emws.exposure.v1')`);
}

/**
 * The installable app: manifest, service worker, and the promise that matters - pull the
 * network out and the whole suite, solver included, still works.
 */
async function runPwaTest({ evaluate, send, problems, log }) {
  const check = (ok, message) => {
    if (!ok) throw new Error(`PWA test failed: ${message}`);
    log(`ok  ${message}`);
  };
  const evalAsync = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
  const until = async (expr, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await evaluate(expr)) return true;
      await sleep(200);
    }
    return false;
  };

  check(await evaluate('window.isSecureContext'), 'a secure origin, which the worker needs');
  const manifest = await evalAsync(`fetch('manifest.webmanifest').then((r) => (r.ok ? r.json() : null)).catch(() => null)`);
  check(manifest && manifest.name.includes('EMWS') && manifest.display === 'standalone', `the manifest is served and standalone: ${manifest?.name}`);
  check(Array.isArray(manifest.icons) && manifest.icons.length === 2 && manifest.icons.some((i) => i.purpose === 'maskable'), 'with an any icon and a maskable one');

  const controlled = await until(`navigator.serviceWorker?.controller !== null && navigator.serviceWorker?.controller !== undefined`, 30_000);
  if (!controlled) {
    // A failed install (one 404 in the precache list is enough) looks just like no
    // registration at all, so say which it was before failing.
    const reg = await evalAsync(
      `navigator.serviceWorker.getRegistration().then((r) => JSON.stringify(r ? { installing: !!r.installing, waiting: !!r.waiting, active: !!r.active } : null)).catch((e) => String(e))`,
    );
    log(`    registration: ${reg}`);
  }
  check(controlled, 'the service worker takes the page');
  const cacheName = await evalAsync(`caches.keys().then((k) => k.find((n) => n.startsWith('emws-')) ?? '')`);
  check(cacheName.startsWith('emws-'), `a versioned cache: ${cacheName}`);
  const cached = await evalAsync(`caches.open(${JSON.stringify(cacheName)}).then((c) => c.keys()).then((k) => k.length)`);
  check(cached > 15, `${cached} files precached`);
  // ONE engine: the one this browser runs, never both - the suite's own rule.
  const engines = await evalAsync(`caches.open(${JSON.stringify(cacheName)}).then((c) => c.keys()).then((k) => k.filter((r) => r.url.endsWith('.wasm')).map((r) => r.url.split('/').pop()))`);
  const simd = await evaluate(`WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,10,9,1,7,0,65,0,253,15,26,11]))`);
  check(engines.length === 1 && engines[0].startsWith(simd ? 'nec2c-simd-' : 'nec2c-') && (simd || !engines[0].startsWith('nec2c-simd-')), `exactly one engine cached, the ${simd ? 'SIMD' : 'plain'} one this browser runs: ${engines.join(', ')}`);

  // Pull the network out. A reload now must come entirely from the worker's cache.
  const beforeOffline = problems.length;
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await send('Page.navigate', { url: new URL('#/toolbox', baseUrl).href });
  await sleep(300);
  await send('Page.reload', {});
  check(await until(`document.querySelector('h1')?.textContent === 'RF toolbox'`, 30_000), 'offline: a full reload still serves the app');
  // A lazy tool chunk and the solver's WASM, all from the cache: solve a model with no network.
  await send('Page.navigate', { url: new URL('#/antenna', baseUrl).href });
  check(await until(`[...document.querySelectorAll('.summary > div')].some((d) => d.querySelector('dt')?.textContent === 'Feed impedance')`, 45_000), 'offline: the modeler opens and SOLVES - engine, worker and chunk all from the cache');
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  log('    (network restored)');
  // Offline, the optional community store cannot answer its health probe - which is the
  // designed outcome (its panel simply stays away), so those failures are not loose problems.
  // Anything else that failed offline, a precached file that was not, stays reported.
  const offline = problems.splice(beforeOffline);
  const probes = offline.filter((p) => p.includes('community/index.php'));
  let bare = probes.length;
  const kept = offline.filter((p) => {
    if (probes.includes(p)) return false;
    if (bare > 0 && p === 'request failed: net::ERR_INTERNET_DISCONNECTED') {
      bare--;
      return false;
    }
    return true;
  });
  problems.push(...kept);
  check(kept.length === 0, `offline, nothing failed but the optional community probe (${probes.length})${kept.length ? `: ${kept.join('; ')}` : ''}`);

  // Print: the results stay, the controls go. Checked on the solved modeler page.
  await send('Emulation.setEmulatedMedia', { media: 'print' });
  const printed = JSON.parse(
    await evaluate(`JSON.stringify({
      panel: getComputedStyle(document.querySelector('aside.side-panel')).display,
      buttons: [...document.querySelectorAll('button')].filter((b) => getComputedStyle(b).display !== 'none').length,
      summary: getComputedStyle(document.querySelector('.summary')).display,
      plots: [...document.querySelectorAll('figure.plot')].filter((f) => getComputedStyle(f).display !== 'none').length,
      background: getComputedStyle(document.body).backgroundColor,
    })`),
  );
  await send('Emulation.setEmulatedMedia', { media: '' });
  check(printed.panel === 'none' && printed.buttons === 0, `print hides the side panel and every button (${printed.buttons} left)`);
  check(printed.summary !== 'none' && printed.plots > 0, `and keeps the summary and ${printed.plots} plots`);
  check(printed.background === 'rgb(255, 255, 255)', `on white paper: ${printed.background}`);
}

/** Drives the field sandbox: a scene plays and paints, a sheet is drawn with the mouse and undone, a buried source is caught. */
async function runFdtdTest({ evaluate, send, log, screenshot }) {
  const check = (ok, message) => {
    if (!ok) throw new Error(`Field sandbox test failed: ${message}`);
    log(`ok  ${message}`);
  };
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
      const select = [...document.querySelectorAll('select')].find((s) => s.closest('label')?.textContent.includes(${JSON.stringify(label)}));
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
  const until = async (expr, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await evaluate(expr)) return true;
      await sleep(150);
    }
    return false;
  };
  const statusOf = (name) => `parseFloat([...document.querySelectorAll('.field-status > div')].find((d) => d.querySelector('dt')?.textContent === ${JSON.stringify(name)})?.querySelector('dd')?.textContent ?? '0')`;
  const shapeCount = () => evaluate(`JSON.parse(localStorage.getItem('emws.fdtd.v1') ?? '{"shapes":[]}').shapes.length`);
  /** With --screenshot out.png, the pictures along the way as out-<suffix>.png. */
  const shoot = async (suffix) => {
    if (!screenshot) return;
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(screenshot.replace(/.png$/i, `-${suffix}.png`), Buffer.from(data, 'base64'));
  };
  const state = async () =>
    JSON.parse(
      await evaluate(`JSON.stringify({
        tools: [...document.querySelectorAll('.tool-buttons button')].map((b) => b.textContent.trim()),
        status: Object.fromEntries([...document.querySelectorAll('.field-status > div')].map((d) =>
          [(d.querySelector('dt')?.textContent ?? '').trim(), (d.querySelector('dd')?.textContent ?? '').trim()])),
        play: [...document.querySelectorAll('.run-buttons button')].map((b) => b.textContent.trim()),
        issues: [...document.querySelectorAll('.issue-text')].map((e) => e.textContent),
        legend: document.querySelector('.field-legend')?.textContent ?? '',
        gridNote: document.querySelector('.grid-note')?.textContent ?? '',
      })`),
    );

  const typeNumber = async (label, text) => {
    const focused = await evaluate(`(() => {
      const input = [...document.querySelectorAll('.sandbox label.field')].find((l) => l.querySelector('.field-label')?.textContent.trim() === ${JSON.stringify(label)})?.querySelector('input');
      if (!input) return false;
      input.focus();
      input.select();
      return true;
    })()`);
    if (!focused) return false;
    await send('Input.insertText', { text: String(text) });
    for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await sleep(300);
    return true;
  };
  const fieldValue = (label) => evaluate(`[...document.querySelectorAll('.sandbox label.field')].find((l) => l.querySelector('.field-label')?.textContent.trim() === ${JSON.stringify(label)})?.querySelector('input')?.value`);

  // A fresh start: the first scene, paused.
  await evaluate(`(localStorage.removeItem('emws.fdtd.v1'), location.reload())`);
  check(await until(`document.querySelector('canvas.field-canvas') !== null && document.querySelectorAll('.tool-buttons button').length === 5`, 15_000), 'the sandbox loads');
  let now = await state();
  check(now.tools.join('|') === 'Conductor|Dielectric|Source|Probe|Select', `five tools: ${now.tools.join(', ')}`);
  check(now.legend.includes('10.0 × 6.7 wavelengths'), `the world is ten wavelengths wide: ${now.legend.trim()}`);
  check(now.gridNote.includes('200 × 133 cells'), `on a 200 x 133 grid: ${now.gridNote.trim()}`);
  check(now.play[0] === 'Play', 'paused at the start');

  // Every control explains itself when the pointer rests on it.
  const bare = JSON.parse(
    await evaluate(`JSON.stringify([...document.querySelectorAll('.sandbox .panel label, .sandbox .panel button, .sandbox .field-status > div')]
      .filter((el) => !el.closest('[title]')?.getAttribute('title'))
      .map((el) => el.textContent.trim().slice(0, 30)))`),
  );
  check(bare.length === 0, `every control has hover text${bare.length ? `; these do not: ${bare.join(' | ')}` : ''}`);
  const polarisationHint = await evaluate(`document.querySelector('.polarisation-picker')?.closest('label')?.getAttribute('title') ?? ''`);
  check(/Brewster/.test(polarisationHint), `the polarisation picker says what Ez and Hz mean: "${polarisationHint.slice(0, 60)}…"`);

  // The frequency scales the scene: a tenth of the frequency is ten times the metres and the same cells.
  check(await typeNumber('Frequency', '100'), 'Frequency: 100 MHz');
  now = await state();
  check(now.gridNote.includes('200 × 133 cells of 149.9'), `the picture keeps its 200 x 133 cells: ${now.gridNote.trim()}`);
  check((await fieldValue('Width')) === '30' && (await fieldValue('Height')) === '20', 'and the world is now 30 x 20 m');
  check(await until(`JSON.parse(localStorage.getItem('emws.fdtd.v1')).shapes.every((s) => s.geometry.x1 === 14)`), 'with the wall drawn at 14 m instead of 1.4');
  check(now.legend.includes('10.0 × 6.7 wavelengths'), 'still ten wavelengths wide');
  // Held in metres instead, the same change leaves a one-wavelength world - and says so.
  check(await click('.panel label.check', 'Scale the scene'), 'untick Scale the scene with the frequency');
  check(await typeNumber('Frequency', '10'), 'Frequency: 10 MHz, metres held');
  now = await state();
  check(now.gridNote.includes('20 × 13 cells'), `the picture is now 20 x 13 cells: ${now.gridNote.trim()}`);
  check(now.issues.some((t) => t.includes('only 1.0 × 0.7 wavelengths')), 'and the panel says the world is only a wavelength wide');
  // Ctrl+Z inside a text box is the box's own undo, so leave the box first.
  await evaluate(`document.activeElement?.blur()`);
  for (let n = 0; n < 3; n++) {
    for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90 });
    await sleep(200);
  }
  check((await fieldValue('Frequency')) === '1000' && (await fieldValue('Width')) === '3', 'three Ctrl+Z put the scene back at 1000 MHz and 3 m');

  // Play: the field must come up and time must pass.
  check(await click('.run-buttons button', 'Play'), 'Play');
  check(await until(`${statusOf('Peak |Ez|')} > 0.01`, 15_000), 'the field comes up');
  check(await until(`${statusOf('Time')} > 3`, 30_000), 'and time passes: more than 3 ns of it');
  now = await state();
  log(`    ${now.status.Speed}`);
  // Both signs of the field are painted, and the wall is drawn in ink.
  const colours = JSON.parse(
    await evaluate(`(() => {
      const c = document.querySelector('canvas.field-canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let cool = 0, warm = 0, ink = 0;
      for (let p = 0; p < d.length; p += 16) {
        const r = d[p], g = d[p + 1], b = d[p + 2];
        if (b > r + 40) cool++; else if (r > b + 40) warm++;
        if (r < 70 && g < 70 && b < 80) ink++;
      }
      return JSON.stringify({ cool, warm, ink });
    })()`),
  );
  check(colours.cool > 100 && colours.warm > 100, `both signs of the field are painted (${colours.cool} cool, ${colours.warm} warm samples)`);
  check(colours.ink > 20, `and the wall is drawn in ink (${colours.ink} samples)`);

  // Pause and draw a conductor with the mouse.
  check(await click('.run-buttons button', 'Pause'), 'Pause');
  const box = JSON.parse(await evaluate(`JSON.stringify(document.querySelector('canvas.field-canvas').getBoundingClientRect())`));
  const drag = async (fx1, fy1, fx2, fy2) => {
    const x1 = box.left + box.width * fx1;
    const y1 = box.top + box.height * fy1;
    const x2 = box.left + box.width * fx2;
    const y2 = box.top + box.height * fy2;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1 });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1 });
    for (let s = 1; s <= 8; s++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1 + ((x2 - x1) * s) / 8, y: y1 + ((y2 - y1) * s) / 8, button: 'left' });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 });
    await sleep(350);
  };
  const before = await shapeCount();
  await drag(0.7, 0.3, 0.7, 0.7);
  let shapes = await shapeCount();
  check(shapes === before + 1, `a drag draws one conductor (${before} -> ${shapes})`);
  now = await state();
  check((now.status.Time ?? '').startsWith('0.00 ns'), 'and the clock restarts, because the scene is the simulation');
  for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90 });
  await sleep(300);
  shapes = await shapeCount();
  check(shapes === before, 'Ctrl+Z takes it away again');

  // A source clicked into the wall is caught by the checks; deleting it clears them.
  check(await click('.tool-buttons button', 'Source'), 'Source tool');
  await drag(1.4 / 3, 0.75, 1.4 / 3, 0.75);
  now = await state();
  check(now.issues.some((t) => t.includes('inside a conductor')), 'a source clicked into the wall draws the warning');
  check(await click('.selected-item button', 'Delete it'), 'Delete it');
  now = await state();
  check(!now.issues.some((t) => t.includes('inside a conductor')), 'and deleting it clears the warning');

  // Another scene plays at once.
  check(await choose('Start from', 'Corner reflector'), 'Start from: Corner reflector');
  check(await until(`JSON.parse(localStorage.getItem('emws.fdtd.v1')).shapes.length === 2`), 'two sheets in the scene');
  now = await state();
  check(now.play[0] === 'Pause', 'and it plays');

  // Brewster's angle: a plane wave in Hz over a ground, and the checks say what the slant costs.
  check(await choose('Start from', "Brewster's angle"), "Start from: Brewster's angle");
  check(await until(`document.querySelector('.polarisation-picker')?.value === 'te'`), 'the scene is in Hz');
  now = await state();
  check(now.legend.includes('Hz negative'), `the legend names Hz: ${now.legend.trim().slice(0, 40)}`);
  check(now.issues.some((t) => t.includes('starts in empty space only')), 'the ground reaching the side the wave slants in by is reported');
  check(await until(`${statusOf('Peak |Hz|')} > 0.5`, 20_000), 'the plane wave comes in at about its own amplitude');
  // 15 ns is the wave across the world and back three times over: anything that would stand has stood.
  check(await until(`${statusOf('Time')} > 15`, 60_000), 'the wave has filled the world');
  check(await until(`${statusOf('Peak |Hz|')} < 1.25`, 2_000), `and nothing stands above the ground (peak ${(await state()).status['Peak |Hz|']})`);
  await shoot('brewster-hz');

  // The probe: click a point above the ground, and the trace and its spectrum come up at the scene's frequency.
  check(await click('.tool-buttons button', 'Probe'), 'Probe tool');
  await drag(0.75, 0.3, 0.75, 0.3);
  check(await until(`document.querySelectorAll('.probe-charts .xy-chart').length === 2`, 30_000), 'the probe shows its trace and its spectrum');
  const strongest = await evaluate(`parseFloat((document.querySelector('.probe-head p')?.textContent ?? '').split('strongest at')[1] ?? 'NaN')`);
  check(Math.abs(strongest - 1000) < 30, `the spectrum peaks at the scene's 1000 MHz (${strongest} MHz)`);
  const clockBefore = await evaluate(statusOf('Time'));
  await drag(0.6, 0.35, 0.6, 0.35);
  await sleep(300);
  check((await evaluate(statusOf('Time'))) >= clockBefore, 'moving the probe does not restart the clock');

  // The same scene in Ez: horizontal polarisation reflects, so a standing wave forms over the ground.
  check(await choose('Polarisation', 'Ez'), 'Polarisation: Ez');
  check(await until(`${statusOf('Peak |Ez|')} > 1.3`, 30_000), `horizontal polarisation stands over the ground (${(await state()).status['Peak |Ez|']})`);
  check(await until(`(document.querySelector('.probe-head p')?.textContent ?? '').includes('strongest at')`, 20_000), 'the probe records again from the new start');
  await shoot('brewster-ez');
  check(await click('.probe-head button', 'Remove the probe'), 'Remove the probe');
  check(!(await evaluate(`document.querySelector('.probe-charts') !== null`)), 'and its charts go with it');

  // Average ground on 40 m: a 7.1 MHz world in metres, with the envelope showing the lobes.
  check(await choose('Start from', 'Average ground on 40 m'), 'Start from: Average ground on 40 m');
  now = await state();
  check(now.gridNote.includes('284 × 142 cells'), `at 40 cells a wavelength: ${now.gridNote.trim()}`);
  check(!now.issues.some((t) => t.includes('times shorter')), 'with the ground resolved too: no warning about it');
  check(await choose('Show', 'envelope'), 'Show: its envelope');
  check(await until(`${statusOf('Time')} > 3000`, 90_000), 'the wave has crossed the world three times');
  await shoot('ground-40m');
}

/** One visitor measures and shares a core; another takes it and designs on it. */
async function runCommunityTest({ evaluate, send, log }) {
  const check = (ok, message) => {
    if (!ok) throw new Error('Community test failed: ' + message);
    log('ok  ' + message);
  };
  const until = async (expr, ms = 15_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await evaluate(expr)) return true;
      await sleep(150);
    }
    return false;
  };
  const clickText = async (selector, text) => {
    const done = await evaluate('(() => { const b = [...document.querySelectorAll(' + JSON.stringify(selector) + ')].find((e) => e.textContent.trim().startsWith(' + JSON.stringify(text) + ')); if (!b) return false; b.click(); return true; })()');
    await sleep(250);
    return done;
  };
  /** React-controlled inputs only notice a value set through the native setter. */
  const setInput = (selector, value) =>
    evaluate('(() => { const el = document.querySelector(' + JSON.stringify(selector) + '); if (!el) return false; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ' + JSON.stringify(value) + '); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()');
  const signInAs = async (callsign) => {
    check(await setInput('.community-signin input[type="text"]', callsign), 'callsign typed: ' + callsign);
    check(await setInput('.community-signin input[type="password"]', 'a smoke passphrase'), 'password typed');
    check(await clickText('.community-signin button', 'Register'), 'Register');
    check(await until('document.querySelector(".community .vna-status")?.textContent.includes(' + JSON.stringify(callsign) + ')'), 'signed in as ' + callsign);
  };

  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  const coreName = 'Smoke shared core ' + suffix;

  // A measured core in the local bin: the raw sweep is the truth, the curve re-derives.
  const sweep = Array.from({ length: 24 }, (_, i) => {
    const fMHz = 1 * 30 ** (i / 23);
    return { fMHz, r: 20 + 60 * Math.sqrt(fMHz), x: 2 * Math.PI * fMHz * 1e6 * 30e-6 };
  });
  const profile = {
    id: 'smk-' + suffix, name: coreName, size: { id: 'FT240', name: 'FT240', odMm: 61, idMm: 35.55, heightMm: 12.7 },
    family: 'NiZn', mix: '#43', measuredAt: new Date().toISOString(),
    setup: { turns: 8, strayPf: 0, stack: 1 }, sweep, curve: [],
  };
  await evaluate('localStorage.setItem("emws.balun.cores.v1", ' + JSON.stringify(JSON.stringify([profile])) + ')');
  await evaluate('location.reload()');
  await sleep(1500);

  check(await until('document.querySelector(".community") !== null'), 'the site has a store, so the Community section exists');
  await evaluate('document.querySelector(".community").scrollIntoView({ block: "center" })');
  await signInAs('SMOKE-A' + suffix);
  check(await until('[...document.querySelectorAll(".community-list li")].some((li) => li.textContent.includes(' + JSON.stringify(coreName) + '))'), 'the measured core is offered for keeping and sharing');
  // The buttons sit disabled while the sign-in's own refresh is in flight.
  check(await until('[...document.querySelectorAll(".community-list button")].length > 0 && ![...document.querySelectorAll(".community-list button")].some((b) => b.disabled)'), 'and its buttons are live');
  check(await clickText('.community-list button', 'Share…'), 'Share…');
  check(await until('document.querySelector(".community-dedication") !== null'), 'the dedication appears before anything is shared');
  const dedication = await evaluate('document.querySelector(".community-dedication")?.textContent ?? ""');
  check(/public domain/.test(dedication) && /CC0/.test(dedication), 'in words: CC0, public domain, callsign shown');
  check(await clickText('.community-dedication button', 'Share it, CC0'), 'Share it, CC0');
  check(await until('[...document.querySelectorAll(".community h4")].some((h) => h.textContent === "Shared by the community") && [...document.querySelectorAll(".community-list li")].filter((li) => li.textContent.includes("by SMOKE-A' + suffix + '")).length === 1'), 'and it appears on the community shelf, with the callsign');

  // The second visitor: fresh account, fresh (empty) local bin.
  check(await clickText('.community button', 'Sign out'), 'sign out');
  await evaluate('localStorage.removeItem("emws.balun.cores.v1")');
  await evaluate('location.reload()');
  await sleep(1500);
  await evaluate('document.querySelector(".community")?.scrollIntoView({ block: "center" })');
  await signInAs('SMOKE-B' + suffix);
  const row = '[...document.querySelectorAll(".community-list li")].find((li) => li.textContent.includes(' + JSON.stringify(coreName) + ') && li.textContent.includes("by SMOKE-A' + suffix + '"))';
  check(await until(row + ' !== undefined'), 'the other visitor sees it, by SMOKE-A' + suffix);
  check(await evaluate('(() => { const li = ' + row + '; const b = li && [...li.querySelectorAll("button")].find((x) => x.textContent.includes("Add to my cores")); if (!b) return false; b.click(); return true; })()'), 'Add to my cores');
  const landed = await until('[...document.querySelectorAll(".bin .core-chip")].some((c) => (c.getAttribute("aria-label") ?? c.textContent).includes("SMOKE-A' + suffix + '"))', 20_000);
  if (!landed) log(`    the panel says: ${await evaluate('[...document.querySelectorAll(".community .alert-inline, .community .community-taken")].map((e) => e.textContent).join(" | ") || "(nothing)"')}; bin: ${await evaluate('[...document.querySelectorAll(".bin .core-chip")].map((c) => c.getAttribute("aria-label") ?? c.textContent).join(", ") || "(empty)"')}`);
  check(landed, 'it lands in their bin, named with its measurer');
  check(await evaluate('(() => { const c = [...document.querySelectorAll(".bin .core-chip")].find((x) => (x.getAttribute("aria-label") ?? x.textContent).includes("SMOKE-A' + suffix + '")); if (!c) return false; c.click(); return true; })()'), 'and a click designs on it');
  check(await until('/your measurement/.test(document.querySelector(".results-title + p")?.textContent ?? "")', 20_000), 'the results say they come from a measurement, as they must');

  // ---- the club library's other shelves: a balun design, and an antenna model ----
  const shelf = (kind) => `document.querySelector('.community-shelf[data-kind="${kind}"]')`;
  const designName = 'Smoke design ' + suffix;
  check(await evaluate(`(() => { const s = [...document.querySelectorAll('.form-section')].find((x) => x.querySelector('h3')?.textContent.startsWith('Your designs')); const i = s?.querySelector('input[type="text"]'); if (!i) return false; i.focus(); return true; })()`), 'Your designs: a name box');
  await send('Input.insertText', { text: designName });
  check(await clickText('.form-section button', 'Save this design'), 'save a design wound on the measured core');
  check(await until(`[...${shelf('balun-design')}?.querySelectorAll('.community-list li') ?? []].some((li) => li.textContent.includes(${JSON.stringify(designName)}))`), 'it is offered on the balun-design shelf');
  check(await evaluate(`(() => { const li = [...${shelf('balun-design')}.querySelectorAll('.community-list li')].find((x) => x.textContent.includes(${JSON.stringify(designName)})); const b = li && [...li.querySelectorAll('button')].find((x) => x.textContent.startsWith('Share')); if (!b) return false; b.click(); return true; })()`), 'Share…');
  check(await clickText('.community-dedication button', 'Share it, CC0'), 'through the same CC0 dedication');
  check(await until(`[...${shelf('balun-design')}.querySelectorAll('.community-list li')].some((li) => li.textContent.includes(${JSON.stringify(designName)}) && li.textContent.includes('by SMOKE-B'))`), 'and it is on the shelf for everyone, by SMOKE-B');

  await send('Page.navigate', { url: new URL('#/antenna', baseUrl).href });
  check(await until(`document.querySelector('.example-picker') !== null`, 20_000), 'the Antenna Modeler opens');
  await evaluate(`(() => { const s = document.querySelector('.example-picker'); s.value = 'ocf-dipole-windom'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  check(await until(`${shelf('antenna-model')} !== null`, 20_000), 'with a Club library section, the store being here');
  const modelName = await evaluate(`${shelf('antenna-model')}.querySelector('.community-list li .community-name')?.textContent ?? ''`);
  check(modelName.length > 0, `this model is offered, named by its notes: ${modelName}`);
  check(await evaluate(`(() => { const b = [...${shelf('antenna-model')}.querySelectorAll('.community-list li button')].find((x) => x.textContent.startsWith('Share')); if (!b) return false; b.click(); return true; })()`), 'Share…');
  check(await clickText('.community-dedication button', 'Share it, CC0'), 'Share it, CC0');
  check(await until(`[...${shelf('antenna-model')}.querySelectorAll('.community-list li')].some((li) => li.textContent.includes('by SMOKE-B') && li.querySelector('button')?.textContent === 'Open it')`), 'the model is on the shelf, to open');
  // Load something else, then open the shared Windom back: deck AND its 200 Ω reference.
  await evaluate(`(() => { const s = document.querySelector('.example-picker'); s.value = 'dipole-20m-free-space'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(800);
  check(await evaluate(`(() => { const li = [...${shelf('antenna-model')}.querySelectorAll('.community-list li')].find((x) => x.textContent.includes('by SMOKE-B')); const b = li && [...li.querySelectorAll('button')].find((x) => x.textContent === 'Open it'); if (!b) return false; b.click(); return true; })()`), 'Open it');
  check(await until(`(document.querySelector('.note')?.textContent ?? '').includes('From the club library') && (document.querySelector('.note')?.textContent ?? '').includes('SMOKE-B')`), 'it opens, credited to who shared it');
  check(await until(`document.querySelector('input.z0[aria-label="Reference impedance in ohms"]')?.value === '200'`, 20_000), 'with the Windom\'s 200 Ω reference carried across');
}

async function runVnaTest({ evaluate, send, log }) {
  const check = (ok, message) => {
    if (!ok) throw new Error(`VNA test failed: ${message}`);
    log(`ok  ${message}`);
  };
  const clickText = async (selector, text) => {
    const done = await evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)})); if (!b) return false; b.click(); return true; })()`);
    await sleep(300);
    return done;
  };
  const until = async (expr, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await evaluate(expr)) return true;
      await sleep(150);
    }
    return false;
  };

  const secure = await evaluate('window.isSecureContext');
  if (!secure) {
    const note = await evaluate(`document.querySelector('.vna-unavailable')?.textContent ?? ''`);
    check(/secure page|https/i.test(note), `on a plain-http origin the tool says why the VNA is unavailable: "${note.slice(0, 90)}…"`);
    log('    (run against https:// or localhost to exercise the instrument itself)');
    return;
  }
  if (process.env.SMOKE_DEBUG) console.error('vna debug:', await evaluate(`JSON.stringify({ sim: window.__emwsSimulatedVna, err: window.__emwsSimError, secure: window.isSecureContext, serial: typeof navigator.serial })`));
  check(await evaluate('window.__emwsSimulatedVna === true'), 'a simulated NanoVNA-H is on the (fake) serial port');

  // ---- Smith chart: the load straight off the instrument ----
  const before = await evaluate(`document.querySelector('.summary')?.textContent ?? ''`);
  check(await clickText('.vna button', 'Connect a NanoVNA'), 'Smith chart: Connect a NanoVNA…');
  check(await until(`document.querySelector('.vna-status')?.textContent.includes('connected')`), `connected: ${await evaluate(`document.querySelector('.vna-status strong')?.textContent`)}`);
  check(await clickText('.vna button', 'Measure the load'), 'Measure the load');
  check(await until(`(document.querySelector('.summary')?.textContent ?? '') !== ${JSON.stringify(before)}`), 'and the chart takes it as the load');
  const load = await evaluate(`document.querySelector('.form-section p.muted strong')?.textContent ?? ''`);
  check(load.includes('NanoVNA-H (simulated)'), `named after the instrument: ${load}`);
  const z = await evaluate(`[...document.querySelectorAll('.summary > div')].map((d) => d.textContent).find((t) => /Load|impedance/i.test(t)) ?? document.querySelector('.summary')?.textContent ?? ''`);
  const seventyFive = (t) => t.includes('74.') || t.includes('75.');
  check(seventyFive(z), `the readout shows the 75-ohm load the instrument was fed: ${z.replace(/\s+/g, ' ').slice(0, 80)}`);

  // ---- The same load on a NanoVNA-V2: raw readings, calibrated in the page ----
  check(await clickText('.vna button', 'Disconnect'), 'disconnect the NanoVNA-H');
  await evaluate(`window.__emwsVnaPick = 'v2'`);
  check(await clickText('.vna button', 'Connect a NanoVNA'), 'connect again, to the simulated NanoVNA-V2 on the other port');
  check(await until(`document.querySelector('.vna-status')?.textContent.includes('NanoVNA-V2')`), `connected: ${await evaluate(`document.querySelector('.vna-status strong')?.textContent`)}`);
  check(await evaluate(`document.querySelector('.vna-calibration') !== null`), 'it asks for a short-open-load calibration');
  check(await evaluate(`[...document.querySelectorAll('.vna button')].find((b) => b.textContent.startsWith('Measure the load'))?.disabled === true`), 'and will not measure until it has one');
  for (const standard of ['short', 'open', 'load']) {
    const label = standard[0].toUpperCase() + standard.slice(1);
    await evaluate(`window.__emwsVnaAttach(${JSON.stringify(standard)})`);
    check(await clickText('.vna-calibration button', label), `${label} on the connector: measured`);
    check(await until(`[...document.querySelectorAll('.vna-calibration button')].some((b) => b.textContent.trim() === '✓ ${label}')`), 'ticked');
  }
  check(await until(`(document.querySelector('.vna-calibration')?.textContent ?? '').includes('Calibrated')`), 'calibrated from the three');
  check(await evaluate(`[...document.querySelectorAll('.vna button')].find((b) => b.textContent.startsWith('Measure the load'))?.disabled === false`), 'and now it will measure');
  await evaluate(`window.__emwsVnaAttach('antenna')`);
  const beforeV2 = await evaluate(`document.querySelector('.form-section p.muted strong')?.textContent ?? ''`);
  check(await clickText('.vna button', 'Measure the load'), 'Measure the load');
  check(await until(`(document.querySelector('.form-section p.muted strong')?.textContent ?? '') !== ${JSON.stringify(beforeV2)}`), 'taken as the load');
  const zV2 = await evaluate(`[...document.querySelectorAll('.summary > div')].map((d) => d.textContent).find((t) => /Load|impedance/i.test(t)) ?? document.querySelector('.summary')?.textContent ?? ''`);
  check(zV2 === z, `the error terms are corrected away: the V2 reads the same 75 ohms as the H did (${zV2.replace(/\s+/g, ' ').slice(0, 60)})`);

  // ---- Antenna Modeler: modelled against measured ----
  await send('Page.navigate', { url: new URL('#/antenna', baseUrl).href });
  // A hash change keeps the Smith page on screen until the modeler's chunk has arrived, so
  // wait for the modeler itself, not just for summary cards (the Smith chart has those too).
  check(await until(`document.querySelector('h1')?.textContent !== 'Smith chart and matching' && document.querySelectorAll('.summary > div').length > 2`, 30_000), 'Antenna Modeler solves its example');
  await evaluate(`[...document.querySelectorAll('details.compare')].forEach((d) => d.setAttribute('open', ''))`);
  // A hash change is not a new document, so the V2 would still be the port picked: back to the H.
  await evaluate("window.__emwsVnaPick = 'h'");
  check(await clickText('.compare .vna button', 'Connect a NanoVNA'), 'Compare with the real antenna: connect');
  check(await until(`document.querySelector('.compare .vna-status')?.textContent.includes('connected')`), 'connected');
  check(await clickText('.compare .vna button', 'Measure the antenna'), 'Measure the antenna');
  check(await until(`document.querySelector('.compare-table') !== null`), 'modelled and measured are put side by side');
  const row = await evaluate(`[...document.querySelectorAll('.compare-table tbody tr')].map((r) => r.textContent).join(' | ')`);
  check(row.includes('Impedance') && seventyFive(row), `with the instrument's 75 ohms in the measured column: ${row.replace(/\s+/g, ' ').slice(0, 110)}`);
  // The Yagi is one frequency, so there is no SWR curve to draw over. Load the sweep
  // example, measure again, and the measurement should be laid over the modelled curve.
  await evaluate(`(() => { const s = document.querySelector('.example-picker'); s.value = 'dipole-20m-swr-sweep'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  check(await until(`document.querySelector('.plot-wide') !== null && document.querySelector('.modeler')?.dataset.busy !== 'true'`, 45_000), 'the 20 m sweep example solves, with an SWR curve');
  await evaluate(`[...document.querySelectorAll('details.compare')].forEach((d) => d.setAttribute('open', ''))`);
  const stillConnected = await evaluate(`document.querySelector('.compare .vna-status')?.textContent.includes('connected') ?? false`);
  if (!stillConnected) {
    check(await clickText('.compare .vna button', 'Connect a NanoVNA'), 'connect again for the new model');
    check(await until(`document.querySelector('.compare .vna-status')?.textContent.includes('connected')`), 'connected');
  }
  check(await clickText('.compare .vna button', 'Measure the antenna'), 'Measure the antenna across the sweep');
  check(await until(`document.querySelectorAll('path.sweep-measured').length === 1`), 'and it is drawn over the modelled SWR curve, dashed, with a legend');
  const legend = await evaluate(`document.querySelector('.plot-wide .chart-legend')?.textContent ?? ''`);
  check(legend.includes('modelled') && legend.includes('measured'), `legend: ${legend.replace(/\s+/g, ' ').trim()}`);

  // ---- Balun tool: a core measured straight off the instrument, and the resonance notice ----
  await send('Page.navigate', { url: new URL('#/balun', baseUrl).href });
  check(await until(`document.querySelector('h1')?.textContent === 'Baluns and ununs'`, 30_000), 'the balun tool opens');
  await evaluate(`localStorage.removeItem('emws.balun.cores.v1')`);
  await evaluate(`[...document.querySelectorAll('details')].find((d) => d.textContent.includes('Measure the core in your hand'))?.setAttribute('open', '')`);
  await evaluate(`window.__emwsVnaPick = 'h'`);
  check(await clickText('.vna button', 'Connect a NanoVNA'), 'measure the core in your hand: connect the H');
  check(await until(`document.querySelector('.vna-status')?.textContent.includes('connected')`), 'connected');
  check(await clickText('.vna button', 'Measure this core'), 'Measure this core');
  check(await until(`document.querySelectorAll('.bin .core-chip').length === 1`), 'an inductive reading lands in the bin');
  check((await evaluate(`document.querySelector('.resonance-notice') === null`)) === true, 'with no resonance notice: it never went capacitive');
  check(await clickText('.vna button', 'Disconnect'), 'disconnect the H');

  // The V2 wound too far: a reading that goes capacitive at 7 MHz must be said to the face.
  await evaluate(`window.__emwsVnaPick = 'v2'`);
  check(await clickText('.vna button', 'Connect a NanoVNA'), 'connect the V2');
  check(await until(`document.querySelector('.vna-calibration') !== null`), 'it asks for the calibration here too');
  for (const standard of ['short', 'open', 'load']) {
    const label = standard[0].toUpperCase() + standard.slice(1);
    await evaluate(`window.__emwsVnaAttach(${JSON.stringify(standard)})`);
    check(await clickText('.vna-calibration button', label), `${label}: measured`);
    check(await until(`[...document.querySelectorAll('.vna-calibration button')].some((b) => b.textContent.trim() === '✓ ${label}')`), 'ticked');
  }
  await evaluate(`window.__emwsVnaAttach('resonant')`);
  check(await clickText('.vna button', 'Measure this core'), 'Measure this core, wound too far');
  check(await until(`document.querySelector('.resonance-notice') !== null`), 'the resonance notice appears the moment the reading is back');
  const notice = await evaluate(`document.querySelector('.resonance-notice')?.textContent ?? ''`);
  check(/resonated/.test(notice) && /trust it up to about/.test(notice) && /fewer turns/.test(notice), 'saying the resonance, the trust limit and the fix');
  const saidMHz = Number((notice.match(/up to about ([\d.]+) MHz/) ?? [])[1]);
  check(saidMHz > 2 && saidMHz < 2.8, `the limit is a third of the 7.1 MHz resonance: ${saidMHz} MHz`);
  check(await clickText('.resonance-notice button', 'Forget this measurement'), 'Forget this measurement');
  check(await until(`document.querySelector('.resonance-notice') === null && document.querySelectorAll('.bin .core-chip').length === 1`), 'and it is gone; the good reading stays');
  check(await clickText('.vna button', 'Measure this core'), 'measured again, same winding');
  check(await until(`document.querySelector('.resonance-notice') !== null`), 'warned again');
  check(await clickText('.resonance-notice button', 'Keep it'), 'Keep it, knowingly');
  check(await until(`document.querySelectorAll('.bin .core-chip').length === 2`), 'kept in the bin this time');
  await evaluate(`[...document.querySelectorAll('details')].find((d) => d.textContent.includes('Your core library'))?.setAttribute('open', '')`);
  const cards = await evaluate(`[...document.querySelectorAll('.profile-facts')].map((e) => e.textContent).join(' || ')`);
  check(/trust it up to/.test(cards), 'and its library card carries the same limit');
  await evaluate(`localStorage.removeItem('emws.balun.cores.v1')`);

  // ---- Port 2: measure a filter through the V2, thru + isolation calibrated in the page ----
  await send('Page.navigate', { url: new URL('#/lc', baseUrl).href });
  check(await until(`document.querySelector('h1')?.textContent === 'Coils, traps and filters'`, 30_000), 'the coils, traps and filters tool opens');
  check(await clickText('.lc-tab', 'Stubs & cavities'), 'Stubs & cavities');
  await evaluate(`document.querySelector('.measure-filter')?.setAttribute('open', '')`);
  await evaluate(`window.__emwsVnaPick = 'v2'`);
  check(await clickText('.measure-filter .vna button', 'Connect a NanoVNA'), 'connect the V2 for port 2');
  check(await until(`document.querySelector('.measure-filter .vna-status')?.textContent.includes('NanoVNA-V2')`), 'connected');
  check(await evaluate(`[...document.querySelectorAll('.measure-filter .vna button')].find((b) => b.textContent.trim() === 'Measure it')?.disabled === true`), 'it will not measure S21 from a raw V2 before a thru');
  await evaluate(`window.__emwsVnaPort2('thru')`);
  check(await clickText('.measure-filter .vna-calibration button', 'Thru'), 'Thru: the two cables joined');
  check(await until(`[...document.querySelectorAll('.measure-filter .vna-calibration button')].some((b) => b.textContent.trim() === '✓ Thru')`), 'ticked');
  await evaluate(`window.__emwsVnaPort2('isolation')`);
  check(await clickText('.measure-filter .vna-calibration button', 'Isolation'), 'Isolation: both cables terminated');
  check(await until(`(document.querySelector('.measure-filter .vna-calibration')?.textContent ?? '').includes('with isolation')`), 'calibrated, with isolation');
  await evaluate(`window.__emwsVnaPort2('dut')`);
  check(await clickText('.measure-filter .vna button', 'Measure it'), 'Measure it');
  check(await until(`(document.querySelector('.xy-chart .chart-legend')?.textContent ?? '').includes('measured')`), 'the measurement is drawn over the design, dashed, with a legend');
  // Hover at 145 MHz: the simulated low-pass is 3 dB down there, whatever the raw readings said.
  // Scroll first and let it settle: measured mid-scroll, the chart is not where the mouse goes.
  // The plot is the figure's own svg; the legend's line swatches are svgs too, inside the caption.
  await evaluate(`document.querySelector('.xy-chart > svg').scrollIntoView({ block: 'center' })`);
  await sleep(600);
  const point = JSON.parse(await evaluate(`(() => { const r = document.querySelector('.xy-chart > svg').getBoundingClientRect(); return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height }); })()`));
  const [lo, hi] = [145 * 0.5, 290 * 1.5];
  const px = point.x + ((52 + ((145 - lo) / (hi - lo)) * (700 - 52 - 16)) / 700) * point.w;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: point.y + point.h / 2 });
  await sleep(250);
  const readout = await evaluate(`document.querySelector('.xy-chart .chart-readout')?.textContent ?? ''`);
  if (!readout) {
    const under = await evaluate(`(() => { const e = document.elementFromPoint(${px}, ${point.y + point.h / 2}); return e ? e.tagName + '.' + (e.getAttribute('class') ?? '') + ' in ' + (e.closest('figure')?.className ?? 'no figure') : 'nothing'; })()`);
    log(`    hover debug: rect ${JSON.stringify(point)}, px ${px.toFixed(0)}, under the mouse: ${under}, viewport ${await evaluate('innerWidth + "x" + innerHeight')}`);
  }
  const measuredDb = Number((readout.match(/measured\s*(-?[\d.]+)/) ?? [])[1]);
  check(Math.abs(measuredDb + 3.01) < 0.15, `the error terms are corrected away: the low-pass reads ${measuredDb} dB at 145 MHz (${readout.replace(/\s+/g, ' ').trim()})`);
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
  const cuts = getState().figures.filter((f) => f.includes('pattern') && !f.startsWith('3-D'));
  check(getState().figures.some((f) => f.startsWith('3-D pattern at')), 'and a 3-D pattern of the whole sphere beside them');
  check(cuts.length === 2, `the automatic pattern plots two cuts through the main lobe: ${cuts.join(' | ')}`);
  check(getState().figures.some((f) => f.startsWith('SWR')), 'and the sweep keeps its SWR curve');

  // 10. Tune: the 20 m dipole's length until it is resonant at 14.2 MHz - every trial a real solve.
  await loadExample('dipole-20m-free-space');
  const tuneReady = async (expr, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await evaluate(expr)) return true;
      await sleep(150);
    }
    return false;
  };
  check(await tuneReady(`[...document.querySelectorAll('.tune select')].length > 0`), 'the Tune section offers something to change');
  const choice = await evaluate(`document.querySelector('.tune select')?.selectedOptions[0]?.textContent ?? ''`);
  check(choice === 'Length of wire 1', `it starts on the length of wire 1 (${choice})`);
  const goalAt = await evaluate(`[...document.querySelectorAll('.tune label.field')].find((l) => l.textContent.startsWith('at'))?.querySelector('input')?.value ?? ''`);
  check(goalAt === '14.2', `the goal frequency followed the example: ${goalAt} MHz`);
  check(await evaluate(`(() => { const b = [...document.querySelectorAll('.tune button')].find((x) => x.textContent.trim() === 'Tune'); if (!b) return false; b.click(); return true; })()`), 'Tune');
  check(await tuneReady(`/Set the length of wire 1 .* solves\\./.test(document.querySelector('.tune-note')?.textContent ?? '')`, 60_000), 'it finishes and says what it did');
  const note = await evaluate(`document.querySelector('.tune-note')?.textContent ?? ''`);
  const metres = Number(/to (\d+\.\d+) m/.exec(note)?.[1]);
  const reactance = Number(/j(\d+\.\d)/.exec(note)?.[1]);
  check(metres > 9.8 && metres < 10.6 && reactance < 3, `a half wave of 2 mm wire, resonant: ${note}`);
  check(!/edge of the range/.test(note), 'and not at the edge of its range');
  await sleep(1200); // the re-solve of the tuned model
  const tuned = await readState();
  check(tuned.modelWires[0]?.includes(metres.toFixed(3).slice(0, 4)) ?? false, `the model took the new length: ${tuned.modelWires[0]}`);

  // ---- the convergence check: double the segments, see what moves ----
  check(await evaluate(`(() => { const b = [...document.querySelectorAll('.convergence button')].find((x) => x.textContent.trim() === 'Check it'); if (!b) return false; b.click(); return true; })()`), 'Is the model converged? Check it');
  check(await tuneReady(`/Settled|Not settled/.test(document.querySelector('.convergence-note')?.textContent ?? '')`, 30_000), 'it answers');
  const verdict = await evaluate(`document.querySelector('.convergence-note')?.textContent ?? ''`);
  check(/^Settled/.test(verdict) && /21 → 42/.test(verdict) && /moved the feed impedance by/.test(verdict), `the dipole is settled, with the movement in numbers: ${verdict.slice(0, 110)}…`);

  // 11. Ratings: the trap dipole's traps at 100 W.
  await loadExample('trap-dipole-40-80m');
  check(await tuneReady(`document.querySelectorAll('.ratings-table tbody tr').length === 2`, 45_000), 'the trap dipole lists both traps under What the loads must survive');
  const volts = await evaluate(`[...document.querySelectorAll('.ratings-table tbody tr')].map((r) => Number(r.children[3].textContent))`);
  check(volts.length === 2 && volts.every((v) => v > 50 && v < 5000), `peak volts across the traps at 100 W: ${volts.join(' and ')} V`);

  // 12. A vertical on real ground: the radial screen drawn as spokes, copper in the wire, and a change of metal.
  await loadExample('vertical-40m-radials');
  const efficiencyOf = `(() => { const d = [...document.querySelectorAll('.summary > div')].find((x) => x.querySelector('dt')?.textContent === 'Efficiency'); return parseFloat(d?.querySelector('dd')?.textContent ?? 'NaN'); })()`;
  check(await tuneReady(`document.querySelector('.modeler')?.dataset.busy !== 'true' && Number.isFinite(${efficiencyOf}) && ${efficiencyOf} < 100`, 45_000), 'the vertical over radials solves');
  const spokes = await evaluate(`document.querySelectorAll('line.radial').length`);
  check(spokes >= 16, `the radial screen is drawn as spokes (${spokes} across the views)`);
  const copperEff = await evaluate(efficiencyOf);
  check(copperEff > 98 && copperEff < 99, `copper wire: ${copperEff} % efficient`);
  const groundNoise = await evaluate(`[...document.querySelectorAll('.issue-text')].some((e) => /reaches the ground/.test(e.textContent))`);
  check(groundNoise === false, 'and no warning about the wire reaching the ground, because the screen connects it');
  // Select the wire, change its material to aluminium, and the efficiency must fall.
  check(await evaluate(`(() => { const b = document.querySelector('.wire-list button'); if (!b) return false; b.click(); return true; })()`), 'select wire 1');
  check(
    await evaluate(`(() => { const s = [...document.querySelectorAll('select')].find((x) => [...x.options].some((o) => o.textContent === 'Aluminium')); if (!s) return false; s.value = [...s.options].find((o) => o.textContent === 'Aluminium').value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`),
    'Material: Aluminium',
  );
  check(await tuneReady(`document.querySelector('.modeler')?.dataset.busy !== 'true' && ${efficiencyOf} < ${copperEff}`, 45_000), `and the efficiency falls: ${await evaluate(efficiencyOf)} %`);
  // The card deck tab shows the LD 5 card for it; then back to the model tab for whatever follows.
  const deckTab = (name) => `(() => { const b = [...document.querySelectorAll('button[role=tab]')].find((x) => x.textContent.trim() === '${name}'); if (!b) return false; b.click(); return true; })()`;
  check(await evaluate(deckTab('Card deck')), 'open the card deck');
  const deckText = await evaluate(`document.querySelector('textarea.deck-text')?.value ?? ''`);
  check(/^LD 5 1 0 0 35000000$/m.test(deckText), 'written to the deck as an LD 5 card for the whole wire');
  check(/^GN 0 16 0 0 13 0\.005 10 0\.001$/m.test(deckText), 'and the screen on the GN card');
  check(await evaluate(deckTab('Model')), 'back to the model');
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
  //
  // The release must NEVER wait on the enables' answers. A service worker paused at start
  // does not answer them, and an earlier version that awaited both before releasing left
  // the PWA's worker frozen before its first line: register() never settled, nothing was
  // cached, and the run hung. A session handles its commands in order, so the enables are
  // still in place before the target runs; their replies just do not gate the release.
  const previousOnMessage = ws.onmessage;
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Target.attachedToTarget') {
      const { sessionId } = msg.params;
      send('Network.enable', {}, sessionId).catch(() => {});
      send('Runtime.enable', {}, sessionId).catch(() => {});
      send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
      return;
    }
    previousOnMessage(event);
  };
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Page.enable');
  if (vnaTest) {
    // Two NanoVNAs, as Web Serial ports. A NanoVNA-H with DiSlord firmware answers the
    // text shell the way the instrument does; a NanoVNA-V2 answers the binary registers,
    // and sends RAW readings with known error terms, as the real one does, so that only a
    // working short-open-load calibration in the page gets the right answer out of it.
    // Both are connected to the same "antenna": 75 ohms with half a microhenry in series,
    // so the tools should read 75 + j(2 pi f L) back from either. The page picks the port
    // with window.__emwsVnaPick ('v2' for the V2), and what is on the V2's connector with
    // window.__emwsVnaAttach('short' | 'open' | 'load' | 'antenna' | 'resonant').
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => { try {
        if (!window.isSecureContext) return;
        const enc = new TextEncoder(), dec = new TextDecoder();
        const gamma = (fMHz) => {
          const r = 75, x = 2 * Math.PI * fMHz * 1e6 * 0.5e-6, d = (r + 50) ** 2 + x * x;
          return [((r - 50) * (r + 50) + x * x) / d, (x * (r + 50) - (r - 50) * x) / d];
        };
        // Between the two ports: a first-order low-pass with its 3 dB point at 145 MHz.
        const through = (fMHz) => { const x = fMHz / 145; return [1 / (1 + x * x), -x / (1 + x * x)]; };
        const reply = (cmd) => {
          if (cmd === '') return 'ch> ';
          if (cmd === 'version') return 'version\\r\\n1.2.14\\r\\nch> ';
          if (cmd === 'info') return 'info\\r\\nBoard: NanoVNA-H (simulated)\\r\\nch> ';
          // Mask 3: frequency + S11. Mask 5: frequency + S21 (calibrated on the instrument).
          const m = /^scan (\\d+) (\\d+) (\\d+) ([35])$/.exec(cmd);
          if (m) {
            const [a, b, n] = [Number(m[1]), Number(m[2]), Number(m[3])];
            const lines = [];
            for (let i = 0; i < n; i++) { const hz = Math.round(a + (b - a) * i / (n - 1)); const [re, im] = m[4] === '3' ? gamma(hz / 1e6) : through(hz / 1e6); lines.push(hz + ' ' + re.toFixed(6) + ' ' + im.toFixed(6)); }
            return cmd + '\\r\\n' + lines.join('\\r\\n') + '\\r\\nch> ';
          }
          return cmd + '\\r\\nch> ';
        };
        // As a real port does: fresh streams on every open(), none while closed.
        const port = {
          readable: null, writable: null,
          async open() {
            let push;
            this.readable = new ReadableStream({ start(c) { push = (t) => { try { c.enqueue(enc.encode(t)); } catch {} }; } });
            this.writable = new WritableStream({ write(chunk) { const cmd = dec.decode(chunk).trim(); setTimeout(() => push(reply(cmd)), 5); } });
          },
          async close() { this.readable = null; this.writable = null; },
          async forget() {}, getInfo() { return { usbVendorId: 0x0483, usbProductId: 0x5740 }; },
        };
        const v2 = (() => {
          const regs = new Map([[0xf0, 2], [0xf3, 1], [0xf4, 9]]);
          const LEN = { 0x00: 1, 0x0d: 1, 0x10: 2, 0x11: 2, 0x12: 2, 0x18: 3, 0x20: 3, 0x21: 4, 0x22: 6, 0x23: 10 };
          const E = { e00: [0.05, -0.02], e11: [-0.1, 0.03], e10e01: [0.9, -0.05] };
          const mul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
          const div = (a, b) => { const d = b[0] * b[0] + b[1] * b[1]; return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d]; };
          let attached = 'load';
          window.__emwsVnaAttach = (what) => { attached = what; };
          // 'resonant' is a test winding wound too far: a lossy parallel LC (5 uH, 100 pF,
          // 5 ohms in the coil) that goes capacitive above 7.1 MHz, as an over-wound core does.
          const resonant = (fMHz) => {
            const w = 2 * Math.PI * fMHz * 1e6;
            const zl = [5, w * 5e-6], zc = [0, -1 / (w * 100e-12)];
            const z = div(mul(zl, zc), [zl[0] + zc[0], zl[1] + zc[1]]);
            return div([z[0] - 50, z[1]], [z[0] + 50, z[1]]);
          };
          const actual = (fMHz) => attached === 'short' ? [-1, 0] : attached === 'open' ? [1, 0] : attached === 'load' ? [0, 0] : attached === 'resonant' ? resonant(fMHz) : gamma(fMHz);
          // Gm = e00 + e10e01 * Ga / (1 - e11 * Ga): what an uncorrected instrument reads.
          const raw = (fMHz) => { const g = actual(fMHz); const eg = mul(E.e11, g); const q = div(mul(E.e10e01, g), [1 - eg[0], -eg[1]]); return [E.e00[0] + q[0], E.e00[1] + q[1]]; };
          // Port 2, raw as the V2 sends it: S21m = e30 + e10e32 * S21a, leakage and tracking
          // both varying with frequency, so only a thru + isolation calibration recovers S21a.
          // window.__emwsVnaPort2('thru' | 'isolation' | 'dut') says what is between the cables.
          let port2 = 'dut';
          window.__emwsVnaPort2 = (what) => { port2 = what; };
          const s21a = (fMHz) => (port2 === 'thru' ? [1, 0] : port2 === 'isolation' ? [0, 0] : through(fMHz));
          const raw21 = (fMHz) => { const e30 = [0.003 + 1e-5 * fMHz, -0.002]; const t = mul([0.7 - 2e-4 * fMHz, -0.25 + 1e-4 * fMHz], s21a(fMHz)); return [e30[0] + t[0], e30[1] + t[1]]; };
          const entry = (index) => {
            const fMHz = ((regs.get(0x00) ?? 0) + index * (regs.get(0x10) ?? 0)) / 1e6;
            const [re, im] = raw(fMHz);
            const [re21, im21] = raw21(fMHz);
            const b = new Uint8Array(32), v = new DataView(b.buffer);
            v.setInt32(0, 1000000, true); v.setInt32(8, Math.round(re * 1e6), true); v.setInt32(12, Math.round(im * 1e6), true);
            v.setInt32(16, Math.round(re21 * 1e6), true); v.setInt32(20, Math.round(im21 * 1e6), true); v.setUint16(24, index, true);
            return b;
          };
          let buffered = [], cursor = 17, push;
          const handle = (cmd) => {
            const op = cmd[0], addr = cmd[1] ?? 0;
            if (op === 0x0d) push(new Uint8Array([0x32]));
            else if (op === 0x10) push(new Uint8Array([(regs.get(addr) ?? 0) & 0xff]));
            else if (op >= 0x20 && op <= 0x23) { let v = 0; for (let i = cmd.length - 1; i >= 2; i--) v = v * 256 + cmd[i]; regs.set(addr, v); }
            else if (op === 0x18) {
              // The sweep runs continuously, so entries start wherever it has got to; and
              // the reply comes in two USB packets, cut off an entry boundary.
              const count = cmd[2], points = regs.get(0x20) ?? 101, all = new Uint8Array(count * 32);
              for (let n = 0; n < count; n++, cursor = (cursor + 1) % points) all.set(entry(cursor), n * 32);
              push(all.slice(0, 40)); setTimeout(() => push(all.slice(40)), 3);
            }
          };
          return {
            readable: null, writable: null,
            async open() {
              this.readable = new ReadableStream({ start(c) { push = (b) => { try { c.enqueue(b); } catch {} }; } });
              this.writable = new WritableStream({ write(chunk) { buffered.push(...chunk); while (buffered.length) { const need = LEN[buffered[0]] ?? 1; if (buffered.length < need) break; handle(buffered.splice(0, need)); } } });
            },
            async close() { this.readable = null; this.writable = null; },
            async forget() {}, getInfo() { return { usbVendorId: 0x04b4, usbProductId: 0x0008 }; },
          };
        })();
        Object.defineProperty(navigator, 'serial', { value: { requestPort: async () => (window.__emwsVnaPick === 'v2' ? v2 : port), getPorts: async () => [port, v2] }, configurable: true });
        window.__emwsSimulatedVna = true;
      } catch (e) { window.__emwsSimError = String(e); } })();`,
    });
  }
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
    if (vnaTest) await runVnaTest({ evaluate, send, log: (l) => editLog.push(l) });
    if (lcTest) await runLcTest({ evaluate, send, log: (l) => editLog.push(l), screenshot });
    if (toolboxTest) await runToolboxTest({ evaluate, send, log: (l) => editLog.push(l) });
    if (fdtdTest) await runFdtdTest({ evaluate, send, log: (l) => editLog.push(l), screenshot });
    if (communityTest) await runCommunityTest({ evaluate, send, log: (l) => editLog.push(l) });
    if (pwaTest) await runPwaTest({ evaluate, send, problems, log: (l) => editLog.push(l) });
    if (process.env.SMOKE_PROBE) console.log('probe:', await evaluate(process.env.SMOKE_PROBE));
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

  if (exposureTest) await runExposureTest({ send, evaluate, loadExample, log: (l) => editLog.push(l), screenshot });
  if (optimiseTest) await runOptimiseTest({ send, evaluate, loadExample, log: (l) => editLog.push(l), screenshot });
  if (maaTest) await runMaaTest({ send, evaluate, log: (l) => editLog.push(l), folder: join(profile, 'maa') });

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
