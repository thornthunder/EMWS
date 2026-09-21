import { describe, expect, it } from 'vitest';
import { estimateSolveMs, formatDuration, formatDurationShort } from '../src/tools/antenna-modeler/cost';
import { addFeed, addWire, emptyModel, setWireGeometry } from '../src/tools/antenna-modeler/model';
import { vec } from '../src/lib/vec3';
import { validateModel } from '../src/tools/antenna-modeler/validate';

describe('how long a solve will take', () => {
  it('follows the cube of the segment count', () => {
    // Doubling the segments is eight times the work, once the matrix dominates the
    // fixed costs of setting a run up.
    const ratio = estimateSolveMs(2000, 1) / estimateSolveMs(1000, 1);
    expect(ratio).toBeGreaterThan(7.5);
    expect(ratio).toBeLessThan(8.1);
  });

  it('is measured against this build of the engine', () => {
    // 2000 segments at one frequency was timed at 11.0 s; 800 segments at 0.63 s.
    expect(estimateSolveMs(2000, 1) / 1000).toBeCloseTo(11, 0);
    expect(estimateSolveMs(800, 1) / 1000).toBeCloseTo(0.7, 1);
    // The reported case: 2000 segments across 30 frequencies took 305 s.
    expect(estimateSolveMs(2000, 30) / 1000).toBeCloseTo(330, -2);
    // What that wire actually needs is instant by comparison.
    expect(estimateSolveMs(81, 30)).toBeLessThan(200);
  });

  it('says how long in words people use', () => {
    expect(formatDuration(200)).toBe('well under a second');
    expect(formatDuration(12_400)).toBe('about 12 seconds');
    expect(formatDuration(305_000)).toBe('about 5.1 minutes');
    expect(formatDurationShort(305_000)).toBe('~5.1 min');
    expect(formatDurationShort(12_400)).toBe('~12 s');
  });
});

describe('the slow-model warning', () => {
  /** The model from the report: a 40 m wire cut into 2000 segments, swept 1-30 MHz. */
  function reportedModel() {
    const base = emptyModel(1);
    const wire = addWire(base, vec(0, -20, 0), vec(0, 20, 0), { segments: 3 });
    const fed = addFeed(wire.model, wire.wireId, 2);
    return {
      ...setWireGeometry(fed, wire.wireId, { segments: 2000 }),
      frequency: { startMHz: 1, stepMHz: 1, steps: 30 },
    };
  }

  it('warns before a run that would keep somebody waiting, and says what to do', () => {
    const issues = validateModel(reportedModel());
    const slow = issues.find((i) => i.message.includes('to solve'));
    expect(slow?.severity).toBe('warning');
    expect(slow?.message).toMatch(/about 5\.\d minutes/);
    expect(slow?.message).toMatch(/2000 segments at 30 frequencies/);
    expect(slow?.message).toMatch(/cube of the segment count/);
    expect(slow?.message).toMatch(/Auto-segment would use \d+/);
  });

  it('stays quiet about models that solve while you blink', () => {
    const quick = { ...reportedModel(), frequency: { startMHz: 14.2, stepMHz: 0, steps: 1 } };
    const sensible = setWireGeometry(quick, quick.wires[0]!.id, { segments: 81 });
    expect(validateModel(sensible).some((i) => i.message.includes('to solve'))).toBe(false);
  });
});
