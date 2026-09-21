// Reads Touchstone .s1p files - what a NanoVNA (or any VNA) writes when you save a
// one-port sweep. Only the one-port case is handled; that is what a load is.
//
// Format (Touchstone 1.1): comment lines start with '!', one option line starts with '#'
//     # <frequency unit> <parameter> <format> R <reference impedance>
// e.g. "# MHZ S RI R 50", then rows of: frequency, first number, second number.

import { type Complex, cAbs, cDiv } from './complex';

export interface MeasuredPoint {
  fMHz: number;
  /** Impedance in ohms. */
  z: Complex;
  /** Reflection coefficient against the file's reference impedance. */
  gamma: Complex;
}

export interface TouchstoneFile {
  points: MeasuredPoint[];
  /** The file's reference impedance, in ohms. */
  referenceZ0: number;
  comments: string[];
}

const FREQUENCY_SCALE: Record<string, number> = { HZ: 1e-6, KHZ: 1e-3, MHZ: 1, GHZ: 1e3 };

export class TouchstoneError extends Error {}

/** Impedance from a reflection coefficient: Z = Z0 (1 + Γ) / (1 − Γ). */
export function impedanceFromGamma(gamma: Complex, z0: number): Complex {
  return cDiv({ re: z0 * (1 + gamma.re), im: z0 * gamma.im }, { re: 1 - gamma.re, im: -gamma.im });
}

/** Reflection coefficient of an impedance: Γ = (Z − Z0) / (Z + Z0). */
export function gammaFromImpedance(z: Complex, z0: number): Complex {
  return cDiv({ re: z.re - z0, im: z.im }, { re: z.re + z0, im: z.im });
}

export function standingWaveRatio(gamma: Complex): number {
  const rho = cAbs(gamma);
  return rho >= 1 ? Infinity : (1 + rho) / (1 - rho);
}

export function parseTouchstone(text: string): TouchstoneFile {
  const comments: string[] = [];
  // Touchstone's documented defaults, used when a file has no option line.
  let scale = FREQUENCY_SCALE.GHZ!;
  let format = 'MA';
  let parameter = 'S';
  let referenceZ0 = 50;
  let sawOptions = false;
  const points: MeasuredPoint[] = [];

  for (const raw of text.split(/\r\n|\r|\n/)) {
    const withoutComment = raw.split('!');
    const comment = withoutComment.slice(1).join('!').trim();
    if (comment !== '') comments.push(comment);
    const line = (withoutComment[0] ?? '').trim();
    if (line === '') continue;

    if (line.startsWith('#')) {
      if (sawOptions) continue; // only the first option line counts
      sawOptions = true;
      const tokens = line.slice(1).trim().toUpperCase().split(/[\s,]+/).filter(Boolean);
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]!;
        if (token in FREQUENCY_SCALE) scale = FREQUENCY_SCALE[token]!;
        else if (['S', 'Y', 'Z', 'G', 'H'].includes(token)) parameter = token;
        else if (['MA', 'DB', 'RI'].includes(token)) format = token;
        else if (token === 'R') {
          const value = Number(tokens[++i]);
          if (Number.isFinite(value) && value > 0) referenceZ0 = value;
        }
      }
      if (parameter !== 'S' && parameter !== 'Z') {
        throw new TouchstoneError(`This file holds ${parameter} parameters; EMWS reads S or Z.`);
      }
      continue;
    }

    const fields = line.split(/[\s,]+/).filter(Boolean).map(Number);
    if (fields.length < 3 || fields.some((v) => !Number.isFinite(v))) {
      throw new TouchstoneError(`Cannot read this line as "frequency value value": ${line}`);
    }
    const [f = 0, first = 0, second = 0] = fields;
    const value = readPair(first, second, format);
    const z = parameter === 'Z' ? value : impedanceFromGamma(value, referenceZ0);
    const gamma = parameter === 'Z' ? gammaFromImpedance(value, referenceZ0) : value;
    points.push({ fMHz: f * scale, z, gamma });
  }

  if (points.length === 0) throw new TouchstoneError('The file holds no measurements.');
  points.sort((a, b) => a.fMHz - b.fMHz);
  return { points, referenceZ0, comments };
}

function readPair(first: number, second: number, format: string): Complex {
  if (format === 'RI') return { re: first, im: second };
  // MA is linear magnitude and angle in degrees; DB is 20·log10 magnitude and angle.
  const magnitude = format === 'DB' ? 10 ** (first / 20) : first;
  const radians = (second * Math.PI) / 180;
  return { re: magnitude * Math.cos(radians), im: magnitude * Math.sin(radians) };
}
