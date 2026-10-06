// MMANA-GAL's .maa antenna files, in and out.
//
// The largest pool of amateur antenna models anywhere is in this plain-text format, so
// opening it brings people's existing work in. It was written from the format itself,
// never from MMANA's code: from MMANA-GAL basic's own help (its sample file and its
// definitions of the wire, source and load tables), checked line by line against 935
// real files from a public collection, with OpenNEC's MIT-licensed format notes read for
// orientation only (no text or code taken; where they disagreed with the help and the
// files - the load line - the help and the files won).
//
// What a .maa holds, in order, each section after a header line of stars (in English,
// "***Wires***", or Russian, "* Провода *" - so sections are found by POSITION, never by
// name):
//
//   title / "*" / frequency MHz
//   wires:    count; then X1, Y1, Z1, X2, Y2, Z2 (m), radius (m), segments
//   sources:  count, flag; then pulse, phase (deg), volts
//   loads:    count, flag; then pulse, type, parameters
//   segmentation (DM1, DM2, SC, EC); ground line G/H/M/R/AzEl/X; ###Comment###
//
// Facts this rests on, each confirmed in the help or the files: the file's radius is in
// METRES (the help's sample whip carries 0.0015 for 1.5 mm; the table shows mm); a
// NEGATIVE radius points at a stepped-diameter "taper" definition, not a size; segments
// > 0 are exact and 0, -1, -2, -3 are MMANA's automatic (mostly tapered) schemes; a pulse
// is W<wire><C|B|E>[offset]; load type 0 is L (µH), C (pF), Q - with L and C both set a
// PARALLEL trap - type 1 is R + jX, type 2 a Laplace "S" polynomial; ground 0 free space,
// 1 perfect, 2 real; H is the "add height" put under every wire. NOT known, so never
// guessed: the material code table, and the soil (kept in MMANA's setup, not the file).
//
// MMANA computes with MININEC, EMWS with NEC-2. Close, not identical - the notes say so.
//
// Public domain (The Unlicense). By ZR1JT.

import { type AntennaModel, AVERAGE_GROUND, type Feed, type Load, type Wire, newId, suggestedSegments, wavelengthM } from './model';

export type MaaImport = { ok: true; model: AntennaModel; notes: string[]; z0?: number } | { ok: false; reason: string };

/**
 * Bytes to text. MMANA writes in the Windows code page of its user: Western files in
 * 1252, the Russian edition's in 1251. UTF-8 is tried first. Then: read as 1251, three
 * Cyrillic letters in a row anywhere is Russian - a Western file's accented letters
 * almost never come three high bytes together. (Headers alone are not enough: an English
 * MMANA writes English headers above a Russian comment.)
 */
export function decodeMaa(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    const cyrillic = new TextDecoder('windows-1251').decode(bytes);
    return /[Ѐ-ӿ]{3}/.test(cyrillic) ? cyrillic : new TextDecoder('windows-1252').decode(bytes);
  }
}

const isHeader = (l: string) => (/^\*+.*\*+$/.test(l) && /[^\s*]/.test(l)) || /^#{3}/.test(l);
const fields = (l: string) => l.split(/[\s,]+/).filter(Boolean);
const numbers = (l: string) => fields(l).map(Number);
const finite = (xs: number[]) => xs.every((x) => Number.isFinite(x));

interface Block {
  header: string;
  rows: string[];
}

/** A pulse: W<n><C|B|E>[signed offset]. Resolves to a 1-based NEC segment once the wire's count is known. */
interface Pulse {
  wire: number;
  at: 'c' | 'b' | 'e';
  offset: number;
}

function parsePulse(token: string): Pulse | undefined {
  const m = /^[wv](\d+)([cbe])([-+]?\d+)?$/i.exec(token.trim());
  if (!m) return undefined;
  return { wire: Number(m[1]), at: m[2]!.toLowerCase() as Pulse['at'], offset: m[3] ? Number(m[3]) : 0 };
}

function segmentOf(p: Pulse, n: number): number {
  const base = p.at === 'c' ? Math.ceil(n / 2) : p.at === 'b' ? 1 + p.offset : n - p.offset;
  const s = p.at === 'c' ? base + p.offset : base;
  return Math.min(n, Math.max(1, s));
}

export function maaToModel(text: string): MaaImport {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const refuse = (reason: string): MaaImport => ({ ok: false, reason });

  // The preamble (before the first header) holds title, "*" and frequency - and, in a few
  // files, the wire table too, with no header of its own.
  const first = lines.findIndex(isHeader);
  if (first < 0) return refuse('This does not look like an MMANA .maa file: it has no section headers (lines such as ***Wires***).');
  const preamble = lines.slice(0, first).filter((l) => l !== '');
  const blocks: Block[] = [];
  let current: Block | undefined;
  for (const l of lines.slice(first)) {
    if (isHeader(l)) {
      current = { header: l, rows: [] };
      blocks.push(current);
    } else if (l !== '' && current) current.rows.push(l);
  }
  const comments = blocks.filter((b) => b.header.startsWith('#'));
  const sections = blocks.filter((b) => !b.header.startsWith('#'));

  let title = '';
  let i = 0;
  if (preamble[i] !== undefined && preamble[i] !== '*' && !finite(numbers(preamble[i]!))) title = preamble[i++]!;
  if (preamble[i] === '*') i++;
  const fMHz = Number(preamble[i++]);
  if (!(fMHz > 0)) return refuse('The file gives no frequency where MMANA puts it, after the title.');
  const headerlessWires = preamble.slice(i);
  const wireBlock: Block | undefined = headerlessWires.length > 0 ? { header: '', rows: headerlessWires } : sections.shift();
  const [sourceBlock, loadBlock, , groundBlock] = sections;
  if (!wireBlock || !sourceBlock) return refuse('The file has no wire table or no source table.');

  // ---- wires ----
  const notes: string[] = [];
  const declared = Number(wireBlock.rows[0]);
  const wireRows = wireBlock.rows.slice(1).map(numbers);
  if (!(declared > 0) || wireRows.length < declared) return refuse(`The file says it has ${wireBlock.rows[0]} wires but lists ${wireRows.length}.`);
  const ground = groundBlock?.rows[0] ? numbers(groundBlock.rows[0]) : [];
  const g = ground[0];
  if (g !== undefined && g !== 0 && g !== 1 && g !== 2) return refuse(`The ground line starts with ${ground[0]}, which is not one of MMANA's ground types (0 free space, 1 perfect, 2 real).`);
  const freeSpace = g === undefined || g === 0;
  const addHeight = !freeSpace && Number.isFinite(ground[1]) ? ground[1]! : 0;
  const wavelength = wavelengthM(fMHz);
  const wires: Wire[] = [];
  let autoSegmented = 0;
  for (const [k, row] of wireRows.slice(0, declared).entries()) {
    if (row.length < 8 || !finite(row.slice(0, 8))) return refuse(`Wire ${k + 1}: expected X1, Y1, Z1, X2, Y2, Z2, R, Seg as numbers.`);
    const [x1, y1, z1, x2, y2, z2, r, seg] = row as [number, number, number, number, number, number, number, number];
    if (r < 0) return refuse(`Wire ${k + 1} uses one of MMANA's stepped-diameter ("taper") elements (a negative radius points at its definition). EMWS cannot build those from the file yet; replace it with a plain wire in MMANA, or model the steps as separate wires.`);
    if (r === 0) return refuse(`Wire ${k + 1} has a radius of 0, which MMANA uses as an insulator between wires. NEC-2 has no insulating wire.`);
    const a = { x: x1, y: y1, z: z1 + addHeight };
    const b = { x: x2, y: y2, z: z2 + addHeight };
    const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    // MMANA's tapering packs segments in near junctions; NEC-2's even λ/20 gives a short
    // wire just one, and MEASURED on a real file (a 160 m tower's legs) one segment per wire
    // in a junction stopped nec2c outright. So never fewer than three - odd, for a centre.
    let segments = seg > 0 ? Math.round(seg) : Math.max(3, suggestedSegments(length, wavelength));
    if (!(seg > 0)) autoSegmented += 1;
    wires.push({ id: newId('w'), tag: k + 1, a, b, radius: r, segments });
  }

  // ---- sources ----
  const feeds: Feed[] = [];
  const sourceCount = Number(fields(sourceBlock.rows[0] ?? '')[0]);
  let evenCentres = 0;
  for (const row of sourceBlock.rows.slice(1, 1 + (sourceCount > 0 ? sourceCount : 0))) {
    const [pulseText, phaseText, voltsText] = fields(row);
    const pulse = parsePulse(pulseText ?? '');
    const wire = pulse && wires[pulse.wire - 1];
    if (!pulse || !wire) return refuse(`A source sits at "${pulseText}", which is not a wire in this file.`);
    // A centre pulse on an even count sits between two segments; NEC-2 feeds a segment.
    // One more segment puts one exactly at the centre, which is where MMANA put the source.
    if (pulse.at === 'c' && pulse.offset === 0 && wire.segments % 2 === 0) {
      wire.segments += 1;
      evenCentres += 1;
    }
    const phase = (Number(phaseText) * Math.PI) / 180;
    const volts = Number(voltsText);
    if (!Number.isFinite(phase) || !Number.isFinite(volts)) return refuse(`The source at ${pulseText} has no phase and voltage the file can be read for.`);
    feeds.push({ id: newId('f'), wireId: wire.id, segment: segmentOf(pulse, wire.segments), voltage: { re: volts * Math.cos(phase), im: volts * Math.sin(phase) } });
  }
  if (feeds.length === 0) return refuse('The file has no source, so there is nothing to excite the antenna.');

  // ---- loads ----
  const loads: Load[] = [];
  let qConverted = 0;
  const loadCount = Number(fields(loadBlock?.rows[0] ?? '0')[0]);
  for (const row of (loadBlock?.rows ?? []).slice(1, 1 + (loadCount > 0 ? loadCount : 0))) {
    const [pulseText, typeText, ...rest] = fields(row);
    const pulse = parsePulse(pulseText ?? '');
    const wire = pulse && wires[pulse.wire - 1];
    if (!pulse || !wire) return refuse(`A load sits at "${pulseText}", which is not a wire in this file.`);
    const p = rest.map(Number);
    const base = { id: newId('l'), wireId: wire.id, segment: segmentOf(pulse, wire.segments), ohms: 0, henries: 0, farads: 0, reactance: 0 };
    const type = Number(typeText);
    if (type === 0) {
      const [uH = 0, pF = 0, q = 0] = p;
      const L = uH * 1e-6;
      const C = pF * 1e-12;
      if (L > 0 && C > 0) {
        // MMANA's L and C together are a parallel trap; its loss as a parallel resistance at its own resonance.
        const w0 = 1 / Math.sqrt(L * C);
        if (q > 0) qConverted += 1;
        loads.push({ ...base, kind: 'parallel', henries: L, farads: C, ohms: q > 0 ? q * w0 * L : 0, label: `trap, ${fmt(uH)} µH / ${fmt(pF)} pF` });
      } else if (L > 0 || C > 0) {
        // A lone coil or capacitor, in series; its Q as a series resistance at the file's frequency.
        const w = 2 * Math.PI * fMHz * 1e6;
        const x = L > 0 ? w * L : 1 / (w * C);
        if (q > 0) qConverted += 1;
        loads.push({ ...base, kind: 'series', henries: L, farads: C, ohms: q > 0 ? x / q : 0, label: L > 0 ? `coil, ${fmt(uH)} µH` : `capacitor, ${fmt(pF)} pF` });
      }
      // L and C both 0 is MMANA's way of switching a load off: nothing to add.
    } else if (type === 1) {
      const [r = 0, x = 0] = p;
      loads.push({ ...base, kind: 'impedance', ohms: r, reactance: x, label: `${fmt(r)} ${x < 0 ? '−' : '+'} j${fmt(Math.abs(x))} Ω` });
    } else {
      return refuse(`The load at ${pulseText} is MMANA's "S" type (a Laplace polynomial, or an unknown type ${typeText}). NEC-2 has no card for it; EMWS takes coils, capacitors, traps and R + jX.`);
    }
  }

  // ---- ground, height, reference impedance ----
  // A wire standing on MMANA's real ground: NEC-2 connects it only through a radial screen,
  // and with one nec2c gives the perfect-ground feed impedance while the soil shapes the
  // far field (MEASURED 2026-10-04, tests/ground.test.ts) - the very split MMANA's help
  // says it makes. The screen's size changes nothing in nec2c's result.
  const grounded = g === 2 && wires.some((w) => Math.min(Math.abs(w.a.z), Math.abs(w.b.z)) <= 1e-6);
  const modelGround: AntennaModel['ground'] = freeSpace
    ? { kind: 'free-space' }
    : g === 1
      ? { kind: 'perfect' }
      : grounded
        ? { kind: 'real', permittivity: 13, conductivity: 0.005, method: 'reflection', screen: { radials: 32, radiusM: Number((wavelength / 4).toPrecision(3)), wireRadiusM: 0.001 } }
        : AVERAGE_GROUND;
  const z0 = Number.isFinite(ground[3]) && ground[3]! > 0 ? ground[3] : undefined;

  notes.push(
    'Opened from an MMANA-GAL .maa file. MMANA computes with MININEC and EMWS with NEC-2: the two methods agree closely in free space and differ most near the ground and at junctions, so compare rather than expect the same digits.',
  );
  if (autoSegmented > 0) {
    notes.push(
      `${autoSegmented === wires.length ? 'Every wire' : `${autoSegmented} of the ${wires.length} wires`} used MMANA's automatic (tapered) segmentation, which NEC-2 has no equal for: EMWS segmented ${autoSegmented === 1 ? 'it' : 'them'} its own way - about 20 per wavelength, never fewer than 3. Press "Is the model converged?" to see whether that is fine enough for this antenna.`,
    );
  }
  if (evenCentres > 0) notes.push(`${evenCentres === 1 ? 'A wire' : `${evenCentres} wires`} fed at the centre had an even segment count; EMWS added one so a segment sits exactly where MMANA put the source.`);
  if (addHeight !== 0) notes.push(`MMANA's "add height" of ${fmt(addHeight)} m was added under every wire.`);
  if (g === 2) {
    notes.push("MMANA keeps its soil in a setup window, not in the file, so EMWS used average ground (permittivity 13, 5 mS/m): set yours in the ground section.");
    notes.push(
      grounded
        ? 'Wires stand on the ground. NEC-2 connects a wire to real ground only through a radial screen, and with one it gives the perfect-ground feed impedance while the soil shapes the pattern - the same split MMANA makes, by its own help. EMWS added a screen at the origin; its size changes nothing in the result.'
        : "MMANA's own help says it works the feed impedance out over perfect ground even when real ground is chosen, and recommends NEC-2 for antennas lower than 0.2 λ: EMWS uses the real ground for the impedance too, so a low antenna's impedance will differ - NEC-2's is the more realistic one.",
    );
  }
  if (ground[2] !== undefined && Number.isFinite(ground[2])) {
    notes.push(`MMANA's wire material setting (code ${ground[2]}) was not carried over - its code table is not published. Set each wire's material in EMWS if the loss matters.`);
  }
  if (qConverted > 0) notes.push(`The Q of ${qConverted === 1 ? 'one load' : `${qConverted} loads`} became a fixed loss resistance (a trap's at its own resonance, a coil's at ${fmt(fMHz)} MHz), as NEC-2 holds it.`);
  if (z0 !== undefined && z0 !== 50) notes.push(`The SWR is shown against ${fmt(z0)} Ω, the reference the file gives.`);

  const commentText = comments.flatMap((b) => [b.header.replace(/^#+[^#]*#+/, '').trim(), ...b.rows]).filter((l) => l !== '');
  return {
    ok: true,
    model: {
      comments: [title, ...commentText].filter((l) => l !== ''),
      wires,
      feeds,
      loads,
      ground: modelGround,
      frequency: { startMHz: fMHz, stepMHz: 0, steps: 1 },
      pattern: { kind: 'auto' },
      extraCards: [],
    },
    notes,
    ...(z0 !== undefined ? { z0 } : {}),
  };
}

function fmt(v: number): string {
  return String(Number(v.toPrecision(6)));
}

// ---------------------------------------------------------------- export

export type MaaExport = { ok: true; text: string; notes: string[] } | { ok: false; reason: string };

/** A pulse for a NEC segment: the centre where it is one, else counted from the nearer end. */
function pulseFor(wireNumber: number, segment: number, n: number): string {
  if (n % 2 === 1 && segment === (n + 1) / 2) return `w${wireNumber}c`;
  if (segment <= n / 2) return segment === 1 ? `w${wireNumber}b` : `w${wireNumber}b${segment - 1}`;
  return segment === n ? `w${wireNumber}e` : `w${wireNumber}e${n - segment}`;
}

/** Text for the file, before encodeMaa picks the code page: only printable characters. */
const ansi = (s: string) => s.replace(/[\x00-\x1F\x7F]/g, ' ');

/**
 * The bytes MMANA reads: Russian text in windows-1251 (the Russian edition's code page),
 * anything else in windows-1252. A character the chosen page cannot hold becomes "?",
 * never a mangled multi-byte sequence.
 */
export function encodeMaa(text: string): Uint8Array<ArrayBuffer> {
  const russian = /[Ѐ-ӿ]/.test(text);
  return Uint8Array.from(text, (c) => {
    const code = c.charCodeAt(0);
    if (code < 0x80) return code;
    if (russian) {
      if (code >= 0x410 && code <= 0x44f) return code - 0x410 + 0xc0; // А..я
      if (code === 0x401) return 0xa8; // Ё
      if (code === 0x451) return 0xb8; // ё
      return 0x3f;
    }
    return code >= 0xa0 && code <= 0xff ? code : 0x3f;
  });
}

/**
 * The model as a .maa file. Segment counts are written exactly (positive), so MMANA uses
 * EMWS's segmentation rather than its own. What MMANA's format cannot hold is refused
 * outright rather than dropped: a file missing a load would be a different antenna.
 */
export function modelToMaa(model: AntennaModel, z0 = 50): MaaExport {
  if (model.wires.length === 0) return { ok: false, reason: 'There are no wires to write.' };
  if (model.feeds.length === 0) return { ok: false, reason: 'MMANA needs a source; this model has none.' };
  if (model.extraCards.length > 0) {
    return { ok: false, reason: `The model carries NEC cards MMANA has no place for (${[...new Set(model.extraCards.map((c) => c.slice(0, 2).toUpperCase()))].join(', ')}).` };
  }
  const notes: string[] = [];
  const fMHz = model.frequency.startMHz;
  const w = 2 * Math.PI * fMHz * 1e6;
  const order = new Map(model.wires.map((wire, i) => [wire.id, i + 1]));
  const lines: string[] = [];
  lines.push(ansi(model.comments[0] ?? 'EMWS model'), '*', fmt(fMHz));
  lines.push('***Wires***', String(model.wires.length));
  for (const wire of model.wires) {
    lines.push([wire.a.x, wire.a.y, wire.a.z, wire.b.x, wire.b.y, wire.b.z, wire.radius].map(fmt).join(',\t') + `,\t${wire.segments}`);
  }
  lines.push('***Source***', `${model.feeds.length},\t1`);
  for (const f of model.feeds) {
    const wire = model.wires.find((x) => x.id === f.wireId)!;
    const volts = Math.hypot(f.voltage.re, f.voltage.im);
    const phase = (Math.atan2(f.voltage.im, f.voltage.re) * 180) / Math.PI;
    lines.push(`${pulseFor(order.get(wire.id)!, f.segment, wire.segments)},\t${fmt(phase)},\t${fmt(volts)}`);
  }
  const loadLines: string[] = [];
  for (const l of model.loads) {
    const wire = model.wires.find((x) => x.id === l.wireId);
    if (!wire) continue;
    const at = pulseFor(order.get(wire.id)!, l.segment, wire.segments);
    const name = l.label ?? `the load on wire ${wire.tag}`;
    if (l.kind === 'impedance') {
      loadLines.push(`${at},\t1,\t${fmt(l.ohms)},\t${fmt(l.reactance)}`);
    } else if (l.kind === 'parallel') {
      if (!(l.henries > 0 && l.farads > 0)) return { ok: false, reason: `${name} is a parallel load without both L and C; MMANA's LC load in parallel is a trap of both.` };
      const w0 = 1 / Math.sqrt(l.henries * l.farads);
      const q = l.ohms > 0 ? l.ohms / (w0 * l.henries) : 0;
      loadLines.push(`${at},\t0,\t${fmt(l.henries * 1e6)},\t${fmt(l.farads * 1e12)},\t${fmt(q)}`);
    } else {
      if (l.henries > 0 && l.farads > 0) return { ok: false, reason: `${name} is a coil and a capacitor in series; MMANA reads an L and a C together as a parallel trap, so it cannot be written faithfully.` };
      if (!(l.henries > 0) && !(l.farads > 0)) {
        // A pure resistance is R + jX with X = 0, exactly.
        loadLines.push(`${at},\t1,\t${fmt(l.ohms)},\t0`);
        continue;
      }
      const x = l.henries > 0 ? w * l.henries : 1 / (w * l.farads);
      const q = l.ohms > 0 ? x / l.ohms : 0;
      if (l.ohms > 0) notes.push(`The loss of ${name} was written as a Q of ${fmt(q)}, worked out at ${fmt(fMHz)} MHz.`);
      loadLines.push(`${at},\t0,\t${fmt(l.henries * 1e6)},\t${fmt(l.farads * 1e12)},\t${fmt(q)}`);
    }
  }
  lines.push('***Load***', `${loadLines.length},\t1`, ...loadLines);
  lines.push('***Segmentation***', '800,\t80,\t2.0,\t1');
  const g = model.ground.kind === 'free-space' ? 0 : model.ground.kind === 'perfect' ? 1 : 2;
  lines.push('***G/H/M/R/AzEl/X***', `${g},\t0.0,\t0,\t${fmt(z0)},\t120,\t60,\t0.0`);
  const rest = model.comments.slice(1).map(ansi);
  lines.push('###Comment###', ...rest, 'Exported from EMWS (public domain).');

  if (model.frequency.steps > 1) notes.push(`MMANA's file holds one frequency: ${fmt(fMHz)} MHz was written, the start of the sweep.`);
  if (model.ground.kind === 'real') notes.push("The soil is not written: MMANA keeps it in its own ground setup. Set it there.");
  if (model.wires.some((x) => x.conductivity !== undefined)) notes.push('Wire materials are not written: MMANA has one material for the whole antenna. Set it on its Calculate tab.');
  notes.push('Segment counts are written as they are, so MMANA uses these rather than its own automatic segmentation.');
  return { ok: true, text: lines.join('\r\n') + '\r\n', notes };
}
