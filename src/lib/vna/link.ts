// A byte link to an instrument: what the drivers talk through.
//
// Kept apart from the Web Serial API on purpose. The drivers see only "write these
// bytes" and "give me what has arrived", so the same driver runs against a real port in
// the browser, a scripted fake in the tests, and a simulated NanoVNA in the smoke test -
// which is the only way to test a device driver without the device.
//
// Public domain (The Unlicense). By ZR1JT.

export interface Link {
  write(bytes: Uint8Array): Promise<void>;
  /**
   * Bytes that have arrived since the last read, waiting up to `timeoutMs` for the first
   * of them. An empty array means nothing came in time; it is not an error.
   */
  read(timeoutMs: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

export class VnaError extends Error {}

const encoder = new TextEncoder();
export const decoder = new TextDecoder();
export const text = (s: string): Uint8Array => encoder.encode(s);

export function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(parts.reduce((n, p) => n + p.length, 0)));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Reads until a predicate is satisfied by what has accumulated, or time runs out. A
 * device that goes quiet for `idleMs` before the predicate is met is taken to have
 * finished - which is how a reply of unknown length is read.
 */
export async function readUntil(
  link: Link,
  done: (sofar: Uint8Array) => boolean,
  { totalMs = 5000, idleMs = 400 }: { totalMs?: number; idleMs?: number } = {},
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let sofar: Uint8Array = new Uint8Array(0);
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    const chunk = await link.read(Math.min(idleMs, Math.max(1, deadline - Date.now())));
    if (chunk.length === 0) {
      if (parts.length > 0) break; // it has said its piece
      continue;
    }
    parts.push(chunk);
    sofar = concat(parts);
    if (done(sofar)) break;
  }
  return sofar;
}

/** Web Serial, wrapped. Reads are buffered so a driver can wait on them with a timeout. */
export class WebSerialLink implements Link {
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  private pending: Uint8Array[] = [];
  private waiting: (() => void) | undefined;
  private closed = false;

  constructor(private readonly port: SerialPort) {}

  static async open(port: SerialPort, baudRate = 115200): Promise<WebSerialLink> {
    await port.open({ baudRate, bufferSize: 65536 });
    const link = new WebSerialLink(port);
    link.start();
    return link;
  }

  private start(): void {
    if (!this.port.readable || !this.port.writable) throw new VnaError('The port opened but has no streams.');
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    void this.pump();
  }

  /** Drains the port into a queue, so nothing is lost while a driver is thinking. */
  private async pump(): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await this.reader!.read();
        if (done) break;
        if (value && value.length > 0) {
          this.pending.push(value);
          this.waiting?.();
        }
      }
    } catch {
      // the port was closed or unplugged; read() will report nothing from now on
    } finally {
      this.closed = true;
      this.waiting?.();
    }
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this.writer || this.closed) throw new VnaError('The instrument is no longer connected.');
    await this.writer.write(bytes);
  }

  async read(timeoutMs: number): Promise<Uint8Array> {
    if (this.pending.length === 0 && !this.closed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.waiting = undefined;
          resolve();
        }, timeoutMs);
        this.waiting = () => {
          clearTimeout(timer);
          this.waiting = undefined;
          resolve();
        };
      });
    }
    const out = concat(this.pending);
    this.pending = [];
    return out;
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      await this.reader?.cancel();
    } catch {
      // already gone
    }
    try {
      this.writer?.releaseLock();
      this.reader?.releaseLock();
    } catch {
      // already released
    }
    try {
      await this.port.close();
    } catch {
      // unplugged first
    }
  }
}
