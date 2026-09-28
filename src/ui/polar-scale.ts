// The ARRL log-periodic gain scale, shared by the polar plots and the 3-D pattern: each
// 2 dB down shrinks the radius by a factor of 0.89, and nothing is drawn below the floor.

export const POLAR_FLOOR_DB = -60;

/** Radius on the ARRL log scale, as a share of the outer ring (1 = the peak). */
export function arrlRadius(relativeDb: number): number {
  if (relativeDb <= POLAR_FLOOR_DB) return 0;
  return Math.pow(0.89, -Math.min(relativeDb, 0) / 2);
}
