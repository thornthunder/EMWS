// Converts between the editor's AntennaModel and a NEC-2 card deck.
//
// Decks the model cannot represent (arcs, helices, GM copies, tapered wires, patches,
// several runs in one deck, ...) are reported rather than approximated: the editor then
// falls back to running the deck as text, exactly as written.

import { type Card, floatField, formatCard, intField, lexDeck } from '../../engine/nec2/cards';
import type { Vec3 } from '../../engine/nec2/types';
import {
  type AntennaModel,
  type Feed,
  type FrequencyPlan,
  type Ground,
  type PatternPlan,
  type Wire,
  newId,
} from './model';

// ---- model -> deck ----

/** nec2c's line buffer is 132 characters; keep comment cards well inside it. */
const COMMENT_WIDTH = 100;

/** Cards that trigger a solution. They must follow the setup cards. */
const EXECUTION_CARDS = new Set(['XQ', 'RP', 'NE', 'NH']);

/** Program cards kept verbatim. Everything else the model either understands or rejects. */
const PASSTHROUGH_CARDS = new Set(['LD', 'TL', 'NT', 'EK', 'KH', 'PT', 'PQ', 'CP', 'NE', 'NH']);

function wrapComment(text: string): string[] {
  const words = text.split(/\s+/).filter((w) => w !== '');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line !== '' && line.length + 1 + word.length > COMMENT_WIDTH) {
      lines.push(line);
      line = '';
    }
    line = line === '' ? word.slice(0, COMMENT_WIDTH) : `${line} ${word}`;
  }
  if (line !== '') lines.push(line);
  return lines;
}

/** The whole sphere at 5° steps; the upper hemisphere when there is ground. */
export function autoPatternCard(ground: Ground): string {
  return ground.kind === 'free-space' ? 'RP 0 37 72 1000 0 0 5 5' : 'RP 0 19 72 1000 0 0 5 5';
}

function groundCard(ground: Ground): string | undefined {
  switch (ground.kind) {
    case 'free-space':
      return undefined;
    case 'perfect':
      return formatCard('GN', [1]);
    case 'real':
      return formatCard('GN', [ground.method === 'sommerfeld' ? 2 : 0, 0, 0, 0], [
        ground.permittivity,
        ground.conductivity,
      ]);
  }
}

function wireCard(w: Wire): string {
  return formatCard('GW', [w.tag, w.segments], [w.a.x, w.a.y, w.a.z, w.b.x, w.b.y, w.b.z, w.radius]);
}

export interface DeckOptions {
  /** Use this frequency plan instead of the model's own. */
  frequency?: FrequencyPlan;
  /** 'model' (default) follows the model's pattern plan; 'none' solves without a far field. */
  pattern?: 'model' | 'none';
  /**
   * Write the frequency with every digit it has, rather than tidying it to ten
   * significant figures. Splitting a sweep needs this: the frequency must be bit for bit
   * the one the engine would have reached itself.
   */
  exactFrequency?: boolean;
}

export function modelToDeck(model: AntennaModel, options: DeckOptions = {}): string {
  const lines: string[] = [];
  for (const comment of model.comments) {
    for (const line of wrapComment(comment)) lines.push(`CM ${line}`);
  }
  lines.push('CE');

  for (const w of model.wires) lines.push(wireCard(w));
  lines.push(formatCard('GE', [model.ground.kind === 'free-space' ? 0 : 1]));

  const gn = groundCard(model.ground);
  if (gn) lines.push(gn);
  const setup = model.extraCards.filter((c) => !EXECUTION_CARDS.has(c.slice(0, 2).toUpperCase()));
  const after = model.extraCards.filter((c) => EXECUTION_CARDS.has(c.slice(0, 2).toUpperCase()));
  lines.push(...setup);

  const plan = options.frequency ?? model.frequency;
  const steps = Math.max(1, plan.steps);
  const step = plan.steps > 1 ? plan.stepMHz : 0;
  lines.push(
    options.exactFrequency
      ? `FR 0 ${steps} 0 0 ${String(plan.startMHz)} ${String(step)}`
      : formatCard('FR', [0, steps, 0, 0], [plan.startMHz, step]),
  );

  for (const feed of model.feeds) {
    const wire = model.wires.find((w) => w.id === feed.wireId);
    if (!wire) continue;
    lines.push(formatCard('EX', [0, wire.tag, feed.segment, 0], [feed.voltage.re, feed.voltage.im]));
  }

  const pattern: PatternPlan = options.pattern === 'none' ? { kind: 'none' } : model.pattern;
  switch (pattern.kind) {
    case 'auto':
      lines.push(autoPatternCard(model.ground));
      break;
    case 'cards':
      lines.push(...pattern.cards);
      break;
    case 'none':
      lines.push('XQ');
      break;
  }
  lines.push(...after);
  lines.push('EN');
  return `${lines.join('\n')}\n`;
}

export function singleFrequency(frequencyMHz: number): FrequencyPlan {
  return { startMHz: frequencyMHz, stepMHz: 0, steps: 1 };
}

/**
 * The frequencies the engine will actually solve. nec2c walks a sweep by adding the step
 * to a running total (main.c: `save.fmhz += delfrq`), so a split sweep has to reach each
 * frequency the same way, or the last digits drift apart.
 */
export function steppedFrequencies(plan: FrequencyPlan): number[] {
  const list: number[] = [];
  let f = plan.startMHz;
  for (let i = 0; i < Math.max(1, plan.steps); i++) {
    if (i > 0) f += plan.stepMHz;
    list.push(f);
  }
  return list;
}

/** One deck per frequency of a sweep, so they can be solved side by side. */
export function perFrequencyDecks(model: AntennaModel, options: DeckOptions = {}): string[] {
  return steppedFrequencies(model.frequency).map((f) =>
    modelToDeck(model, { ...options, frequency: singleFrequency(f), exactFrequency: true }),
  );
}

export interface RunPlan {
  /** Solves every frequency in the model, in one go. */
  main: string;
  /**
   * The same sweep as one deck per frequency. Each is an independent solve, so they can
   * run on as many cores as the machine has. Only set for a sweep.
   */
  perFrequency?: string[];
  /**
   * For an automatic pattern over a sweep: the far field is solved separately, one
   * frequency at a time, because a whole sphere at every step of a sweep is slow.
   */
  patternDeck?: (frequencyMHz: number) => string;
}

export function planRuns(model: AntennaModel): RunPlan {
  const sweep = model.frequency.steps > 1;
  if (sweep && model.pattern.kind === 'auto') {
    return {
      main: modelToDeck(model, { pattern: 'none' }),
      perFrequency: perFrequencyDecks(model, { pattern: 'none' }),
      patternDeck: (f) => modelToDeck(model, { frequency: singleFrequency(f) }),
    };
  }
  return sweep ? { main: modelToDeck(model), perFrequency: perFrequencyDecks(model) } : { main: modelToDeck(model) };
}

// ---- deck -> model ----

export type DeckImport =
  | { ok: true; model: AntennaModel; notes: string[] }
  | { ok: false; reason: string; notes: string[] };

const UNSUPPORTED_GEOMETRY: Record<string, string> = {
  GA: 'wire arcs (GA)',
  GH: 'helices (GH)',
  GM: 'moved or copied structures (GM)',
  GR: 'rotated copies (GR)',
  GX: 'reflected copies (GX)',
  GC: 'tapered wires (GC)',
  GF: 'NGF files (GF)',
  SP: 'surface patches (SP)',
  SM: 'surface patches (SM)',
  SC: 'surface patches (SC)',
};

class Unsupported extends Error {}

function fail(card: Card, message: string): never {
  throw new Unsupported(`Line ${card.line} (${card.mnemonic}): ${message}`);
}

function ints(card: Card, count: number): number[] {
  return Array.from({ length: count }, (_, i) => {
    const v = intField(card, i);
    if (v === undefined) fail(card, `integer field ${i + 1} is "${card.fields[i]}"`);
    return v;
  });
}

function floats(card: Card, count: number): number[] {
  return Array.from({ length: count }, (_, i) => {
    const v = floatField(card, i);
    if (v === undefined) fail(card, `number field ${i + 1} is not a number`);
    return v;
  });
}

interface RawFeed {
  card: Card;
  tag: number;
  segment: number;
  voltage: { re: number; im: number };
}

export function deckToModel(text: string): DeckImport {
  const { cards, notices } = lexDeck(text);
  const notes = notices.map((n) => n.message);
  try {
    return { ok: true, model: buildModel(cards, notes), notes };
  } catch (e) {
    if (e instanceof Unsupported) return { ok: false, reason: e.message, notes };
    throw e;
  }
}

function buildModel(cards: Card[], notes: string[]): AntennaModel {
  const comments: string[] = [];
  let wires: Wire[] = [];
  let groundPlane: number | undefined;
  let groundCard: Card | undefined;
  let frequency: FrequencyPlan | undefined;
  const rawFeeds: RawFeed[] = [];
  const patternCards: string[] = [];
  const extraCards: string[] = [];
  let executed = false;

  for (const card of cards) {
    const m = card.mnemonic;

    if (card.section === 'comment') {
      if (card.text !== '') comments.push(card.text);
      continue;
    }

    if (card.section === 'geometry') {
      if (m === 'GW') {
        const [tag = 0, segments = 0] = ints(card, 2);
        const [x1 = 0, y1 = 0, z1 = 0, x2 = 0, y2 = 0, z2 = 0, radius = 0] = floats(card, 7);
        if (radius === 0) fail(card, `radius 0 means a tapered wire (GC card), which the editor can't edit yet`);
        if (radius < 0) fail(card, 'the wire radius is negative');
        if (segments < 1) fail(card, `the wire has ${segments} segments; it needs at least 1`);
        wires.push({ id: newId('w'), tag, segments, a: { x: x1, y: y1, z: z1 }, b: { x: x2, y: y2, z: z2 }, radius });
      } else if (m === 'GS') {
        const [factor = 1] = floats(card, 1);
        const s = (p: Vec3): Vec3 => ({ x: p.x * factor, y: p.y * factor, z: p.z * factor });
        wires = wires.map((w) => ({ ...w, a: s(w.a), b: s(w.b), radius: w.radius * factor }));
        notes.push(`Line ${card.line}: the GS scale factor ${factor} was applied to the wires.`);
      } else if (m === 'GE') {
        const [flag = 0] = ints(card, 1);
        if (flag === -1) fail(card, 'GE -1 (ground without current interpolation) is not supported by the editor');
        groundPlane = flag;
      } else if (m in UNSUPPORTED_GEOMETRY) {
        fail(card, `${UNSUPPORTED_GEOMETRY[m]} can't be edited visually yet`);
      } else {
        fail(card, `"${m}" is not a geometry card`);
      }
      continue;
    }

    // Program section.
    if (m === 'EN') break;
    if (EXECUTION_CARDS.has(m)) {
      executed = true;
      if (m === 'RP') patternCards.push(card.raw);
      else if (m === 'NE' || m === 'NH') extraCards.push(card.raw);
      continue;
    }
    if (executed) fail(card, 'the deck has more than one run (setup cards after an RP or XQ card)');

    if (m === 'GN') {
      groundCard = card;
    } else if (m === 'FR') {
      const [kind = 0, steps = 1] = ints(card, 2);
      const [start = 0, step = 0] = floats(card, 2);
      if (kind !== 0) fail(card, 'multiplicative frequency steps are not supported by the editor');
      frequency = { startMHz: start, stepMHz: steps > 1 ? step : 0, steps: Math.max(1, steps) };
    } else if (m === 'EX') {
      const [kind = 0, tag = 0, segment = 0, flags = 0] = ints(card, 4);
      const [re = 0, im = 0] = floats(card, 2);
      if (kind !== 0) fail(card, `only voltage sources (EX 0) can be edited; this is EX ${kind}`);
      if (flags !== 0) fail(card, 'EX print options are not supported by the editor');
      rawFeeds.push({ card, tag, segment, voltage: { re, im } });
    } else if (PASSTHROUGH_CARDS.has(m)) {
      extraCards.push(card.raw);
    } else {
      fail(card, `"${m}" is not a card the editor knows`);
    }
  }

  if (groundPlane === undefined) {
    throw new Unsupported('The deck has no GE card, so it has no end to its geometry.');
  }
  if (wires.length === 0) throw new Unsupported('The deck defines no wires.');

  const ground = readGround(groundCard, groundPlane);

  // Tags must be unique for the editor to address wires; renumber when nothing depends on them.
  const tags = wires.map((w) => w.tag);
  const tagsUsable = tags.every((t) => t > 0) && new Set(tags).size === tags.length;
  const tagRefs = extraCards.some((c) => /^(LD|TL|NT)/i.test(c));
  const feeds = rawFeeds.map((f) => resolveFeed(f, wires));
  if (!tagsUsable) {
    if (tagRefs) throw new Unsupported('Wire tags are missing or repeated, and other cards refer to them by tag.');
    wires = wires.map((w, i) => ({ ...w, tag: i + 1 }));
    notes.push('Wire tags were missing or repeated, so the wires were renumbered 1, 2, 3, ...');
  }

  if (!frequency) {
    frequency = { startMHz: 299.8, stepMHz: 0, steps: 1 };
    notes.push('The deck has no FR card; nec2c then solves at 299.8 MHz.');
  }

  const pattern: PatternPlan = patternCards.length > 0 ? { kind: 'cards', cards: patternCards } : { kind: 'none' };

  return { comments, wires, feeds: dedupeFeeds(feeds, notes), ground, frequency, pattern, extraCards };
}

function readGround(card: Card | undefined, groundPlane: number): Ground {
  if (!card) {
    if (groundPlane !== 0) {
      throw new Unsupported('GE asks for a ground plane but there is no GN card, so nec2c would solve it in free space.');
    }
    return { kind: 'free-space' };
  }
  const [type = 0, radials = 0] = ints(card, 2);
  const [permittivity = 0, conductivity = 0, p3 = 0, p4 = 0, p5 = 0, p6 = 0] = floats(card, 6);
  if (type === -1) return { kind: 'free-space' };
  if (radials !== 0) fail(card, 'radial-wire ground screens are not supported by the editor');
  if (type === 1) return { kind: 'perfect' };
  if (type !== 0 && type !== 2) fail(card, `ground type ${type} is not one nec2c knows`);
  if (p3 !== 0 || p4 !== 0 || p5 !== 0 || p6 !== 0) fail(card, 'a second ground medium (a cliff) is not supported by the editor');
  return { kind: 'real', permittivity, conductivity, method: type === 2 ? 'sommerfeld' : 'reflection' };
}

function resolveFeed(raw: RawFeed, wires: Wire[]): Feed {
  let wire: Wire | undefined;
  let segment = raw.segment;
  if (raw.tag > 0) {
    // The m-th segment among the wires carrying this tag, in deck order.
    for (const w of wires.filter((x) => x.tag === raw.tag)) {
      if (segment <= w.segments) {
        wire = w;
        break;
      }
      segment -= w.segments;
    }
  } else {
    for (const w of wires) {
      if (segment <= w.segments) {
        wire = w;
        break;
      }
      segment -= w.segments;
    }
  }
  if (!wire || segment < 1) {
    fail(raw.card, `the source is on segment ${raw.segment} of tag ${raw.tag}, which doesn't exist`);
  }
  return { id: newId('f'), wireId: wire.id, segment, voltage: raw.voltage };
}

function dedupeFeeds(feeds: Feed[], notes: string[]): Feed[] {
  const kept = new Map<string, Feed>();
  for (const f of feeds) {
    const key = `${f.wireId}:${f.segment}`;
    if (kept.has(key)) notes.push('Two EX cards drive the same segment; the later one is kept.');
    kept.set(key, f);
  }
  return [...kept.values()];
}
