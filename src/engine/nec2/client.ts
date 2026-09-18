// Main-thread handle on the NEC2 worker.

import type { Nec2Request, Nec2Response } from './nec2.worker';
import type { Nec2Run } from './types';

interface Pending {
  resolve: (run: Nec2Run) => void;
  reject: (error: Error) => void;
}

export class SimulationCancelled extends Error {
  constructor() {
    super('Simulation cancelled');
    this.name = 'SimulationCancelled';
  }
}

export class Nec2Client {
  private worker: Worker | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./nec2.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<Nec2Response>) => {
      const response = event.data;
      const waiting = this.pending.get(response.id);
      if (!waiting) return;
      this.pending.delete(response.id);
      if (response.ok) waiting.resolve(response.run);
      else waiting.reject(new Error(response.error));
    };
    worker.onerror = (event) => {
      this.shutDown(new Error(event.message || 'The NEC2 worker crashed'));
    };
    this.worker = worker;
    return worker;
  }

  simulate(deck: string): Promise<Nec2Run> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<Nec2Run>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const request: Nec2Request = { id, deck };
      worker.postMessage(request);
    });
  }

  /**
   * Stops whatever is running; pending simulations reject with SimulationCancelled.
   * A solve can't be interrupted, so the worker is killed and the next simulate()
   * starts a new one. Also the way to release the worker when finished with the client.
   */
  cancel(): void {
    this.shutDown(new SimulationCancelled());
  }

  private shutDown(reason: Error): void {
    this.worker?.terminate();
    this.worker = undefined;
    for (const waiting of this.pending.values()) waiting.reject(reason);
    this.pending.clear();
  }
}
