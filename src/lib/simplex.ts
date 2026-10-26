// Nelder-Mead's simplex method, written from the 1965 paper's rules (reflect, expand,
// contract, shrink), over the unit cube: every variable is scaled to [0, 1] by its caller,
// so a 3 cm spacing and a 30 cm length move on equal terms. Shared by the Antenna
// Modeler's optimiser (where every trial is a NEC solve) and the Smith chart's (where a
// trial is closed-form arithmetic and thousands run in a blink).
//
// Public domain (The Unlicense). By ZR1JT.

export interface SimplexResult {
  /** Best point found, in the unit cube. */
  x: number[];
  score: number;
  evaluations: number;
  /** Stopped at maxEvaluations before the simplex shrank to the tolerance. */
  truncated: boolean;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Minimises f over the unit cube [0, 1]^n by Nelder-Mead. Points that would leave the cube
 * are pulled back onto its face (the search stays inside the ranges the person gave).
 * Evaluations are cached by point, so a repeated vertex is never solved twice. Pure.
 */
export async function nelderMead(
  f: (x: number[]) => Promise<number>,
  start: readonly number[],
  options: { step?: number; tolerance?: number; maxEvaluations?: number; onEvaluation?: (x: number[], score: number, count: number) => void } = {},
): Promise<SimplexResult> {
  const n = start.length;
  const { step = 0.2, tolerance = 2e-3, maxEvaluations = 150 } = options;
  const cache = new Map<string, number>();
  let count = 0;
  let truncated = false;
  const at = async (raw: readonly number[]): Promise<number> => {
    const x = raw.map(clamp01);
    const key = x.map((v) => v.toFixed(6)).join(',');
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    if (count >= maxEvaluations) {
      truncated = true;
      return Infinity;
    }
    count += 1;
    const score = await f(x);
    const safe = Number.isFinite(score) ? score : Infinity;
    cache.set(key, safe);
    options.onEvaluation?.(x, safe, count);
    return safe;
  };

  // The first simplex: the start, and one step along each axis - inward where the start
  // sits near the far side, so no vertex starts outside the cube.
  const simplex: { x: number[]; f: number }[] = [];
  const x0 = start.map(clamp01);
  simplex.push({ x: x0, f: await at(x0) });
  for (let i = 0; i < n; i++) {
    const x = [...x0];
    x[i] = x0[i]! + step <= 1 ? x0[i]! + step : x0[i]! - step;
    simplex.push({ x: x.map(clamp01), f: await at(x) });
  }

  const combine = (a: readonly number[], b: readonly number[], t: number) => a.map((v, i) => clamp01(v + t * (b[i]! - v)));
  while (!truncated) {
    simplex.sort((p, q) => p.f - q.f);
    const best = simplex[0]!;
    const worst = simplex[n]!;
    const size = Math.max(...simplex.slice(1).map((p) => Math.max(...p.x.map((v, i) => Math.abs(v - best.x[i]!)))));
    if (size < tolerance) break;
    // Centroid of all but the worst.
    const centroid = Array.from({ length: n }, (_, i) => simplex.slice(0, n).reduce((s, p) => s + p.x[i]!, 0) / n);
    const reflected = combine(centroid, worst.x, -1);
    const fr = await at(reflected);
    if (fr < best.f) {
      const expanded = combine(centroid, worst.x, -2);
      const fe = await at(expanded);
      simplex[n] = fe < fr ? { x: expanded, f: fe } : { x: reflected, f: fr };
      continue;
    }
    if (fr < simplex[n - 1]!.f) {
      simplex[n] = { x: reflected, f: fr };
      continue;
    }
    // Contract: outside if the reflection beat the worst, inside if not.
    const outside = fr < worst.f;
    const contracted = combine(centroid, outside ? reflected : worst.x, 0.5);
    const fc = await at(contracted);
    if (fc < (outside ? fr : worst.f)) {
      simplex[n] = { x: contracted, f: fc };
      continue;
    }
    // Shrink everything toward the best.
    for (let i = 1; i <= n; i++) {
      const x = combine(best.x, simplex[i]!.x, 0.5);
      simplex[i] = { x, f: await at(x) };
    }
  }
  simplex.sort((p, q) => p.f - q.f);
  return { x: simplex[0]!.x, score: simplex[0]!.f, evaluations: count, truncated };
}
