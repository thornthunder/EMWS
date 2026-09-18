// End-to-end: real card decks through the real WebAssembly engine and the report parser.
//
// WebAssembly arithmetic is deterministic and nec2c's libm is compiled into the module,
// so these values are identical on every machine. They were checked against antenna
// theory when first recorded (see the comments); a change here means the engine build
// or the parser changed.

import { describe, expect, it } from 'vitest';
import { TRAPPED } from '../src/engine/nec2/run';
import { NO_FIELD_DB, type RadiationPattern } from '../src/engine/nec2/types';
import { swr } from '../src/lib/rf';
import { loadExample, simulate } from './helpers/engine';

function maxGain(pattern: RadiationPattern | undefined) {
  const points = pattern?.points ?? [];
  return points.reduce((best, p) => (p.totalDb > best.totalDb ? p : best), points[0]!);
}

describe('nec2c WebAssembly engine', () => {
  it('models a resonant half-wave dipole in free space', async () => {
    const { raw, report } = await simulate(await loadExample('dipole-20m-free-space.nec'));

    expect(raw.exitCode).toBe(0);
    expect(raw.stderr).toBe('');
    expect(report.errors).toEqual([]);
    expect(report.comments[0]).toBe('20 m half-wave dipole in free space.');

    expect(report.segments).toHaveLength(21);
    expect(report.segments[0]?.start.y).toBeCloseTo(-5.13, 3);
    expect(report.segments[20]?.end.y).toBeCloseTo(5.13, 3);

    expect(report.frequencies).toHaveLength(1);
    const f = report.frequencies[0]!;
    expect(f.frequencyMHz).toBe(14.2);
    expect(f.wavelengthM).toBeCloseTo(21.113, 3);

    // Theory: a thin resonant half-wave dipole is about 72 ohms, purely resistive.
    const z = f.feeds[0]!.impedance;
    expect(z.re).toBeCloseTo(72.353, 3);
    expect(z.im).toBeCloseTo(1.9898, 3);
    expect(f.feeds[0]!.segment).toBe(11);

    expect(f.currents).toHaveLength(21);
    expect(f.power?.efficiencyPct).toBe(100);

    // Theory: 2.15 dBi broadside, nulls off the ends of the wire.
    expect(f.patterns).toHaveLength(2);
    const [azimuth, wirePlane] = f.patterns;
    expect(azimuth?.points).toHaveLength(73);
    expect(maxGain(azimuth).totalDb).toBe(2.14);
    expect(maxGain(azimuth).phiDeg).toBe(0);

    const offTheEnd = wirePlane?.points.find((p) => p.thetaDeg === 90);
    expect(offTheEnd?.totalDb).toBe(NO_FIELD_DB);
    expect(offTheEnd?.sense).toBe(''); // nec2c leaves SENSE blank where there is no field
    expect(wirePlane?.points.find((p) => p.thetaDeg === 0)?.sense).toBe('LINEAR');
  });

  it('models a quarter-wave vertical over perfect ground', async () => {
    const { raw, report } = await simulate(await loadExample('vertical-40m-perfect-ground.nec'));
    expect(raw.exitCode).toBe(0);
    const f = report.frequencies[0]!;

    // Theory: half the dipole's impedance (~36 ohms) and 3 dB more gain (5.15 dBi), at the horizon.
    expect(f.feeds[0]!.impedance.re).toBeCloseTo(37.567, 3);
    expect(f.feeds[0]!.impedance.im).toBeCloseTo(8.4634, 3);
    const peak = maxGain(f.patterns[1]);
    expect(peak.totalDb).toBe(5.16);
    expect(Math.abs(peak.thetaDeg)).toBe(90);
  });

  it('models a dipole over Sommerfeld-Norton ground', async () => {
    const { raw, report } = await simulate(await loadExample('dipole-20m-over-ground.nec'));
    expect(raw.exitCode).toBe(0);
    expect(report.errors).toEqual([]);
    const f = report.frequencies[0]!;

    expect(f.feeds[0]!.impedance.re).toBeCloseTo(71.152, 3);
    expect(f.feeds[0]!.impedance.im).toBeCloseTo(-8.8261, 3);
    // Ground reflection adds roughly 5 dB; almost nothing goes straight up at this height.
    const elevation = f.patterns[1];
    expect(maxGain(elevation).totalDb).toBe(7.11);
    expect(Math.abs(maxGain(elevation).thetaDeg)).toBe(60);
    expect(elevation?.points.find((p) => p.thetaDeg === 0)?.totalDb).toBe(-5.04);
  });

  it('models a 3-element Yagi', async () => {
    const { raw, report } = await simulate(await loadExample('yagi-3el-2m.nec'));
    expect(raw.exitCode).toBe(0);
    expect(report.segments).toHaveLength(33);
    const f = report.frequencies[0]!;

    expect(f.feeds[0]!.tag).toBe(2);
    expect(f.feeds[0]!.impedance.re).toBeCloseTo(27.067, 3);
    expect(f.feeds[0]!.impedance.im).toBeCloseTo(14.781, 3);

    const ePlane = f.patterns[0]!;
    const forward = maxGain(ePlane);
    expect(forward.totalDb).toBe(8.73);
    expect(forward.phiDeg).toBe(0); // fires along the boom, towards the director
    const backward = ePlane.points.find((p) => p.phiDeg === 180)!;
    expect(forward.totalDb - backward.totalDb).toBeGreaterThan(8); // front-to-back ratio
  });

  it('runs a frequency sweep and finds resonance inside the 20 m band', async () => {
    const { raw, report } = await simulate(await loadExample('dipole-20m-swr-sweep.nec'));
    expect(raw.exitCode).toBe(0);
    expect(report.frequencies).toHaveLength(17);
    expect(report.frequencies.map((f) => f.frequencyMHz)).toContain(14.2);

    // Reactance rises monotonically through zero: capacitive below resonance, inductive above.
    const reactance = report.frequencies.map((f) => f.feeds[0]!.impedance.im);
    for (let i = 1; i < reactance.length; i++) {
      expect(reactance[i]!).toBeGreaterThan(reactance[i - 1]!);
    }
    const resonance = report.frequencies.find((f) => f.feeds[0]!.impedance.im > 0)!;
    expect(resonance.frequencyMHz).toBe(14.2);

    const best = Math.min(...report.frequencies.map((f) => swr(f.feeds[0]!.impedance)));
    expect(best).toBeGreaterThan(1.4);
    expect(best).toBeLessThan(1.5); // ~72 ohms into 50
  });

  it('gives each run a clean engine', async () => {
    const deck = await loadExample('dipole-20m-free-space.nec');
    const first = await simulate(deck);
    await simulate(await loadExample('yagi-3el-2m.nec'));
    const again = await simulate(deck);
    expect(again.report.frequencies[0]!.feeds).toEqual(first.report.frequencies[0]!.feeds);
    expect(again.report.segments).toEqual(first.report.segments);
  });

  it('reports an engine crash instead of throwing', async () => {
    // A wire with zero segments makes nec2c divide by zero, which WebAssembly traps.
    const { raw, report } = await simulate('CM broken\nCE\nGW 1 0 0 0 0 0 0 1 0.001\nGE 0\nEN\n');
    expect(raw.exitCode).toBe(TRAPPED);
    expect(raw.trap).toMatch(/divide by zero/);
    expect(report.frequencies).toEqual([]);
  });

  it('reports a deck nec2c rejects', async () => {
    const { raw, report } = await simulate('CM unknown geometry card\nCE\nZZ 1 2 3\nGE 0\nEN\n');
    expect(raw.exitCode).not.toBe(0);
    expect(report.errors.join('\n')).toMatch(/GEOMETRY DATA CARD ERROR/);
  });

  it('recovers after a crash', async () => {
    await simulate('CM broken\nCE\nGW 1 0 0 0 0 0 0 1 0.001\nGE 0\nEN\n');
    const { raw } = await simulate(await loadExample('yagi-3el-2m.nec'));
    expect(raw.exitCode).toBe(0);
  });
});
