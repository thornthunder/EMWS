import { describe, expect, it } from 'vitest';
import { vec } from '../src/lib/vec3';
import {
  type AntennaModel,
  addFeed,
  addWire,
  autoSegment,
  deleteWire,
  duplicateWire,
  emptyModel,
  endsMovedWithWire,
  junctionOf,
  moveEnds,
  remapSegment,
  setWireGeometry,
  splitWire,
  suggestedSegments,
  translateEnds,
  wavelengthM,
} from '../src/tools/antenna-modeler/model';
import { validateModel } from '../src/tools/antenna-modeler/validate';

/** An inverted V: two legs meeting at an apex, fed where they meet. */
function invertedV(): { model: AntennaModel; left: string; right: string } {
  const m0 = emptyModel(7.1);
  const leftLeg = addWire(m0, vec(0, -8, 6), vec(0, 0, 10), { segments: 11 });
  const rightLeg = addWire(leftLeg.model, vec(0, 0, 10), vec(0, 8, 6), { segments: 11 });
  return { model: rightLeg.model, left: leftLeg.wireId, right: rightLeg.wireId };
}

describe('model edits', () => {
  it('gives new wires unique tags and a sensible segment count', () => {
    const { model } = invertedV();
    expect(model.wires.map((w) => w.tag)).toEqual([1, 2]);
    const third = addWire(model, vec(0, 0, 0), vec(0, 0, 10));
    const wire = third.model.wires.find((w) => w.id === third.wireId)!;
    expect(wire.tag).toBe(3);
    expect(wire.segments % 2).toBe(1);
    expect(wire.segments).toBe(suggestedSegments(10, wavelengthM(7.1)));
  });

  it('never mutates the model it was given', () => {
    const { model, left } = invertedV();
    const before = JSON.stringify(model);
    moveEnds(model, [{ wireId: left, end: 'a' }], vec(1, 2, 3));
    deleteWire(model, left);
    splitWire(model, left, 0.5);
    expect(JSON.stringify(model)).toBe(before);
  });

  it('treats ends at the same point as a junction that moves together', () => {
    const { model, left, right } = invertedV();
    const apex = junctionOf(model, { wireId: left, end: 'b' });
    expect(apex).toHaveLength(2);
    expect(apex).toContainEqual({ wireId: right, end: 'a' });

    const raised = moveEnds(model, apex, vec(0, 0, 12));
    expect(raised.wires[0]!.b).toEqual(vec(0, 0, 12));
    expect(raised.wires[1]!.a).toEqual(vec(0, 0, 12));
    expect(raised.wires[0]!.a).toEqual(vec(0, -8, 6)); // the far ends stay put
  });

  it('stretches connected wires when a whole wire is dragged, unless detached', () => {
    const { model, left, right } = invertedV();
    const moving = endsMovedWithWire(model, left, false);
    expect(moving).toHaveLength(3); // both ends of the left leg, plus the right leg's apex end
    const moved = translateEnds(model, moving, vec(1, 0, 0));
    expect(moved.wires.find((w) => w.id === right)!.a).toEqual(vec(1, 0, 10));
    expect(moved.wires.find((w) => w.id === right)!.b).toEqual(vec(0, 8, 6));

    expect(endsMovedWithWire(model, left, true)).toHaveLength(2);
  });

  it('keeps coordinates free of floating-point dust', () => {
    const { model, left } = invertedV();
    const moved = translateEnds(model, [{ wireId: left, end: 'a' }], vec(0.1, 0.2, 0));
    expect(moved.wires[0]!.a).toEqual(vec(0.1, -7.8, 6));
  });

  it('keeps a feed at the same place when the segment count changes', () => {
    expect(remapSegment(11, 21, 31)).toBe(16); // centre stays centre
    expect(remapSegment(1, 21, 5)).toBe(1);
    expect(remapSegment(21, 21, 5)).toBe(5);

    const { model, left } = invertedV();
    const fed = addFeed(model, left, 6);
    const resegmented = setWireGeometry(fed, left, { segments: 21 });
    expect(resegmented.feeds[0]!.segment).toBe(11);
  });

  it('refuses a second feed on the same segment, and drops feeds with their wire', () => {
    const { model, left } = invertedV();
    const once = addFeed(model, left, 6);
    expect(addFeed(once, left, 6)).toBe(once);
    expect(deleteWire(once, left).feeds).toEqual([]);
  });

  it('splits a wire into two joined wires, dividing segments and keeping the feed in place', () => {
    const m = addWire(emptyModel(14.2), vec(0, -5, 0), vec(0, 5, 0), { segments: 20 });
    const fed = addFeed(m.model, m.wireId, 15); // centre at 72.5 % of the way along
    const split = splitWire(fed, m.wireId, 0.5)!;
    const [head, tail] = split.model.wires;
    expect(head!.b).toEqual(vec(0, 0, 0));
    expect(tail!.a).toEqual(vec(0, 0, 0));
    expect([head!.segments, tail!.segments]).toEqual([10, 10]);
    expect(tail!.tag).toBe(2);
    expect(split.model.feeds[0]).toMatchObject({ wireId: tail!.id, segment: 5 });
    expect(junctionOf(split.model, { wireId: head!.id, end: 'b' })).toHaveLength(2);
    expect(validateModel(split.model).filter((i) => i.severity === 'error')).toEqual([]);

    expect(splitWire(fed, m.wireId, 0)).toBeUndefined();
    expect(splitWire(fed, m.wireId, 1)).toBeUndefined();
  });

  it('duplicates a wire with a new tag', () => {
    const { model, left } = invertedV();
    const copy = duplicateWire(model, left, vec(1, 0, 0))!;
    const wire = copy.model.wires.find((w) => w.id === copy.wireId)!;
    expect(wire.tag).toBe(3);
    expect(wire.a).toEqual(vec(1, -8, 6));
  });

  it('auto-segments to λ/20 at the highest frequency', () => {
    const m = addWire(emptyModel(14.2), vec(0, -5, 0), vec(0, 5, 0), { segments: 3 });
    const sweep = { ...m.model, frequency: { startMHz: 14, stepMHz: 0.05, steps: 8 } };
    const wavelength = wavelengthM(14.35);
    expect(autoSegment(sweep).wires[0]!.segments).toBe(suggestedSegments(10, wavelength));
    expect(Math.ceil(10 / (wavelength / 20))).toBe(10); // so the odd count is 11
    expect(autoSegment(sweep).wires[0]!.segments).toBe(11);
  });
});

describe('design checks', () => {
  const messages = (m: AntennaModel) => validateModel(m).map((i) => `${i.severity}: ${i.message}`);

  it('passes a sound model', () => {
    const { model, left } = invertedV();
    expect(validateModel(addFeed(model, left, 11))).toEqual([]);
  });

  it('asks for wires and a feed', () => {
    expect(messages(emptyModel())).toEqual([expect.stringMatching(/^error: There are no wires/)]);
    expect(messages(invertedV().model)).toEqual([expect.stringMatching(/^warning: Nothing is driven/)]);
  });

  it('catches wires below ground, but only when there is ground', () => {
    const { model, left } = invertedV();
    const buried = addFeed(moveEnds(model, [{ wireId: left, end: 'a' }], vec(0, -8, -1)), left, 11);
    expect(messages(buried)).toEqual([]);
    expect(messages({ ...buried, ground: { kind: 'perfect' } })).toEqual([expect.stringMatching(/^error: Wire 1 goes below ground/)]);
  });

  it('warns about long segments and fat wires', () => {
    const m = addWire(emptyModel(14.2), vec(0, -5, 0), vec(0, 5, 0), { segments: 3 });
    const fed = addFeed(m.model, m.wireId, 2);
    expect(messages(fed)).toEqual([expect.stringMatching(/segments are 0\.16 λ long at 14\.2 MHz.*use 11 segments/)]);
    const fat = setWireGeometry(fed, m.wireId, { segments: 11, radius: 0.2 });
    expect(messages(fat)).toEqual([expect.stringMatching(/only 4\.5 times the wire radius/)]);
  });

  it('spots ends that almost meet, ends landing part-way along a wire, and crossings', () => {
    const base = addWire(emptyModel(14.2), vec(0, -5, 0), vec(0, 5, 0), { segments: 21 });
    const fed = (m: AntennaModel) => addFeed(m, base.wireId, 11);

    const nearly = addWire(base.model, vec(0, 5.001, 0), vec(0, 5.001, 3), { segments: 5 });
    expect(messages(fed(nearly.model))).toEqual([expect.stringMatching(/almost meet/)]);

    const tee = addWire(base.model, vec(0, 1, 0), vec(0, 1, 3), { segments: 5 });
    expect(messages(fed(tee.model))).toEqual([expect.stringMatching(/Wire 2 ends part-way along Wire 1.*Split wire here/)]);

    const cross = addWire(base.model, vec(-1, 1, 0), vec(1, 1, 0), { segments: 5 });
    expect(messages(fed(cross.model))).toEqual([expect.stringMatching(/Wire 1 and Wire 2 cross/)]);
  });
});
