// Intermodulation products: where the mixes of several transmitters land, and which of
// them fall on a frequency someone is trying to receive.
//
// A nonlinearity fed f1, f2, ... produces every  a1 f1 + a2 f2 + ...  with integer
// coefficients; the ORDER of a product is |a1| + |a2| + ...  The odd orders with
// coefficients of mixed sign (2f1 - f2, 3f1 - 2f2) are the ones that land back near the
// inputs, which is why a site with two transmitters a few hundred kHz apart can put a
// product on a receiver's channel. The even orders (f1 + f2, f2 - f1) fall far away and
// matter to wideband front ends. Harmonics (3 f1) are the one-frequency case.
//
// Levels are not computed except for the one closed form everybody uses: for two equal
// tones at P into a stage with an input intercept point IIP3, the third-order product
// sits at  3 P - 2 IIP3 . That is an ideal cubic nonlinearity, so it is a guide to how
// fast a product grows (3 dB per dB), not a measurement of any particular radio.
//
// Public domain (The Unlicense). By ZR1JT.

export interface ImdProduct {
  /** |a1| + |a2| + ... */
  order: number;
  /** One integer per input frequency; the product is their weighted sum. */
  coefficients: number[];
  fMHz: number;
  /** 'harmonic' when only one coefficient is non-zero. */
  kind: 'mix' | 'harmonic';
}

/** Every product up to the given order, each once, at a positive frequency, in order of order then frequency. */
export function intermodProducts(inputsMHz: readonly number[], maxOrder: number): ImdProduct[] {
  const n = inputsMHz.length;
  if (n === 0 || !(maxOrder >= 2)) return [];
  const out: ImdProduct[] = [];
  const seen = new Set<string>();
  const coefficients = new Array<number>(n).fill(0);
  const walk = (i: number, budget: number) => {
    if (i === n) {
      const order = coefficients.reduce((sum, c) => sum + Math.abs(c), 0);
      if (order < 2) return;
      let f = coefficients.reduce((sum, c, k) => sum + c * inputsMHz[k]!, 0);
      let signed = coefficients.slice();
      // a f1 - b f2 and b f2 - a f1 are the same product: keep the positive one.
      if (f < 0) {
        f = -f;
        signed = signed.map((c) => -c);
      }
      if (!(f > 0)) return;
      const key = signed.join(',');
      if (seen.has(key)) return;
      seen.add(key);
      const nonZero = signed.filter((c) => c !== 0).length;
      out.push({ order, coefficients: signed, fMHz: f, kind: nonZero === 1 ? 'harmonic' : 'mix' });
      return;
    }
    for (let c = -budget; c <= budget; c++) {
      coefficients[i] = c;
      walk(i + 1, budget - Math.abs(c));
    }
    coefficients[i] = 0;
  };
  walk(0, Math.floor(maxOrder));
  return out.sort((a, b) => a.order - b.order || a.fMHz - b.fMHz);
}

/** "2A − B", with the inputs named A, B, C ... and the added terms written first. */
export function productLabel(coefficients: readonly number[]): string {
  const terms = coefficients.map((c, i) => ({ c, name: String.fromCharCode(65 + i) })).filter((t) => t.c !== 0);
  const ordered = [...terms.filter((t) => t.c > 0), ...terms.filter((t) => t.c < 0)];
  return ordered
    .map((t, k) => {
      const size = Math.abs(t.c) === 1 ? '' : String(Math.abs(t.c));
      const sign = t.c < 0 ? '−' : '+';
      return (k === 0 ? (t.c < 0 ? '−' : '') : ` ${sign} `) + size + t.name;
    })
    .join('');
}

export interface ImdHit {
  product: ImdProduct;
  /** Which protected frequency it lands on (index into the list given). */
  receiver: number;
  /** How far off it is, kHz, signed: product minus receiver. */
  offsetKHz: number;
}

/** The products within +/- tolerance of any protected frequency, nearest first. */
export function intermodHits(products: readonly ImdProduct[], receiversMHz: readonly number[], toleranceKHz: number): ImdHit[] {
  const hits: ImdHit[] = [];
  for (const product of products) {
    receiversMHz.forEach((rx, receiver) => {
      const offsetKHz = (product.fMHz - rx) * 1000;
      if (Math.abs(offsetKHz) <= toleranceKHz + 1e-9) hits.push({ product, receiver, offsetKHz });
    });
  }
  return hits.sort((a, b) => Math.abs(a.offsetKHz) - Math.abs(b.offsetKHz) || a.product.order - b.product.order);
}

/** Third-order product level for two equal tones at `toneDbm` into a stage with input intercept `iip3Dbm`: 3 P - 2 IIP3. */
export function thirdOrderProductDbm(toneDbm: number, iip3Dbm: number): number {
  return 3 * toneDbm - 2 * iip3Dbm;
}

/** The two-tone level at which the third-order product just reaches a given floor: (floor + 2 IIP3) / 3. */
export function toneForProductAt(floorDbm: number, iip3Dbm: number): number {
  return (floorDbm + 2 * iip3Dbm) / 3;
}
