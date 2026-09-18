// Parses the text report written by nec2c into a structured Nec2Report.
//
// Every numeric field in nec2c's printf formats is separated by a literal space,
// so rows are tokenised on whitespace rather than by fixed column positions.

import type {
  FeedPoint,
  FrequencyResult,
  Nec2Report,
  PatternPoint,
  PowerBudget,
  Segment,
  SegmentCurrent,
} from './types';

const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

function tokens(line: string): string[] {
  const trimmed = line.trim();
  return trimmed === '' ? [] : trimmed.split(/\s+/);
}

function num(row: string[], i: number): number {
  const t = row[i];
  return t !== undefined && NUMBER.test(t) ? Number(t) : NaN;
}

function isDataRow(row: string[]): boolean {
  const first = row[0];
  return first !== undefined && NUMBER.test(first);
}

/**
 * Reads the table that follows a section heading: skips the column-header lines,
 * then collects rows until the first line that doesn't start with a number.
 * Returns the index of the last line consumed.
 */
function readTable(lines: string[], heading: number, onRow: (row: string[]) => void): number {
  let i = heading + 1;
  // Column headers: at most a handful of lines before the first numeric row.
  const limit = Math.min(lines.length, heading + 8);
  while (i < limit && !isDataRow(tokens(lines[i] ?? ''))) i++;
  if (i >= limit) return heading;
  for (; i < lines.length; i++) {
    const row = tokens(lines[i] ?? '');
    if (!isDataRow(row)) break;
    onRow(row);
  }
  return i - 1;
}

const DEG = Math.PI / 180;

function parseSegment(row: string[]): Segment | undefined {
  // SEG  X  Y  Z  LENGTH  ALPHA  BETA  RADIUS  I-  I  I+  TAG
  if (row.length < 12) return undefined;
  const center = { x: num(row, 1), y: num(row, 2), z: num(row, 3) };
  const length = num(row, 4);
  const alpha = num(row, 5) * DEG; // elevation above the XY plane
  const beta = num(row, 6) * DEG; // azimuth from +X
  const half = length / 2;
  const dx = Math.cos(alpha) * Math.cos(beta) * half;
  const dy = Math.cos(alpha) * Math.sin(beta) * half;
  const dz = Math.sin(alpha) * half;
  return {
    index: num(row, 0),
    tag: num(row, 11),
    center,
    start: { x: center.x - dx, y: center.y - dy, z: center.z - dz },
    end: { x: center.x + dx, y: center.y + dy, z: center.z + dz },
    length,
    radius: num(row, 7),
  };
}

function parseFeed(row: string[]): FeedPoint | undefined {
  // TAG SEG  V.re V.im  I.re I.im  Z.re Z.im  Y.re Y.im  POWER
  if (row.length < 11) return undefined;
  return {
    tag: num(row, 0),
    segment: num(row, 1),
    voltage: { re: num(row, 2), im: num(row, 3) },
    current: { re: num(row, 4), im: num(row, 5) },
    impedance: { re: num(row, 6), im: num(row, 7) },
    admittance: { re: num(row, 8), im: num(row, 9) },
    powerW: num(row, 10),
  };
}

function parseCurrent(row: string[]): SegmentCurrent | undefined {
  // SEG TAG  X Y Z  LENGTH  I.re I.im  MAGN PHASE
  if (row.length < 10) return undefined;
  return {
    segment: num(row, 0),
    tag: num(row, 1),
    current: { re: num(row, 6), im: num(row, 7) },
    magnitude: num(row, 8),
    phaseDeg: num(row, 9),
  };
}

function parsePatternPoint(row: string[]): PatternPoint | undefined {
  // THETA PHI  VERT HORIZ TOTAL  AXIAL TILT [SENSE]  E(theta) mag/phase  E(phi) mag/phase
  // SENSE is blank where the field is zero, so the row has 11 or 12 tokens.
  if (row.length < 11) return undefined;
  const senseToken = row[7];
  const sense = senseToken !== undefined && !NUMBER.test(senseToken) ? senseToken : '';
  return {
    thetaDeg: num(row, 0),
    phiDeg: num(row, 1),
    verticalDb: num(row, 2),
    horizontalDb: num(row, 3),
    totalDb: num(row, 4),
    axialRatio: num(row, 5),
    tiltDeg: num(row, 6),
    sense,
  };
}

function labelledValue(line: string): number {
  const m = /[=:]\s*([-+]?[\d.]+(?:[eE][-+]?\d+)?)/.exec(line);
  return m?.[1] !== undefined ? Number(m[1]) : NaN;
}

export function parseNec2Output(output: string): Nec2Report {
  const lines = output.split(/\r?\n/);
  const report: Nec2Report = { comments: [], segments: [], frequencies: [], errors: [] };
  let current: FrequencyResult | undefined;
  let inComments = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    if (/\bERROR\b/.test(line)) report.errors.push(line.trim());

    if (line.includes('- COMMENTS -')) {
      inComments = true;
      continue;
    }
    if (line.includes('STRUCTURE SPECIFICATION')) {
      inComments = false;
      continue;
    }
    if (inComments) {
      if (line.trim() !== '') report.comments.push(line.trim());
      continue;
    }

    if (line.includes('SEGMENTATION DATA')) {
      i = readTable(lines, i, (row) => {
        const s = parseSegment(row);
        if (s) report.segments.push(s);
      });
      continue;
    }

    if (line.includes('FREQUENCY :')) {
      current = {
        frequencyMHz: labelledValue(line),
        wavelengthM: labelledValue(lines[i + 1] ?? ''),
        environment: 'free-space',
        feeds: [],
        currents: [],
        patterns: [],
      };
      report.frequencies.push(current);
      continue;
    }

    if (!current) continue;
    const freq = current;

    if (line.includes('PERFECT GROUND')) {
      freq.environment = 'perfect-ground';
    } else if (line.includes('FINITE GROUND')) {
      freq.environment = 'finite-ground';
    } else if (line.includes('ANTENNA INPUT PARAMETERS')) {
      i = readTable(lines, i, (row) => {
        const f = parseFeed(row);
        if (f) freq.feeds.push(f);
      });
    } else if (line.includes('CURRENTS AND LOCATION')) {
      i = readTable(lines, i, (row) => {
        const c = parseCurrent(row);
        if (c) freq.currents.push(c);
      });
    } else if (line.includes('POWER BUDGET')) {
      const budget: PowerBudget = {
        inputW: labelledValue(lines[i + 1] ?? ''),
        radiatedW: labelledValue(lines[i + 2] ?? ''),
        structureLossW: labelledValue(lines[i + 3] ?? ''),
        networkLossW: labelledValue(lines[i + 4] ?? ''),
        efficiencyPct: labelledValue(lines[i + 5] ?? ''),
      };
      freq.power = budget;
      i += 5;
    } else if (line.includes('RADIATION PATTERNS')) {
      const points: PatternPoint[] = [];
      i = readTable(lines, i, (row) => {
        const p = parsePatternPoint(row);
        if (p) points.push(p);
      });
      if (points.length > 0) freq.patterns.push({ points });
    }
  }

  return report;
}
