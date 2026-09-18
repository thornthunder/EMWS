// Structured form of a nec2c report. Angles are in degrees and follow NEC's
// conventions: theta is measured down from +Z (zenith), phi anticlockwise from +X.

export interface Complex {
  re: number;
  im: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** One straight wire segment, after all geometry cards (GM, GX, GS...) were applied. */
export interface Segment {
  index: number;
  tag: number;
  center: Vec3;
  start: Vec3;
  end: Vec3;
  /** Metres. */
  length: number;
  /** Metres. */
  radius: number;
}

/** A driven segment, from the ANTENNA INPUT PARAMETERS table. */
export interface FeedPoint {
  tag: number;
  segment: number;
  voltage: Complex;
  current: Complex;
  /** Ohms. */
  impedance: Complex;
  admittance: Complex;
  powerW: number;
}

export interface SegmentCurrent {
  segment: number;
  tag: number;
  current: Complex;
  magnitude: number;
  phaseDeg: number;
}

export interface PowerBudget {
  inputW: number;
  radiatedW: number;
  structureLossW: number;
  networkLossW: number;
  efficiencyPct: number;
}

/** nec2c prints this for directions where there is no field at all. */
export const NO_FIELD_DB = -999.99;

export interface PatternPoint {
  thetaDeg: number;
  phiDeg: number;
  /** Gains in dBi. NO_FIELD_DB where the field is zero. */
  verticalDb: number;
  horizontalDb: number;
  totalDb: number;
  axialRatio: number;
  tiltDeg: number;
  /** 'LINEAR', 'RIGHT', 'LEFT', or '' where the field is zero. */
  sense: string;
}

/** The result of one RP card. */
export interface RadiationPattern {
  points: PatternPoint[];
}

export type Environment = 'free-space' | 'perfect-ground' | 'finite-ground';

export interface FrequencyResult {
  frequencyMHz: number;
  wavelengthM: number;
  environment: Environment;
  feeds: FeedPoint[];
  currents: SegmentCurrent[];
  power?: PowerBudget;
  patterns: RadiationPattern[];
}

export interface Nec2Report {
  comments: string[];
  segments: Segment[];
  frequencies: FrequencyResult[];
  /** Error lines nec2c wrote into the report, verbatim. */
  errors: string[];
}

/** Exactly what came back from the engine, before parsing. */
export interface Nec2RawResult {
  exitCode: number;
  /** Set when the engine crashed (a WebAssembly trap) rather than exiting; e.g. 'divide by zero'. */
  trap?: string;
  /** The full text report nec2c wrote. */
  output: string;
  stderr: string;
  elapsedMs: number;
}

export interface Nec2Run {
  raw: Nec2RawResult;
  report: Nec2Report;
}
