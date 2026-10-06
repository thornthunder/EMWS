// Coils, traps and filters: the reactive parts a station is made of.
//
// One page, three designs. The coil is the common part: a trap is a coil across a
// capacitor, a filter is several of each, so "wind it" on the other two tabs means "on
// the coil tab's former, with its wire". Everything is worked out, nothing looked up, and
// where the working is only an estimate - a coil's Q above all - the page says so and
// takes a measurement instead.

import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import { guideForTool } from '../../guides/registry';
import { cAbs } from '../../lib/complex';
import { saveLoadHandoff } from '../../lib/handoff';
import { type MeasuredPoint, TouchstoneError, parseTouchstone } from '../../lib/touchstone';
import { LineChart } from '../../ui/LineChart';
import { MeasureWithVna } from '../../ui/MeasureWithVna';
import { NumberField } from '../../ui/NumberField';
import { formatSi } from '../smith-chart/units';
import { copperOhmsPerM, inductanceH, meanDiameterMm, qualityEstimate, reactanceOhms, selfResonanceBoundMHz, turnsFor, windingLengthMm, wireLengthM, wireResistanceOhms } from './coil';
import { type Ladder, type LadderElement, MAX_ORDER, MIN_ORDER, logFrequencies, nearestStandard, respond, sweepResponse, synthesise, withStandardCapacitors } from './filter';
import { BANDS, type CoilDesign, type FilterDesign, type LcState, type LcTab, SPACINGS, type StubDesign, type TrapDesign, WIRE_CHOICES, loadState, saveState, trapParts } from './model';
import { StubSection } from './StubSection';
import { type TransmissionPoint, s21Db } from '../../lib/vna/transmission';
import { MeasureTransmission } from '../../ui/MeasureTransmission';
import { type TrapSpec, bandwidthMHz, resonantImpedanceOhms, trapAt, trapImpedance } from './trap';

const TABS: { id: LcTab; label: string }[] = [
  { id: 'coil', label: 'A coil' },
  { id: 'trap', label: 'A trap' },
  { id: 'filter', label: 'A filter' },
  { id: 'stub', label: 'Stubs & cavities' },
];

interface Note {
  severity: 'warning' | 'error';
  message: string;
}

/** The Q the other tabs should take from the coil tab: measured if there is one, else the close-wound estimate. */
export function coilQ(coil: CoilDesign, fMHz: number): number {
  return coil.measuredQ ?? qualityEstimate(coil, fMHz).closeWound;
}

const round = (v: number, digits: number) => Number(v.toFixed(digits));
const ordinal = (n: number) => `${n}${n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;
const halfTurns = (turns: number) => Math.max(0.5, Math.round(turns * 2) / 2);
const wireName = (coil: CoilDesign) => WIRE_CHOICES.find((w) => w.wireMm === coil.wireMm && w.wallMm === coil.wallMm)?.name ?? `${coil.wireMm} mm wire`;

export function LcTool() {
  const [state, setState] = useState<LcState>(loadState);
  useEffect(() => saveState(state), [state]);
  const guide = guideForTool('#/lc');

  const setTab = (tab: LcTab) => setState((s) => ({ ...s, tab }));
  const setCoil = (patch: Partial<CoilDesign>) => setState((s) => ({ ...s, coil: { ...s.coil, ...patch } }));
  const setTrap = (patch: Partial<TrapDesign>) => setState((s) => ({ ...s, trap: { ...s.trap, ...patch } }));
  const setFilter = (patch: Partial<FilterDesign>) => setState((s) => ({ ...s, filter: { ...s.filter, ...patch } }));
  const setStub = (patch: Partial<StubDesign>) => setState((s) => ({ ...s, stub: { ...s.stub, ...patch } }));

  return (
    <div className="page">
      <header className="page-header">
        <h1>Coils, traps and filters</h1>
        <p className="muted">
          Wind a coil and know what it is; put one across a capacitor and cut it into a wire; string a few together and keep the
          harmonics in.
          {guide && (
            <>
              {' '}
              <a href={`#/guides/${guide.id}`}>How to use this</a>
            </>
          )}
        </p>
      </header>

      <div className="lc-tabs" role="tablist" aria-label="What to design">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={state.tab === t.id} className="lc-tab" onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {state.tab === 'coil' && <CoilSection coil={state.coil} onChange={setCoil} />}
      {state.tab === 'trap' && <TrapSection trap={state.trap} coil={state.coil} onChange={setTrap} onCoil={setCoil} goTo={setTab} />}
      {state.tab === 'filter' && <FilterSection filter={state.filter} coil={state.coil} onChange={setFilter} goTo={setTab} />}
      {state.tab === 'stub' && <StubSection stub={state.stub} onChange={setStub} />}
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

// ---------------------------------------------------------------- the coil

interface CoilMeasurement {
  source: string;
  fMHz: number;
  henries: number;
  q: number | undefined;
  srfMHz: number | undefined;
}

/** What a one-port sweep of a coil says: L and Q nearest the frequency of interest, and where it goes capacitive. */
export function analyseCoilSweep(points: MeasuredPoint[], atMHz: number, source: string): CoilMeasurement | undefined {
  if (points.length === 0) return undefined;
  let nearest = points[0]!;
  for (const p of points) if (Math.abs(p.fMHz - atMHz) < Math.abs(nearest.fMHz - atMHz)) nearest = p;
  const w = 2 * Math.PI * nearest.fMHz * 1e6;
  const henries = nearest.z.im / w;
  const q = nearest.z.re > 0 && nearest.z.im > 0 ? nearest.z.im / nearest.z.re : undefined;
  let srfMHz: number | undefined;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (a.z.im > 0 && b.z.im <= 0) {
      srfMHz = a.fMHz + ((b.fMHz - a.fMHz) * a.z.im) / (a.z.im - b.z.im);
      break;
    }
  }
  return { source, fMHz: nearest.fMHz, henries, q, srfMHz };
}

export function coilNotes(coil: CoilDesign): Note[] {
  const notes: Note[] = [];
  const srf = selfResonanceBoundMHz(coil);
  if (coil.turns < 3) {
    notes.push({ severity: 'warning', message: `With only ${coil.turns} turns the wire's own thickness and the lead-outs matter as much as the formula: expect a few percent either way.` });
  }
  if (coil.atMHz > srf / 3) {
    notes.push({
      severity: 'warning',
      message: `At ${coil.atMHz} MHz the coil is within a factor of three of its self-resonance bound (about ${srf.toFixed(0)} MHz). Its inductance will read high and its Q low there. Measure it, or use fewer turns of thicker wire.`,
    });
  }
  if (meanDiameterMm(coil) > 0 && windingLengthMm(coil) > 6 * meanDiameterMm(coil)) {
    notes.push({ severity: 'warning', message: 'A coil this long for its diameter wastes wire: the same inductance comes from fewer turns on a fatter former, with a better Q.' });
  }
  return notes;
}

function CoilSection({ coil, onChange }: { coil: CoilDesign; onChange: (patch: Partial<CoilDesign>) => void }) {
  const henries = inductanceH(coil);
  const [target, setTarget] = useState(round(henries * 1e6, 3));
  const [measured, setMeasured] = useState<CoilMeasurement | undefined>();
  const [fileError, setFileError] = useState<string | undefined>();
  const [customWire, setCustomWire] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const quality = qualityEstimate(coil, coil.atMHz);
  const srf = selfResonanceBoundMHz(coil);
  const listedWire = WIRE_CHOICES.find((w) => w.wireMm === coil.wireMm && w.wallMm === coil.wallMm);
  const chosenWire = customWire ? undefined : listedWire;
  const spacing = SPACINGS.find((s) => s.value === coil.spacing);
  const notes = coilNotes(coil);

  const pickWire = (e: ChangeEvent<HTMLSelectElement>) => {
    const w = WIRE_CHOICES.find((c) => c.id === e.target.value);
    setCustomWire(!w);
    if (w) onChange({ wireMm: w.wireMm, wallMm: w.wallMm });
  };

  const findTurns = () => {
    const turns = halfTurns(turnsFor(target * 1e-6, coil));
    onChange({ turns });
  };

  const takeFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const parsed = parseTouchstone(await file.text());
      setFileError(undefined);
      setMeasured(analyseCoilSweep(parsed.points, coil.atMHz, file.name));
    } catch (err) {
      setFileError(err instanceof TouchstoneError ? err.message : String(err));
    }
  };

  return (
    <div className="modeler">
      <aside className="panel">
        <section className="form-section">
          <h2>The coil</h2>
          <div className="field-row">
            <NumberField label="Former diameter" value={coil.formerMm} above={0} unit="mm" onCommit={(v) => onChange({ formerMm: v })} />
            <NumberField label="Turns" value={coil.turns} above={0} onCommit={(v) => onChange({ turns: v })} />
          </div>
          <label className="field">
            <span className="field-label">Wire</span>
            <select value={chosenWire?.id ?? 'custom'} onChange={pickWire}>
              {WIRE_CHOICES.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
              <option value="custom">Other…</option>
            </select>
          </label>
          {!chosenWire && (
            <div className="field-row">
              <NumberField label="Copper diameter" value={coil.wireMm} above={0} unit="mm" onCommit={(v) => onChange({ wireMm: v })} />
              <NumberField label="Insulation wall" value={coil.wallMm} min={0} unit="mm" onCommit={(v) => onChange({ wallMm: v })} />
            </div>
          )}
          <label className="field">
            <span className="field-label">Turn spacing</span>
            <select value={coil.spacing} onChange={(e) => onChange({ spacing: Number(e.target.value) })}>
              {SPACINGS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <NumberField label="For use at" value={coil.atMHz} above={0} unit="MHz" onCommit={(v) => onChange({ atMHz: v })} />
        </section>

        <section className="form-section">
          <h2>Wind it to a value</h2>
          <div className="field-row">
            <NumberField label="Inductance wanted" value={target} above={0} unit="µH" onCommit={setTarget} />
            <button type="button" className="small" onClick={findTurns}>
              Find the turns
            </button>
          </div>
          <p className="muted">Keeps the former, wire and spacing, and changes the turns, to the nearest half.</p>
        </section>

        <section className="form-section">
          <h2>Q to use elsewhere</h2>
          <p className="muted">The trap and filter tabs take this coil's Q from here: the close-wound estimate, unless you give a measured one.</p>
          <div className="field-row">
            <NumberField label="Measured Q" value={coil.measuredQ ?? 0} min={0} onCommit={(v) => onChange({ measuredQ: v > 0 ? v : undefined })} />
            {coil.measuredQ !== undefined && (
              <button type="button" className="link" onClick={() => onChange({ measuredQ: undefined })}>
                Back to the estimate
              </button>
            )}
          </div>
        </section>
      </aside>

      <div className="workspace">
        <section className="panel">
          <h2 className="results-title">{formatSi(henries, 'H', 3)}</h2>
          <p className="build-card">
            <strong>{coil.turns} turns</strong> of {wireName(coil)} on a <strong>{coil.formerMm} mm</strong> former, {spacing?.label ?? `${coil.spacing} wire diameters apart`}: a
            winding <strong>{windingLengthMm(coil).toFixed(1)} mm</strong> long and {meanDiameterMm(coil).toFixed(1)} mm across, from{' '}
            <strong>{wireLengthM(coil).toFixed(2)} m</strong> of wire.
          </p>
          <dl className="summary">
            <div>
              <dt>Inductance</dt>
              <dd>{formatSi(henries, 'H', 4)}</dd>
            </div>
            <div>
              <dt>Reactance at {coil.atMHz} MHz</dt>
              <dd>{reactanceOhms(henries, coil.atMHz).toFixed(1)} Ω</dd>
            </div>
            <div>
              <dt>Q at {coil.atMHz} MHz</dt>
              <dd>
                {coil.measuredQ !== undefined ? (
                  <>
                    {coil.measuredQ.toFixed(0)}
                    <small>measured. The estimate: up to {quality.upper.toFixed(0)}, about {quality.closeWound.toFixed(0)} close-wound</small>
                  </>
                ) : (
                  <>
                    up to {quality.upper.toFixed(0)}
                    <small>skin effect alone; close-wound about {quality.closeWound.toFixed(0)}</small>
                  </>
                )}
              </dd>
            </div>
            <div>
              <dt>Self-resonance</dt>
              <dd>
                below {srf.toFixed(0)} MHz<small>where the wire is a half wave long</small>
              </dd>
            </div>
            <div>
              <dt>Wire resistance</dt>
              <dd>
                {wireResistanceOhms(coil, coil.atMHz).toFixed(3)} Ω at {coil.atMHz} MHz
                <small>{(copperOhmsPerM(coil.wireMm, 1e-9) * wireLengthM(coil)).toFixed(4)} Ω at DC</small>
              </dd>
            </div>
          </dl>
          <div className="button-row">
            <button
              type="button"
              className="small"
              title="Offers it to the Antenna Modeler as a series load: the inductance, with its loss at the frequency above as the resistance"
              onClick={() => {
                const q = coilQ(coil, coil.atMHz);
                saveLoadHandoff({ name: `${formatSi(henries, 'H', 3)} coil`, savedAt: new Date().toISOString(), kind: 'series', ohms: q > 0 ? reactanceOhms(henries, coil.atMHz) / q : 0, henries, farads: 0 });
                location.hash = '#/antenna';
              }}
            >
              Put this coil in an antenna
            </button>
            <span className="muted">A loading coil: opens the Antenna Modeler, where it goes on a wire and NEC works out what it does there.</span>
          </div>
        </section>

        <Notes notes={notes} />

        <section className="panel">
          <h2 className="results-title">Measure it</h2>
          <p className="muted">
            Sweep the coil on its own with a NanoVNA and the numbers above stop being estimates: inductance and Q at {coil.atMHz} MHz, and where it
            really goes self-resonant.
          </p>
          <MeasureWithVna
            startMHz={Math.max(0.1, round(coil.atMHz / 2, 2))}
            stopMHz={Math.min(300, round(Math.max(coil.atMHz * 4, srf * 1.5), 1))}
            points={201}
            action="Measure the coil"
            onMeasured={(points, source) => setMeasured(analyseCoilSweep(points, coil.atMHz, source))}
          />
          <div className="button-row">
            <button type="button" className="small" onClick={() => fileInput.current?.click()}>
              Open a NanoVNA .s1p…
            </button>
            <input ref={fileInput} type="file" accept=".s1p,.S1P" onChange={takeFile} hidden />
            {fileError && <span className="alert-inline">{fileError}</span>}
          </div>
          {measured && (
            <dl className="summary">
              <div>
                <dt>Measured at {measured.fMHz.toFixed(2)} MHz</dt>
                <dd>
                  {formatSi(measured.henries, 'H', 3)}
                  <small>{measured.source}</small>
                </dd>
              </div>
              <div>
                <dt>Measured Q</dt>
                <dd>
                  {measured.q !== undefined ? measured.q.toFixed(0) : 'not inductive there'}
                  {measured.q !== undefined && (
                    <small>
                      <button type="button" className="link" onClick={() => onChange({ measuredQ: round(measured.q!, 0) })}>
                        Use this Q
                      </button>
                    </small>
                  )}
                </dd>
              </div>
              <div>
                <dt>Self-resonant at</dt>
                <dd>{measured.srfMHz !== undefined ? `${measured.srfMHz.toFixed(1)} MHz` : 'above the sweep'}</dd>
              </div>
            </dl>
          )}
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the trap

export function trapNotes(trap: TrapDesign, parts: { henries: number; farads: number }): Note[] {
  const notes: Note[] = [];
  if (trap.q < 50) notes.push({ severity: 'warning', message: `A coil Q of ${trap.q} makes a lossy trap: its impedance at resonance is only ${(resonantImpedanceOhms({ ...parts, q: trap.q }) / 1000).toFixed(1)} kΩ, and the band it isolates will show it as loss.` });
  if (parts.farads < 10e-12) notes.push({ severity: 'warning', message: `${formatSi(parts.farads, 'F', 2)} is so little capacitance that the coil's own and the leads' will move the resonance. Use a smaller coil and a bigger capacitor.` });
  if (parts.henries > 60e-6) notes.push({ severity: 'warning', message: `${formatSi(parts.henries, 'H', 2)} is a big coil to hang in a wire. A larger capacitor brings it down.` });
  return notes;
}

function TrapSection({ trap, coil, onChange, onCoil, goTo }: { trap: TrapDesign; coil: CoilDesign; onChange: (patch: Partial<TrapDesign>) => void; onCoil: (patch: Partial<CoilDesign>) => void; goTo: (tab: LcTab) => void }) {
  const parts = trapParts(trap);
  const spec: TrapSpec = { ...parts, q: trap.q };
  const [hover, setHover] = useState<number | undefined>();
  const freqs = logFrequencies(trap.fMHz / 4, trap.fMHz * 4, 361);
  const magnitude = freqs.map((f) => cAbs(trapImpedance(spec, f)) / 1000);
  const turns = halfTurns(turnsFor(parts.henries, coil));
  const notes = trapNotes(trap, parts);
  const bands = BANDS.filter(([, f]) => f >= freqs[0]! && f <= freqs[freqs.length - 1]!);

  const useCoilTab = () => onChange({ given: 'coil', henries: inductanceH(coil), q: round(coilQ(coil, trap.fMHz), 0) });
  const designCoil = () => {
    onCoil({ turns, atMHz: trap.fMHz });
    goTo('coil');
  };

  return (
    <div className="modeler">
      <aside className="panel">
        <section className="form-section">
          <h2>The trap</h2>
          <div className="band-buttons">
            {BANDS.map(([name, f]) => (
              <button key={name} type="button" className="small" aria-pressed={Math.abs(trap.fMHz - f) < 0.01} onClick={() => onChange({ fMHz: f })}>
                {name}
              </button>
            ))}
          </div>
          <NumberField label="Resonant at" value={trap.fMHz} above={0} unit="MHz" onCommit={(v) => onChange({ fMHz: v })} />
          <label className="field">
            <span className="field-label">Start from</span>
            <select value={trap.given} onChange={(e) => onChange({ given: e.target.value === 'capacitor' ? 'capacitor' : 'coil', ...parts })}>
              <option value="coil">the coil I have</option>
              <option value="capacitor">the capacitor I have</option>
            </select>
          </label>
          {trap.given === 'coil' ? (
            <div className="field-row">
              <NumberField label="Coil" value={round(trap.henries * 1e6, 3)} above={0} unit="µH" onCommit={(v) => onChange({ henries: v * 1e-6 })} />
              <button type="button" className="small" onClick={useCoilTab} title="The coil on the coil tab, with its Q">
                From the coil tab
              </button>
            </div>
          ) : (
            <NumberField label="Capacitor" value={round(trap.farads * 1e12, 1)} above={0} unit="pF" onCommit={(v) => onChange({ farads: v * 1e-12 })} />
          )}
          <NumberField label="Coil Q" value={trap.q} above={0} onCommit={(v) => onChange({ q: v })} />
          <p className="muted">
            Q at the trap frequency. The coil tab estimates it, or measures it: about {coilQ(coil, trap.fMHz).toFixed(0)} for the coil there now.
          </p>
        </section>
      </aside>

      <div className="workspace">
        <section className="panel">
          <h2 className="results-title">
            {trap.fMHz} MHz trap: {formatSi(parts.henries, 'H', 3)} across {formatSi(parts.farads, 'F', 3)}
          </h2>
          <dl className="summary">
            <div>
              <dt>{trap.given === 'coil' ? 'Capacitor needed' : 'Coil needed'}</dt>
              <dd>{trap.given === 'coil' ? formatSi(parts.farads, 'F', 4) : formatSi(parts.henries, 'H', 4)}</dd>
            </div>
            <div>
              <dt>Wind the coil</dt>
              <dd>
                {turns} turns
                <small>
                  of {wireName(coil)} on the coil tab's {coil.formerMm} mm former.{' '}
                  <button type="button" className="link" onClick={designCoil}>
                    Design that coil
                  </button>
                </small>
              </dd>
            </div>
            <div>
              <dt>Impedance at resonance</dt>
              <dd>
                {(resonantImpedanceOhms(spec) / 1000).toFixed(1)} kΩ<small>Q × the coil's reactance: what isolates the wire beyond it</small>
              </dd>
            </div>
            <div>
              <dt>Bandwidth</dt>
              <dd>
                {(bandwidthMHz(spec) * 1000).toFixed(0)} kHz<small>between the half-power points</small>
              </dd>
            </div>
          </dl>
          <div className="button-row">
            <button
              type="button"
              className="small"
              title="Offers it to the Antenna Modeler as a parallel load, with the coil's loss as the resistance across it"
              onClick={() => {
                saveLoadHandoff({ name: `${trap.fMHz} MHz trap`, savedAt: new Date().toISOString(), kind: 'parallel', ohms: resonantImpedanceOhms(spec), henries: parts.henries, farads: parts.farads });
                location.hash = '#/antenna';
              }}
            >
              Put this trap in an antenna
            </button>
            <span className="muted">Opens the Antenna Modeler, where it can go on any wire and be solved as part of the antenna.</span>
          </div>
        </section>

        <Notes notes={notes} />

        <LineChart title="Impedance across the trap" unit="kΩ" fMHz={freqs} series={[{ label: '|Z|', colour: 'var(--series-1)', values: magnitude }]} hover={hover} onHover={setHover} marks={[{ fMHz: trap.fMHz, label: `${trap.fMHz} MHz` }]} />

        <details className="panel" open>
          <summary>On the other bands</summary>
          <table className="band-table">
            <thead>
              <tr>
                <th scope="col">Band</th>
                <th scope="col">The trap is</th>
                <th scope="col">Impedance, Ω</th>
                <th scope="col">Loss resistance, Ω</th>
              </tr>
            </thead>
            <tbody>
              {bands.map(([name, f]) => {
                const view = trapAt(spec, f);
                const role =
                  view.role === 'trap' ? 'the trap: the wire ends here' : view.role === 'inductor' ? `a loading coil of ${formatSi(view.equivalentH!, 'H', 3)}` : `a capacitor of ${formatSi(view.equivalentF!, 'F', 3)}`;
                return (
                  <tr key={name}>
                    <th scope="row">{name}</th>
                    <td>{role}</td>
                    <td>{cAbs(view.z) >= 1000 ? `${(cAbs(view.z) / 1000).toFixed(1)} k` : cAbs(view.z).toFixed(1)}</td>
                    <td>{view.z.re >= 1000 ? `${(view.z.re / 1000).toFixed(1)} k` : view.z.re.toFixed(2)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="muted">
            Below resonance the outer wire is still part of the antenna, made electrically longer by the loading the trap adds. What that does to a
            particular antenna is a job for the Antenna Modeler.
          </p>
        </details>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the filter

export function filterNotes(filter: FilterDesign, ladder: Ladder): Note[] {
  const notes: Note[] = [];
  if (filter.family === 'chebyshev' && filter.order % 2 === 0) {
    notes.push({
      severity: 'warning',
      message: `An even-order Chebyshev wants unequal terminations: this one is designed for a ${ladder.loadOhms.toFixed(1)} Ω load. With ${filter.z0} Ω at both ends the passband is not the textbook ripple; the dashed curve shows it with the load it wants. An odd order avoids the problem.`,
    });
  }
  if (filter.qInductor < 30) notes.push({ severity: 'warning', message: `Coils of Q ${filter.qInductor} make a lossy filter; the passband loss shows it. Thicker wire on a bigger former helps, and so does spacing the turns.` });
  if (filter.cutoffMHz > 300) notes.push({ severity: 'warning', message: 'Above VHF a coil is a length of wire and a capacitor has leads: lumped-part designs stop meaning what they say. This method is for HF and low VHF.' });
  return notes;
}

function FilterSection({ filter, coil, onChange, goTo }: { filter: FilterDesign; coil: CoilDesign; onChange: (patch: Partial<FilterDesign>) => void; goTo: (tab: LcTab) => void }) {
  const designed = synthesise(filter);
  const ladder = filter.standardCapacitors ? withStandardCapacitors(designed) : designed;
  const q = { inductor: filter.qInductor, capacitor: filter.qCapacitor };
  const ends = { z0: filter.z0 };
  const fc = filter.cutoffMHz;
  const [hover, setHover] = useState<number | undefined>();
  const [measured, setMeasured] = useState<{ points: TransmissionPoint[]; source: string }>();
  const freqs = logFrequencies(fc / 8, fc * 8, 361);
  const points = sweepResponse(ladder, ends, freqs, q);
  const unequal = Math.abs(ladder.loadOhms - filter.z0) > 0.01 * filter.z0;
  const asDesigned = unequal ? sweepResponse(ladder, { z0: filter.z0, loadOhms: ladder.loadOhms }, freqs, q) : undefined;
  const low = filter.kind === 'lowpass';
  const inBand = respond(ladder, ends, low ? fc * 0.8 : fc / 0.8, q);
  const harmonics = [2, 3].map((n) => ({ n, fMHz: low ? fc * n : fc / n, lossDb: respond(ladder, ends, low ? fc * n : fc / n, q).lossDb }));
  const notes = filterNotes(filter, ladder);
  const title = `${ordinal(filter.order)}-order ${filter.family === 'butterworth' ? 'Butterworth' : `Chebyshev, ${filter.rippleDb} dB ripple,`} ${low ? 'low-pass' : 'high-pass'}, ${fc} MHz cutoff`;

  const build = (part: LadderElement) => {
    if (part.kind === 'inductor') {
      const turns = halfTurns(turnsFor(part.value, coil));
      return `${turns} turns on the coil tab's ${coil.formerMm} mm former`;
    }
    const standard = nearestStandard(part.value);
    return Math.abs(standard - part.value) / part.value < 1e-9 ? 'a standard value' : `nearest E24: ${formatSi(standard, 'F', 3)}`;
  };

  return (
    <div className="modeler">
      <aside className="panel">
        <section className="form-section">
          <h2>The filter</h2>
          <div className="field-row">
            <label className="field">
              <span className="field-label">Kind</span>
              <select value={filter.kind} onChange={(e) => onChange({ kind: e.target.value === 'highpass' ? 'highpass' : 'lowpass' })}>
                <option value="lowpass">Low-pass</option>
                <option value="highpass">High-pass</option>
              </select>
            </label>
            <label className="field">
              <span className="field-label">Shape</span>
              <select value={filter.family} onChange={(e) => onChange({ family: e.target.value === 'chebyshev' ? 'chebyshev' : 'butterworth' })}>
                <option value="butterworth">Butterworth (flat)</option>
                <option value="chebyshev">Chebyshev (steeper, rippled)</option>
              </select>
            </label>
          </div>
          <div className="field-row">
            <NumberField label="Order" value={filter.order} min={MIN_ORDER} integer onCommit={(v) => onChange({ order: Math.max(MIN_ORDER, Math.min(MAX_ORDER, Math.round(v))) })} />
            <NumberField label="Cutoff" value={fc} above={0} unit="MHz" onCommit={(v) => onChange({ cutoffMHz: v })} />
          </div>
          {filter.family === 'chebyshev' && (
            <label className="field">
              <span className="field-label">Passband ripple</span>
              <select value={filter.rippleDb} onChange={(e) => onChange({ rippleDb: Number(e.target.value) })}>
                {[0.01, 0.1, 0.5, 1].map((r) => (
                  <option key={r} value={r}>
                    {r} dB
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="field-row">
            <NumberField label="Impedance" value={filter.z0} above={0} unit="Ω" onCommit={(v) => onChange({ z0: v })} />
            <label className="field">
              <span className="field-label">Nearest the source</span>
              <select value={filter.first} onChange={(e) => onChange({ first: e.target.value === 'series' ? 'series' : 'shunt' })}>
                <option value="shunt">{low ? 'a shunt capacitor' : 'a shunt coil'}</option>
                <option value="series">{low ? 'a series coil' : 'a series capacitor'}</option>
              </select>
            </label>
          </div>
        </section>

        <section className="form-section">
          <h2>The parts as they will be</h2>
          <div className="field-row">
            <NumberField label="Coil Q" value={filter.qInductor} above={0} onCommit={(v) => onChange({ qInductor: v })} />
            <button type="button" className="small" onClick={() => onChange({ qInductor: round(coilQ(coil, fc), 0) })} title="The coil tab's Q at the cutoff frequency">
              From the coil tab ({coilQ(coil, fc).toFixed(0)})
            </button>
          </div>
          <NumberField label="Capacitor Q" value={filter.qCapacitor} above={0} onCommit={(v) => onChange({ qCapacitor: v })} />
          <label className="check">
            <input type="checkbox" checked={filter.standardCapacitors} onChange={(e) => onChange({ standardCapacitors: e.target.checked })} />
            Round the capacitors to E24 values, and show what that does
          </label>
        </section>
      </aside>

      <div className="workspace">
        <section className="panel">
          <h2 className="results-title">{title}</h2>
          <table className="band-table parts-table">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Part</th>
                <th scope="col">Value</th>
                <th scope="col">Build it</th>
              </tr>
            </thead>
            <tbody>
              {ladder.elements.map((part, i) => (
                <tr key={i}>
                  <th scope="row">{i + 1}</th>
                  <td>
                    {part.position} {part.kind === 'inductor' ? 'coil' : 'capacitor'}
                  </td>
                  <td>{formatSi(part.value, part.kind === 'inductor' ? 'H' : 'F', 3)}</td>
                  <td>{build(part)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            Coils are wound to order:{' '}
            <button type="button" className="link" onClick={() => goTo('coil')}>
              change the former or wire on the coil tab
            </button>
            . Source and load {filter.z0} Ω{unequal ? `; designed for a ${ladder.loadOhms.toFixed(1)} Ω load` : ''}.
          </p>
          <dl className="summary">
            <div>
              <dt>In the passband, at {inBand.fMHz.toFixed(2)} MHz</dt>
              <dd>
                {inBand.lossDb.toFixed(2)} dB loss<small>SWR {Number.isFinite(inBand.swr) ? inBand.swr.toFixed(2) : '∞'}</small>
              </dd>
            </div>
            {harmonics.map((h) => (
              <div key={h.n}>
                <dt>
                  {low ? `${h.n === 2 ? 'Second' : 'Third'} harmonic, ${h.fMHz.toFixed(1)} MHz` : `At a ${h.n === 2 ? 'half' : 'third'} of cutoff, ${h.fMHz.toFixed(2)} MHz`}
                </dt>
                <dd>{h.lossDb.toFixed(1)} dB down</dd>
              </div>
            ))}
          </dl>
        </section>

        <Notes notes={notes} />

        <LineChart
          title="Attenuation"
          unit="dB"
          fMHz={freqs}
          series={[
            { label: `with ${filter.z0} Ω at both ends`, colour: 'var(--series-1)', values: points.map((p) => p.lossDb) },
            ...(asDesigned ? [{ label: `with the ${ladder.loadOhms.toFixed(0)} Ω load it wants`, colour: 'var(--series-2)', dashed: true, values: asDesigned.map((p) => p.lossDb) }] : []),
            ...(measured
              ? [{ label: 'measured', colour: 'var(--series-3)', dashed: true, values: measured.points.map((p) => Math.min(100, -s21Db(p.s21))), fMHz: measured.points.map((p) => p.fMHz) }]
              : []),
          ]}
          ceiling={100}
          marks={[{ fMHz: fc, label: 'cutoff' }, ...(low ? [{ fMHz: 2 * fc, label: '2×' }, { fMHz: 3 * fc, label: '3×' }] : [{ fMHz: fc / 2, label: '½' }, { fMHz: fc / 3, label: '⅓' }])]}
          hover={hover}
          onHover={setHover}
        />
        <LineChart
          title="Return loss at the input"
          unit="dB"
          fMHz={freqs}
          series={[{ label: 'return loss', colour: 'var(--series-1)', values: points.map((p) => p.returnLossDb) }]}
          ceiling={40}
          guides={[14]}
          marks={[{ fMHz: fc }]}
          hover={hover}
          onHover={setHover}
        />
        <p className="muted">
          Return loss 14 dB is SWR 1.5:1. The passband edge of a Butterworth is its 3 dB point; of a Chebyshev, the last ripple.
        </p>
        <details className="panel measure-filter">
          <summary>Measure the filter you built</summary>
          <p className="muted">
            Port 1 into the filter, port 2 out of it. Its attenuation is drawn dashed over the design{measured ? ` - ${measured.source}` : ''}.
          </p>
          <MeasureTransmission
            startMHz={Number((fc / 8).toPrecision(4))}
            stopMHz={Number(Math.min(fc * 8, 3000).toPrecision(4))}
            action="Measure the filter"
            onMeasured={(pts, source) => setMeasured({ points: pts, source })}
          />
        </details>
      </div>
    </div>
  );
}
