// The NanoVNA-V2 (and the SAA-2 it is sold as): the binary register protocol.
//
// Nothing like the classic's text shell. The V2 is a bag of registers read and written
// with one-byte opcodes, and a FIFO that streams measurements as it sweeps:
//
//     0x0d  INDICATE            -> replies 0x32, the character '2'
//     0x10  READ  addr          -> 1 byte      0x20  WRITE  addr, 1 byte
//     0x11  READ2 addr          -> 2 bytes     0x21  WRITE2 addr, 2 bytes
//     0x12  READ4 addr          -> 4 bytes     0x22  WRITE4 addr, 4 bytes
//     0x18  READFIFO addr, n    -> n bytes     0x23  WRITE8 addr, 8 bytes
//
//     0x00  sweep start, Hz, 8 bytes    0x20  points, 2 bytes      0xf0  device variant
//     0x10  sweep step, Hz, 8 bytes     0x22  values per point, 2  0xf3  firmware major
//     0x30  the FIFO: read it for measurements; write anything to it to clear and restart
//
// Each FIFO entry is 32 bytes: three complex readings as little-endian int32 pairs -
// forward, reflected at port 1, received at port 2 - then the point's index as uint16.
// S11 is reflected / forward; S21 is received / forward.
//
// WHAT COMES OUT IS RAW. The V2 applies no calibration to what it sends over USB - that
// is the host's job - so a sweep from this driver must go through calibration.ts before
// it means anything. The tool that asks for the sweep is told so, and refuses to show
// uncalibrated figures as if they were measurements.
//
// PROVENANCE. Written from the published protocol description, which is an interface.
// No code from the V2 firmware or from any client for it is used or consulted.
//
// Public domain (The Unlicense). By ZR1JT.

import type { MeasuredPoint } from '../touchstone';
import { impedanceFromGamma } from '../touchstone';
import { type Link, VnaError, concat, readUntil } from './link';
import type { Instrument, SweepRequest } from './instrument';

const OP = { INDICATE: 0x0d, READ: 0x10, READ2: 0x11, READ4: 0x12, READFIFO: 0x18, WRITE: 0x20, WRITE2: 0x21, WRITE8: 0x23 } as const;
const REG = { START: 0x00, STEP: 0x10, POINTS: 0x20, VALUES_PER_POINT: 0x22, FIFO: 0x30, VARIANT: 0xf0, FW_MAJOR: 0xf3, FW_MINOR: 0xf4 } as const;

const ENTRY_BYTES = 32;
/** READFIFO takes a one-byte count, so at most seven whole entries per request. */
const ENTRIES_PER_READ = 7;
const MAX_POINTS = 1024;

export class NanoVnaV2 implements Instrument {
  readonly kind = 'nanovna-v2' as const;
  name = 'NanoVNA-V2';

  constructor(private readonly link: Link) {}

  /** A V2 answers INDICATE with '2'. Anything else is not one. */
  static async probe(link: Link): Promise<boolean> {
    await link.write(new Uint8Array([OP.INDICATE]));
    const reply = await readUntil(link, (b) => b.includes(0x32), { totalMs: 1500, idleMs: 300 });
    return reply.includes(0x32);
  }

  private async read(op: number, addr: number, bytes: number): Promise<Uint8Array> {
    await this.link.write(new Uint8Array([op, addr]));
    const reply = await readUntil(this.link, (b) => b.length >= bytes, { totalMs: 3000, idleMs: 500 });
    if (reply.length < bytes) throw new VnaError('The NanoVNA-V2 did not answer a register read.');
    return reply.slice(0, bytes);
  }

  private async write(op: number, addr: number, value: bigint | number, bytes: number): Promise<void> {
    const frame = new Uint8Array(2 + bytes);
    frame[0] = op;
    frame[1] = addr;
    let v = BigInt(value);
    for (let i = 0; i < bytes; i++) {
      frame[2 + i] = Number(v & 0xffn);
      v >>= 8n;
    }
    await this.link.write(frame);
  }

  async describe(): Promise<string> {
    const variant = (await this.read(OP.READ, REG.VARIANT, 1))[0];
    if (variant !== 2) throw new VnaError(`That is not a NanoVNA-V2 (device variant ${variant}).`);
    const major = (await this.read(OP.READ, REG.FW_MAJOR, 1))[0];
    const minor = (await this.read(OP.READ, REG.FW_MINOR, 1))[0];
    this.name = `NanoVNA-V2 (firmware ${major}.${minor})`;
    return this.name;
  }

  async sweep(request: SweepRequest): Promise<MeasuredPoint[]> {
    const points = Math.max(2, Math.min(request.points, MAX_POINTS));
    const startHz = Math.round(request.startMHz * 1e6);
    const stopHz = Math.round(request.stopMHz * 1e6);
    if (!(stopHz > startHz)) throw new VnaError('The sweep has to go up.');
    const stepHz = Math.round((stopHz - startHz) / (points - 1));

    await this.write(OP.WRITE8, REG.START, startHz, 8);
    await this.write(OP.WRITE8, REG.STEP, stepHz, 8);
    await this.write(OP.WRITE2, REG.POINTS, points, 2);
    await this.write(OP.WRITE2, REG.VALUES_PER_POINT, 1, 2);
    // Clear the FIFO: the next entries out are index 0 of a fresh sweep.
    await this.write(OP.WRITE, REG.FIFO, 0, 1);

    const entries = new Map<number, { s11: { re: number; im: number } }>();
    request.onProgress?.(0, points);
    const deadline = Date.now() + 10_000 + points * 20;
    while (entries.size < points && Date.now() < deadline) {
      const want = Math.min(ENTRIES_PER_READ, points - entries.size) * ENTRY_BYTES;
      await this.link.write(new Uint8Array([OP.READFIFO, REG.FIFO, want]));
      const chunk = await readUntil(this.link, (b) => b.length >= want, { totalMs: 4000, idleMs: 600 });
      if (chunk.length < ENTRY_BYTES) continue; // not ready yet; ask again
      for (const entry of decodeFifo(chunk)) {
        if (entry.index < points) entries.set(entry.index, { s11: entry.s11 });
      }
      request.onProgress?.(entries.size, points);
    }
    if (entries.size < points) throw new VnaError(`The NanoVNA-V2 delivered ${entries.size} of ${points} points before timing out.`);

    const out: MeasuredPoint[] = [];
    for (let i = 0; i < points; i++) {
      const gamma = entries.get(i)!.s11;
      out.push({ fMHz: (startHz + i * stepHz) / 1e6, gamma, z: impedanceFromGamma(gamma, 50) });
    }
    return out;
  }

  async close(): Promise<void> {
    await this.link.close();
  }
}

export interface FifoEntry {
  index: number;
  s11: { re: number; im: number };
  s21: { re: number; im: number };
}

/** Whole 32-byte entries out of a FIFO read; a trailing partial entry is ignored. */
export function decodeFifo(bytes: Uint8Array): FifoEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: FifoEntry[] = [];
  for (let at = 0; at + ENTRY_BYTES <= bytes.length; at += ENTRY_BYTES) {
    const fwd = { re: view.getInt32(at, true), im: view.getInt32(at + 4, true) };
    const rev0 = { re: view.getInt32(at + 8, true), im: view.getInt32(at + 12, true) };
    const rev1 = { re: view.getInt32(at + 16, true), im: view.getInt32(at + 20, true) };
    const index = view.getUint16(at + 24, true);
    out.push({ index, s11: divide(rev0, fwd), s21: divide(rev1, fwd) });
  }
  return out;
}

function divide(a: { re: number; im: number }, b: { re: number; im: number }): { re: number; im: number } {
  const d = b.re * b.re + b.im * b.im;
  if (d === 0) return { re: 0, im: 0 };
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
}

/** For tests and the simulator: an entry, encoded the way the instrument sends it. */
export function encodeFifoEntry(entry: FifoEntry, forward = 1_000_000): Uint8Array {
  const bytes = new Uint8Array(ENTRY_BYTES);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, forward, true);
  view.setInt32(4, 0, true);
  view.setInt32(8, Math.round(entry.s11.re * forward), true);
  view.setInt32(12, Math.round(entry.s11.im * forward), true);
  view.setInt32(16, Math.round(entry.s21.re * forward), true);
  view.setInt32(20, Math.round(entry.s21.im * forward), true);
  view.setUint16(24, entry.index, true);
  return bytes;
}

export { concat as concatBytes };
