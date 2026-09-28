// The 3-D pattern's surface, and the balun-strain verdict on the Antenna Modeler's card.

import { describe, expect, it } from 'vitest';
import { modelToDeck } from '../src/tools/antenna-modeler/deck';
import { patternMesh } from '../src/tools/antenna-modeler/pattern-mesh';
import { FLUX_BURN, FLUX_HOT, RISE_BURN_C, RISE_HOT_C, balunStrain } from '../src/tools/antenna-modeler/through';
import { vec } from '../src/lib/vec3';
import { addFeed, addWire, emptyModel } from '../src/tools/antenna-modeler/model';
import { simulate } from './helpers/engine';

describe('the 3-D pattern', () => {
  it('a dipole along Y is a doughnut round Y: strongest broadside along X, nothing off its ends', async () => {
    const { model, wireId } = addWire(emptyModel(14.2), vec(0, -5.13, 0), vec(0, 5.13, 0), { segments: 21 });
    const deck = modelToDeck(addFeed(model, wireId, 11));
    const patterns = (await simulate(deck)).report.frequencies[0]!.patterns;
    const mesh = patternMesh(patterns)!;
    expect(mesh).toBeDefined();
    expect(mesh.wraps).toBe(true);
    expect(mesh.peakDb).toBeCloseTo(2.14, 1);
    // The peak lies in the plane at right angles to the wire.
    expect(Math.abs(mesh.peakDirection.y)).toBeLessThan(1e-6);
    // And on the horizon, where the peak-gain card puts it, not at the zenith, which ties with it.
    expect(Math.abs(mesh.peakDirection.z)).toBeLessThan(1e-6);
    // Every point's reach is at most the peak's, and along the wire it is next to nothing.
    const reach = mesh.grid.flat().map((p) => Math.hypot(p.x, p.y, p.z));
    expect(Math.max(...reach)).toBeCloseTo(1, 6);
    const alongWire = mesh.grid.flat().filter((p) => Math.abs(p.y) > 0.999 * Math.hypot(p.x, p.y, p.z) && Math.hypot(p.x, p.y, p.z) > 0);
    for (const p of alongWire) expect(Math.hypot(p.x, p.y, p.z)).toBeLessThan(0.3);
    // The whole sphere at 5 degrees is 37 x 72; thinned for drawing to at most 40 a side.
    expect(mesh.grid.length).toBeLessThanOrEqual(40);
    expect(mesh.grid[0]!.length).toBeLessThanOrEqual(40);
  });

  it('draws nothing from a single cut: there is no surface in one slice', () => {
    const cut = { points: Array.from({ length: 37 }, (_, i) => ({ thetaDeg: 90, phiDeg: i * 10, verticalDb: 0, horizontalDb: 0, totalDb: 0, axialRatio: 0, tiltDeg: 0, sense: 'LINEAR' })) };
    expect(patternMesh([cut])).toBeUndefined();
    // Two crossed cuts, azimuth and elevation, share angles with a sphere but are not one.
    const elevation = { points: Array.from({ length: 37 }, (_, i) => ({ ...cut.points[0]!, thetaDeg: i * 5, phiDeg: 90 })) };
    expect(patternMesh([cut, elevation])).toBeUndefined();
    expect(patternMesh([])).toBeUndefined();
  });
});

describe('how hard the balun works', () => {
  it('green, orange and red on the temperature rise and on flux, whichever is worse', () => {
    expect(balunStrain({ tempRiseC: 10, fluxOfSaturation: 0.05 }).level).toBe('ok');
    expect(balunStrain({ tempRiseC: RISE_HOT_C, fluxOfSaturation: 0.05 }).level).toBe('hot');
    expect(balunStrain({ tempRiseC: RISE_BURN_C, fluxOfSaturation: 0.05 }).level).toBe('burn');
    expect(balunStrain({ tempRiseC: 10, fluxOfSaturation: FLUX_HOT }).level).toBe('hot');
    expect(balunStrain({ tempRiseC: 10, fluxOfSaturation: FLUX_BURN }).level).toBe('burn');
    expect(balunStrain({ tempRiseC: RISE_HOT_C, fluxOfSaturation: FLUX_BURN }).level).toBe('burn');
    expect(balunStrain({ tempRiseC: Infinity, fluxOfSaturation: 0 }).level).toBe('burn');
    expect(balunStrain({ tempRiseC: 55, fluxOfSaturation: 0.1 }).reason).toMatch(/55 °C.*runaway/);
  });
});
