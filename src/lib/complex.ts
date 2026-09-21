// Complex arithmetic, in the plain {re, im} form used throughout EMWS.

export interface Complex {
  re: number;
  im: number;
}

export const ZERO: Complex = { re: 0, im: 0 };
export const ONE: Complex = { re: 1, im: 0 };
/** The imaginary unit. */
export const J: Complex = { re: 0, im: 1 };

export function complex(re: number, im = 0): Complex {
  return { re, im };
}

export function cAdd(a: Complex, b: Complex): Complex {
  return { re: a.re + b.re, im: a.im + b.im };
}

export function cSub(a: Complex, b: Complex): Complex {
  return { re: a.re - b.re, im: a.im - b.im };
}

export function cMul(a: Complex, b: Complex): Complex {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
}

export function cScale(a: Complex, k: number): Complex {
  return { re: a.re * k, im: a.im * k };
}

export function cDiv(a: Complex, b: Complex): Complex {
  if (!isFiniteComplex(b)) return { re: 0, im: 0 }; // anything over infinity
  const d = b.re * b.re + b.im * b.im;
  if (d === 0) return { re: Infinity, im: Infinity };
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
}

/** 1 / a. */
export function cInv(a: Complex): Complex {
  return cDiv(ONE, a);
}

export function cAbs(a: Complex): number {
  return Math.hypot(a.re, a.im);
}

/** Argument in radians. */
export function cArg(a: Complex): number {
  return Math.atan2(a.im, a.re);
}

export function cExp(a: Complex): Complex {
  const r = Math.exp(a.re);
  return { re: r * Math.cos(a.im), im: r * Math.sin(a.im) };
}

export function cCosh(a: Complex): Complex {
  return { re: Math.cosh(a.re) * Math.cos(a.im), im: Math.sinh(a.re) * Math.sin(a.im) };
}

export function cSinh(a: Complex): Complex {
  return { re: Math.sinh(a.re) * Math.cos(a.im), im: Math.cosh(a.re) * Math.sin(a.im) };
}

/**
 * Hyperbolic tangent. It runs off to infinity a quarter wave along a lossless line, so
 * transmission-line work uses cosh and sinh separately instead.
 */
export function cTanh(a: Complex): Complex {
  // tanh(x + jy) = (sinh 2x + j sin 2y) / (cosh 2x + cos 2y)
  const d = Math.cosh(2 * a.re) + Math.cos(2 * a.im);
  if (!Number.isFinite(d)) return { re: Math.sign(a.re) || 1, im: 0 };
  if (d === 0) return { re: 0, im: Math.sin(2 * a.im) >= 0 ? Infinity : -Infinity };
  return { re: Math.sinh(2 * a.re) / d, im: Math.sin(2 * a.im) / d };
}

export function isFiniteComplex(a: Complex): boolean {
  return Number.isFinite(a.re) && Number.isFinite(a.im);
}
