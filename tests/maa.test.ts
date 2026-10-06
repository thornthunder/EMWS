// MMANA-GAL .maa files. The fixtures are written here, CC0, in the shapes 935 real files
// were MEASURED to take (2026-10-05: 877 opened, all 877 solved and round-tripped; the 58
// refused each with a stated reason - 40 of them stepped-diameter "taper" elements).

import { describe, expect, it } from 'vitest';
import { loadExample, simulate } from './helpers/engine';
import { deckToModel, modelToDeck } from '../src/tools/antenna-modeler/deck';
import { decodeMaa, encodeMaa, maaToModel, modelToMaa } from '../src/tools/antenna-modeler/maa';
import type { AntennaModel } from '../src/tools/antenna-modeler/model';

const ok = (text: string) => {
  const r = maaToModel(text);
  if (!r.ok) throw new Error(r.reason);
  return r;
};

/** A 20 m dipole 10 m up (via MMANA's add height), with a trap, a coil and a resistor. */
const DIPOLE = [
  '20 m test dipole',
  '*',
  '14.2',
  '***Wires***',
  '1',
  '0.0,\t-5.13,\t0.0,\t0.0,\t5.13,\t0.0,\t0.001,\t-1',
  '***Source***',
  '1,\t1',
  'w1c,\t0.0,\t1.0',
  '***Load***',
  '3,\t1',
  'w1b2,\t0,\t2.0,\t60.0,\t200',
  'w1e1,\t0,\t1.5,\t0.0,\t0',
  'w1c1,\t1,\t50.0,\t-25.0',
  '***Segmentation***',
  '800,\t80,\t2.0,\t1',
  '***G/H/M/R/AzEl/X***',
  '2,\t10.0,\t1,\t50.0,\t120,\t60,\t0.0',
  '###Comment###',
  'Written for the EMWS tests. CC0.',
].join('\r\n');

describe('reading a .maa', () => {
  it('reads wires in metres, adds the height, segments automatic wires its own way', () => {
    const r = ok(DIPOLE);
    const w = r.model.wires[0]!;
    expect(r.model.wires).toHaveLength(1);
    expect(w.radius).toBe(0.001);
    expect(w.a.z).toBe(10);
    expect(w.b.z).toBe(10);
    // λ/20 at 14.2 MHz over 10.26 m, odd: 11.
    expect(w.segments).toBe(11);
    expect(r.model.frequency).toEqual({ startMHz: 14.2, stepMHz: 0, steps: 1 });
    expect(r.model.comments).toEqual(['20 m test dipole', 'Written for the EMWS tests. CC0.']);
    expect(r.notes.join(' ')).toMatch(/MININEC/);
    expect(r.notes.join(' ')).toMatch(/add height" of 10 m/);
    expect(r.notes.join(' ')).toMatch(/material setting \(code 1\) was not carried over/);
  });

  it('puts sources and loads where the pulses say, and reads each load type', () => {
    const r = ok(DIPOLE);
    expect(r.model.feeds[0]!.segment).toBe(6); // the centre of 11
    const [trap, coil, resistor] = r.model.loads;
    // w1b2: two past the first segment.
    expect(trap!.segment).toBe(3);
    expect(trap!.kind).toBe('parallel');
    expect(trap!.henries).toBeCloseTo(2e-6, 15);
    expect(trap!.farads).toBeCloseTo(60e-12, 20);
    // Q 200 at the trap's own resonance, as a parallel loss: Q ω0 L.
    expect(trap!.ohms).toBeCloseTo((200 * 2e-6) / Math.sqrt(2e-6 * 60e-12), 6);
    // w1e1: one before the last.
    expect(coil!.segment).toBe(10);
    expect(coil!.kind).toBe('series');
    expect(coil!.henries).toBeCloseTo(1.5e-6, 15);
    expect(coil!.ohms).toBe(0);
    // w1c1: one past the centre.
    expect(resistor!.segment).toBe(7);
    expect(resistor!).toMatchObject({ kind: 'impedance', ohms: 50, reactance: -25 });
  });

  it('reads the Russian edition by position, whatever the headers say, in its own code page', () => {
    // Cyrillic А..я sit at 0xC0..0xFF in windows-1251.
    const cp1251 = (s: string) => Uint8Array.from([...s].map((c) => (c >= 'А' && c <= 'я' ? c.charCodeAt(0) - 0x410 + 0xc0 : c.charCodeAt(0))));
    const text = DIPOLE.replace('20 m test dipole', 'Диполь')
      .replace('***Wires***', '* Провода *')
      .replace('***Source***', '*** Источ. ***')
      .replace('***Load***', '*** Нагрузка ***')
      .replace('***Segmentation***', '*** Автосегм ***')
      .replace('***G/H/M/R/AzEl/X***', '*G/H/M/R/AzEl/X*');
    const decoded = decodeMaa(cp1251(text));
    expect(decoded).toContain('Провода');
    const r = ok(decoded);
    expect(r.model.comments[0]).toBe('Диполь');
    expect(r.model.loads).toHaveLength(3);
    expect(r.model.wires[0]!.a.z).toBe(10);
  });

  it('gives one more segment to an even wire fed at its centre, so a segment sits there', () => {
    const r = ok(DIPOLE.replace('0.001,\t-1', '0.001,\t10'));
    expect(r.model.wires[0]!.segments).toBe(11);
    expect(r.model.feeds[0]!.segment).toBe(6);
    expect(r.notes.join(' ')).toMatch(/even segment count/);
  });

  it('refuses what NEC-2 cannot hold, and says which and why', () => {
    const cases: [string, RegExp][] = [
      [DIPOLE.replace('0.001,\t-1', '-0.001,\t-1'), /stepped-diameter/],
      [DIPOLE.replace('0.001,\t-1', '0.0,\t-1'), /insulator/],
      [DIPOLE.replace('w1c1,\t1,\t50.0,\t-25.0', 'w1c1,\t2,\t0.0,1.0,1e-6,0,0,1e-16'), /"S" type/],
      [DIPOLE.replace('2,\t10.0,\t1,\t50.0', '7,\t10.0,\t1,\t50.0'), /not one of MMANA's ground types/],
      [DIPOLE.replace('1,\t1\r\nw1c,\t0.0,\t1.0', '0,\t1'), /no source/],
      [DIPOLE.replace('w1c,\t0.0', 'w4c,\t0.0'), /not a wire in this file/],
      ['just some text\r\nnot an antenna', /no section headers/],
    ];
    for (const [text, reason] of cases) {
      const r = maaToModel(text);
      expect(r.ok, String(reason)).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(reason);
    }
  });
});

describe('writing a .maa', () => {
  it('writes Russian text in windows-1251 and Western text in windows-1252, so MMANA reads it back', () => {
    expect([...encodeMaa('Диполь Ёё')]).toEqual([0xc4, 0xe8, 0xef, 0xee, 0xeb, 0xfc, 0x20, 0xa8, 0xb8]);
    expect(decodeMaa(encodeMaa('Диполь 40 м'))).toBe('Диполь 40 м');
    expect([...encodeMaa('Müller 5 Ω')]).toEqual([0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72, 0x20, 0x35, 0x20, 0x3f]);
    expect(decodeMaa(encodeMaa('Müller 5 Ω'))).toBe('Müller 5 ?');
  });

  it('round-trips the trap dipole: geometry, feed, and the traps with their loss', async () => {
    const imported = deckToModel(await loadExample('trap-dipole-40-80m.nec'));
    if (!imported.ok) throw new Error(imported.reason);
    const model = imported.model;
    const out = modelToMaa(model);
    if (!out.ok) throw new Error(out.reason);
    const back = ok(out.text);
    expect(back.model.wires.map((w) => [w.a, w.b, w.radius, w.segments])).toEqual(model.wires.map((w) => [w.a, w.b, w.radius, w.segments]));
    expect(back.model.feeds.map((f) => f.segment)).toEqual(model.feeds.map((f) => f.segment));
    expect(back.model.loads).toHaveLength(model.loads.length);
    for (const [i, l] of model.loads.entries()) {
      const b = back.model.loads[i]!;
      expect(b.kind).toBe(l.kind);
      expect(b.segment).toBe(l.segment);
      expect(b.henries).toBeCloseTo(l.henries, 12);
      expect(b.farads).toBeCloseTo(l.farads, 18);
      expect(b.ohms / (l.ohms || 1)).toBeCloseTo(l.ohms === 0 ? 0 : 1, 4);
    }
  });

  it('refuses what MMANA cannot hold rather than dropping it', () => {
    const base = ok(DIPOLE).model;
    const seriesLC: AntennaModel = { ...base, loads: [{ ...base.loads[1]!, kind: 'series', henries: 1e-6, farads: 100e-12 }] };
    const r1 = modelToMaa(seriesLC);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toMatch(/parallel trap/);
    const r2 = modelToMaa({ ...base, extraCards: ['TL 1 6 2 6 50 0'] });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toMatch(/TL/);
  });
});

describe('on the real engine', () => {
  it('solves an imported dipole to the same impedance as the same dipole written as NEC', async () => {
    const free = DIPOLE.replace('2,\t10.0,\t1,\t50.0', '0,\t0.0,\t1,\t50.0').replace(/\*\*\*Load\*\*\*\r\n3,\t1\r\n[^*]*/, '***Load***\r\n0,\t1\r\n');
    const fromMaa = ok(free).model;
    const run = await simulate(modelToDeck(fromMaa, { pattern: 'none' }));
    const example = deckToModel(await loadExample('dipole-20m-free-space.nec'));
    if (!example.ok) throw new Error(example.reason);
    // Same wire, same 2 mm, but 11 segments where the example has 21: close, not equal.
    const reference = await simulate(modelToDeck(example.model, { pattern: 'none' }));
    const z = run.report.frequencies[0]!.feeds[0]!.impedance;
    const zr = reference.report.frequencies[0]!.feeds[0]!.impedance;
    expect(Math.abs(z.re - zr.re)).toBeLessThan(2);
    expect(Math.abs(z.im - zr.im)).toBeLessThan(5);
  }, 30_000);

  it('stands a grounded vertical on a radial screen, giving the perfect-ground impedance as MMANA does', async () => {
    const vertical = [
      '40 m quarter wave',
      '*',
      '7.1',
      '***Wires***',
      '1',
      '0.0,\t0.0,\t0.0,\t0.0,\t0.0,\t10.3,\t0.001,\t-1',
      '***Source***',
      '1,\t1',
      'w1b,\t0.0,\t1.0',
      '***Load***',
      '0,\t1',
      '***Segmentation***',
      '800,\t80,\t2.0,\t1',
      '***G/H/M/R/AzEl/X***',
      '2,\t0.0,\t0,\t50.0,\t120,\t60,\t0.0',
    ].join('\r\n');
    const r = ok(vertical);
    expect(r.model.ground).toMatchObject({ kind: 'real', method: 'reflection', screen: { radials: 32 } });
    expect(r.notes.join(' ')).toMatch(/radial screen/);
    const screened = await simulate(modelToDeck(r.model, { pattern: 'none' }));
    const perfect = await simulate(modelToDeck({ ...r.model, ground: { kind: 'perfect' } }, { pattern: 'none' }));
    const zs = screened.report.frequencies[0]!.feeds[0]!.impedance;
    const zp = perfect.report.frequencies[0]!.feeds[0]!.impedance;
    expect(zs.re).toBeCloseTo(zp.re, 6);
    expect(zs.im).toBeCloseTo(zp.im, 6);
  }, 30_000);
});
