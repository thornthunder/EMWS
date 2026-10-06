// The multi-variable optimiser and the parameter sweep. The search is held to functions
// whose minima are known on paper; the engine tests hold it to antennas, with every figure
// in a comment MEASURED before it was written down.

import { describe, expect, it } from 'vitest';
import { deckToModel } from '../src/tools/antenna-modeler/deck';
import type { AntennaModel } from '../src/tools/antenna-modeler/model';
import {
  type OptimiseGoal,
  type OptimiseVariable,
  FB_CAP_DB,
  evenlySpaced,
  nelderMead,
  optimise,
  scoreOf,
  sweepParameter,
} from '../src/tools/antenna-modeler/optimise';
import { currentValue, variableChoices } from '../src/tools/antenna-modeler/tune';
import { loadExample, simulate } from './helpers/engine';

function imported(text: string): AntennaModel {
  const result = deckToModel(text);
  if (!result.ok) throw new Error(result.reason);
  return result.model;
}

describe('Nelder-Mead on paper', () => {
  it('finds the bottom of a bowl', async () => {
    const r = await nelderMead(async ([x, y]) => (x! - 0.3) ** 2 + 2 * (y! - 0.7) ** 2, [0.9, 0.1], { tolerance: 1e-5, maxEvaluations: 400 });
    expect(r.x[0]).toBeCloseTo(0.3, 3);
    expect(r.x[1]).toBeCloseTo(0.7, 3);
    expect(r.truncated).toBe(false);
  });

  it("follows Rosenbrock's curved valley to its end", async () => {
    // x = 4u - 2 maps the unit square onto [-2, 2]^2; the minimum at (1, 1) is u = 0.75.
    const rosen = async ([u, v]: number[]) => {
      const x = 4 * u! - 2;
      const y = 4 * v! - 2;
      return (1 - x) ** 2 + 100 * (y - x * x) ** 2;
    };
    const r = await nelderMead(rosen, [0.2, 0.8], { tolerance: 1e-6, maxEvaluations: 2000 });
    expect(r.x[0]).toBeCloseTo(0.75, 2);
    expect(r.x[1]).toBeCloseTo(0.75, 2);
  });

  it('stays inside the ranges, ending on the face nearest a minimum outside them', async () => {
    const r = await nelderMead(async ([x, y]) => (x! - 1.5) ** 2 + (y! - 0.4) ** 2, [0.2, 0.2], { tolerance: 1e-5, maxEvaluations: 400 });
    expect(r.x[0]).toBeCloseTo(1, 6);
    expect(r.x[1]).toBeCloseTo(0.4, 3);
  });

  it('never solves more than it is allowed, and says when it stopped early', async () => {
    let calls = 0;
    const r = await nelderMead(
      async ([x, y, z]) => {
        calls += 1;
        return x! * x! + y! * y! + z! * z!;
      },
      [0.9, 0.9, 0.9],
      { tolerance: 1e-12, maxEvaluations: 12 },
    );
    expect(calls).toBe(12);
    expect(r.evaluations).toBe(12);
    expect(r.truncated).toBe(true);
  });
});

describe('the score', () => {
  const goal: OptimiseGoal = { fMHz: 146, gainWeight: 1, fbWeight: 0.5, swrWeight: 1, swrTarget: 1.5, swrOver: 'frequency', z0: 50 };
  it('weighs gain, capped front-to-back and SWR over target as the guide says', () => {
    expect(scoreOf({ gainDbi: 8, fbDb: 20, swr: 1.2 }, goal)).toBeCloseTo(-8 - 10, 12);
    // F/B past the cap counts as the cap: a razor-thin null earns nothing extra.
    expect(scoreOf({ gainDbi: 8, fbDb: 60, swr: 1.2 }, goal)).toBeCloseTo(-8 - 0.5 * FB_CAP_DB, 12);
    // 0.1 of SWR over the target costs exactly 1 dB.
    expect(scoreOf({ gainDbi: 8, fbDb: 20, swr: 1.6 }, goal) - scoreOf({ gainDbi: 8, fbDb: 20, swr: 1.5 }, goal)).toBeCloseTo(1, 12);
  });
});

describe('on the real engine', () => {
  // MEASURED 2026-10-05: gain alone takes the example from 8.73 to 9.53 dBi in 35 solves, the
  // director lengthened 0.904 -> 0.944 m - and F/B falls 16.0 -> 8.2 dB, the textbook price of
  // optimising for gain alone, which is why the goal has an F/B weight.
  it("improves the 3-element Yagi, searching its director's length and place together", async () => {
    const model = imported(await loadExample('yagi-3el-2m.nec'));
    const choices = variableChoices(model);
    const director = model.wires.find((w) => w.tag === 3)!;
    const pick = (key: string) => choices.find((c) => c.key === key)!.variable;
    const vars: OptimiseVariable[] = [
      { variable: pick('wire:' + director.id), range: { min: 0.8, max: 1.0 } },
      { variable: pick('pos:' + director.id + ':x'), range: { min: 0.2, max: 0.7 } },
    ];
    const current = vars.map((v) => currentValue(model, v.variable)!);
    const goal: OptimiseGoal = { fMHz: 146, gainWeight: 1, fbWeight: 0, swrWeight: 0, swrTarget: 1.5, swrOver: 'frequency', z0: 50 };
    const result = await optimise(model, vars, goal, current, (deck) => simulate(deck), undefined, 80);
    expect(result.improved).toBe(true);
    expect(result.after.gainDbi!).toBeGreaterThan(result.before.gainDbi!);
    result.values.forEach((v, i) => {
      expect(v).toBeGreaterThanOrEqual(vars[i]!.range.min);
      expect(v).toBeLessThanOrEqual(vars[i]!.range.max);
    });
    // The new model really has those values: the director moved along the boom only.
    const moved = result.model.wires.find((w) => w.tag === 3)!;
    expect((moved.a.x + moved.b.x) / 2).toBeCloseTo(result.values[1]!, 6);
    expect(result.evaluations).toBeLessThanOrEqual(80);
  }, 120_000);

  // MEASURED 2026-10-05 over the example's real ground, take-off angle against the textbook
  // first lobe sin(el) = lambda / 4h: 12 m 24/26.1°, 15 m 20/20.6°, 18 m 16/17.1°,
  // 21 m 14/14.6°, 24 m 12/12.7° - inside the sweep's 2° pattern step from half a wave up.
  // Lower down real ground pulls it away from the perfect-ground formula (6 m: 50 against 61.6°).
  it('draws the textbook curve: a dipole lowers its take-off angle as it is raised', async () => {
    const model = imported(await loadExample('dipole-20m-over-ground.nec'));
    const height = variableChoices(model).find((c) => c.key === 'height')!.variable;
    const rows = await sweepParameter(model, height, evenlySpaced({ min: 6, max: 24 }, 7), 14.2, 50, (deck) => simulate(deck));
    expect(rows).toHaveLength(7);
    const angles = rows.map((r) => r.elevationDeg!);
    for (let i = 1; i < angles.length; i++) expect(angles[i]!).toBeLessThanOrEqual(angles[i - 1]!);
    const lambda = 299.792458 / 14.2;
    for (const r of rows.filter((x) => x.value >= 12)) {
      const theory = (Math.asin(lambda / (4 * r.value)) * 180) / Math.PI;
      expect(Math.abs(r.elevationDeg! - theory), `${r.value} m`).toBeLessThanOrEqual(2.5);
    }
  }, 120_000);
});
