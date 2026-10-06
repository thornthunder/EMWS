// The RF exposure map: nec2c's near-field tables, read and scaled. Held to antenna theory -
// far from a dipole the near-field table must become the textbook far field - and to the
// identities the scaling rests on. Every bound here was set after the engine was run.

import { describe, expect, it } from 'vitest';
import { deckToModel } from '../src/tools/antenna-modeler/deck';
import {
  ETA0,
  averagePowerW,
  distanceToSegment,
  exposureDeck,
  exposureMap,
  fieldScale,
  rmsMagnitude,
  suggestedGrid,
  verdict,
} from '../src/tools/antenna-modeler/exposure';
import type { AntennaModel } from '../src/tools/antenna-modeler/model';
import { loadExample, simulate } from './helpers/engine';

function imported(text: string): AntennaModel {
  const result = deckToModel(text);
  if (!result.ok) throw new Error(result.reason);
  return result.model;
}

/** The free-space dipole's deck with its RP cards swapped for these near-field cards. */
async function dipoleWith(cards: string[]): Promise<string> {
  const deck = await loadExample('dipole-20m-free-space.nec');
  return deck.replace(/^RP .*\n/gm, '').replace(/^EN/m, `${cards.join('\n')}\nEN`);
}

const LAMBDA_14_2 = 299.792458 / 14.2;

describe('near fields from the engine', () => {
  // MEASURED 2026-10-05: E·r is 0.9979 / 0.9981 / 0.9982 of sqrt(60 P G) with G = 2.15 dBi at
  // 10 / 15 / 20 wavelengths (this 10.26 m dipole is 2.14 dBi, which is the 0.2 %), and
  // |E| / |H| is 0.99974 / 0.99987 / 0.99992 of eta0 - closing on 1 as the near-field terms fade.
  it('become the textbook far field broadside to a dipole: E·r = sqrt(60 P G), and E / H = eta0', async () => {
    // Along +X (broadside: the wire lies along Y) at 10, 15 and 20 wavelengths.
    const r0 = 10 * LAMBDA_14_2;
    const dr = 5 * LAMBDA_14_2;
    const run = await simulate(await dipoleWith([`NE 0 3 1 1 ${r0} 0 0 ${dr} 0 0`, `NH 0 3 1 1 ${r0} 0 0 ${dr} 0 0`]));
    const f = run.report.frequencies[0]!;
    expect(f.nearElectric).toHaveLength(3);
    expect(f.nearMagnetic).toHaveLength(3);
    const inputW = f.power!.inputW;
    const gain = 10 ** (2.15 / 10);
    const expected = Math.sqrt(60 * inputW * gain);
    for (const [i, e] of f.nearElectric!.entries()) {
      const r = Math.hypot(e.x, e.y, e.z);
      const ePeak = Math.sqrt(2) * rmsMagnitude(e);
      expect(ePeak * r).toBeGreaterThan(expected * 0.995);
      expect(ePeak * r).toBeLessThan(expected * 1.001);
      const h = f.nearMagnetic![i]!;
      expect(rmsMagnitude(e) / rmsMagnitude(h)).toBeGreaterThan(ETA0 * 0.999);
      expect(rmsMagnitude(e) / rmsMagnitude(h)).toBeLessThan(ETA0 * 1.0005);
    }
  }, 30_000);

  it('are mirror-symmetric about the centre-fed dipole, and all but nil off its ends', async () => {
    const run = await simulate(await dipoleWith(['NE 0 1 3 1 5 -5 0 0 5 0', 'NE 0 1 1 1 0 200 0 0 0 0', 'NE 0 1 1 1 200 0 0 0 0 0']));
    const e = run.report.frequencies[0]!.nearElectric!;
    expect(e).toHaveLength(5);
    // (5, -5, 0) and (5, 5, 0) see the same field.
    expect(rmsMagnitude(e[0]!)).toBeCloseTo(rmsMagnitude(e[2]!), 6);
    // 200 m off the end of the wire against 200 m broadside: the end-fire null.
    expect(rmsMagnitude(e[3]!) / rmsMagnitude(e[4]!)).toBeLessThan(0.05);
  }, 30_000);
});

describe('the exposure deck and map', () => {
  it('maps a square grid at the chosen height, scaled to the average power', async () => {
    const model = imported(await loadExample('dipole-20m-free-space.nec'));
    const grid = { ...suggestedGrid(model), points: 11 };
    const run = await simulate(exposureDeck(model, 14.2, grid));
    const f = run.report.frequencies[0]!;
    expect(run.report.frequencies).toHaveLength(1);
    expect(f.nearElectric).toHaveLength(121);
    expect(f.nearMagnetic).toHaveLength(121);
    // At the engine's own input power the scale is 1 and the cell is the RMS of the row.
    const own = exposureMap(f, run.report.segments, f.power!.inputW)!;
    expect(own.scale).toBeCloseTo(1, 12);
    expect(own.cells[60]!.eRms).toBeCloseTo(rmsMagnitude(f.nearElectric![60]!), 12);
    // Four times the power, twice the field.
    const four = exposureMap(f, run.report.segments, 4 * f.power!.inputW)!;
    expect(four.cells[0]!.eRms / own.cells[0]!.eRms).toBeCloseTo(2, 9);
    // The middle of the grid sits on the wire: not trusted.
    expect(own.cells[60]!.tooClose).toBe(true);
    // A corner of a 5 m map is clear of a 10 m dipole along Y.
    expect(own.cells[0]!.tooClose).toBe(false);
  }, 30_000);

  it('works over real ground and over a radial screen, as the modeller builds them', async () => {
    for (const name of ['dipole-20m-over-ground.nec', 'vertical-40m-radials.nec', 'vertical-40m-perfect-ground.nec']) {
      const model = imported(await loadExample(name));
      const grid = { ...suggestedGrid(model), points: 5 };
      const run = await simulate(exposureDeck(model, model.frequency.startMHz, grid));
      expect(run.raw.exitCode, name).toBe(0);
      expect(run.report.errors, name).toEqual([]);
      expect(run.report.frequencies[0]?.nearElectric, name).toHaveLength(25);
      for (const p of run.report.frequencies[0]!.nearElectric!) expect(Number.isFinite(rmsMagnitude(p)), name).toBe(true);
    }
  }, 60_000);
});

describe('the arithmetic', () => {
  it('averages power by duty and time on air, and scales fields by its square root', () => {
    expect(averagePowerW(100, 0.4, 0.5)).toBeCloseTo(20, 12);
    expect(averagePowerW(100, 1.5, -1)).toBe(0);
    expect(fieldScale(0.01, 100)).toBeCloseTo(100, 9);
  });

  it('measures the distance to a segment, ends included', () => {
    const a = { x: 0, y: -1, z: 0 };
    const b = { x: 0, y: 1, z: 0 };
    expect(distanceToSegment({ x: 3, y: 0, z: 4 }, a, b)).toBeCloseTo(5, 12);
    expect(distanceToSegment({ x: 0, y: 4, z: 0 }, a, b)).toBeCloseTo(3, 12);
  });

  it('finds where a limit is crossed and says when the map is too small', () => {
    const cell = (x: number, v: number, edge = false) => ({ x, y: 0, z: 0, eRms: v, hRms: v / ETA0, wireDistanceM: Math.abs(x), tooClose: false, edge });
    // A 3 x 3 grid, strongest in the middle, over the limit only there.
    const cells = [1, 1, 1, 1, 9, 1, 1, 1, 1].map((v, i) => cell(i - 4, v));
    const map = { cells, points: 3, scale: 1, averageW: 1 };
    const inside = verdict(map, 'e', 5);
    expect(inside.overCount).toBe(1);
    expect(inside.overAtEdge).toBe(false);
    expect(inside.peak).toBe(9);
    const everywhere = verdict(map, 'e', 0.5);
    expect(everywhere.overAtEdge).toBe(true);
    expect(verdict(map, 'e', undefined).overCount).toBe(0);
  });
});
