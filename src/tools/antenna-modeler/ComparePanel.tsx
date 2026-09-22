// Modelled against measured: the check that says whether a model is worth anything.
//
// A measurement of the real antenna - from a NanoVNA on the port, or a .s1p it saved -
// is laid over the modelled sweep, and the two impedances are put side by side at the
// frequency being looked at. Where they disagree is where the model is wrong: a
// resonance shifted by the wire's insulation, a ground the model was too kind about, a
// coax the model did not know was there.

import { type ChangeEvent, useRef, useState } from 'react';
import { type Complex } from '../../lib/complex';
import { formatImpedance, swr } from '../../lib/rf';
import { type MeasuredPoint, TouchstoneError, parseTouchstone } from '../../lib/touchstone';
import { MeasureWithVna } from '../../ui/MeasureWithVna';

export interface Measurement {
  source: string;
  takenAt: string;
  points: MeasuredPoint[];
}

export interface ComparePanelProps {
  measurement: Measurement | undefined;
  onMeasurement: (m: Measurement | undefined) => void;
  /** The modelled result at the frequency being looked at. */
  modelled: { fMHz: number; z: Complex } | undefined;
  z0: number;
  sweep: { startMHz: number; stopMHz: number };
}

/** The measured impedance at a frequency, straight lines between the measured points. */
export function measuredAt(points: readonly MeasuredPoint[], fMHz: number): Complex | undefined {
  if (points.length === 0) return undefined;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (fMHz < first.fMHz * 0.999 || fMHz > last.fMHz * 1.001) return undefined;
  if (fMHz <= first.fMHz) return first.z;
  if (fMHz >= last.fMHz) return last.z;
  let hi = 1;
  while (points[hi]!.fMHz < fMHz) hi++;
  const a = points[hi - 1]!;
  const b = points[hi]!;
  const t = (fMHz - a.fMHz) / (b.fMHz - a.fMHz);
  return { re: a.z.re + (b.z.re - a.z.re) * t, im: a.z.im + (b.z.im - a.z.im) * t };
}

export function ComparePanel({ measurement, onMeasurement, modelled, z0, sweep }: ComparePanelProps) {
  const [error, setError] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);

  const take = (points: MeasuredPoint[], source: string) => {
    const sorted = [...points].sort((a, b) => a.fMHz - b.fMHz);
    onMeasurement({ source, takenAt: new Date().toISOString(), points: sorted });
    setError(undefined);
  };

  const open = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      take(parseTouchstone(await file.text()).points, file.name);
    } catch (problem) {
      setError(problem instanceof TouchstoneError ? problem.message : String(problem));
    }
  };

  const at = measurement && modelled ? measuredAt(measurement.points, modelled.fMHz) : undefined;

  return (
    <details className="panel compare" open={measurement !== undefined}>
      <summary>Compare with the real antenna</summary>
      <p className="muted">
        A model is a claim. Measure the antenna you built - with a NanoVNA on the port, or a <code>.s1p</code> it saved -
        and see where the two part company.
      </p>
      {measurement ? (
        <>
          <p className="compare-source">
            <strong>{measurement.source}</strong>: {measurement.points.length} points,{' '}
            {measurement.points[0]!.fMHz.toFixed(3)}–{measurement.points[measurement.points.length - 1]!.fMHz.toFixed(3)} MHz,
            taken {new Date(measurement.takenAt).toLocaleTimeString()}.{' '}
            <button type="button" className="link" onClick={() => onMeasurement(undefined)}>
              Clear
            </button>
          </p>
          {modelled && (
            <table className="compare-table">
              <caption className="visually-hidden">Modelled against measured at {modelled.fMHz} MHz</caption>
              <thead>
                <tr>
                  <th scope="col">At {Number(modelled.fMHz.toFixed(4))} MHz</th>
                  <th scope="col">Modelled</th>
                  <th scope="col">Measured</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Impedance</th>
                  <td>{formatImpedance(modelled.z)} Ω</td>
                  <td>{at ? `${formatImpedance(at)} Ω` : 'outside the measurement'}</td>
                </tr>
                <tr>
                  <th scope="row">SWR ({z0} Ω)</th>
                  <td>{swr(modelled.z, z0).toFixed(2)} : 1</td>
                  <td>{at ? `${swr(at, z0).toFixed(2)} : 1` : '—'}</td>
                </tr>
              </tbody>
            </table>
          )}
        </>
      ) : null}
      <div className="button-row">
        <button type="button" className="small" onClick={() => fileInput.current?.click()}>
          Open .s1p
        </button>
        <input ref={fileInput} type="file" accept=".s1p,.txt,text/plain" hidden onChange={open} />
      </div>
      <MeasureWithVna startMHz={sweep.startMHz} stopMHz={sweep.stopMHz} action="Measure the antenna" onMeasured={take} />
      {error && <p className="alert-inline">{error}</p>}
    </details>
  );
}
