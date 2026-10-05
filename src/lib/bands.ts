// The amateur bands, once, for every tool that offers a band to click.
//
// Edges are IARU Region 1 (South Africa is Region 1); national allocations differ at the
// margins and 4 m and 60 m exist only where a regulator has granted them. `at` is a
// frequency to stand for the band - where the traffic the club talks about is - not a
// band centre: 2 m is 145, not 145.0 exactly for any reason beyond custom, and 13 cm and
// 3 cm sit where the QO-100 uplink and the narrowband segment are.

export interface Band {
  name: string;
  /** Band edges, MHz. */
  from: number;
  to: number;
  /** A frequency to stand for the band, MHz. */
  at: number;
}

export const BANDS: Band[] = [
  { name: '160 m', from: 1.81, to: 2.0, at: 1.85 },
  { name: '80 m', from: 3.5, to: 3.8, at: 3.65 },
  { name: '60 m', from: 5.3515, to: 5.3665, at: 5.36 },
  { name: '40 m', from: 7.0, to: 7.2, at: 7.1 },
  { name: '30 m', from: 10.1, to: 10.15, at: 10.12 },
  { name: '20 m', from: 14.0, to: 14.35, at: 14.2 },
  { name: '17 m', from: 18.068, to: 18.168, at: 18.1 },
  { name: '15 m', from: 21.0, to: 21.45, at: 21.2 },
  { name: '12 m', from: 24.89, to: 24.99, at: 24.94 },
  { name: '10 m', from: 28.0, to: 29.7, at: 28.5 },
  { name: '6 m', from: 50.0, to: 52.0, at: 50.3 },
  { name: '4 m', from: 70.0, to: 70.5, at: 70.2 },
  { name: '2 m', from: 144.0, to: 146.0, at: 145.0 },
  { name: '70 cm', from: 430.0, to: 440.0, at: 435.0 },
  { name: '23 cm', from: 1240, to: 1300, at: 1296 },
  { name: '13 cm', from: 2300, to: 2450, at: 2400 },
  { name: '3 cm', from: 10000, to: 10500, at: 10368 },
];

/** The bands whose representative frequency is at or below a limit: a tool that stops at UHF asks for 450. */
export function bandsUpTo(maxMHz: number): Band[] {
  return BANDS.filter((b) => b.at <= maxMHz);
}

/** Name and frequency pairs, the shape the coil and balun tools' tables use. */
export function bandPairs(bands: Band[] = BANDS): [string, number][] {
  return bands.map((b) => [b.name, b.at]);
}

export function bandByName(name: string): Band | undefined {
  return BANDS.find((b) => b.name === name);
}
