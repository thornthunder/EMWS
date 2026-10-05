// RF toolbox: the small sums a station is built with, each shown with its working.
//
// Five tabs, no solver: wavelengths and wire, coax loss, attenuators, levels and SWR.
// Where a figure is an estimate rather than arithmetic - a catalogue cable's loss, the
// field at a distance, how short a dipole really is - the page says what it is and
// points at the tool that does it properly.

import { useEffect, useState } from 'react';
import { guideForTool } from '../../guides/registry';
import { type ImpedanceHandoff, loadImpedanceHandoff } from '../../lib/handoff';
import { magnitude, mismatchLossFromRho, reflectionCoefficient, returnLossFromRho, rhoFromSwr, swrFromPowers, swrFromRho } from '../../lib/rf';
import { LineChart } from '../../ui/LineChart';
import { NumberField } from '../../ui/NumberField';
import { BANDS } from '../../lib/bands';
import { logFrequencies } from '../lc/filter';
import { formatSi } from '../smith-chart/units';
import { type Pad, type Topology, designPad, evaluatePad, minimumLossDb, minimumLossPad, snapPad } from './attenuator';
import { type Cable, CATALOGUE, cableById, catalogueGroups, dielectricById, fitDatasheet, lossOfRun, matchedLossPer100m, runPowers } from './coax';
import { DIPOLE_GAIN_DBI, dBmToWatts, dBuV, dbToPowerRatio, dbToVoltageRatio, farFieldFromM, fieldStrength, radiatedPower, sMeter, voltsRms } from './levels';
import { type CoaxInputs, type LevelsInputs, type PadInputs, type SwrInputs, type ToolboxState, type ToolboxTab, type WireInputs, loadState, saveState } from './model';
import { HALF_WAVE_RULES, electricalLength, physicalLengthM, wavelengthM } from './wavelength';

const TABS: { id: ToolboxTab; label: string }[] = [
  { id: 'wire', label: 'Wavelength & wire' },
  { id: 'coax', label: 'Coax loss' },
  { id: 'pad', label: 'Attenuators' },
  { id: 'levels', label: 'dB, watts & S-units' },
  { id: 'swr', label: 'SWR & return loss' },
];

interface Note {
  severity: 'warning' | 'error';
  message: string;
}

const dB = (v: number, digits = 2) => (Number.isFinite(v) ? `${v.toFixed(digits)} dB` : v === Infinity ? '∞ dB' : '—');
const metres = (v: number) => (Number.isFinite(v) ? (v >= 100 ? `${v.toFixed(1)} m` : v >= 1 ? `${v.toFixed(3)} m` : `${(v * 1000).toFixed(0)} mm`) : '—');
const swrText = (s: number) => (Number.isFinite(s) ? `${s.toFixed(2)} : 1` : s === Infinity ? '∞' : '—');
const percent = (v: number, digits = 1) => (Number.isFinite(v) ? `${(v * 100).toFixed(digits)} %` : '—');
const ohms = (r: number) => (r === 0 ? 'none (a link)' : !Number.isFinite(r) ? 'none (left out)' : r >= 1000 ? `${(r / 1000).toFixed(2)} kΩ` : `${r.toFixed(r >= 100 ? 1 : 2)} Ω`);
const watts = (w: number, digits = 3) => (Number.isFinite(w) ? formatSi(w, 'W', digits) : '—');

export function ToolboxTool() {
  const [state, setState] = useState<ToolboxState>(loadState);
  useEffect(() => saveState(state), [state]);
  const guide = guideForTool('#/toolbox');

  const setTab = (tab: ToolboxTab) => setState((s) => ({ ...s, tab }));
  const patch =
    <K extends Exclude<keyof ToolboxState, 'tab'>>(key: K) =>
    (p: Partial<ToolboxState[K]>) =>
      setState((s) => ({ ...s, [key]: { ...s[key], ...p } }));

  return (
    <div className="page toolbox">
      <header className="page-header">
        <h1>RF toolbox</h1>
        <p className="muted">
          The sums behind the station: how long, how lossy, how many dB, how many volts - each with its working shown.
          {guide && (
            <>
              {' '}
              <a href={`#/guides/${guide.id}`}>How to use this</a>
            </>
          )}
        </p>
      </header>

      <div className="tool-tabs" role="tablist" aria-label="Which sum">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={state.tab === t.id} className="tool-tab" onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {state.tab === 'wire' && <WireSection inputs={state.wire} onChange={patch('wire')} />}
      {state.tab === 'coax' && <CoaxSection inputs={state.coax} onChange={patch('coax')} />}
      {state.tab === 'pad' && <PadSection inputs={state.pad} onChange={patch('pad')} />}
      {state.tab === 'levels' && <LevelsSection inputs={state.levels} onChange={patch('levels')} />}
      {state.tab === 'swr' && <SwrSection inputs={state.swr} onChange={patch('swr')} />}
    </div>
  );
}

function Notes({ notes }: { notes: Note[] }) {
  if (notes.length === 0) return null;
  return (
    <ul className="issues">
      {notes.map((n) => (
        <li key={n.message} className={`issue issue-${n.severity}`}>
          <span className="issue-mark" aria-hidden="true">
            {n.severity === 'error' ? '✕' : '!'}
          </span>
          <span className="issue-text">{n.message}</span>
        </li>
      ))}
    </ul>
  );
}

function BandButtons({ fMHz, onPick }: { fMHz: number; onPick: (f: number) => void }) {
  return (
    <div className="band-buttons">
      {BANDS.map((b) => (
        <button key={b.name} type="button" className="small" aria-pressed={Math.abs(fMHz - b.at) < 0.01} onClick={() => onPick(b.at)}>
          {b.name}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- wavelength and wire

function WireSection({ inputs, onChange }: { inputs: WireInputs; onChange: (p: Partial<WireInputs>) => void }) {
  const lambda = wavelengthM(inputs.fMHz);
  const inLine = electricalLength(inputs.physicalM, inputs.fMHz, inputs.velocityFactor);
  return (
    <div className="modeler">
      <aside className="panel">
        <section className="form-section">
          <h2>The frequency</h2>
          <BandButtons fMHz={inputs.fMHz} onPick={(f) => onChange({ fMHz: f })} />
          <NumberField label="Frequency" value={inputs.fMHz} above={0} unit="MHz" onCommit={(v) => onChange({ fMHz: v })} />
        </section>
        <section className="form-section">
          <h2>A length of line</h2>
          <p className="muted">How long a piece of coax or wire is electrically, at that frequency.</p>
          <div className="field-row">
            <NumberField label="Physical length" value={inputs.physicalM} min={0} unit="m" onCommit={(v) => onChange({ physicalM: v })} />
            <NumberField label="Velocity factor" value={inputs.velocityFactor} above={0} onCommit={(v) => onChange({ velocityFactor: Math.min(1, v) })} />
          </div>
          <p className="muted">Solid-polyethylene coax is 0.66, foam about 0.8, open wire and bare antenna wire about 1.</p>
        </section>
      </aside>

      <div className="workspace">
        <section className="panel">
          <h2 className="results-title">{metres(lambda)} at {inputs.fMHz} MHz</h2>
          <dl className="summary">
            <div>
              <dt>Wavelength</dt>
              <dd>
                {metres(lambda)}
                <small>c / f, in free space</small>
              </dd>
            </div>
            <div>
              <dt>Half wave</dt>
              <dd>{metres(lambda / 2)}</dd>
            </div>
            <div>
              <dt>Quarter wave</dt>
              <dd>{metres(lambda / 4)}</dd>
            </div>
            <div>
              <dt>In the line</dt>
              <dd>
                {inLine.degrees.toFixed(1)}°
                <small>
                  {inputs.physicalM} m at VF {inputs.velocityFactor} = {inLine.wavelengths.toFixed(3)} λ
                </small>
              </dd>
            </div>
            <div>
              <dt>Quarter wave of that line</dt>
              <dd>
                {metres(physicalLengthM(0.25, inputs.fMHz, inputs.velocityFactor))}
                <small>a half wave is {metres(physicalLengthM(0.5, inputs.fMHz, inputs.velocityFactor))}</small>
              </dd>
            </div>
          </dl>
        </section>

        <section className="panel">
          <h2 className="results-title">A half-wave dipole for {inputs.fMHz} MHz</h2>
          <p className="muted">
            Three answers, because there is no single one: how much shorter than a half wave a real dipole is depends on the wire's
            thickness and what is near it. The Antenna Modeler's <em>Tune it for me</em> finds it for your wire at your height.
          </p>
          <table className="band-table rules-table">
            <thead>
              <tr>
                <th scope="col">Figure</th>
                <th scope="col">Overall</th>
                <th scope="col">Each leg</th>
                <th scope="col">Where it comes from</th>
              </tr>
            </thead>
            <tbody>
              {HALF_WAVE_RULES.map((rule) => (
                <tr key={rule.id}>
                  <th scope="row">{rule.label}</th>
                  <td>{metres(rule.metreMHz / inputs.fMHz)}</td>
                  <td>{metres(rule.metreMHz / inputs.fMHz / 2)}</td>
                  <td className="origin">{rule.origin}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="button-row">
            <a className="small button-like" href="#/antenna">
              Open the Antenna Modeler
            </a>
            <span className="muted">Draw it, press Tune, and get the length for the wire and height you really have.</span>
          </div>
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- coax

/** 1 MHz to 1 GHz, or further when the frequency in use is above that, so the mark stays on the chart. */
function chartFrequencies(fMHz: number): number[] {
  const top = fMHz > 700 ? 10 ** Math.ceil(Math.log10(fMHz * 1.5)) : 1000;
  return logFrequencies(1, top, 121);
}

function cableOf(inputs: CoaxInputs): Cable {
  if (inputs.cableId === 'datasheet') {
    const d = inputs.datasheet;
    return { id: 'datasheet', name: d.name || 'My cable', z0: d.z0, velocityFactor: d.velocityFactor, loss: { kind: 'datasheet', points: d.points } };
  }
  return cableById(inputs.cableId) ?? CATALOGUE[0]!;
}

/** The modeller's SWR at the frequency nearest to the one in use, against the cable's Z0. */
function handoffSwr(handoff: ImpedanceHandoff, fMHz: number, z0: number): { fMHz: number; swr: number } | undefined {
  let nearest = handoff.points[0];
  if (!nearest) return undefined;
  for (const p of handoff.points) if (Math.abs(p.fMHz - fMHz) < Math.abs(nearest.fMHz - fMHz)) nearest = p;
  return { fMHz: nearest.fMHz, swr: swrFromRho(magnitude(reflectionCoefficient({ re: nearest.r, im: nearest.x }, z0))) };
}

export function coaxNotes(inputs: CoaxInputs, cable: Cable): Note[] {
  const notes: Note[] = [];
  if (cable.loss.kind === 'geometry') {
    notes.push({
      severity: 'warning',
      message:
        'The catalogue loss is calculated for smooth, solid copper conductors from the cable\'s nominal dimensions, so it is a floor: a real braided shield and stranded centre lose more. For the figure you will actually get, pick "From its datasheet" and type two of the maker\'s numbers.',
    });
  } else {
    const fit = fitDatasheet(cable.loss.points);
    if (!fit) notes.push({ severity: 'error', message: 'The two datasheet points need two different frequencies above zero and losses of zero or more.' });
    else if (fit.k1 < 0 || fit.k2 < 0) {
      notes.push({ severity: 'warning', message: 'Those two figures do not follow the usual law (a √f part for the conductors plus an f part for the dielectric). Check them against the datasheet; the fit still passes through both.' });
    }
  }
  if (inputs.fMHz > 3000 && cable.loss.kind === 'geometry') {
    notes.push({
      severity: 'warning',
      message: `At ${inputs.fMHz} MHz the catalogue figure is a rough floor at best: the dielectric figures are generic, connectors and bends matter as much as the cable, and many types are not specified this high. Use the datasheet, and expect worse.`,
    });
  }
  if (inputs.loadSwr > 3) notes.push({ severity: 'warning', message: `With an SWR of ${inputs.loadSwr} on the cable the extra loss is real, but the bigger risk is the voltage at the peaks and the heat at the connectors. The modeller's Tune can bring the antenna nearer resonance.` });
  return notes;
}

function CoaxSection({ inputs, onChange }: { inputs: CoaxInputs; onChange: (p: Partial<CoaxInputs>) => void }) {
  const [handoff] = useState<ImpedanceHandoff | undefined>(() => loadImpedanceHandoff());
  const [hover, setHover] = useState<number | undefined>();
  const cable = cableOf(inputs);
  const per100 = matchedLossPer100m(cable, inputs.fMHz);
  const run = lossOfRun(cable, inputs.fMHz, inputs.lengthM, inputs.loadSwr);
  const powers = runPowers(run.totalDb, inputs.powerW);
  const electrical = electricalLength(inputs.lengthM, inputs.fMHz, cable.velocityFactor);
  const fromModel = handoff ? handoffSwr(handoff, inputs.fMHz, cable.z0) : undefined;
  const notes = coaxNotes(inputs, cable);
  const floor = cable.loss.kind === 'geometry';
  const chartF = chartFrequencies(inputs.fMHz);
  const setDatasheet = (p: Partial<CoaxInputs['datasheet']>) => onChange({ datasheet: { ...inputs.datasheet, ...p } });
  const setPoint = (i: 0 | 1, p: Partial<{ fMHz: number; dbPer100m: number }>) => {
    const points: CoaxInputs['datasheet']['points'] = [{ ...inputs.datasheet.points[0] }, { ...inputs.datasheet.points[1] }];
    points[i] = { ...points[i], ...p };
    setDatasheet({ points });
  };

  return (
    <div className="modeler">
      <aside className="panel">
        <section className="form-section">
          <h2>The cable</h2>
          <label className="field">
            <span className="field-label">Cable</span>
            <select value={inputs.cableId} onChange={(e) => onChange({ cableId: e.target.value })}>
              {catalogueGroups().map(({ group, cables }) => (
                <optgroup key={group} label={group}>
                  {cables.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </optgroup>
              ))}
              <option value="datasheet">From its datasheet…</option>
            </select>
          </label>
          {inputs.cableId === 'datasheet' ? (
            <>
              <label className="field">
                <span className="field-label">Name</span>
                <input type="text" value={inputs.datasheet.name} onChange={(e) => setDatasheet({ name: e.target.value })} spellCheck={false} />
              </label>
              <div className="field-row">
                <NumberField label="Z0" value={inputs.datasheet.z0} above={0} unit="Ω" onCommit={(v) => setDatasheet({ z0: v })} />
                <NumberField label="Velocity factor" value={inputs.datasheet.velocityFactor} above={0} onCommit={(v) => setDatasheet({ velocityFactor: Math.min(1, v) })} />
              </div>
              <p className="muted">Two lines from the attenuation table, one low and one high in frequency:</p>
              <div className="field-row">
                <NumberField label="At" value={inputs.datasheet.points[0].fMHz} above={0} unit="MHz" onCommit={(v) => setPoint(0, { fMHz: v })} />
                <NumberField label="Loss" value={inputs.datasheet.points[0].dbPer100m} min={0} unit="dB/100 m" onCommit={(v) => setPoint(0, { dbPer100m: v })} />
              </div>
              <div className="field-row">
                <NumberField label="And at" value={inputs.datasheet.points[1].fMHz} above={0} unit="MHz" onCommit={(v) => setPoint(1, { fMHz: v })} />
                <NumberField label="Loss" value={inputs.datasheet.points[1].dbPer100m} min={0} unit="dB/100 m" onCommit={(v) => setPoint(1, { dbPer100m: v })} />
              </div>
              <p className="muted">Datasheets often give dB per 100 ft: multiply by 3.28 for dB per 100 m.</p>
            </>
          ) : (
            <p className="muted">
              {cable.z0} Ω, velocity factor {cable.velocityFactor.toFixed(2)}
              {cable.loss.kind === 'geometry' && <>, {dielectricById(cable.loss.geometry.dielectric).label.toLowerCase()}</>}.{cable.note && <> {cable.note}</>}
            </p>
          )}
        </section>
        <section className="form-section">
          <h2>The run</h2>
          <BandButtons fMHz={inputs.fMHz} onPick={(f) => onChange({ fMHz: f })} />
          <div className="field-row">
            <NumberField label="Frequency" value={inputs.fMHz} above={0} unit="MHz" onCommit={(v) => onChange({ fMHz: v })} />
            <NumberField label="Length" value={inputs.lengthM} min={0} unit="m" onCommit={(v) => onChange({ lengthM: v })} />
          </div>
          <div className="field-row">
            <NumberField label="SWR at the antenna" value={inputs.loadSwr} min={1} onCommit={(v) => onChange({ loadSwr: v })} />
            <NumberField label="Power in" value={inputs.powerW} min={0} unit="W" onCommit={(v) => onChange({ powerW: v })} />
          </div>
          {fromModel && (
            <div className="button-row">
              <button type="button" className="small" onClick={() => onChange({ loadSwr: Number(fromModel.swr.toFixed(3)) })} title={`${handoff?.name ?? ''}, saved ${handoff ? new Date(handoff.savedAt).toLocaleString() : ''}`}>
                Use the modelled antenna: {swrText(fromModel.swr)} at {fromModel.fMHz} MHz
              </button>
            </div>
          )}
          {!handoff && <p className="muted">Run an antenna in the Antenna Modeler and its SWR can be taken from there.</p>}
        </section>
      </aside>

      <div className="workspace">
        <section className="panel">
          <h2 className="results-title">
            {floor ? 'At least ' : ''}
            {dB(run.totalDb)} lost in {inputs.lengthM} m of {cable.name.replace(/ \(.*\)$/, '')}
          </h2>
          <p className="build-card">
            At {inputs.fMHz} MHz this cable loses <strong>{floor ? 'at least ' : ''}{per100.totalDb.toFixed(2)} dB per 100 m</strong> matched ({per100.conductorDb.toFixed(2)} in the
            conductors, {per100.dielectricDb.toFixed(2)} in the dielectric). Your {inputs.lengthM} m with an SWR of {inputs.loadSwr} at the far end loses{' '}
            <strong>{dB(run.totalDb)}</strong>: of {inputs.powerW} W in, <strong>{watts(powers.deliveredW)}</strong> reaches the antenna and {watts(powers.heatW)} warms the cable.
          </p>
          <dl className="summary">
            <div>
              <dt>Matched loss</dt>
              <dd>
                {dB(run.matchedDb)}
                <small>{per100.totalDb.toFixed(2)} dB per 100 m{floor ? ', at least' : ''}</small>
              </dd>
            </div>
            <div>
              <dt>Added by the SWR</dt>
              <dd>
                {dB(run.additionalDb)}
                <small>standing waves make the current and voltage peaks lossier</small>
              </dd>
            </div>
            <div>
              <dt>Total loss</dt>
              <dd>{dB(run.totalDb)}</dd>
            </div>
            <div>
              <dt>SWR at the radio</dt>
              <dd>
                {swrText(run.radioSwr)}
                <small>the loss hides some of the antenna's {swrText(inputs.loadSwr)}</small>
              </dd>
            </div>
            <div>
              <dt>Power at the antenna</dt>
              <dd>
                {watts(powers.deliveredW)}
                <small>{watts(powers.heatW)} as heat in the cable</small>
              </dd>
            </div>
            <div>
              <dt>Electrical length</dt>
              <dd>
                {electrical.wavelengths.toFixed(2)} λ<small>{electrical.degrees.toFixed(0)}° at VF {cable.velocityFactor.toFixed(2)}</small>
              </dd>
            </div>
          </dl>
        </section>

        <Notes notes={notes} />

        <section className="panel">
          <LineChart
            title={`Matched loss per 100 m${floor ? ' (floor)' : ''}`}
            fMHz={chartF}
            series={[{ label: cable.name, colour: 'var(--series-1)', values: chartF.map((f) => matchedLossPer100m(cable, f).totalDb) }]}
            unit="dB"
            marks={[{ fMHz: inputs.fMHz, label: `${inputs.fMHz} MHz` }]}
            hover={hover}
            onHover={setHover}
          />
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- attenuators

const TOPOLOGIES: { id: PadInputs['topology'] | 'ell'; label: string }[] = [
  { id: 'pi', label: 'Pi (shunt - series - shunt)' },
  { id: 'tee', label: 'T (series - shunt - series)' },
  { id: 'ell', label: 'Minimum-loss L pad between two impedances' },
];

function padFor(inputs: PadInputs): { pad: Pad | undefined; ell: boolean } {
  if (inputs.topology === 'ell') return { pad: minimumLossPad(inputs.zIn, inputs.zOut), ell: true };
  return { pad: designPad(inputs.topology, inputs.attenuationDb, inputs.zIn, inputs.zOut), ell: false };
}

function PadFigure({ pad }: { pad: Pad }) {
  const r = (v: number) => (v === 0 ? '' : !Number.isFinite(v) ? '' : v >= 1000 ? `${(v / 1000).toPrecision(3)} k` : v.toPrecision(3));
  const series = (x: number, label: string) =>
    label === '' ? (
      <line x1={x - 30} y1={30} x2={x + 30} y2={30} className="pad-wire" />
    ) : (
      <g>
        <line x1={x - 30} y1={30} x2={x - 16} y2={30} className="pad-wire" />
        <rect x={x - 16} y={22} width={32} height={16} className="pad-r" />
        <line x1={x + 16} y1={30} x2={x + 30} y2={30} className="pad-wire" />
        <text x={x} y={14} textAnchor="middle" className="pad-label">
          {label}
        </text>
      </g>
    );
  const shunt = (x: number, label: string) =>
    label === '' ? null : (
      <g>
        <line x1={x} y1={30} x2={x} y2={48} className="pad-wire" />
        <rect x={x - 8} y={48} width={16} height={32} className="pad-r" />
        <line x1={x} y1={80} x2={x} y2={100} className="pad-wire" />
        <text x={x + 12} y={68} className="pad-label">
          {label}
        </text>
      </g>
    );
  const tee = pad.topology === 'tee';
  return (
    <svg viewBox="0 0 320 112" className="pad-figure" role="img" aria-label={`${tee ? 'T' : 'Pi'} attenuator schematic`}>
      <line x1={10} y1={100} x2={310} y2={100} className="pad-ground" />
      <line x1={10} y1={30} x2={60} y2={30} className="pad-wire" />
      <line x1={260} y1={30} x2={310} y2={30} className="pad-wire" />
      <text x={10} y={22} className="pad-label">
        in
      </text>
      <text x={298} y={22} className="pad-label">
        out
      </text>
      {tee ? (
        <>
          {series(90, r(pad.r1))}
          <line x1={120} y1={30} x2={200} y2={30} className="pad-wire" />
          {shunt(160, r(pad.r3))}
          {series(230, r(pad.r2))}
        </>
      ) : (
        <>
          <line x1={60} y1={30} x2={130} y2={30} className="pad-wire" />
          {shunt(80, r(pad.r1))}
          {series(160, r(pad.r3))}
          <line x1={190} y1={30} x2={260} y2={30} className="pad-wire" />
          {shunt(240, r(pad.r2))}
        </>
      )}
    </svg>
  );
}

function PadSection({ inputs, onChange }: { inputs: PadInputs; onChange: (p: Partial<PadInputs>) => void }) {
  const { pad, ell } = padFor(inputs);
  const minimum = minimumLossDb(inputs.zIn, inputs.zOut);
  const built = pad && inputs.standardValues ? snapPad(pad) : pad;
  const exact = pad ? evaluatePad(pad, inputs.zIn, inputs.zOut, inputs.powerW) : undefined;
  const report = built ? evaluatePad(built, inputs.zIn, inputs.zOut, inputs.powerW) : undefined;
  const notes: Note[] = [];
  if (!pad && !ell) {
    notes.push({ severity: 'error', message: `Between ${inputs.zIn} Ω and ${inputs.zOut} Ω a resistive pad loses at least ${minimum.toFixed(2)} dB. Ask for that or more, or choose the minimum-loss L pad.` });
  }
  if (ell && !pad) notes.push({ severity: 'error', message: 'An L pad only exists between two different impedances; with equal ones nothing is needed.' });
  if (report && exact && Math.abs(report.attenuationDb - exact.attenuationDb) > 0.25) {
    notes.push({ severity: 'warning', message: `Rounding to E24 moved the attenuation by ${(report.attenuationDb - exact.attenuationDb).toFixed(2)} dB. Put two resistors in series or parallel for the arms that matter, or use E96 parts.` });
  }
  const names = pad?.topology === 'tee' ? { r1: 'Series, input side', r2: 'Series, output side', r3: 'Shunt' } : { r1: 'Shunt, input side', r2: 'Shunt, output side', r3: 'Series' };
  const title = ell ? `${minimum.toFixed(2)} dB minimum-loss pad` : `${inputs.attenuationDb} dB ${inputs.topology === 'tee' ? 'T' : 'Pi'} pad`;

  return (
    <div className="modeler">
      <aside className="panel">
        <section className="form-section">
          <h2>The pad</h2>
          <label className="field">
            <span className="field-label">Shape</span>
            <select value={inputs.topology} onChange={(e) => onChange({ topology: e.target.value as Topology | 'ell' })}>
              {TOPOLOGIES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          {!ell && <NumberField label="Attenuation" value={inputs.attenuationDb} above={0} unit="dB" onCommit={(v) => onChange({ attenuationDb: v })} />}
          <div className="field-row">
            <NumberField label="Input impedance" value={inputs.zIn} above={0} unit="Ω" onCommit={(v) => onChange({ zIn: v })} />
            <NumberField label="Output impedance" value={inputs.zOut} above={0} unit="Ω" onCommit={(v) => onChange({ zOut: v })} />
          </div>
          <NumberField label="Power into it" value={inputs.powerW} min={0} unit="W" onCommit={(v) => onChange({ powerW: v })} />
          <label className="check">
            <input type="checkbox" checked={inputs.standardValues} onChange={(e) => onChange({ standardValues: e.target.checked })} /> Round to E24 values and show what that pad really does
          </label>
        </section>
      </aside>

      <div className="workspace">
        <section className="panel">
          <h2 className="results-title">
            {title}, {inputs.zIn} → {inputs.zOut} Ω
          </h2>
          {pad && built && report && exact && (
            <>
              <PadFigure pad={built} />
              <table className="band-table parts-table">
                <thead>
                  <tr>
                    <th scope="col">Resistor</th>
                    <th scope="col">Exact</th>
                    {inputs.standardValues && <th scope="col">E24</th>}
                    <th scope="col">Dissipates</th>
                  </tr>
                </thead>
                <tbody>
                  {(['r1', 'r3', 'r2'] as const).map((k) => (
                    <tr key={k}>
                      <th scope="row">{names[k]}</th>
                      <td>{ohms(pad[k])}</td>
                      {inputs.standardValues && <td>{ohms(built[k])}</td>}
                      <td>{built[k] === 0 || !Number.isFinite(built[k]) ? '—' : watts(report.dissipationW[k])}</td>
                    </tr>
                  ))}
                  <tr>
                    <th scope="row">Load</th>
                    <td>{inputs.zOut} Ω</td>
                    {inputs.standardValues && <td />}
                    <td>{watts(report.dissipationW.load)}</td>
                  </tr>
                </tbody>
              </table>
              <dl className="summary">
                <div>
                  <dt>{inputs.standardValues ? 'Attenuation as built' : 'Attenuation'}</dt>
                  <dd>
                    {dB(report.attenuationDb)}
                    {inputs.standardValues && <small>{dB(exact.attenuationDb)} with exact values</small>}
                  </dd>
                </div>
                <div>
                  <dt>Match at the input</dt>
                  <dd>
                    {report.zIn.toFixed(1)} Ω<small>return loss {dB(report.returnLossInDb, 1)}</small>
                  </dd>
                </div>
                <div>
                  <dt>Match at the output</dt>
                  <dd>
                    {report.zOut.toFixed(1)} Ω<small>return loss {dB(report.returnLossOutDb, 1)}</small>
                  </dd>
                </div>
                <div>
                  <dt>Heat in the pad</dt>
                  <dd>
                    {watts(report.dissipationW.r1 + report.dissipationW.r2 + report.dissipationW.r3)}
                    <small>of {inputs.powerW} W in; rate each resistor at twice its share</small>
                  </dd>
                </div>
              </dl>
            </>
          )}
        </section>
        <Notes notes={notes} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- levels

function LevelsSection({ inputs, onChange }: { inputs: LevelsInputs; onChange: (p: Partial<LevelsInputs>) => void }) {
  const w = dBmToWatts(inputs.dBm);
  const vRms = voltsRms(w, inputs.z);
  const meter = sMeter(inputs.dBm, inputs.band);
  const radiated = radiatedPower(inputs.txW, inputs.feederLossDb, inputs.gainDbi);
  const field = fieldStrength(radiated.eirpW, inputs.distanceM);
  const farFrom = farFieldFromM(inputs.fMHz, inputs.antennaSizeM);
  return (
    <div className="modeler">
      <aside className="panel">
        <section className="form-section">
          <h2>A level</h2>
          <div className="field-row">
            <NumberField label="Level" value={inputs.dBm} unit="dBm" onCommit={(v) => onChange({ dBm: v })} />
            <NumberField label="Across" value={inputs.z} above={0} unit="Ω" onCommit={(v) => onChange({ z: v })} />
          </div>
          <label className="field">
            <span className="field-label">S-meter scale</span>
            <select value={inputs.band} onChange={(e) => onChange({ band: e.target.value as LevelsInputs['band'] })}>
              <option value="hf">HF: S9 = −73 dBm (50 µV)</option>
              <option value="vhf">VHF and up: S9 = −93 dBm (5 µV)</option>
            </select>
          </label>
          <NumberField label="A ratio in dB" value={inputs.dB} unit="dB" onCommit={(v) => onChange({ dB: v })} />
        </section>
        <section className="form-section">
          <h2>What the station radiates</h2>
          <div className="field-row">
            <NumberField label="Transmitter" value={inputs.txW} min={0} unit="W" onCommit={(v) => onChange({ txW: v })} />
            <NumberField label="Feeder loss" value={inputs.feederLossDb} min={0} unit="dB" onCommit={(v) => onChange({ feederLossDb: v })} />
          </div>
          <NumberField label="Antenna gain" value={inputs.gainDbi} unit="dBi" onCommit={(v) => onChange({ gainDbi: v })} />
          <p className="muted">dBd + {DIPOLE_GAIN_DBI} = dBi. The modeller's gain figures are dBi.</p>
          <div className="field-row">
            <NumberField label="At a distance of" value={inputs.distanceM} above={0} unit="m" onCommit={(v) => onChange({ distanceM: v })} />
            <NumberField label="Antenna size" value={inputs.antennaSizeM} min={0} unit="m" onCommit={(v) => onChange({ antennaSizeM: v })} />
          </div>
          <NumberField label="Frequency" value={inputs.fMHz} above={0} unit="MHz" onCommit={(v) => onChange({ fMHz: v })} />
        </section>
      </aside>

      <div className="workspace">
        <section className="panel">
          <h2 className="results-title">
            {inputs.dBm} dBm is {watts(w)} - {meter.reading}
          </h2>
          <dl className="summary">
            <div>
              <dt>Power</dt>
              <dd>{watts(w, 4)}</dd>
            </div>
            <div>
              <dt>Volts across {inputs.z} Ω</dt>
              <dd>
                {formatSi(vRms, 'V', 4)} RMS<small>{formatSi(vRms * Math.SQRT2, 'V', 4)} peak, {dBuV(w, inputs.z).toFixed(1)} dBµV</small>
              </dd>
            </div>
            <div>
              <dt>S-meter</dt>
              <dd>
                {meter.reading}
                <small>
                  S{meter.units.toFixed(1)} on the IARU scale, {meter.overS9Db >= 0 ? '+' : ''}
                  {meter.overS9Db.toFixed(1)} dB from S9
                </small>
              </dd>
            </div>
            <div>
              <dt>{inputs.dB} dB is</dt>
              <dd>
                × {dbToPowerRatio(inputs.dB).toPrecision(4)} in power<small>× {dbToVoltageRatio(inputs.dB).toPrecision(4)} in voltage</small>
              </dd>
            </div>
          </dl>
        </section>

        <section className="panel">
          <h2 className="results-title">
            {watts(radiated.eirpW)} EIRP, {watts(radiated.erpW)} ERP
          </h2>
          <p className="build-card">
            {inputs.txW} W less {inputs.feederLossDb} dB of feeder into {inputs.gainDbi} dBi radiates <strong>{watts(radiated.eirpW)}</strong> EIRP ({radiated.eirpDbm.toFixed(1)} dBm), which
            is {watts(radiated.erpW)} ERP relative to a dipole. In free space, {inputs.distanceM} m away, that is a field of <strong>{formatSi(field.voltsPerM, 'V/m', 3)}</strong>.
          </p>
          <dl className="summary">
            <div>
              <dt>Field strength</dt>
              <dd>
                {formatSi(field.voltsPerM, 'V/m', 3)}
                <small>{field.dBuVPerM.toFixed(1)} dBµV/m</small>
              </dd>
            </div>
            <div>
              <dt>Power density</dt>
              <dd>
                {formatSi(field.wattsPerM2, 'W/m²', 3)}
                <small>{(field.wattsPerM2 / 10).toPrecision(3)} mW/cm²</small>
              </dd>
            </div>
            <div>
              <dt>Where this holds</dt>
              <dd>
                beyond about {metres(farFrom)}
                <small>the far field of a {inputs.antennaSizeM} m antenna at {inputs.fMHz} MHz; nearer in, measure</small>
              </dd>
            </div>
          </dl>
          <p className="muted">
            A free-space estimate for comparing against your regulator's exposure limits, which this page does not state. Ground reflections can
            double the field at a point; the Antenna Modeler's pattern says where the energy goes.
          </p>
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- swr

function SwrSection({ inputs, onChange }: { inputs: SwrInputs; onChange: (p: Partial<SwrInputs>) => void }) {
  const rho = rhoFromSwr(inputs.swr);
  const fromMeter = swrFromPowers(inputs.forwardW, inputs.reflectedW);
  const gamma = reflectionCoefficient({ re: inputs.r, im: inputs.x }, inputs.z0);
  const rhoZ = magnitude(gamma);
  return (
    <div className="modeler">
      <aside className="panel">
        <section className="form-section">
          <h2>From an SWR</h2>
          <NumberField label="SWR" value={inputs.swr} min={1} onCommit={(v) => onChange({ swr: v })} />
        </section>
        <section className="form-section">
          <h2>From a wattmeter</h2>
          <div className="field-row">
            <NumberField label="Forward" value={inputs.forwardW} min={0} unit="W" onCommit={(v) => onChange({ forwardW: v })} />
            <NumberField label="Reflected" value={inputs.reflectedW} min={0} unit="W" onCommit={(v) => onChange({ reflectedW: v })} />
          </div>
        </section>
        <section className="form-section">
          <h2>From an impedance</h2>
          <div className="field-row">
            <NumberField label="R" value={inputs.r} min={0} unit="Ω" onCommit={(v) => onChange({ r: v })} />
            <NumberField label="X" value={inputs.x} unit="Ω" onCommit={(v) => onChange({ x: v })} />
          </div>
          <NumberField label="System impedance" value={inputs.z0} above={0} unit="Ω" onCommit={(v) => onChange({ z0: v })} />
        </section>
      </aside>

      <div className="workspace">
        <section className="panel">
          <h2 className="results-title">SWR {swrText(inputs.swr)}</h2>
          <dl className="summary">
            <div>
              <dt>Reflection coefficient</dt>
              <dd>
                |Γ| = {rho.toFixed(3)}
                <small>(SWR − 1) / (SWR + 1)</small>
              </dd>
            </div>
            <div>
              <dt>Return loss</dt>
              <dd>{dB(returnLossFromRho(rho), 1)}</dd>
            </div>
            <div>
              <dt>Power reflected</dt>
              <dd>
                {percent(rho * rho)}
                <small>{percent(1 - rho * rho)} goes forward</small>
              </dd>
            </div>
            <div>
              <dt>Mismatch loss</dt>
              <dd>
                {dB(mismatchLossFromRho(rho))}
                <small>if nothing sends the reflection back</small>
              </dd>
            </div>
          </dl>
          <p className="muted">
            A reflection is not simply lost: a tuner or the transmitter sends it back, and what it costs then is the extra cable loss on the Coax tab.
          </p>
        </section>

        <section className="panel">
          <h2 className="results-title">The wattmeter says {swrText(fromMeter)}</h2>
          <p className="build-card">
            {inputs.forwardW} W forward and {inputs.reflectedW} W reflected is |Γ| = √({inputs.reflectedW} / {inputs.forwardW}) ={' '}
            {Number.isFinite(fromMeter) ? Math.sqrt(inputs.reflectedW / inputs.forwardW).toFixed(3) : '—'}, so an SWR of <strong>{swrText(fromMeter)}</strong>; {watts(inputs.forwardW - inputs.reflectedW)} goes on into the
            load.
          </p>
        </section>

        <section className="panel">
          <h2 className="results-title">
            {inputs.r} {inputs.x < 0 ? '−' : '+'} j{Math.abs(inputs.x)} Ω in a {inputs.z0} Ω system: SWR {swrText(swrFromRho(rhoZ))}
          </h2>
          <dl className="summary">
            <div>
              <dt>Reflection coefficient</dt>
              <dd>
                |Γ| = {rhoZ.toFixed(3)}
                <small>
                  Γ = {gamma.re.toFixed(3)} {gamma.im < 0 ? '−' : '+'} j{Math.abs(gamma.im).toFixed(3)}
                </small>
              </dd>
            </div>
            <div>
              <dt>Return loss</dt>
              <dd>{dB(returnLossFromRho(rhoZ), 1)}</dd>
            </div>
            <div>
              <dt>Mismatch loss</dt>
              <dd>{dB(mismatchLossFromRho(rhoZ))}</dd>
            </div>
          </dl>
          <div className="button-row">
            <a className="small button-like" href="#/smith">
              Match it on the Smith chart
            </a>
          </div>
        </section>
      </div>
    </div>
  );
}
