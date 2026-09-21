// Putting a feed where you want it along a wire - the off-centre-fed dipole case.

import { describe, expect, it } from 'vitest';
import { vec } from '../src/lib/vec3';
import { swr } from '../src/lib/rf';
import {
  addFeed,
  addWire,
  emptyModel,
  feedPosition,
  segmentNearest,
  segmentsForPosition,
  setFeedPosition,
  setWireGeometry,
} from '../src/tools/antenna-modeler/model';
import { loadExample, simulate } from './helpers/engine';

/** A 41.1 m wire, the classic Windom length. */
function wireModel(segments: number) {
  const m = addWire(emptyModel(7.1), vec(0, -13.7, 10), vec(0, 27.4, 10), { segments });
  return { model: m.model, wireId: m.wireId };
}

describe('feed position', () => {
  it('reports where a feed really sits, in metres and as a fraction', () => {
    const { model } = wireModel(79);
    const wire = model.wires[0]!;
    expect(feedPosition(wire, 27).fraction).toBeCloseTo(26.5 / 79, 12);
    expect(feedPosition(wire, 27).metres).toBeCloseTo((26.5 / 79) * 41.1, 6);
    expect(feedPosition(wire, 1).metres).toBeCloseTo(41.1 / 79 / 2, 6);
    expect(feedPosition({ ...wire, segments: 21 }, 11).fraction).toBe(0.5); // an odd count has a true centre
  });

  it('places a feed by asking for a fraction of the way along', () => {
    const { model, wireId } = wireModel(79);
    const fed = addFeed(model, wireId, 1);
    const third = setFeedPosition(fed, fed.feeds[0]!.id, 1 / 3);
    expect(third.feeds[0]!.segment).toBe(27);
    expect(feedPosition(third.wires[0]!, 27).metres).toBeCloseTo(13.79, 2);

    // Asking past either end lands on the first or last segment, not off the wire.
    expect(setFeedPosition(fed, fed.feeds[0]!.id, -5).feeds[0]!.segment).toBe(1);
    expect(setFeedPosition(fed, fed.feeds[0]!.id, 5).feeds[0]!.segment).toBe(79);
  });

  it('refuses to stack two feeds on one segment', () => {
    const { model, wireId } = wireModel(21);
    const two = addFeed(addFeed(model, wireId, 5), wireId, 11);
    const clash = setFeedPosition(two, two.feeds[0]!.id, 0.5); // segment 11, already taken
    expect(clash).toBe(two);
  });

  it('finds a segment count that lands on the position you asked for', () => {
    // The centre of a wire is not a segment centre when the count is even.
    expect(segmentNearest({ ...wireModel(20).model.wires[0]!, segments: 20 }, 0.5)).toBe(11);
    expect(feedPosition({ ...wireModel(20).model.wires[0]!, segments: 20 }, 11).fraction).toBe(0.525);
    const odd = segmentsForPosition(0.5, 20);
    expect(odd % 2).toBe(1);
    expect(feedPosition({ ...wireModel(odd).model.wires[0]!, segments: odd }, segmentNearest({ ...wireModel(odd).model.wires[0]!, segments: odd }, 0.5)).fraction).toBe(0.5);

    // Never fewer segments than accuracy needs.
    expect(segmentsForPosition(1 / 3, 79)).toBeGreaterThanOrEqual(79);
  });

  it('keeps the feed where it is when the segment count changes', () => {
    const { model, wireId } = wireModel(79);
    const fed = setFeedPosition(addFeed(model, wireId, 1), addFeed(model, wireId, 1).feeds[0]!.id, 1 / 3);
    const before = feedPosition(fed.wires[0]!, fed.feeds[0]!.segment).fraction;
    const resegmented = setWireGeometry(fed, wireId, { segments: 159 });
    const after = feedPosition(resegmented.wires[0]!, resegmented.feeds[0]!.segment).fraction;
    expect(after).toBeCloseTo(before, 2);
  });
});

describe('the off-centre-fed dipole example', () => {
  it('is fed about a third along, and shows why it wants a 4:1 balun', async () => {
    const { raw, report } = await simulate(await loadExample('ocf-dipole-windom.nec'));
    expect(raw.exitCode).toBe(0);
    const feed = report.frequencies[0]!.feeds[0]!;
    const z = feed.impedance;

    // Measured: 131 - j24 ohms at 7.1 MHz over average ground.
    expect(z.re).toBeCloseTo(131, -1);
    expect(Math.abs(z.im)).toBeLessThan(40);
    // Hopeless on 50 ohms, reasonable through a 4:1 balun - the reason the design exists.
    expect(swr(z, 50)).toBeGreaterThan(2);
    expect(swr(z, 200)).toBeLessThan(1.8);

    // The feed is on the segment nearest a third of the way along.
    const segmentsOfWire = report.segments.filter((s) => s.tag === 1).length;
    expect(segmentsOfWire).toBe(79);
    expect((feed.segment - 0.5) / segmentsOfWire).toBeCloseTo(1 / 3, 2);
  });
});
