// Solving somewhere else must give the same answer as solving here.
//
// These run a real stub service over real HTTP - the decks go through the same engine
// the browser uses, and the reports come back over the wire to be parsed on this side.
// That is the whole point of the protocol: a remote solver hands over nec2c's text and
// nothing else, so it cannot change how a result is read.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSolver,
  describeChoice,
  engineFor,
  isAllowedSolverUrl,
  loadSolverChoice,
  saveSolverChoice,
  SITE_PROXY_PATH,
  SolverUnavailable,
  solverEndpoint,
  type SolverChoice,
} from '../src/engine/nec2/solver';
import { loadExample, simulate } from './helpers/engine';

interface Stub {
  url: string;
  /** Every path the service was asked for, in order. */
  calls: string[];
  /** The kind named on every job it was sent, in order. */
  kinds: string[];
  close(): Promise<void>;
}

interface StubOptions {
  /** Answer solve-batch with this status instead of solving. */
  batchStatus?: number;
  /** Answer every solve with this body, rather than running the engine. */
  solveAs?: { status: number; body: unknown };
  /** Wait this long before answering, so a timeout can be tested. */
  delayMs?: number;
  /** What /health claims to solve. Defaults to nec2 on nec2c. */
  engines?: unknown;
  /** The whole /health answer, for testing shapes this client did not write. */
  healthAs?: unknown;
}

const servers: Stub[] = [];

async function startStub(options: StubOptions = {}): Promise<Stub> {
  const calls: string[] = [];
  const kinds: string[] = [];

  const body = (req: IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        try {
          resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(e as Error);
        }
      });
      req.on('error', reject);
    });

  const send = (res: ServerResponse, status: number, payload: unknown) => {
    const text = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  };

  const server: Server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    calls.push(path);
    if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));

    if (path === '/health') {
      if (options.healthAs) {
        send(res, 200, options.healthAs);
        return;
      }
      send(res, 200, {
        service: 'emws-solver',
        version: '0.1.0',
        host: 'stub',
        workers: 2,
        engines: options.engines ?? [{ kind: 'nec2', engine: 'nec2c', version: '1.3.1', build: 'wasm', precision: 'double' }],
      });
      return;
    }
    if (path === '/solve') {
      if (options.solveAs) {
        send(res, options.solveAs.status, options.solveAs.body);
        return;
      }
      const job = (await body(req)) as { kind?: string; deck?: string };
      kinds.push(job.kind ?? '(none)');
      const run = await simulate(job.deck ?? '');
      send(res, 200, { kind: job.kind, output: run.raw.output, exitCode: run.raw.exitCode, stderr: run.raw.stderr, elapsedMs: run.raw.elapsedMs });
      return;
    }
    if (path === '/solve-batch') {
      if (options.batchStatus) {
        send(res, options.batchStatus, { error: 'No such endpoint' });
        return;
      }
      const { jobs } = (await body(req)) as { jobs: Array<{ kind?: string; deck?: string }> };
      const results = [];
      for (const job of jobs) {
        kinds.push(job.kind ?? '(none)');
        const run = await simulate(job.deck ?? '');
        results.push({ kind: job.kind, output: run.raw.output, exitCode: run.raw.exitCode, stderr: run.raw.stderr });
      }
      send(res, 200, { results });
      return;
    }
    send(res, 404, { error: 'No such endpoint' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const stub: Stub = {
    url: `http://127.0.0.1:${port}`,
    calls,
    kinds,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  servers.push(stub);
  return stub;
}

afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
});

/** A short sweep, small enough to solve several times in a test. */
function sweepDecks(): string[] {
  return [7.0, 7.1, 7.2].map(
    (f) => `CM sweep step\nCE\nGW 1 21 0 -10.0 0 0 10.0 0 0.001\nGE 0\nFR 0 1 0 0 ${f} 0\nEX 0 1 11 0 1 0\nXQ\nEN\n`,
  );
}

describe('choosing where to solve', () => {
  it('only lets a service on this machine be named by hand', () => {
    expect(isAllowedSolverUrl('http://127.0.0.1:8073')).toBe(true);
    expect(isAllowedSolverUrl('http://localhost:9000/')).toBe(true);
    expect(isAllowedSolverUrl('https://localhost:8443')).toBe(true);
    // Anything else goes through the site's own proxy instead.
    expect(isAllowedSolverUrl('http://192.168.0.124:8073')).toBe(false);
    expect(isAllowedSolverUrl('http://solver.example.com')).toBe(false);
    expect(isAllowedSolverUrl('file:///C:/solver')).toBe(false);
    expect(isAllowedSolverUrl('not a url')).toBe(false);
    expect(isAllowedSolverUrl('')).toBe(false);
  });

  it('builds the address of each operation', () => {
    const page = 'http://emws.local/tools/#/antenna-modeler';
    expect(solverEndpoint({ kind: 'site' }, 'health', page)).toBe(`http://emws.local/tools/${SITE_PROXY_PATH}?op=health`);
    expect(solverEndpoint({ kind: 'site' }, 'solve-batch', page)).toBe(`http://emws.local/tools/${SITE_PROXY_PATH}?op=solve-batch`);
    // A named service is reached directly, with or without a trailing slash.
    expect(solverEndpoint({ kind: 'url', url: 'http://127.0.0.1:8073' }, 'solve')).toBe('http://127.0.0.1:8073/solve');
    expect(solverEndpoint({ kind: 'url', url: 'http://127.0.0.1:8073/' }, 'solve')).toBe('http://127.0.0.1:8073/solve');
    // Solving here needs no address at all.
    expect(solverEndpoint({ kind: 'local' }, 'solve')).toBe('');
  });

  it('describes each choice in words', () => {
    expect(describeChoice({ kind: 'local' })).toBe('This browser');
    expect(describeChoice({ kind: 'site' })).toBe("This site's solver");
    expect(describeChoice({ kind: 'url', url: 'http://127.0.0.1:8073' })).toBe('http://127.0.0.1:8073');
  });

  it('remembers the choice, and falls back to this browser for anything it cannot read', () => {
    const store = new Map<string, string>();
    const stub = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    };
    Object.defineProperty(globalThis, 'localStorage', { value: stub, configurable: true });
    try {
      expect(loadSolverChoice()).toEqual({ kind: 'local' });
      for (const choice of [{ kind: 'site' }, { kind: 'url', url: 'http://127.0.0.1:8073' }] as SolverChoice[]) {
        saveSolverChoice(choice);
        expect(loadSolverChoice()).toEqual(choice);
      }
      store.set('emws.solver', '{"kind":"url"}'); // no address
      expect(loadSolverChoice()).toEqual({ kind: 'local' });
      store.set('emws.solver', 'not json');
      expect(loadSolverChoice()).toEqual({ kind: 'local' });
    } finally {
      Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });
});

describe('a solver on the other end of the wire', () => {
  it('says what it is and what it can solve', async () => {
    const stub = await startStub();
    const info = await createSolver({ kind: 'url', url: stub.url }).describe();
    expect(info).toMatchObject({ service: 'emws-solver', host: 'stub', workers: 2 });
    expect(engineFor(info, 'nec2')).toEqual({
      kind: 'nec2',
      engine: 'nec2c',
      version: '1.3.1',
      build: 'wasm',
      precision: 'double',
    });
  });

  it('understands a service from before jobs had kinds', async () => {
    // It answers with flat fields and means NEC-2, because that was all there was.
    const stub = await startStub({
      healthAs: { engine: 'nec2c', version: '1.3.1', build: 'native', precision: 'single', workers: 64, host: 'old' },
    });
    const info = await createSolver({ kind: 'url', url: stub.url }).describe();
    expect(engineFor(info, 'nec2')).toEqual({
      kind: 'nec2',
      engine: 'nec2c',
      version: '1.3.1',
      build: 'native',
      precision: 'single',
    });
    expect(info.host).toBe('old');
    expect(info.workers).toBe(64);
  });

  it('refuses an address that answers with something else entirely', async () => {
    const stub = await startStub({ healthAs: { hello: 'I am a web server' } });
    await expect(createSolver({ kind: 'url', url: stub.url }).describe()).rejects.toThrow(/not like an EMWS solver/i);
  });

  it('refuses a solver that cannot do NEC-2, and says what it does instead', async () => {
    const stub = await startStub({ engines: [{ kind: 'fdtd', engine: 'something-else', version: '2.0' }] });
    await expect(createSolver({ kind: 'url', url: stub.url }).describe()).rejects.toThrow(
      /does not do NEC-2, only fdtd/i,
    );
  });

  it('gives the same report as solving here', async () => {
    const stub = await startStub();
    const deck = await loadExample('dipole-20m-free-space.nec');
    const here = await simulate(deck);
    const there = await createSolver({ kind: 'url', url: stub.url }).solve(deck);

    // Parsed on this side from the same text, so every number has to match.
    expect(there.report).toEqual(here.report);
    expect(there.raw.exitCode).toBe(0);
    expect(there.report.frequencies[0]?.feeds[0]?.impedance.re).toBeCloseTo(72.353, 3);
    // And it said what kind of job it was, so a service with more than one engine knows.
    expect(stub.kinds).toEqual(['nec2']);
  });

  it('sends a sweep as one batch, and reports it finished', async () => {
    const stub = await startStub();
    const decks = sweepDecks();
    const progress: Array<[number, number]> = [];
    const runs = await createSolver({ kind: 'url', url: stub.url }).solveAll(decks, {
      onProgress: (done, total) => progress.push([done, total]),
    });

    expect(stub.calls).toEqual(['/solve-batch']);
    expect(runs).toHaveLength(3);
    expect(runs.map((r) => r.report.frequencies[0]?.frequencyMHz)).toEqual([7, 7.1, 7.2]);
    expect(progress.at(-1)).toEqual([3, 3]);
  });

  it('falls back to one deck at a time when the solver has no batch endpoint', async () => {
    const stub = await startStub({ batchStatus: 404 });
    const decks = sweepDecks();
    const solver = createSolver({ kind: 'url', url: stub.url });
    const runs = await solver.solveAll(decks);

    expect(stub.calls).toEqual(['/solve-batch', '/solve', '/solve', '/solve']);
    expect(runs.map((r) => r.report.frequencies[0]?.frequencyMHz)).toEqual([7, 7.1, 7.2]);

    // Having learnt that, it does not ask again.
    stub.calls.length = 0;
    await solver.solveAll(decks);
    expect(stub.calls).toEqual(['/solve', '/solve', '/solve']);
  });

  it('keeps a sweep in the order it was asked for, however the lanes finish', async () => {
    const stub = await startStub({ batchStatus: 501 });
    const decks = [7.0, 7.05, 7.1, 7.15, 7.2, 7.25].map(
      (f) => `CM order\nCE\nGW 1 9 0 -10.0 0 0 10.0 0 0.001\nGE 0\nFR 0 1 0 0 ${f} 0\nEX 0 1 5 0 1 0\nXQ\nEN\n`,
    );
    const runs = await createSolver({ kind: 'url', url: stub.url }).solveAll(decks);
    expect(runs.map((r) => r.report.frequencies[0]?.frequencyMHz)).toEqual([7, 7.05, 7.1, 7.15, 7.2, 7.25]);
  });
});

describe('when the far end is not well', () => {
  const deck = 'CM tiny\nCE\nGW 1 9 0 -5.13 0 0 5.13 0 0.001\nGE 0\nFR 0 1 0 0 14.2 0\nEX 0 1 5 0 1 0\nXQ\nEN\n';

  it('reads a proxy’s explanation back as prose, not as JSON', async () => {
    const body = { error: 'This site’s solver is not answering', detail: 'It may be switched off' };
    const stub = await startStub({ solveAs: { status: 502, body } });
    const failed = await createSolver({ kind: 'url', url: stub.url })
      .solve(deck)
      .catch((e: unknown) => e);

    expect(failed).toBeInstanceOf(SolverUnavailable);
    const error = failed as SolverUnavailable;
    expect(error.status).toBe(502);
    // Both sentences, punctuated, and nothing a person has to decode.
    expect(error.message).toBe('This site’s solver is not answering. It may be switched off.');
    expect(error.message).not.toContain('{');
  });

  it('shows whatever it gets when the far end is not one of ours', async () => {
    const stub = await startStub({ solveAs: { status: 500, body: 'Internal Server Error' } });
    await expect(createSolver({ kind: 'url', url: stub.url }).solve(deck)).rejects.toThrow(/answered 500/i);
  });

  it('refuses a result with no report in it', async () => {
    const stub = await startStub({ solveAs: { status: 200, body: { exitCode: 0 } } });
    await expect(createSolver({ kind: 'url', url: stub.url }).solve(deck)).rejects.toThrow(/returned nothing to read/i);
  });

  it('says so when nothing is listening', async () => {
    // Port 1 is never a NEC solver.
    await expect(createSolver({ kind: 'url', url: 'http://127.0.0.1:1' }).solve(deck)).rejects.toThrow(/could not reach the solver/i);
  });

  it('gives up on a health check that never answers', async () => {
    const stub = await startStub({ delayMs: 6000 });
    const started = performance.now();
    await expect(createSolver({ kind: 'url', url: stub.url }).describe()).rejects.toThrow(/did not answer in time/i);
    expect(performance.now() - started).toBeLessThan(5500);
  }, 10_000);

  it('stops a solve when it is cancelled', async () => {
    const stub = await startStub({ delayMs: 3000 });
    const solver = createSolver({ kind: 'url', url: stub.url });
    const pending = solver.solve(deck);
    solver.cancel();
    await expect(pending).rejects.toThrow(/cancelled/i);
  });
});
