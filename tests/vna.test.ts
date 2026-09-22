// The VNA drivers, against simulated instruments.
//
// A real NanoVNA cannot be plugged into the test suite, so each driver is run against a
// fake that speaks the instrument's protocol - byte for byte, as the instrument does -
// and returns readings we chose. What is proved is that the driver sends what the
// protocol says, reads back what the instrument would send, and turns it into the same
// MeasuredPoint[] a .s1p file gives. The last mile, a real device on a real port, only a
// person with the device can walk.

import { describe, expect, it } from 'vitest';
import { cAbs, cSub } from '../src/lib/complex';
import { applyCalibration, calibrationCovers, makeCalibration, solveTerms } from '../src/lib/vna/calibration';
import { identify, VnaError } from '../src/lib/vna';
import { type Link, concat, decoder, text } from '../src/lib/vna/link';
import { NanoVna, parsePairs, parseScan } from '../src/lib/vna/nanovna';
import { NanoVnaV2, decodeFifo, encodeFifoEntry } from '../src/lib/vna/nanovna-v2';
import type { MeasuredPoint } from '../src/lib/touchstone';

/** A link whose far end is a function of what was written. */
class FakeLink implements Link {
  private queue: Uint8Array[] = [];
  readonly written: Uint8Array[] = [];
  closed = false;
  constructor(private readonly device: (bytes: Uint8Array) => Uint8Array | Uint8Array[] | undefined) {}
  async write(bytes: Uint8Array): Promise<void> {
    this.written.push(bytes);
    const reply = this.device(bytes);
    if (reply) this.queue.push(...(Array.isArray(reply) ? reply : [reply]));
  }
  async read(): Promise<Uint8Array> {
    return this.queue.shift() ?? new Uint8Array(0);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  get transcript(): string {
    return this.written.map((w) => decoder.decode(w)).join('');
  }
}

/** A load worth measuring: 75 ohms with a little inductance, as reflection. */
function gammaOf(fMHz: number) {
  const z = { re: 75, im: 2 * Math.PI * fMHz * 1e6 * 0.5e-6 };
  const d = (z.re + 50) ** 2 + z.im ** 2;
  return { re: ((z.re - 50) * (z.re + 50) + z.im * z.im) / d, im: (z.im * (z.re + 50) - (z.re - 50) * z.im) / d };
}

/** A classic NanoVNA with DiSlord firmware: answers `scan` with everything in one go. */
function classicWithScan(): FakeLink {
  return new FakeLink((bytes) => {
    const cmd = decoder.decode(bytes).trim();
    if (cmd === '') return text('ch> ');
    if (cmd === 'version') return text('version\r\n1.2.14\r\nch> ');
    if (cmd === 'info') return text('info\r\nBoard: NanoVNA-H 4\r\nch> ');
    const scan = /^scan (\d+) (\d+) (\d+) 3$/.exec(cmd);
    if (scan) {
      const [start, stop, points] = [Number(scan[1]), Number(scan[2]), Number(scan[3])];
      const lines = [];
      for (let i = 0; i < points; i++) {
        const hz = Math.round(start + ((stop - start) * i) / (points - 1));
        const g = gammaOf(hz / 1e6);
        lines.push(`${hz} ${g.re.toFixed(6)} ${g.im.toFixed(6)}`);
      }
      // Chunked, as a serial port delivers it.
      const whole = `${cmd}\r\n${lines.join('\r\n')}\r\nch> `;
      return [text(whole.slice(0, 40)), text(whole.slice(40))];
    }
    return text(`${cmd}\r\nch> `);
  });
}

/** Older firmware: `scan` prints nothing; the long way round is needed. */
function classicOld(): FakeLink {
  let start = 50_000;
  let stop = 900_000_000;
  const points = 101;
  return new FakeLink((bytes) => {
    const cmd = decoder.decode(bytes).trim();
    if (cmd === '') return text('ch> ');
    if (cmd === 'version') return text('version\r\n0.4.5-1\r\nch> ');
    const sweep = /^sweep (\d+) (\d+)/.exec(cmd);
    if (sweep) {
      start = Number(sweep[1]);
      stop = Number(sweep[2]);
      return text(`${cmd}\r\nch> `);
    }
    const hz = (i: number) => Math.round(start + ((stop - start) * i) / (points - 1));
    if (cmd === 'frequencies') return text(`frequencies\r\n${Array.from({ length: points }, (_, i) => hz(i)).join('\r\n')}\r\nch> `);
    if (cmd === 'data 0') {
      return text(
        `data 0\r\n${Array.from({ length: points }, (_, i) => {
          const g = gammaOf(hz(i) / 1e6);
          return `${g.re.toFixed(6)} ${g.im.toFixed(6)}`;
        }).join('\r\n')}\r\nch> `,
      );
    }
    return text(`${cmd}\r\nch> `);
  });
}

/** A V2: registers and a FIFO. */
function v2(): FakeLink {
  const regs = new Map<number, bigint>([
    [0xf0, 2n],
    [0xf3, 1n],
    [0xf4, 9n],
  ]);
  let cursor = 0;
  return new FakeLink((bytes) => {
    const op = bytes[0]!;
    const addr = bytes[1]!;
    if (op === 0x0d) return new Uint8Array([0x32]);
    if (op === 0x10) return new Uint8Array([Number(regs.get(addr) ?? 0n) & 0xff]);
    if (op >= 0x20 && op <= 0x23) {
      const size = { 0x20: 1, 0x21: 2, 0x22: 4, 0x23: 8 }[op]!;
      let v = 0n;
      for (let i = size - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[2 + i]!);
      regs.set(addr, v);
      if (addr === 0x30) cursor = 0; // clear the FIFO
      return undefined;
    }
    if (op === 0x18) {
      const want = bytes[2]!;
      const points = Number(regs.get(0x20) ?? 101n);
      const start = Number(regs.get(0x00) ?? 0n);
      const step = Number(regs.get(0x10) ?? 0n);
      const entries = [];
      for (let n = 0; n < Math.floor(want / 32) && cursor < points; n++, cursor++) {
        const g = gammaOf((start + cursor * step) / 1e6);
        entries.push(encodeFifoEntry({ index: cursor, s11: g, s21: { re: 0.01, im: 0 } }));
      }
      return concat(entries);
    }
    return undefined;
  });
}

const expectPoints = (points: MeasuredPoint[], count: number, startMHz: number, stopMHz: number) => {
  expect(points).toHaveLength(count);
  expect(points[0]!.fMHz).toBeCloseTo(startMHz, 6);
  expect(points[count - 1]!.fMHz).toBeCloseTo(stopMHz, 6);
  for (const p of points) {
    // The impedance is 75 ohms plus the inductance, whatever the instrument.
    expect(p.z.re).toBeCloseTo(75, 1);
    expect(p.z.im).toBeCloseTo(2 * Math.PI * p.fMHz * 1e6 * 0.5e-6, 1);
  }
};

describe('telling the instruments apart', () => {
  it('finds a classic NanoVNA by its prompt', async () => {
    const link = classicWithScan();
    const vna = await identify(link);
    expect(vna.kind).toBe('nanovna');
    expect(vna.name).toBe('NanoVNA-H 4 (1.2.14)');
  });

  it('finds a V2 by its answer to INDICATE, and asks it its firmware', async () => {
    const link = v2();
    const vna = await identify(link);
    expect(vna.kind).toBe('nanovna-v2');
    expect(vna.name).toBe('NanoVNA-V2 (firmware 1.9)');
  });

  it('says so when nothing answers, and when something else does', async () => {
    await expect(identify(new FakeLink(() => undefined))).rejects.toThrow(/Nothing answered/);
    const printer = new FakeLink(() => text('OK\r\n'));
    await expect(identify(printer)).rejects.toThrow(/not like a NanoVNA/);
    expect(printer.closed).toBe(false); // identify() does not own the link; connect() closes it
  });
});

describe('the classic NanoVNA', () => {
  it('sweeps in one command on firmware that has scan', async () => {
    const link = classicWithScan();
    const vna = new NanoVna(link);
    const progress: [number, number][] = [];
    const points = await vna.sweep({ startMHz: 1, stopMHz: 30, points: 101, onProgress: (d, t) => progress.push([d, t]) });
    expectPoints(points, 101, 1, 30);
    expect(link.transcript).toContain('scan 1000000 30000000 101 3\r');
    expect(link.transcript).not.toContain('data 0');
    expect(progress.at(-1)).toEqual([101, 101]);
  });

  it('falls back to sweep / frequencies / data on older firmware, and remembers', async () => {
    const link = classicOld();
    const vna = new NanoVna(link);
    const points = await vna.sweep({ startMHz: 3.5, stopMHz: 3.8, points: 101 });
    expectPoints(points, 101, 3.5, 3.8);
    expect(link.transcript).toContain('sweep 3500000 3800000 101\r');
    expect(link.transcript).toContain('frequencies\r');
    expect(link.transcript).toContain('data 0\r');
    // Second time it does not bother trying scan again.
    const before = link.written.length;
    await vna.sweep({ startMHz: 7, stopMHz: 7.3, points: 101 });
    expect(link.written.slice(before).map((w) => decoder.decode(w)).join('')).not.toContain('scan ');
  }, 20_000);

  it('refuses a sweep that goes down', async () => {
    await expect(new NanoVna(classicWithScan()).sweep({ startMHz: 30, stopMHz: 1, points: 101 })).rejects.toThrow(VnaError);
  });

  it('parses what the shell prints and ignores what it should', () => {
    expect(parseScan('1000000 0.5 -0.25\r\n2000000 0.4 -0.2\r\nsome noise\r\n')).toEqual([
      { hz: 1000000, re: 0.5, im: -0.25 },
      { hz: 2000000, re: 0.4, im: -0.2 },
    ]);
    expect(parsePairs('0.5 -0.25\n\nx y\n0.1 0.2')).toEqual([
      [0.5, -0.25],
      [0.1, 0.2],
    ]);
  });
});

describe('the NanoVNA-V2', () => {
  it('sets the sweep registers, clears the FIFO, and reads it out', async () => {
    const link = v2();
    const vna = new NanoVnaV2(link);
    const progress: [number, number][] = [];
    const points = await vna.sweep({ startMHz: 1, stopMHz: 30, points: 51, onProgress: (d, t) => progress.push([d, t]) });
    expectPoints(points, 51, 1, 30);
    // WRITE8 start, WRITE8 step, WRITE2 points, WRITE2 values-per-point, WRITE fifo.
    const ops = link.written.map((w) => w[0]);
    expect(ops.slice(0, 5)).toEqual([0x23, 0x23, 0x21, 0x21, 0x20]);
    expect(link.written[0]!.slice(2, 10)).toEqual(new Uint8Array([0x40, 0x42, 0x0f, 0, 0, 0, 0, 0])); // 1 000 000 little-endian
    expect(ops.filter((o) => o === 0x18).length).toBe(Math.ceil(51 / 7));
    expect(progress.at(-1)).toEqual([51, 51]);
  });

  it('encodes and decodes FIFO entries exactly', () => {
    const entry = { index: 37, s11: { re: -0.3, im: 0.125 }, s21: { re: 0.5, im: -0.5 } };
    const [back] = decodeFifo(encodeFifoEntry(entry));
    expect(back!.index).toBe(37);
    expect(back!.s11.re).toBeCloseTo(-0.3, 5);
    expect(back!.s11.im).toBeCloseTo(0.125, 5);
    expect(back!.s21.re).toBeCloseTo(0.5, 5);
    // A trailing partial entry is ignored, not misread.
    const bytes = concat([encodeFifoEntry(entry), new Uint8Array(10)]);
    expect(decodeFifo(bytes)).toHaveLength(1);
  });
});

describe('one-port calibration', () => {
  /** An imperfect instrument: known error terms, so the correction can be checked exactly. */
  const terms = (fMHz: number) => ({
    e00: { re: 0.05 + fMHz / 1000, im: -0.02 },
    e11: { re: -0.1, im: 0.03 + fMHz / 2000 },
    e10e01: { re: 0.9, im: -0.05 },
  });
  const measure = (fMHz: number, actual: { re: number; im: number }) => {
    const { e00, e11, e10e01 } = terms(fMHz);
    // Gm = e00 + e10e01 * Ga / (1 - e11 * Ga)
    const denom = cSub({ re: 1, im: 0 }, { re: e11.re * actual.re - e11.im * actual.im, im: e11.re * actual.im + e11.im * actual.re });
    const num = { re: e10e01.re * actual.re - e10e01.im * actual.im, im: e10e01.re * actual.im + e10e01.im * actual.re };
    const d = denom.re ** 2 + denom.im ** 2;
    const q = { re: (num.re * denom.re + num.im * denom.im) / d, im: (num.im * denom.re - num.re * denom.im) / d };
    const gamma = { re: e00.re + q.re, im: e00.im + q.im };
    return { fMHz, gamma, z: { re: 0, im: 0 } } as MeasuredPoint;
  };
  const freqs = [1, 3.5, 7, 14, 21, 28];
  const standards = {
    short: freqs.map((f) => measure(f, { re: -1, im: 0 })),
    open: freqs.map((f) => measure(f, { re: 1, im: 0 })),
    load: freqs.map((f) => measure(f, { re: 0, im: 0 })),
  };

  it('recovers the error terms from the three standards', () => {
    for (const t of solveTerms(standards.short, standards.open, standards.load)) {
      const want = terms(t.fMHz);
      expect(cAbs(cSub(t.e00, want.e00))).toBeLessThan(1e-12);
      expect(cAbs(cSub(t.e11, want.e11))).toBeLessThan(1e-12);
      expect(cAbs(cSub(t.e10e01, want.e10e01))).toBeLessThan(1e-12);
    }
  });

  it('corrects a raw reading back to what was really there', () => {
    const cal = makeCalibration(standards.short, standards.open, standards.load);
    const truth = { re: 0.3, im: -0.4 };
    const raw = freqs.map((f) => measure(f, truth));
    for (const p of applyCalibration(raw, cal)) {
      expect(p.gamma.re).toBeCloseTo(truth.re, 10);
      expect(p.gamma.im).toBeCloseTo(truth.im, 10);
      expect(p.z.re).toBeCloseTo(50 * (1 - 0.3 * 0.3 - 0.4 * 0.4) / ((1 - 0.3) ** 2 + 0.4 ** 2), 6);
    }
    // ...and interpolates the terms between calibrated frequencies.
    const between = applyCalibration([measure(10.5, truth)], cal)[0]!;
    expect(cAbs(cSub(between.gamma, truth))).toBeLessThan(0.01);
  });

  it('knows what range it covers', () => {
    const cal = makeCalibration(standards.short, standards.open, standards.load);
    expect(calibrationCovers(cal, 1.8, 28)).toBe(true);
    expect(calibrationCovers(cal, 1.8, 50)).toBe(false);
    expect(calibrationCovers(cal, 0.5, 28)).toBe(false);
  });

  it('refuses standards that were not swept alike', () => {
    expect(() => solveTerms(standards.short, standards.open.slice(1), standards.load)).toThrow(/same frequencies/);
  });
});
