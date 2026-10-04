// Painting a field into pixels.
//
// A signed field (Ez) gets a diverging map: the suite's blue series colour through the
// page's surface colour to its orange-red one, so zero is the paper and the two signs are
// two hues a colour-blind reader can still tell apart. A magnitude (the envelope) gets one
// hue, light to dark. Conductors are drawn in ink and dielectrics tinted, so the picture
// says where the objects are without a second layer.

import type { Raster } from './scene';

export type Rgb = [number, number, number];

/** The suite's series tokens, as numbers: --series-2 (blue) and --series-3 (orange-red), --series-1 (green). */
export const NEGATIVE: Rgb = [11, 110, 168];
export const POSITIVE: Rgb = [193, 80, 10];
export const MAGNITUDE: Rgb = [10, 122, 82];

/** '#rrggbb' or 'rgb(r, g, b)' from a computed style; undefined for anything else. */
export function parseCssColour(text: string): Rgb | undefined {
  const hex = /^#([0-9a-f]{6})$/i.exec(text.trim());
  if (hex) {
    const v = Number.parseInt(hex[1]!, 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(text.trim());
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return undefined;
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** t from -1 to 1; a gentle curve brings the weak outer waves up so they are not lost in the paper. */
export function diverging(t: number, surface: Rgb): Rgb {
  const clamped = Math.max(-1, Math.min(1, t));
  const strength = Math.abs(clamped) ** 0.6;
  return mix(surface, clamped < 0 ? NEGATIVE : POSITIVE, strength);
}

/** t from 0 to 1. */
export function sequential(t: number, surface: Rgb): Rgb {
  return mix(surface, MAGNITUDE, Math.max(0, Math.min(1, t)) ** 0.6);
}

export type PaintMode = 'field' | 'envelope';

/**
 * Writes the world (inside the PML) into an RGBA buffer of innerNx x innerNy pixels, row 0
 * at the top of the world. `values` is Ez for the field, or its running envelope.
 */
export function paintField(pixels: Uint8ClampedArray, raster: Raster, values: Float32Array, scale: number, mode: PaintMode, surface: Rgb, ink: Rgb): void {
  const { grid, pec, epsr } = raster;
  const { nx, pml, innerNx, innerNy } = grid;
  const inverse = scale > 0 ? 1 / scale : 0;
  let p = 0;
  for (let row = 0; row < innerNy; row++) {
    const j = pml + (innerNy - 1 - row);
    for (let col = 0; col < innerNx; col++) {
      const k = pml + col + j * nx;
      let colour: Rgb;
      if (pec[k]) colour = ink;
      else {
        const v = values[k]! * inverse;
        colour = mode === 'field' ? diverging(v, surface) : sequential(v, surface);
        const er = epsr[k]!;
        if (er > 1) colour = mix(colour, ink, Math.min(0.35, 0.12 * (er - 1)));
      }
      pixels[p] = colour[0];
      pixels[p + 1] = colour[1];
      pixels[p + 2] = colour[2];
      pixels[p + 3] = 255;
      p += 4;
    }
  }
}
