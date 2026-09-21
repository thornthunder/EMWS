// Polar gain plot on the ARRL log-periodic scale - the one in the ARRL Antenna Book
// and EZNEC, where each 2 dB step shrinks the radius by a factor of 0.89. It keeps the
// main lobe readable while still showing minor lobes 30 dB down.

import type { PatternCut } from '../engine/nec2/pattern';
import { elevationOfTheta, mainLobe } from '../engine/nec2/pattern';
import { NO_FIELD_DB } from '../engine/nec2/types';

const SIZE = 340;
const C = SIZE / 2;
const R = 128;
const RINGS_DB = [0, -3, -10, -20, -30];
const FLOOR_DB = -60;

function radiusFor(relativeDb: number): number {
  if (relativeDb <= FLOOR_DB) return 0;
  return R * Math.pow(0.89, -Math.min(relativeDb, 0) / 2);
}

/** Plot angle in degrees, anticlockwise from "3 o'clock". */
function plotAngle(cut: PatternCut, thetaDeg: number, phiDeg: number): number {
  // Azimuth: phi as on a map with +X to the right. Elevation: zenith up, horizon either side.
  return cut.kind === 'azimuth' ? phiDeg : 90 - thetaDeg;
}

function toXY(radius: number, angleDeg: number): [number, number] {
  const a = (angleDeg * Math.PI) / 180;
  return [C + radius * Math.cos(a), C - radius * Math.sin(a)];
}

function spokeLabel(cut: PatternCut, angleDeg: number): string {
  if (cut.kind === 'azimuth') return `${angleDeg}°`;
  // Elevation angle above (or below) the horizon.
  const a = ((angleDeg % 360) + 360) % 360;
  const elevation = a <= 90 ? a : a <= 270 ? 180 - a : a - 360;
  return `${elevation}°`;
}

export interface PolarPlotProps {
  cut: PatternCut;
  title: string;
}

export function PolarPlot({ cut, title }: PolarPlotProps) {
  const peak = mainLobe(cut.points);
  if (!peak) return <p className="muted">No field in this cut.</p>;

  const path = cut.points
    .map((p, i) => {
      const relative = p.totalDb <= NO_FIELD_DB ? FLOOR_DB : p.totalDb - peak.totalDb;
      const [x, y] = toXY(radiusFor(relative), plotAngle(cut, p.thetaDeg, p.phiDeg));
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const first = cut.points[0];
  const last = cut.points[cut.points.length - 1];
  const span =
    first && last
      ? Math.abs(plotAngle(cut, last.thetaDeg, last.phiDeg) - plotAngle(cut, first.thetaDeg, first.phiDeg))
      : 0;
  // A partial sweep (an upper hemisphere over ground, say) is closed through the centre.
  const closed = span >= 360 ? `${path} Z` : `${path} L${C},${C} Z`;

  const [peakX, peakY] = toXY(R, plotAngle(cut, peak.thetaDeg, peak.phiDeg));
  const spokes = Array.from({ length: 12 }, (_, i) => i * 30);

  return (
    <figure className="plot">
      <figcaption>{title}</figcaption>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={`${title}. Peak ${peak.totalDb} dBi.`}>
        {RINGS_DB.map((db) => (
          <circle key={db} cx={C} cy={C} r={radiusFor(db)} className={db === 0 ? 'ring ring-outer' : 'ring'} />
        ))}
        {spokes.map((a) => {
          const [x, y] = toXY(R, a);
          const [lx, ly] = toXY(R + 17, a);
          return (
            <g key={a}>
              <line x1={C} y1={C} x2={x} y2={y} className="spoke" />
              <text x={lx} y={ly} className="spoke-label" textAnchor="middle" dominantBaseline="central">
                {spokeLabel(cut, a)}
              </text>
            </g>
          );
        })}
        {RINGS_DB.slice(1).map((db) => (
          <text key={db} x={C + 3} y={C - radiusFor(db) - 2} className="ring-label">
            {db}
          </text>
        ))}
        <path d={closed} className="lobe" />
        <line x1={C} y1={C} x2={peakX} y2={peakY} className="peak-line" />
      </svg>
      <p className="plot-note">
        Outer ring = {peak.totalDb.toFixed(2)} dBi, at{' '}
        {cut.kind === 'azimuth'
          ? `azimuth ${peak.phiDeg}°`
          : `${elevationOfTheta(peak.thetaDeg)}° elevation`}
      </p>
    </figure>
  );
}
