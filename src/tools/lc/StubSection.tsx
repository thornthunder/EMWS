// The "Stubs & cavities" tab: a coax stub notch, or a band-pass of quarter-wave resonators,
// and the measurement of the one you built laid over the design.
//
// Public domain (The Unlicense). By ZR1JT.

import { useState } from 'react';
import type { TransmissionPoint } from '../../lib/vna/transmission';
import { s21Db } from '../../lib/vna/transmission';
import { MeasureTransmission } from '../../ui/MeasureTransmission';
import { NumberField } from '../../ui/NumberField';
import { XYChart } from '../../ui/XYChart';
import { formatSi } from '../smith-chart/units';
import { type Cable, CATALOGUE, cableById, catalogueGroups } from '../toolbox/coax';
import { savedDatasheetCable } from '../toolbox/model';
import { MAX_ORDER, MIN_ORDER } from './filter';
import type { StubDesign } from './model';
import { STUB_KINDS, bandpassResponse, cavityLine, db, designBandpass, linearFrequencies, stubLengthM, stubResponse } from './stub';

const FLOOR_DB = -80;

function cableOf(id: string): Cable {
  return id === 'datasheet' ? savedDatasheetCable() : (cableById(id) ?? CATALOGUE[0]!);
}

const mm = (m: number) => `${Math.round(m * 1000)} mm`;

export function StubSection({ stub, onChange }: { stub: StubDesign; onChange: (patch: Partial<StubDesign>) => void }) {
  const [hover, setHover] = useState<number>();
  const [measured, setMeasured] = useState<{ points: TransmissionPoint[]; source: string }>();
  const cable = cableOf(stub.cableId);
  const notch = stub.mode === 'notch';

  // ---- the notch ----
  const lengthM = stubLengthM(cable, stub.kind, stub.fMHz);
  const passMHz = stub.kind === 'shorted-quarter' ? stub.fMHz : stub.kind === 'open-quarter' ? 2 * stub.fMHz : stub.fMHz / 2;
  const notchMHz = stub.kind === 'shorted-quarter' ? 2 * stub.fMHz : stub.fMHz;
  const notchFreqs = linearFrequencies(Math.min(passMHz, notchMHz) * 0.5, Math.max(passMHz, notchMHz) * 1.5, 401);

  // ---- the band-pass ----
  const resonatorLine = stub.resonator === 'cavity' ? cavityLine(stub.cavityZ0, stub.cavityQ, stub.centreMHz) : cable;
  const spec = { centreMHz: stub.centreMHz, bandwidthMHz: stub.bandwidthMHz, order: stub.order, family: stub.family, rippleDb: stub.rippleDb, z0: 50 };
  const bp = notch ? undefined : designBandpass(spec, resonatorLine);
  const span = Math.max(stub.bandwidthMHz * 4, stub.centreMHz * 0.04);
  const bpFreqs = linearFrequencies(stub.centreMHz - span, stub.centreMHz + span, 401);

  const freqs = notch ? notchFreqs : bpFreqs;
  const response = freqs.map((f) => (notch ? db(stubResponse(cable, stub.kind, lengthM, f)) : db(bandpassResponse(bp!, resonatorLine, f))));
  const at = (f: number) => (notch ? db(stubResponse(cable, stub.kind, lengthM, f)) : db(bandpassResponse(bp!, resonatorLine, f)));
  const wide = !notch && stub.bandwidthMHz / stub.centreMHz > 0.1;

  return (
    <div className="modeler">
      <aside className="panel">
        <section className="form-section">
          <h2>What to make</h2>
          <div className="segmented" role="radiogroup" aria-label="Notch or band-pass">
            <button type="button" role="radio" aria-checked={notch} onClick={() => onChange({ mode: 'notch' })}>
              A stub notch
            </button>
            <button type="button" role="radio" aria-checked={!notch} onClick={() => onChange({ mode: 'bandpass' })}>
              A band-pass
            </button>
          </div>
          {notch ? (
            <>
              <label className="field">
                <span className="field-label">Stub</span>
                <select value={stub.kind} onChange={(e) => onChange({ kind: e.target.value as StubDesign['kind'] })}>
                  {STUB_KINDS.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label} - {k.does}
                    </option>
                  ))}
                </select>
              </label>
              <NumberField label="Cut for" value={stub.fMHz} above={0} unit="MHz" onCommit={(v) => onChange({ fMHz: v })} />
            </>
          ) : (
            <>
              <div className="field-row">
                <NumberField label="Centre" value={stub.centreMHz} above={0} unit="MHz" onCommit={(v) => onChange({ centreMHz: v })} />
                <NumberField label="Bandwidth" value={stub.bandwidthMHz} above={0} unit="MHz" onCommit={(v) => onChange({ bandwidthMHz: v })} />
              </div>
              <div className="field-row">
                <NumberField label="Resonators" value={stub.order} min={MIN_ORDER} integer onCommit={(v) => onChange({ order: Math.max(MIN_ORDER, Math.min(MAX_ORDER, Math.round(v))) })} />
                <label className="field">
                  <span className="field-label">Shape</span>
                  <select value={stub.family} onChange={(e) => onChange({ family: e.target.value === 'chebyshev' ? 'chebyshev' : 'butterworth' })}>
                    <option value="butterworth">Butterworth (flat)</option>
                    <option value="chebyshev">Chebyshev (steeper, rippled)</option>
                  </select>
                </label>
              </div>
              {stub.family === 'chebyshev' && (
                <label className="field">
                  <span className="field-label">Passband ripple</span>
                  <select value={stub.rippleDb} onChange={(e) => onChange({ rippleDb: Number(e.target.value) })}>
                    {[0.01, 0.1, 0.5].map((r) => (
                      <option key={r} value={r}>
                        {r} dB
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="field">
                <span className="field-label">Resonators made of</span>
                <select value={stub.resonator} onChange={(e) => onChange({ resonator: e.target.value === 'cable' ? 'cable' : 'cavity' })}>
                  <option value="cavity">Cavities or trough line (give their Q)</option>
                  <option value="cable">Coax stubs, the cable below</option>
                </select>
              </label>
              {stub.resonator === 'cavity' && (
                <div className="field-row">
                  <NumberField label="Line impedance" value={stub.cavityZ0} above={0} unit="Ω" onCommit={(v) => onChange({ cavityZ0: v })} />
                  <NumberField label="Unloaded Q" value={stub.cavityQ} above={0} onCommit={(v) => onChange({ cavityQ: v })} />
                </div>
              )}
            </>
          )}
          {(notch || stub.resonator === 'cable') && (
            <label className="field">
              <span className="field-label">Cable</span>
              <select value={stub.cableId} onChange={(e) => onChange({ cableId: e.target.value })}>
                {catalogueGroups().map(({ group, cables }) => (
                  <optgroup key={group} label={group}>
                    {cables.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
                <option value="datasheet">{savedDatasheetCable().name} - your datasheet cable, from the RF toolbox</option>
              </select>
            </label>
          )}
          {(notch || stub.resonator === 'cable') && cable.loss.kind === 'geometry' && (
            <p className="muted">The catalogue loss is computed, a floor: a real braided cable loses a little more, so a real notch is a little shallower.</p>
          )}
        </section>
      </aside>

      <div className="workspace">
        {notch ? (
          <section className="panel">
            <h2 className="results-title">
              {STUB_KINDS.find((k) => k.id === stub.kind)!.label}, {mm(lengthM)} of {cable.name.replace(/ \(.*\)$/, '')}
            </h2>
            <p className="build-card stub-build">
              Cut <strong>{mm(lengthM)}</strong> of {cable.name.replace(/ \(.*\)$/, '')} (velocity factor {cable.velocityFactor.toFixed(2)}),{' '}
              {stub.kind === 'open-quarter' ? 'leave the far end open (cut clean, nothing touching)' : 'short the far end: centre to braid, as short as you can'}, and
              hang it across the feed line at a T. The T and its connector add length: cut it a few millimetres long and trim, watching the
              notch on a NanoVNA.
            </p>
            <dl className="summary">
              <div>
                <dt>Notch at {notchMHz.toFixed(2)} MHz</dt>
                <dd>
                  {at(notchMHz).toFixed(1)} dB<small>as deep as the cable's loss allows</small>
                </dd>
              </div>
              <div>
                <dt>Passes {passMHz.toFixed(2)} MHz</dt>
                <dd>
                  {at(passMHz).toFixed(2)} dB<small>{passMHz < notchMHz ? 'the frequency it is for' : 'twice the notch'}</small>
                </dd>
              </div>
              <div>
                <dt>1 % from the notch</dt>
                <dd>
                  {at(notchMHz * 1.01).toFixed(1)} dB<small>a plain stub's notch is broad</small>
                </dd>
              </div>
            </dl>
          </section>
        ) : (
          <section className="panel">
            <h2 className="results-title">
              {stub.order}-resonator {stub.family === 'butterworth' ? 'Butterworth' : `Chebyshev (${stub.rippleDb} dB)`} band-pass, {stub.centreMHz} MHz ±{' '}
              {stub.bandwidthMHz / 2} MHz
            </h2>
            <table className="band-table parts-table">
              <thead>
                <tr>
                  <th scope="col">Part</th>
                  <th scope="col">Value</th>
                  <th scope="col">Build it</th>
                </tr>
              </thead>
              <tbody>
                {bp!.couplingF.map((c, i) => (
                  <tr key={`c${i}`}>
                    <th scope="row">C{i === 0 ? 'in' : i === bp!.couplingF.length - 1 ? 'out' : `${i}${i + 1}`}</th>
                    <td>{formatSi(c, 'F', 3)}</td>
                    <td>
                      {i === 0
                        ? 'series, from the input connector to resonator 1'
                        : i === bp!.couplingF.length - 1
                          ? `series, from resonator ${i} to the output connector`
                          : `series, between resonators ${i} and ${i + 1}`}
                    </td>
                  </tr>
                ))}
                {bp!.resonatorM.map((len, j) => (
                  <tr key={`r${j}`}>
                    <th scope="row">Resonator {j + 1}</th>
                    <td>{mm(len)}</td>
                    <td>
                      shorted at the far end, {bp!.resonatorDeg[j]!.toFixed(1)}° long - shorter than a quarter wave, to tune out its capacitors
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted">
              Capacitors of a picofarad or less are made, not bought: a short overlap of wire or a small trimmer. Tune each resonator for
              the best passband while measuring - the lengths are where to start.
            </p>
            <dl className="summary">
              <div>
                <dt>At {stub.centreMHz} MHz</dt>
                <dd>
                  {at(stub.centreMHz).toFixed(2)} dB<small>{stub.resonator === 'cavity' ? `resonators of Q ${stub.cavityQ}` : 'coax-stub resonators'}</small>
                </dd>
              </div>
              <div>
                <dt>At the band edges</dt>
                <dd>
                  {at(stub.centreMHz - stub.bandwidthMHz / 2).toFixed(2)} / {at(stub.centreMHz + stub.bandwidthMHz / 2).toFixed(2)} dB
                </dd>
              </div>
              <div>
                <dt>{(span / 2).toFixed(1)} MHz either side</dt>
                <dd>
                  {at(stub.centreMHz - span / 2).toFixed(1)} / {at(stub.centreMHz + span / 2).toFixed(1)} dB
                </dd>
              </div>
            </dl>
            {wide && <p className="alert-inline">Wider than 10 %: the design formulas are for narrow bands. The curve is the exact analysis of these parts, so trust it, not the bandwidth asked for.</p>}
            {stub.resonator === 'cable' && at(stub.centreMHz) < -1 && (
              <p className="alert-inline">
                The resonators' Q sets the loss in the middle: coax stubs are not high-Q enough for a band this narrow. Use cavities, or ask for a
                wider band.
              </p>
            )}
          </section>
        )}

        <section className="panel">
          <XYChart
            title="Through the filter"
            unit="dB"
            xLabel="MHz"
            xTitle="MHz"
            x={freqs}
            series={[
              { label: 'designed', colour: 'var(--series-1)', values: response },
              ...(measured ? [{ label: 'measured', colour: 'var(--series-2)', dashed: true, values: measured.points.map((p) => s21Db(p.s21)), x: measured.points.map((p) => p.fMHz) }] : []),
            ]}
            floor={FLOOR_DB}
            format={(v) => v.toFixed(1)}
            hover={hover}
            onHover={setHover}
          />
        </section>

        <details className="panel measure-filter">
          <summary>Measure the {notch ? 'stub' : 'filter'} you built</summary>
          <p className="muted">
            Port 1 into it, port 2 out of it. The measurement is drawn dashed over the design{measured ? ` - ${measured.source}` : ''}.
          </p>
          <MeasureTransmission
            startMHz={Number(freqs[0]!.toFixed(3))}
            stopMHz={Number(freqs[freqs.length - 1]!.toFixed(3))}
            action="Measure it"
            onMeasured={(points, source) => setMeasured({ points, source })}
          />
        </details>
      </div>
    </div>
  );
}
