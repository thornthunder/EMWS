// What the four views draw: wires split into coloured segments, feed points, and ground.
// Built from the model while editing, or from the engine's report for a deck the model
// can't represent (then nothing is editable).

import type { FrequencyResult, Nec2Report, SegmentCurrent, Vec3 } from '../../../engine/nec2/types';
import { lerp } from '../../../lib/vec3';
import { type AntennaModel, type Wire, segmentCentre } from '../model';

export interface SceneLine {
  key: string;
  wireId?: string;
  a: Vec3;
  b: Vec3;
  /** Set when the line shows current; otherwise the plain wire colour. */
  colour?: string;
}

export interface SceneFeed {
  key: string;
  feedId?: string;
  wireId?: string;
  at: Vec3;
}

export interface Scene {
  editable: boolean;
  /** Wires that can be picked and dragged (empty when not editable). */
  wires: Wire[];
  lines: SceneLine[];
  feeds: SceneFeed[];
  ground: boolean;
  /** Whether the lines are coloured by current. */
  showsCurrent: boolean;
}

/** Blue (little current) through to orange-red (most current). */
export function currentColour(fraction: number): string {
  const hue = 215 - 195 * Math.min(Math.max(fraction, 0), 1);
  return `hsl(${hue.toFixed(0)} 85% 52%)`;
}

function byTag(currents: readonly SegmentCurrent[]): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (const c of currents) {
    const list = map.get(c.tag) ?? [];
    list.push(c.magnitude);
    map.set(c.tag, list);
  }
  return map;
}

/** `currents` only when they were solved for exactly this model. */
export function sceneFromModel(model: AntennaModel, currents?: readonly SegmentCurrent[]): Scene {
  const peak = currents?.reduce((m, c) => Math.max(m, c.magnitude), 0) ?? 0;
  const perTag = currents && peak > 0 ? byTag(currents) : undefined;
  const lines: SceneLine[] = [];
  let showsCurrent = false;

  for (const w of model.wires) {
    const magnitudes = perTag?.get(w.tag);
    if (magnitudes && magnitudes.length === w.segments) {
      showsCurrent = true;
      for (let i = 0; i < w.segments; i++) {
        lines.push({
          key: `${w.id}:${i}`,
          wireId: w.id,
          a: lerp(w.a, w.b, i / w.segments),
          b: lerp(w.a, w.b, (i + 1) / w.segments),
          colour: currentColour((magnitudes[i] ?? 0) / peak),
        });
      }
    } else {
      lines.push({ key: w.id, wireId: w.id, a: w.a, b: w.b });
    }
  }

  const feeds: SceneFeed[] = [];
  for (const f of model.feeds) {
    const wire = model.wires.find((w) => w.id === f.wireId);
    if (wire) feeds.push({ key: f.id, feedId: f.id, wireId: wire.id, at: segmentCentre(wire, f.segment) });
  }

  return { editable: true, wires: model.wires, lines, feeds, ground: model.ground.kind !== 'free-space', showsCurrent };
}

/** Read-only scene from a solved deck, for decks the model can't represent. */
export function sceneFromReport(report: Nec2Report, frequency: FrequencyResult | undefined): Scene {
  const current = new Map(frequency?.currents.map((c) => [c.segment, c.magnitude]) ?? []);
  const peak = Math.max(0, ...current.values());
  const lines: SceneLine[] = report.segments.map((s) => {
    const magnitude = current.get(s.index);
    return {
      key: `s${s.index}`,
      a: s.start,
      b: s.end,
      colour: magnitude !== undefined && peak > 0 ? currentColour(magnitude / peak) : undefined,
    };
  });
  const fed = new Set(frequency?.feeds.map((f) => f.segment));
  const feeds = report.segments.filter((s) => fed.has(s.index)).map((s) => ({ key: `f${s.index}`, at: s.center }));
  return {
    editable: false,
    wires: [],
    lines,
    feeds,
    ground: frequency !== undefined && frequency.environment !== 'free-space',
    showsCurrent: peak > 0,
  };
}

export function scenePoints(scene: Scene): Vec3[] {
  const points = scene.lines.flatMap((l) => [l.a, l.b]);
  if (scene.ground && points.length > 0) {
    // Keep the ground line in shot.
    const first = points[0]!;
    points.push({ x: first.x, y: first.y, z: 0 });
  }
  return points;
}
