// A small pool of NEC2 workers on the main thread's behalf.
//
// One solve is one worker. A frequency sweep is many independent solves, so it can use
// as many cores as the machine will give us; that is the only parallelism NEC-2 offers
// without rewriting its solver.

import type { Nec2Request, Nec2Response } from './nec2.worker';
import type { Nec2Run } from './types';

export class SimulationCancelled extends Error {
  constructor() {
    super('Simulation cancelled');
    this.name = 'SimulationCancelled';
  }
}

/** Each worker holds its own copy of the interaction matrix: 16 bytes per segment squared. */
export function matrixBytes(segments: number): number {
  return 16 * segments * segments;
}

/**
 * How many workers to use. Bounded by the cores the browser admits to, by how many jobs
 * there are, and by memory: a big model's matrix is the same size in every worker.
 */
export function recommendedWorkers(jobs: number, segments = 0): number {
  const cores = typeof navigator === 'undefined' ? 1 : (navigator.hardwareConcurrency ?? 2);
  // navigator.deviceMemory is only in some browsers, and is deliberately vague.
  const memoryGb = (typeof navigator === 'undefined' ? undefined : (navigator as { deviceMemory?: number }).deviceMemory) ?? 4;
  const budget = Math.min(1.5e9, Math.max(2.5e8, (memoryGb * 1e9) / 4));
  const byMemory = segments > 0 ? Math.floor(budget / Math.max(1, matrixBytes(segments))) : Infinity;
  return Math.max(1, Math.min(jobs, cores, byMemory, 16));
}

interface Job {
  deck: string;
  resolve: (run: Nec2Run) => void;
  reject: (error: Error) => void;
}

interface Slot {
  worker: Worker;
  job?: Job;
  requestId: number;
}

export interface SimulateAllOptions {
  /** Called as each deck comes back, for a progress readout. */
  onProgress?: (done: number, total: number) => void;
  /** Upper limit on workers; the pool may use fewer. */
  workers?: number;
}

export class Nec2Client {
  private readonly slots: Slot[] = [];
  private readonly queue: Job[] = [];
  private nextId = 1;

  /** How many workers are alive; useful for telling the user what is happening. */
  get workerCount(): number {
    return this.slots.length;
  }

  simulate(deck: string): Promise<Nec2Run> {
    return new Promise<Nec2Run>((resolve, reject) => {
      this.queue.push({ deck, resolve, reject });
      this.pump(1);
    });
  }

  /** Solves every deck, using several workers at once, and returns the results in order. */
  async simulateAll(decks: readonly string[], options: SimulateAllOptions = {}): Promise<Nec2Run[]> {
    if (decks.length === 0) return [];
    const limit = Math.max(1, Math.min(options.workers ?? decks.length, decks.length));
    let done = 0;
    const runs = decks.map(
      (deck) =>
        new Promise<Nec2Run>((resolve, reject) => {
          this.queue.push({
            deck,
            resolve: (run) => {
              done += 1;
              options.onProgress?.(done, decks.length);
              resolve(run);
            },
            reject,
          });
        }),
    );
    this.pump(limit);
    return Promise.all(runs);
  }

  /** Stops everything in flight. A solve cannot be interrupted, so the workers are replaced. */
  cancel(): void {
    const reason = new SimulationCancelled();
    for (const slot of this.slots) {
      slot.worker.terminate();
      slot.job?.reject(reason);
    }
    this.slots.length = 0;
    for (const job of this.queue) job.reject(reason);
    this.queue.length = 0;
  }

  /** Starts or feeds workers until the queue is empty or `limit` of them are busy. */
  private pump(limit: number): void {
    while (this.queue.length > 0) {
      const slot = this.slots.find((s) => !s.job) ?? (this.slots.length < limit ? this.spawn() : undefined);
      if (!slot) return;
      const job = this.queue.shift()!;
      slot.job = job;
      slot.requestId = this.nextId++;
      const request: Nec2Request = { id: slot.requestId, deck: job.deck };
      slot.worker.postMessage(request);
    }
  }

  private spawn(): Slot {
    const worker = new Worker(new URL('./nec2.worker.ts', import.meta.url), { type: 'module' });
    const slot: Slot = { worker, requestId: 0 };
    worker.onmessage = (event: MessageEvent<Nec2Response>) => {
      const response = event.data;
      const job = slot.job;
      if (!job || response.id !== slot.requestId) return;
      slot.job = undefined;
      if (response.ok) job.resolve(response.run);
      else job.reject(new Error(response.error));
      this.pump(Math.max(1, this.slots.length));
    };
    worker.onerror = (event) => {
      const job = slot.job;
      slot.job = undefined;
      job?.reject(new Error(event.message || 'The NEC2 worker crashed'));
      // A crashed worker is no use to the next job.
      worker.terminate();
      const at = this.slots.indexOf(slot);
      if (at >= 0) this.slots.splice(at, 1);
      this.pump(Math.max(1, this.slots.length + 1));
    };
    this.slots.push(slot);
    return slot;
  }
}
