// How a whole-sphere pattern (the editor's automatic pattern) becomes the two plots.

import { describe, expect, it } from 'vitest';
import { cutsOf, elevationOfTheta, mainLobe } from '../src/engine/nec2/pattern';
import { deckToModel, modelToDeck } from '../src/tools/antenna-modeler/deck';
import type { AntennaModel } from '../src/tools/antenna-modeler/model';
import { loadExample, simulate } from './helpers/engine';

async function autoPattern(example: string, change: (m: AntennaModel) => AntennaModel = (m) => m) {
  const imported = deckToModel(await loadExample(example));
  if (!imported.ok) throw new Error(imported.reason);
  const model = change({ ...imported.model, pattern: { kind: 'auto' } });
  const { raw, report } = await simulate(modelToDeck(model));
  expect(raw.exitCode).toBe(0);
  const pattern = report.frequencies[0]!.patterns[0]!;
  return { points: pattern.points, cuts: cutsOf(pattern) };
}

describe('automatic pattern cuts', () => {
  it('cuts a Yagi through its forward lobe, closing the azimuth ring', async () => {
    const { points, cuts } = await autoPattern('yagi-3el-2m.nec');
    expect(points).toHaveLength(37 * 72);
    const lobe = mainLobe(points)!;
    expect([lobe.thetaDeg, lobe.phiDeg, lobe.totalDb]).toEqual([90, 0, 8.73]); // as the explicit cuts found

    const [azimuth, elevation] = cuts;
    expect(azimuth!.kind).toBe('azimuth');
    expect(elevationOfTheta(azimuth!.fixedDeg)).toBe(0);
    expect(azimuth!.points).toHaveLength(73); // 0..355 plus 360 to close the ring
    expect(azimuth!.points.at(-1)!.phiDeg).toBe(360);

    // Both half-planes of the vertical cut: forward (theta >= 0) and backward (folded to negative theta).
    expect(elevation!.kind).toBe('elevation');
    expect(elevation!.fixedDeg).toBe(0);
    expect(elevation!.points[0]!.thetaDeg).toBe(-180);
    expect(elevation!.points.at(-1)!.thetaDeg).toBe(180);
  });

  it('picks the horizon, not the zenith, when a dipole radiates equally all round its broadside plane', async () => {
    const { points, cuts } = await autoPattern('dipole-20m-free-space.nec');
    // The wire lies along Y: straight up (theta 0) is as strong as the horizon broadside (theta 90, phi 0).
    const up = points.find((p) => p.thetaDeg === 0 && p.phiDeg === 0)!;
    const broadside = points.find((p) => p.thetaDeg === 90 && p.phiDeg === 0)!;
    expect(up.totalDb).toBe(broadside.totalDb);

    const lobe = mainLobe(points)!;
    expect([lobe.thetaDeg, lobe.phiDeg]).toEqual([90, 0]);
    expect(elevationOfTheta(cuts[0]!.fixedDeg)).toBe(0); // the figure-of-eight at the horizon
    expect(cuts[1]!.fixedDeg).toBe(0);
  });

  it('cuts just below the zenith when the lobe really points straight up', async () => {
    // The 20 m dipole lowered to 2 m over perfect ground: a cloud warmer (NVIS).
    const { points, cuts } = await autoPattern('dipole-20m-over-ground.nec', (m) => ({
      ...m,
      ground: { kind: 'perfect' },
      wires: m.wires.map((w) => ({ ...w, a: { ...w.a, z: 2 }, b: { ...w.b, z: 2 } })),
    }));
    expect(points).toHaveLength(19 * 72); // the upper hemisphere only
    const lobe = mainLobe(points)!;
    expect(lobe.thetaDeg).toBe(0);

    const [azimuth, elevation] = cuts;
    expect(elevationOfTheta(azimuth!.fixedDeg)).toBe(85);
    expect(elevation!.points[0]!.thetaDeg).toBe(-90);
    expect(elevation!.points.at(-1)!.thetaDeg).toBe(90);
  });
});
