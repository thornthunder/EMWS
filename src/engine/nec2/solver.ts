// Where a model gets solved: in this browser, or by a solver service somewhere else.
//
// The wire protocol is deliberately small, so that anything can implement it:
//
//   GET  <base>/health                          -> { service, host, workers, engines: [...] }
//   POST <base>/solve        { kind, ...job }   -> { output, exitCode, stderr?, elapsedMs? }
//   POST <base>/solve-batch  { jobs: [...] }    -> { results: [{ output, ... }], elapsedMs? }
//
// Every job says what kind of work it is, and a service says in `engines` which kinds it
// can do. Only 'nec2' exists today - its job is { deck } - but the antenna modeller will
// not be the last tool that would rather not solve in a browser, and a service that grows
// a second engine should not need a second protocol.
//
// `output` is the report text nec2c writes; EMWS parses it here, so every solver is read
// the same way and a remote one cannot quietly change how results are interpreted.
// A service that does not offer solve-batch is used one deck at a time instead.

import { Nec2Client, recommendedWorkers } from './client';
import { parseNec2Output } from './parse-output';
import type { Nec2Run } from './types';

/** Where the user wants their models solved. */
export type SolverChoice =
  | { kind: 'local' }
  /** The service this site is configured to forward to (same origin, so no CORS or mixed content). */
  | { kind: 'site' }
  /** A service the user names, typically http://127.0.0.1:<port> on their own machine. */
  | { kind: 'url'; url: string };

/** The kind of job this client sends. A service says which kinds it can do. */
export const NEC2_KIND = 'nec2';

/** One thing a service can solve. */
export interface SolverEngine {
  /** 'nec2' today. */
  kind: string;
  engine: string;
  version: string;
  /** 'wasm', 'native', 'cuda', ... */
  build?: string;
  /** 'double' or 'single'; single precision is worth saying out loud. */
  precision?: string;
}

export interface SolverInfo {
  /** What the service calls itself, if it says. */
  service?: string;
  version?: string;
  workers?: number;
  host?: string;
  engines: SolverEngine[];
}

/** The engine a service would use for a kind of job, if it has one. */
export function engineFor(info: SolverInfo, kind: string): SolverEngine | undefined {
  return info.engines.find((e) => e.kind === kind);
}

export interface SolveOptions {
  onProgress?: (done: number, total: number) => void;
}

export interface Solver {
  readonly choice: SolverChoice;
  /** Short name for the status line. */
  readonly label: string;
  describe(): Promise<SolverInfo>;
  solve(deck: string): Promise<Nec2Run>;
  solveAll(decks: readonly string[], options?: SolveOptions): Promise<Nec2Run[]>;
  cancel(): void;
}

export class SolverUnavailable extends Error {
  /** The HTTP status behind it, where there was one. */
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'SolverUnavailable';
    this.status = status;
  }
}

const STORAGE_KEY = 'emws.solver';
/** The proxy the site may provide; it forwards to whatever the server is configured for. */
export const SITE_PROXY_PATH = 'solver/index.php';
const HEALTH_TIMEOUT_MS = 4000;

export function loadSolverChoice(): SolverChoice {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { kind: 'local' };
    const saved = JSON.parse(raw) as SolverChoice;
    if (saved.kind === 'local' || saved.kind === 'site') return { kind: saved.kind };
    if (saved.kind === 'url' && typeof saved.url === 'string' && saved.url !== '') return { kind: 'url', url: saved.url };
  } catch {
    // storage can be blocked, or hold something older
  }
  return { kind: 'local' };
}

export function saveSolverChoice(choice: SolverChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // see loadSolverChoice()
  }
}

/**
 * Only a local service may be named by hand. A page's own security policy blocks other
 * origins anyway, and a free-form address would invite sending someone's antenna to a
 * stranger's machine; the site proxy is the way to reach a service on the network.
 */
export function isAllowedSolverUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  } catch {
    return false;
  }
}

/**
 * The address of one operation on the chosen service. Only the site proxy is relative,
 * so only that case needs to know what page we are on.
 */
export function solverEndpoint(choice: SolverChoice, op: 'health' | 'solve' | 'solve-batch', base?: string): string {
  if (choice.kind === 'site') return new URL(`${SITE_PROXY_PATH}?op=${op}`, base ?? location.href).href;
  if (choice.kind === 'url') return `${choice.url.replace(/\/+$/, '')}/${op}`;
  return '';
}

export function describeChoice(choice: SolverChoice): string {
  switch (choice.kind) {
    case 'local':
      return 'This browser';
    case 'site':
      return "This site's solver";
    case 'url':
      return choice.url;
  }
}

class LocalSolver implements Solver {
  readonly choice: SolverChoice = { kind: 'local' };
  readonly label = 'this browser';
  private readonly client = new Nec2Client();

  async describe(): Promise<SolverInfo> {
    return {
      service: 'EMWS',
      workers: recommendedWorkers(navigator.hardwareConcurrency ?? 2),
      host: 'this browser',
      engines: [{ kind: NEC2_KIND, engine: 'nec2c', version: '1.3.1', build: 'wasm', precision: 'double' }],
    };
  }

  solve(deck: string): Promise<Nec2Run> {
    return this.client.simulate(deck);
  }

  solveAll(decks: readonly string[], options: SolveOptions = {}): Promise<Nec2Run[]> {
    return this.client.simulateAll(decks, {
      onProgress: options.onProgress,
      workers: recommendedWorkers(decks.length),
    });
  }

  cancel(): void {
    this.client.cancel();
  }
}

interface RemoteResult {
  output?: string;
  exitCode?: number;
  stderr?: string;
  elapsedMs?: number;
}

class RemoteSolver implements Solver {
  readonly label: string;
  private controller: AbortController | undefined;
  private batchSupported = true;

  constructor(readonly choice: SolverChoice) {
    this.label = choice.kind === 'site' ? "this site's solver" : (choice as { url: string }).url;
  }

  async describe(): Promise<SolverInfo> {
    const response = await this.fetch('health', undefined, HEALTH_TIMEOUT_MS);
    const info = readHealth(await response.json());
    if (!info) throw new SolverUnavailable('That address answered, but not like an EMWS solver.');
    if (!engineFor(info, NEC2_KIND)) {
      const others = info.engines.map((e) => e.kind).join(', ');
      throw new SolverUnavailable(
        `That solver does not do NEC-2${others === '' ? '' : `, only ${others}`}, so it cannot model antennas.`,
      );
    }
    return info;
  }

  async solve(deck: string): Promise<Nec2Run> {
    const response = await this.fetch('solve', { kind: NEC2_KIND, deck });
    return toRun((await response.json()) as RemoteResult);
  }

  async solveAll(decks: readonly string[], options: SolveOptions = {}): Promise<Nec2Run[]> {
    if (this.batchSupported && decks.length > 1) {
      try {
        const response = await this.fetch('solve-batch', { jobs: decks.map((deck) => ({ kind: NEC2_KIND, deck })) });
        const body = (await response.json()) as { results?: RemoteResult[] };
        if (Array.isArray(body.results) && body.results.length === decks.length) {
          options.onProgress?.(decks.length, decks.length);
          return body.results.map(toRun);
        }
        throw new SolverUnavailable('The solver returned the wrong number of results.');
      } catch (e) {
        // A solver that has never heard of solve-batch says so with 404, 405 or 501.
        const unsupported = e instanceof SolverUnavailable && (e.status === 404 || e.status === 405 || e.status === 501);
        if (!unsupported) throw e;
        this.batchSupported = false;
      }
    }

    // One at a time, a few in flight, so a plain solver still gets through a sweep.
    const runs: Nec2Run[] = new Array(decks.length);
    let next = 0;
    let done = 0;
    const lanes = Array.from({ length: Math.min(4, decks.length) }, async () => {
      while (next < decks.length) {
        const index = next++;
        runs[index] = await this.solve(decks[index]!);
        done += 1;
        options.onProgress?.(done, decks.length);
      }
    });
    await Promise.all(lanes);
    return runs;
  }

  cancel(): void {
    this.controller?.abort();
    this.controller = undefined;
  }

  private async fetch(op: 'health' | 'solve' | 'solve-batch', body?: unknown, timeoutMs?: number): Promise<Response> {
    this.controller ??= new AbortController();
    // cancel() stops everything; a timeout stops only the call that set it.
    const signal =
      timeoutMs === undefined
        ? this.controller.signal
        : AbortSignal.any([this.controller.signal, AbortSignal.timeout(timeoutMs)]);
    try {
      const response = await fetch(solverEndpoint(this.choice, op), {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        cache: 'no-store',
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new SolverUnavailable(explain(response.status, detail), response.status);
      }
      return response;
    } catch (e) {
      if (e instanceof SolverUnavailable) throw e;
      const name = e instanceof Error ? e.name : '';
      if (name === 'TimeoutError') throw new SolverUnavailable('The solver did not answer in time.');
      if (name === 'AbortError') throw new SolverUnavailable('That solve was cancelled.');
      throw new SolverUnavailable(
        `Could not reach the solver. ${e instanceof Error ? e.message : String(e)} ` +
          `Check that it is running, and that this page is allowed to connect to it.`,
      );
    }
  }
}

/**
 * Reads a /health answer. A service from before jobs had kinds replies with flat fields
 * and meant NEC-2, because that was all there was; understand it rather than refuse it.
 */
function readHealth(body: unknown): SolverInfo | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const source = body as Record<string, unknown>;

  const engines: SolverEngine[] = [];
  const listed = Array.isArray(source.engines) ? source.engines : [];
  for (const raw of listed) {
    if (raw === null || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.engine !== 'string') continue;
    engines.push({
      kind: typeof e.kind === 'string' ? e.kind : NEC2_KIND,
      engine: e.engine,
      version: typeof e.version === 'string' ? e.version : '?',
      ...(typeof e.build === 'string' ? { build: e.build } : {}),
      ...(typeof e.precision === 'string' ? { precision: e.precision } : {}),
    });
  }
  if (engines.length === 0 && typeof source.engine === 'string') {
    engines.push({
      kind: NEC2_KIND,
      engine: source.engine,
      version: typeof source.version === 'string' ? source.version : '?',
      ...(typeof source.build === 'string' ? { build: source.build } : {}),
      ...(typeof source.precision === 'string' ? { precision: source.precision } : {}),
    });
  }
  if (engines.length === 0) return undefined;

  return {
    ...(typeof source.service === 'string' ? { service: source.service } : {}),
    ...(typeof source.version === 'string' && Array.isArray(source.engines) ? { version: source.version } : {}),
    ...(typeof source.workers === 'number' ? { workers: source.workers } : {}),
    ...(typeof source.host === 'string' ? { host: source.host } : {}),
    engines,
  };
}

function explain(status: number, detail: string): string {
  // A solver or proxy that follows the protocol answers { error, detail }; show that as
  // prose rather than putting raw JSON in front of someone modelling an antenna.
  let trimmed = detail.trim().slice(0, 600);
  try {
    const body = JSON.parse(trimmed) as { error?: unknown; detail?: unknown };
    const parts = [body.error, body.detail].filter((p): p is string => typeof p === 'string' && p !== '');
    if (parts.length > 0) {
      const sentence = parts.map((p) => (/[.!?]$/.test(p) ? p : `${p}.`)).join(' ');
      return status === 404 || status === 405 || status === 501 ? `${sentence} (${status})` : sentence;
    }
  } catch {
    // not JSON; fall through and show what there is
  }
  trimmed = trimmed.slice(0, 300);
  if (status === 404 || status === 405) return `The solver has no such endpoint (${status}). ${trimmed}`;
  if (status === 501) return `The solver does not support that (501). ${trimmed}`;
  if (status === 401 || status === 403) return `The solver would not accept this request (${status}). ${trimmed}`;
  if (status === 502 || status === 504) return `The site could not reach its solver (${status}). ${trimmed}`;
  return `The solver answered ${status}. ${trimmed}`;
}

function toRun(result: RemoteResult): Nec2Run {
  const output = typeof result.output === 'string' ? result.output : '';
  if (output === '') throw new SolverUnavailable('The solver returned nothing to read.');
  return {
    raw: {
      exitCode: result.exitCode ?? 0,
      output,
      stderr: result.stderr ?? '',
      elapsedMs: result.elapsedMs ?? 0,
    },
    report: parseNec2Output(output),
  };
}

export function createSolver(choice: SolverChoice): Solver {
  return choice.kind === 'local' ? new LocalSolver() : new RemoteSolver(choice);
}
