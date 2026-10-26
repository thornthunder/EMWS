// A trap made of coax, on the trap tab: the coil of cable, what it resonates at, and the
// lumped trap it amounts to. The maths is coaxtrap.ts; this is the form and the readouts.

import { useState } from 'react';
import { cAbs } from '../../lib/complex';
import { saveLoadHandoff } from '../../lib/handoff';
import { LineChart } from '../../ui/LineChart';
import { NumberField } from '../../ui/NumberField';
import { formatSi } from '../smith-chart/units';
import { catalogueGroups } from '../toolbox/coax';
import { savedDatasheetCable } from '../toolbox/model';
import { type CoaxTrapSpec, braidQuality, cableCapacitanceF, cableLengthM, coaxTrapAt, coaxTrapImpedance, coilInductanceH, lumpedEquivalent, turnsForCoaxTrap } from './coaxtrap';
import { C0 } from './coil';
import { logFrequencies } from './filter';
import { BANDS, type TrapDesign } from './model';
import { cableOf } from './StubSection';

export type TrapBuild = TrapDesign['build'];

/** Which kind of trap the tab is designing; both sections show it at the top of their form. */
export function BuildPicker({ build, onChange }: { build: TrapBuild; onChange: (build: TrapBuild) => void }) {
  return (
    <label className="field">
      <span className="field-label">Built from</span>
      <select value={build} onChange={(e) => onChange(e.target.value === 'coax' ? 'coax' : 'lumped')}>
        <option value="lumped">a coil and a capacitor</option>
        <option value="coax">a coil of coax</option>
      </select>
    </label>
  );
}

const round = (v: number, digits: number) => Number(v.toFixed(digits));
const shortName = (name: string) => name.replace(/ \(.*\)$/, '');

/** The cable's overall diameter: typed, else the catalogue's nominal; a datasheet cable has none. */
export function jacketMmOf(trap: TrapDesign): number | undefined {
  const cable = cableOf(trap.coax.cableId);
  return trap.coax.jacketMm ?? (cable.loss.kind === 'geometry' ? cable.loss.geometry.outerMm : undefined);
}

export function coaxSpecOf(trap: TrapDesign): CoaxTrapSpec | undefined {
  const jacketMm = jacketMmOf(trap);
  if (!(jacketMm && jacketMm > 0)) return undefined;
  return { cable: cableOf(trap.coax.cableId), jacketMm, formerMm: trap.coax.formerMm, turns: trap.coax.turns, q: trap.coax.q };
}

interface Note {
  severity: 'warning' | 'error';
  message: string;
}

const kOhms = (ohms: number) => (ohms >= 1000 ? `${(ohms / 1000).toFixed(1)} k` : ohms.toFixed(ohms >= 100 ? 1 : 2));

export function CoaxTrapSection({ trap, onChange }: { trap: TrapDesign; onChange: (patch: Partial<TrapDesign>) => void }) {
  const [hover, setHover] = useState<number | undefined>();
  const setCoax = (patch: Partial<TrapDesign['coax']>) => onChange({ coax: { ...trap.coax, ...patch } });
  const cable = cableOf(trap.coax.cableId);
  const spec = coaxSpecOf(trap);
  const eq = spec ? lumpedEquivalent(spec) : undefined;
  const f0 = eq?.f0MHz ?? 0;
  const centre = f0 > 0 ? f0 : trap.fMHz;
  const quality = spec ? braidQuality(spec, centre) : undefined;
  const freqs = logFrequencies(centre / 4, centre * 4, 361);
  const magnitude = spec ? freqs.map((f) => cAbs(coaxTrapImpedance(spec, f)) / 1000) : [];
  const bands = BANDS.filter(([, f]) => f >= freqs[0]! && f <= freqs[freqs.length - 1]!);

  const notes: Note[] = [];
  if (!spec) {
    notes.push({ severity: 'error', message: `${shortName(cable.name)} has no overall diameter on record: type the cable's diameter over its jacket, which sets the pitch of the coil.` });
  } else if (!eq) {
    notes.push({ severity: 'error', message: 'No resonance found between 0.1 and 1000 MHz for this coil - check the turns and the former.' });
  } else {
    const theta = ((2 * Math.PI * f0 * 1e6) / (C0 * cable.velocityFactor)) * cableLengthM(spec);
    const rule = 1 / (2 * Math.PI * Math.sqrt(coilInductanceH(spec) * cableCapacitanceF(spec))) / 1e6;
    if (theta > 0.5) {
      notes.push({
        severity: 'warning',
        message:
          `At ${f0.toFixed(2)} MHz the cable in this coil is ${((theta * 180) / Math.PI).toFixed(0)}° long electrically. The usual rule - 1 / (2π√(LC)) with the ` +
          `whole cable's capacitance - would put the resonance ${((rule / f0 - 1) * 100).toFixed(0)} % higher; the cable's own inductance is in the figure here. ` +
          `It is still a calculation: build it a little high and measure.`,
      });
    }
  }

  const turnsFor = () => {
    if (!spec) return;
    setCoax({ turns: round(turnsForCoaxTrap(trap.fMHz, spec), 2) });
  };

  return (
    <div className="modeler">
      <aside className="panel">
        <section className="form-section">
          <h2>The trap</h2>
          <BuildPicker build={trap.build} onChange={(build) => onChange({ build })} />
          <div className="band-buttons">
            {BANDS.map(([name, f]) => (
              <button key={name} type="button" className="small" aria-pressed={Math.abs(trap.fMHz - f) < 0.01} onClick={() => onChange({ fMHz: f })}>
                {name}
              </button>
            ))}
          </div>
          <NumberField label="Resonant at" value={trap.fMHz} above={0} unit="MHz" onCommit={(v) => onChange({ fMHz: v })} />
          <label className="field">
            <span className="field-label">Cable</span>
            <select value={trap.coax.cableId} onChange={(e) => setCoax({ cableId: e.target.value, jacketMm: undefined })}>
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
          <div className="field-row">
            <NumberField label="Former" value={trap.coax.formerMm} above={0} unit="mm" onCommit={(v) => setCoax({ formerMm: v })} />
            <NumberField label="Cable diameter" value={round(jacketMmOf(trap) ?? 0, 2)} min={0} unit="mm" onCommit={(v) => setCoax({ jacketMm: v > 0 ? v : undefined })} />
          </div>
          <div className="field-row">
            <NumberField label="Turns" value={trap.coax.turns} above={0} onCommit={(v) => setCoax({ turns: v })} />
            <button type="button" className="small" onClick={turnsFor} disabled={!spec} title="How many turns of this cable on this former resonate at the frequency above">
              Turns for {trap.fMHz} MHz
            </button>
          </div>
          <div className="field-row">
            <NumberField label="Coil Q" value={trap.coax.q} above={0} onCommit={(v) => setCoax({ q: v })} />
            {quality && (
              <button type="button" className="small" onClick={() => setCoax({ q: round(quality.closeWound, 0) })} title="Medhurst's close-wound estimate for the braid">
                Use the estimate ({quality.closeWound.toFixed(0)})
              </button>
            )}
          </div>
          <p className="muted">
            The braid's loss, as a Q at the trap frequency. Skin effect alone would allow about {quality ? quality.upper.toFixed(0) : '?'}; close-wound, Medhurst's
            factor says {quality ? quality.closeWound.toFixed(0) : '?'}. The cable's own losses, inner conductor and dielectric, are in the model already. Measure
            the finished trap if it matters.
          </p>
        </section>
      </aside>

      <div className="workspace">
        <section className="panel">
          <h2 className="results-title">
            {eq ? `${f0.toFixed(2)} MHz coax trap: ${trap.coax.turns} turns of ${shortName(cable.name)} on a ${trap.coax.formerMm} mm former` : `Coax trap: ${trap.coax.turns} turns of ${shortName(cable.name)}`}
          </h2>
          {spec && eq && (
            <>
              <dl className="summary">
                <div>
                  <dt>Resonates at</dt>
                  <dd>
                    {f0.toFixed(3)} MHz<small>{Math.abs(f0 - trap.fMHz) / trap.fMHz > 0.005 ? `${trap.fMHz} MHz was asked for: press Turns for ${trap.fMHz} MHz` : 'as asked'}</small>
                  </dd>
                </div>
                <div>
                  <dt>Cable to wind</dt>
                  <dd>
                    {cableLengthM(spec).toFixed(2)} m<small>its {formatSi(cableCapacitanceF(spec), 'F', 3)} is the capacitor; strip the ends at the coil</small>
                  </dd>
                </div>
                <div>
                  <dt>As a trap</dt>
                  <dd>
                    {formatSi(eq.henries, 'H', 3)} across {formatSi(eq.farads, 'F', 3)}
                    <small>the coil alone is {formatSi(coilInductanceH(spec), 'H', 3)}: the trap sees four times it plus the cable's own inductance, across a quarter of the cable's capacitance</small>
                  </dd>
                </div>
                <div>
                  <dt>Impedance at resonance</dt>
                  <dd>
                    {kOhms(eq.ohms)}Ω<small>Q {eq.q.toFixed(0)} all told, the cable's losses included</small>
                  </dd>
                </div>
                <div>
                  <dt>Bandwidth</dt>
                  <dd>
                    {(eq.bandwidthMHz * 1000).toFixed(0)} kHz<small>between the half-power points</small>
                  </dd>
                </div>
              </dl>
              <div className="button-row">
                <button
                  type="button"
                  className="small"
                  title="Offers it to the Antenna Modeler as a parallel load: the lumped trap it amounts to about its resonance"
                  onClick={() => {
                    saveLoadHandoff({ name: `${f0.toFixed(2)} MHz coax trap`, savedAt: new Date().toISOString(), kind: 'parallel', ohms: eq.ohms, henries: eq.henries, farads: eq.farads });
                    location.hash = '#/antenna';
                  }}
                >
                  Put this trap in an antenna
                </button>
                <span className="muted">Opens the Antenna Modeler, where it can go on any wire and be solved as part of the antenna.</span>
              </div>
            </>
          )}
        </section>

        {notes.length > 0 && (
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
        )}

        {spec && (
          <LineChart
            title="Impedance across the trap"
            unit="kΩ"
            fMHz={freqs}
            series={[{ label: '|Z|', colour: 'var(--series-1)', values: magnitude }]}
            hover={hover}
            onHover={setHover}
            marks={eq ? [{ fMHz: f0, label: `${f0.toFixed(2)} MHz` }] : []}
          />
        )}

        {spec && eq && (
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
                  const view = coaxTrapAt(spec, f, eq);
                  const role =
                    view.role === 'trap' ? 'the trap: the wire ends here' : view.role === 'inductor' ? `a loading coil of ${formatSi(view.equivalentH!, 'H', 3)}` : `a capacitor of ${formatSi(view.equivalentF!, 'F', 3)}`;
                  return (
                    <tr key={name}>
                      <th scope="row">{name}</th>
                      <td>{role}</td>
                      <td>{kOhms(cAbs(view.z))}</td>
                      <td>{kOhms(view.z.re)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="muted">
              Below resonance the outer wire is still part of the antenna, made electrically longer by the loading the trap adds. What that does to a particular antenna
              is a job for the Antenna Modeler.
            </p>
          </details>
        )}
      </div>
    </div>
  );
}
