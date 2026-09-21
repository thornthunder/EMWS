// The antenna model behind the visual editor, and every edit that can be made to it.
//
// Every operation is a pure function returning a new model, so the editor gets undo,
// redo and "are these results still current?" (object identity) for free.
// A model converts to and from a NEC-2 card deck in ./deck.ts.

import type { Complex, Vec3 } from '../../engine/nec2/types';
import { add, closestParameter, distance, lerp, manhattan, sub, tidy, tidyVec } from '../../lib/vec3';

export interface Wire {
  /** Stable identity for the editor. Never written to a deck. */
  id: string;
  /** NEC tag number: unique within the model, and how cards refer to the wire. */
  tag: number;
  /** The two ends, in metres. */
  a: Vec3;
  b: Vec3;
  /** Metres. */
  radius: number;
  segments: number;
}

export type EndName = 'a' | 'b';

export interface EndRef {
  wireId: string;
  end: EndName;
}

/** A voltage source on one segment of a wire (an EX 0 card). */
export interface Feed {
  id: string;
  wireId: string;
  /** 1-based, counted along the wire from end a. */
  segment: number;
  /** Volts. Only relative values matter, unless there are several feeds. */
  voltage: Complex;
}

export type Ground =
  | { kind: 'free-space' }
  | { kind: 'perfect' }
  | {
      kind: 'real';
      /** Relative permittivity. */
      permittivity: number;
      /** Siemens per metre. */
      conductivity: number;
      method: 'sommerfeld' | 'reflection';
    };

export interface FrequencyPlan {
  startMHz: number;
  stepMHz: number;
  /** 1 for a single frequency. */
  steps: number;
}

export type PatternPlan =
  /** The whole sphere (or upper hemisphere) at 5° steps; plots cut through the main lobe. */
  | { kind: 'auto' }
  /** RP cards from an imported deck, kept as written. */
  | { kind: 'cards'; cards: string[] }
  /** No far field: impedance and currents only. */
  | { kind: 'none' };

export interface AntennaModel {
  /** CM card text, one entry per line. */
  comments: string[];
  wires: Wire[];
  feeds: Feed[];
  ground: Ground;
  frequency: FrequencyPlan;
  pattern: PatternPlan;
  /** Program cards the editor doesn't model (LD, TL, NT, EK, ...), kept verbatim, in order. */
  extraCards: string[];
}

/** Speed of light, in metres × MHz. */
export const SPEED_OF_LIGHT = 299.792458;

/** nec2c joins wire ends closer than this fraction of a segment length (nec2c.h SMIN). */
export const JOIN_TOLERANCE = 1e-3;

export const DEFAULT_RADIUS = 0.001;

/** Real ground that the ham literature calls "average". */
export const AVERAGE_GROUND: Ground = { kind: 'real', permittivity: 13, conductivity: 0.005, method: 'sommerfeld' };

let idCounter = 0;
// Models are saved and reloaded, so ids must not repeat across page loads either.
const session = Math.floor(Math.random() * 36 ** 4).toString(36);

/** Unique id. (crypto.randomUUID needs HTTPS, which a local IIS site may not have.) */
export function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}${session}.${idCounter.toString(36)}`;
}

export function emptyModel(frequencyMHz = 14.2): AntennaModel {
  return {
    comments: [],
    wires: [],
    feeds: [],
    ground: { kind: 'free-space' },
    frequency: { startMHz: frequencyMHz, stepMHz: 0, steps: 1 },
    pattern: { kind: 'auto' },
    extraCards: [],
  };
}

// ---- measurements ----

export function wavelengthM(frequencyMHz: number): number {
  return SPEED_OF_LIGHT / frequencyMHz;
}

export function frequenciesOf(plan: FrequencyPlan): number[] {
  return Array.from({ length: Math.max(1, plan.steps) }, (_, i) => tidy(plan.startMHz + i * plan.stepMHz));
}

export function highestFrequencyMHz(plan: FrequencyPlan): number {
  return Math.max(...frequenciesOf(plan));
}

export function wireLength(wire: Wire): number {
  return distance(wire.a, wire.b);
}

export function segmentLength(wire: Wire): number {
  return wireLength(wire) / wire.segments;
}

/** Centre of segment `segment` (1-based). */
export function segmentCentre(wire: Wire, segment: number): Vec3 {
  return lerp(wire.a, wire.b, (segment - 0.5) / wire.segments);
}

/** The segment containing the point at parameter t along the wire. */
export function segmentAt(wire: Wire, t: number): number {
  return Math.min(wire.segments, Math.max(1, Math.floor(t * wire.segments) + 1));
}

export function centreSegment(wire: Wire): number {
  return segmentAt(wire, 0.5);
}

/**
 * Where a feed actually sits. NEC-2 drives the middle of one segment, so the positions
 * available along a wire are the segment centres and nothing in between.
 */
export function feedPosition(wire: Wire, segment: number): { fraction: number; metres: number } {
  const fraction = (segment - 0.5) / wire.segments;
  return { fraction, metres: fraction * wireLength(wire) };
}

/** The segment whose centre is nearest `fraction` of the way along the wire. */
export function segmentNearest(wire: Wire, fraction: number): number {
  return Math.min(wire.segments, Math.max(1, Math.round(fraction * wire.segments + 0.5)));
}

export function setFeedPosition(model: AntennaModel, feedId: string, fraction: number): AntennaModel {
  const feed = model.feeds.find((f) => f.id === feedId);
  const wire = feed && wireById(model, feed.wireId);
  if (!feed || !wire) return model;
  const segment = segmentNearest(wire, Math.min(1, Math.max(0, fraction)));
  if (segment === feed.segment || model.feeds.some((f) => f.id !== feedId && f.wireId === wire.id && f.segment === segment)) {
    return model;
  }
  return updateFeed(model, feedId, { segment });
}

/**
 * A segment count that puts a segment centre as close as possible to `fraction` along
 * the wire, without going below `atLeast` (the count accuracy needs). Handy for an
 * off-centre feed, and for the centre of a wire with an even number of segments.
 */
export function segmentsForPosition(fraction: number, atLeast: number, limit = 600): number {
  const target = Math.min(1, Math.max(0, fraction));
  let best = Math.max(1, Math.round(atLeast));
  let bestError = Infinity;
  for (let n = Math.max(1, Math.round(atLeast)); n <= Math.min(limit, Math.max(12, atLeast * 3)); n++) {
    const segment = Math.min(n, Math.max(1, Math.round(target * n + 0.5)));
    const error = Math.abs((segment - 0.5) / n - target);
    if (error < bestError - 1e-12) {
      best = n;
      bestError = error;
    }
  }
  return best;
}

/** Segment count keeping segments within λ/20 at the highest frequency; odd, so a wire has a centre segment. */
export function suggestedSegments(lengthM: number, wavelength: number): number {
  const n = Math.max(1, Math.ceil(lengthM / (wavelength / 20)));
  return n % 2 === 0 ? n + 1 : n;
}

export function wireById(model: AntennaModel, wireId: string): Wire | undefined {
  return model.wires.find((w) => w.id === wireId);
}

export function endPoint(wire: Wire, end: EndName): Vec3 {
  return end === 'a' ? wire.a : wire.b;
}

/** Whether nec2c will join the two points, judged against a segment of length `segmentLengthM`. */
export function joined(p: Vec3, q: Vec3, segmentLengthM: number): boolean {
  return manhattan(p, q) <= segmentLengthM * JOIN_TOLERANCE;
}

/** Wire ends that nec2c would join to `point`: a junction. */
export function endsAt(model: AntennaModel, point: Vec3, segmentLengthM: number): EndRef[] {
  const found: EndRef[] = [];
  for (const wire of model.wires) {
    // nec2c tests each segment against its own length, so the longer of the two decides.
    const tolerance = Math.max(segmentLengthM, segmentLength(wire));
    if (joined(wire.a, point, tolerance)) found.push({ wireId: wire.id, end: 'a' });
    if (joined(wire.b, point, tolerance)) found.push({ wireId: wire.id, end: 'b' });
  }
  return found;
}

/** The end `ref` plus every end joined to it. */
export function junctionOf(model: AntennaModel, ref: EndRef): EndRef[] {
  const wire = wireById(model, ref.wireId);
  if (!wire) return [];
  const found = endsAt(model, endPoint(wire, ref.end), segmentLength(wire));
  return found.some((e) => e.wireId === ref.wireId && e.end === ref.end) ? found : [ref, ...found];
}

// ---- edits ----

function replaceWire(model: AntennaModel, wireId: string, update: (w: Wire) => Wire): AntennaModel {
  let changed = false;
  const wires = model.wires.map((w) => {
    if (w.id !== wireId) return w;
    const next = update(w);
    if (next !== w) changed = true;
    return next;
  });
  return changed ? { ...model, wires } : model;
}

export function nextTag(model: AntennaModel): number {
  return model.wires.reduce((max, w) => Math.max(max, w.tag), 0) + 1;
}

export interface NewWireOptions {
  radius?: number;
  segments?: number;
  /** Supply the id, e.g. to select the wire straight away. */
  id?: string;
}

export function addWire(
  model: AntennaModel,
  a: Vec3,
  b: Vec3,
  options: NewWireOptions = {},
): { model: AntennaModel; wireId: string } {
  const wavelength = wavelengthM(highestFrequencyMHz(model.frequency));
  const wire: Wire = {
    id: options.id ?? newId('w'),
    tag: nextTag(model),
    a: tidyVec(a),
    b: tidyVec(b),
    radius: options.radius ?? DEFAULT_RADIUS,
    segments: options.segments ?? suggestedSegments(distance(a, b), wavelength),
  };
  return { model: { ...model, wires: [...model.wires, wire] }, wireId: wire.id };
}

/** New segment number keeping the segment's position along the wire. */
export function remapSegment(segment: number, fromSegments: number, toSegments: number): number {
  const position = (segment - 0.5) / fromSegments;
  return Math.min(toSegments, Math.max(1, Math.round(position * toSegments + 0.5)));
}

export function setWireGeometry(
  model: AntennaModel,
  wireId: string,
  patch: Partial<Pick<Wire, 'a' | 'b' | 'radius' | 'segments'>>,
): AntennaModel {
  const wire = wireById(model, wireId);
  if (!wire) return model;
  const segments = patch.segments !== undefined ? Math.max(1, Math.round(patch.segments)) : wire.segments;
  const next = replaceWire(model, wireId, (w) => ({
    ...w,
    ...(patch.a ? { a: tidyVec(patch.a) } : {}),
    ...(patch.b ? { b: tidyVec(patch.b) } : {}),
    ...(patch.radius !== undefined ? { radius: patch.radius } : {}),
    segments,
  }));
  if (segments === wire.segments) return next;
  return {
    ...next,
    feeds: next.feeds.map((f) =>
      f.wireId === wireId ? { ...f, segment: remapSegment(f.segment, wire.segments, segments) } : f,
    ),
  };
}

export function deleteWire(model: AntennaModel, wireId: string): AntennaModel {
  if (!wireById(model, wireId)) return model;
  return {
    ...model,
    wires: model.wires.filter((w) => w.id !== wireId),
    feeds: model.feeds.filter((f) => f.wireId !== wireId),
  };
}

/** Moves the given ends to `to`. */
export function moveEnds(model: AntennaModel, ends: readonly EndRef[], to: Vec3): AntennaModel {
  if (ends.length === 0) return model;
  const target = tidyVec(to);
  return {
    ...model,
    wires: model.wires.map((w) => {
      const moveA = ends.some((e) => e.wireId === w.id && e.end === 'a');
      const moveB = ends.some((e) => e.wireId === w.id && e.end === 'b');
      if (!moveA && !moveB) return w;
      return { ...w, ...(moveA ? { a: target } : {}), ...(moveB ? { b: target } : {}) };
    }),
  };
}

/** Shifts the given ends by `delta`. */
export function translateEnds(model: AntennaModel, ends: readonly EndRef[], delta: Vec3): AntennaModel {
  if (ends.length === 0) return model;
  return {
    ...model,
    wires: model.wires.map((w) => {
      const moveA = ends.some((e) => e.wireId === w.id && e.end === 'a');
      const moveB = ends.some((e) => e.wireId === w.id && e.end === 'b');
      if (!moveA && !moveB) return w;
      return {
        ...w,
        ...(moveA ? { a: tidyVec(add(w.a, delta)) } : {}),
        ...(moveB ? { b: tidyVec(add(w.b, delta)) } : {}),
      };
    }),
  };
}

/**
 * The ends that move when a whole wire is dragged: its own, plus (unless `detach`)
 * every end joined to them, so connected wires stretch instead of coming apart.
 */
export function endsMovedWithWire(model: AntennaModel, wireId: string, detach: boolean): EndRef[] {
  const own: EndRef[] = [
    { wireId, end: 'a' },
    { wireId, end: 'b' },
  ];
  if (detach) return own;
  const all = [...own, ...junctionOf(model, own[0]!), ...junctionOf(model, own[1]!)];
  return all.filter((e, i) => all.findIndex((o) => o.wireId === e.wireId && o.end === e.end) === i);
}

/** Splits a wire at parameter t (0..1), dividing its segments and keeping feeds where they were. */
export function splitWire(
  model: AntennaModel,
  wireId: string,
  t: number,
): { model: AntennaModel; newWireId: string } | undefined {
  const wire = wireById(model, wireId);
  if (!wire || t <= 0 || t >= 1) return undefined;
  const point = tidyVec(lerp(wire.a, wire.b, t));
  const first = Math.max(1, Math.round(wire.segments * t));
  const second = Math.max(1, wire.segments - first);
  const head: Wire = { ...wire, b: point, segments: first };
  const tail: Wire = { ...wire, id: newId('w'), tag: nextTag(model), a: point, segments: second };

  const feeds = model.feeds.map((f) => {
    if (f.wireId !== wireId) return f;
    const position = (f.segment - 0.5) / wire.segments;
    if (position < t) return { ...f, segment: segmentAt(head, position / t) };
    return { ...f, wireId: tail.id, segment: segmentAt(tail, (position - t) / (1 - t)) };
  });

  const index = model.wires.findIndex((w) => w.id === wireId);
  const wires = [...model.wires];
  wires.splice(index, 1, head, tail);
  return { model: { ...model, wires, feeds }, newWireId: tail.id };
}

export function duplicateWire(
  model: AntennaModel,
  wireId: string,
  offset: Vec3,
  id: string = newId('w'),
): { model: AntennaModel; wireId: string } | undefined {
  const wire = wireById(model, wireId);
  if (!wire) return undefined;
  const copy: Wire = {
    ...wire,
    id,
    tag: nextTag(model),
    a: tidyVec(add(wire.a, offset)),
    b: tidyVec(add(wire.b, offset)),
  };
  return { model: { ...model, wires: [...model.wires, copy] }, wireId: copy.id };
}

export function addFeed(model: AntennaModel, wireId: string, segment: number): AntennaModel {
  const wire = wireById(model, wireId);
  if (!wire) return model;
  const s = Math.min(wire.segments, Math.max(1, Math.round(segment)));
  if (model.feeds.some((f) => f.wireId === wireId && f.segment === s)) return model;
  const feed: Feed = { id: newId('f'), wireId, segment: s, voltage: { re: 1, im: 0 } };
  return { ...model, feeds: [...model.feeds, feed] };
}

export function removeFeed(model: AntennaModel, feedId: string): AntennaModel {
  const feeds = model.feeds.filter((f) => f.id !== feedId);
  return feeds.length === model.feeds.length ? model : { ...model, feeds };
}

export function updateFeed(model: AntennaModel, feedId: string, patch: Partial<Pick<Feed, 'segment' | 'voltage'>>) {
  return { ...model, feeds: model.feeds.map((f) => (f.id === feedId ? { ...f, ...patch } : f)) };
}

/** Re-segments every wire to λ/20 at the highest frequency, keeping feeds in place. */
export function autoSegment(model: AntennaModel): AntennaModel {
  const wavelength = wavelengthM(highestFrequencyMHz(model.frequency));
  return model.wires.reduce(
    (m, w) => setWireGeometry(m, w.id, { segments: suggestedSegments(wireLength(w), wavelength) }),
    model,
  );
}

/** Where along a wire (0..1) a point falls, measured in the plane of a view or in 3-D. */
export function parameterAlong(wire: Wire, point: Vec3): number {
  return closestParameter(point, wire.a, wire.b);
}

export function vectorOf(wire: Wire): Vec3 {
  return sub(wire.b, wire.a);
}
