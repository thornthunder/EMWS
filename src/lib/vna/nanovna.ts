// The NanoVNA, NanoVNA-H and -H4: the text-shell protocol.
//
// The instrument presents a tiny command shell over USB serial. Send a command ending in
// CR; it echoes the command, prints its reply line by line, and ends with the prompt
// "ch> ". The commands used here:
//
//     version                     one line, e.g. 1.2.14
//     info                        several lines, names the board
//     sweep <start> <stop> [pts]  set the sweep range in Hz (points only on newer firmware)
//     frequencies                 the sweep's frequencies, one per line, Hz
//     data 0                      S11 at each of them, "re im" per line - CALIBRATED,
//                                 with whatever calibration the instrument has applied
//     scan <start> <stop> <pts> 3 newer firmware only: sweep and return "freq re im"
//                                 lines in one go, with nothing to wait for
//
// PROVENANCE. This is written from the protocol - the commands and what they print -
// which is an interface, not a work. The NanoVNA firmware and the usual desktop client
// are GPL; no code from either is used or consulted here, in keeping with this project's
// rule, and nothing here should be lifted from them in future either.
//
// Public domain (The Unlicense). By ZR1JT.

import type { MeasuredPoint } from '../touchstone';
import { impedanceFromGamma } from '../touchstone';
import { type Link, VnaError, decoder, readUntil, text } from './link';
import type { Instrument, SweepRequest } from './instrument';

const PROMPT = 'ch> ';

/** Firmware needs a moment to complete a sweep before "data" reads a fresh one. */
const MS_PER_POINT = 12;
const SETTLE_MS = 400;

const endsWithPrompt = (bytes: Uint8Array) => decoder.decode(bytes).endsWith(PROMPT);

export class NanoVna implements Instrument {
  readonly kind = 'nanovna' as const;
  name = 'NanoVNA';
  private scanSupported: boolean | undefined;

  constructor(private readonly link: Link) {}

  /** Is there a NanoVNA on the other end? A CR alone earns a prompt from one. */
  static async probe(link: Link): Promise<boolean> {
    await link.write(text('\r'));
    const reply = decoder.decode(await readUntil(link, endsWithPrompt, { totalMs: 1500, idleMs: 300 }));
    return reply.includes(PROMPT);
  }

  /** Sends a command and returns its reply, minus the echo and the prompt. */
  async command(cmd: string, totalMs = 5000): Promise<string> {
    await this.link.write(text(`${cmd}\r`));
    const raw = decoder.decode(await readUntil(this.link, endsWithPrompt, { totalMs, idleMs: 500 }));
    if (!raw.endsWith(PROMPT)) throw new VnaError(`The NanoVNA did not answer "${cmd}" in time.`);
    const lines = raw.slice(0, -PROMPT.length).split(/\r?\n/);
    // The first line is the echo of what was sent.
    if (lines[0]?.trim() === cmd.trim()) lines.shift();
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
    return lines.join('\n');
  }

  async describe(): Promise<string> {
    const version = (await this.command('version', 2000)).trim();
    const info = await this.command('info', 2000).catch(() => '');
    const board = info.split('\n').find((l) => /board|nanovna/i.test(l))?.trim();
    this.name = board ? `${board.replace(/^board\s*[:=]?\s*/i, '')} (${version})` : `NanoVNA ${version}`.trim();
    return this.name;
  }

  async sweep(request: SweepRequest): Promise<MeasuredPoint[]> {
    const startHz = Math.round(request.startMHz * 1e6);
    const stopHz = Math.round(request.stopMHz * 1e6);
    const points = Math.max(2, Math.min(request.points, 1001));
    if (!(stopHz > startHz)) throw new VnaError('The sweep has to go up.');

    // Newer firmware answers a whole sweep to one command. Try it once; if it prints
    // nothing usable, this is older firmware and the long way round is used from then on.
    if (this.scanSupported !== false) {
      const reply = await this.command(`scan ${startHz} ${stopHz} ${points} 3`, 3000 + points * MS_PER_POINT * 2);
      const parsed = parseScan(reply);
      if (parsed.length >= 2) {
        this.scanSupported = true;
        request.onProgress?.(parsed.length, parsed.length);
        return parsed.map(toPoint);
      }
      this.scanSupported = false;
    }

    await this.command(`sweep ${startHz} ${stopHz} ${points}`, 2000);
    request.onProgress?.(0, points);
    // Let it complete at least one sweep of the new range before reading it back.
    await new Promise((r) => setTimeout(r, SETTLE_MS + points * MS_PER_POINT));
    const frequencies = parseNumbers(await this.command('frequencies', 5000));
    request.onProgress?.(frequencies.length, frequencies.length * 2);
    const s11 = parsePairs(await this.command('data 0', 5000));
    if (frequencies.length < 2 || s11.length !== frequencies.length) {
      throw new VnaError(`The NanoVNA returned ${frequencies.length} frequencies but ${s11.length} readings.`);
    }
    if (Math.abs(frequencies[0]! - startHz) > startHz * 0.01) {
      throw new VnaError('The NanoVNA has not taken the new sweep range. Try again.');
    }
    request.onProgress?.(frequencies.length * 2, frequencies.length * 2);
    return frequencies.map((hz, i) => toPoint({ hz, re: s11[i]![0], im: s11[i]![1] }));
  }

  async close(): Promise<void> {
    await this.link.close();
  }
}

interface ScanLine {
  hz: number;
  re: number;
  im: number;
}

/** "freq re im" lines, as `scan ... 3` prints them. Anything else on a line is ignored. */
export function parseScan(reply: string): ScanLine[] {
  const out: ScanLine[] = [];
  for (const line of reply.split('\n')) {
    const f = line.trim().split(/\s+/).map(Number);
    if (f.length >= 3 && f.every(Number.isFinite) && f[0]! > 0) out.push({ hz: f[0]!, re: f[1]!, im: f[2]! });
  }
  return out;
}

export function parseNumbers(reply: string): number[] {
  return reply
    .split('\n')
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

export function parsePairs(reply: string): [number, number][] {
  const out: [number, number][] = [];
  for (const line of reply.split('\n')) {
    const f = line.trim().split(/\s+/).map(Number);
    if (f.length >= 2 && Number.isFinite(f[0]) && Number.isFinite(f[1])) out.push([f[0]!, f[1]!]);
  }
  return out;
}

function toPoint({ hz, re, im }: ScanLine): MeasuredPoint {
  const gamma = { re, im };
  return { fMHz: hz / 1e6, gamma, z: impedanceFromGamma(gamma, 50) };
}
