// Baluns and ununs: choose a core, wind it, and see what it does before cutting wire.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Complex, cAbs } from '../../lib/complex';
import { type ImpedanceHandoff, saveImpedanceHandoff } from '../../lib/handoff';
import { formatImpedance } from '../../lib/rf';
import { guideForTool } from '../../guides/registry';
import { MATERIALS, type Material } from './catalog';
import { LineChart, type Series } from './Charts';
import { type Analysis, type Point, analyse } from './circuit';
import { DesignPanel } from './DesignPanel';
import { type Design, checkDesign, coreOf, efhwDesign, summarise, tappedTurns, windTo } from './model';
import { WindingPad } from './WindingPad';

const DESIGN_KEY = 'emws.balun.v1';
const MATERIALS_KEY = 'emws.balun.materials.v1';

/** A frequency to stand for each band, MHz. */
const BANDS: [string, number][] = [
  ['160 m', 1.85],
  ['80 m', 3.6],
  ['40 m', 7.1],
  ['30 m', 10.12],
  ['20 m', 14.2],
  ['17 m', 18.1],
  ['15 m', 21.2],
  ['12 m', 24.94],
  ['10 m', 28.5],
];

function read<T>(key: string, ok: (value: unknown) => value is T): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return undefined;
    const value: unknown = JSON.parse(raw);
    return ok(value) ? value : undefined;
  } catch {
    return undefined; // storage can be blocked, or hold something from an older version
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // see read()
  }
}

const isDesign = (v: unknown): v is Design =>
  typeof v === 'object' && v !== null && Array.isArray((v as Design).steps) && typeof (v as Design).topology === 'string' && typeof (v as Design).overrides === 'object';
const isMaterials = (v: unknown): v is Material[] => Array.isArray(v) && v.every((m) => typeof (m as Material)?.id === 'string' && Array.isArray((m as Material).curve));

interface History {
  past: Design[];
  present: Design;
  future: Design[];
}

function nearest(points: Point[], fMHz: number): number {
  let best = 0;
  for (let i = 1; i < points.length; i++) if (Math.abs(Math.log(points[i]!.fMHz / fMHz)) < Math.abs(Math.log(points[best]!.fMHz / fMHz))) best = i;
  return best;
}

/** The antenna's impedance at any frequency: straight lines between the modelled points. */
function loadFrom(handoff: ImpedanceHandoff): (fMHz: number) => Complex {
  const points = [...handoff.points].sort((a, b) => a.fMHz - b.fMHz);
  return (fMHz) => {
    const first = points[0]!;
    const last = points[points.length - 1]!;
    if (fMHz <= first.fMHz) return { re: first.r, im: first.x };
    if (fMHz >= last.fMHz) return { re: last.r, im: last.x };
    const hi = points.findIndex((p) => p.fMHz >= fMHz);
    const a = points[hi - 1]!;
    const b = points[hi]!;
    const t = (fMHz - a.fMHz) / (b.fMHz - a.fMHz);
    return { re: a.r + (b.r - a.r) * t, im: a.x + (b.x - a.x) * t };
  };
}

const ohms = (v: number) => (v >= 10_000 ? `${(v / 1000).toFixed(1)} kΩ` : v >= 1000 ? `${(v / 1000).toFixed(2)} kΩ` : `${v.toFixed(0)} Ω`);

export function BalunTool() {
  const [history, setHistory] = useState<History>(() => ({ past: [], present: read(DESIGN_KEY, isDesign) ?? efhwDesign(), future: [] }));
  const [measured, setMeasured] = useState<Material[]>(() => read(MATERIALS_KEY, isMaterials) ?? []);
  const [compareId, setCompareId] = useState('');
  const [antenna, setAntenna] = useState<ImpedanceHandoff | undefined>(undefined);
  const [hover, setHover] = useState<number | undefined>(undefined);
  const [lookAtMHz, setLookAtMHz] = useState(3.6);
  const [sent, setSent] = useState(false);
  const gesture = useRef(false);

  const design = history.present;
  const materials = useMemo(() => [...MATERIALS, ...measured], [measured]);
  const material = materials.find((m) => m.id === design.materialId) ?? MATERIALS[1]!;
  const compare = materials.find((m) => m.id === compareId && m.id !== material.id);

  /** Every edit is one undo step, except a drag, which is one step however far it goes. */
  const setDesign = useCallback((next: Design) => {
    setSent(false);
    setHistory((h) => (gesture.current ? { ...h, present: next } : { past: [...h.past.slice(-99), h.present], present: next, future: [] }));
  }, []);
  const onGesture = useCallback((active: boolean) => {
    if (active) setHistory((h) => ({ past: [...h.past.slice(-99), h.present], present: h.present, future: [] }));
    gesture.current = active;
  }, []);
  const undo = () => setHistory((h) => (h.past.length === 0 ? h : { past: h.past.slice(0, -1), present: h.past[h.past.length - 1]!, future: [h.present, ...h.future] }));
  const redo = () => setHistory((h) => (h.future.length === 0 ? h : { past: [...h.past, h.present], present: h.future[0]!, future: h.future.slice(1) }));

  useEffect(() => write(DESIGN_KEY, design), [design]);
  useEffect(() => write(MATERIALS_KEY, measured), [measured]);

  const pickCore = (coreId: string, materialId: string) => {
    const same = design.coreId === coreId && design.materialId === materialId;
    setDesign({ ...design, coreId, materialId, customCore: undefined, stack: same ? Math.min(4, design.stack + 1) : 1 });
  };

  const issues = useMemo(() => checkDesign(design), [design]);
  const blocked = issues.some((i) => i.severity === 'error');
  const loadAt = useMemo(() => (antenna ? loadFrom(antenna) : undefined), [antenna]);
  const analysis: Analysis | undefined = useMemo(() => (blocked ? undefined : analyse(design, material, loadAt)), [blocked, design, material, loadAt]);
  const rival: Analysis | undefined = useMemo(() => (blocked || !compare ? undefined : analyse(design, compare, loadAt)), [blocked, design, compare, loadAt]);

  const tapped = design.topology === 'autotransformer';
  const summary = summarise(design.steps);
  const core = coreOf(design);
  const guide = guideForTool('#/balun');

  const index = analysis ? (hover ?? nearest(analysis.points, lookAtMHz)) : 0;
  const at = analysis?.points[index];
  const rivalAt = rival?.points[index];

  const fMHz = analysis?.points.map((p) => p.fMHz) ?? [];
  const pair = (pick: (p: Point) => number, single = 'this design'): Series[] => {
    if (!analysis) return [];
    const mine: Series = { label: rival ? `${core.name}-${material.name.replace('#', '')}` : single, colour: 'var(--series-1)', values: analysis.points.map(pick) };
    return rival && compare ? [mine, { label: `${core.name}-${compare.name.replace('#', '')}`, colour: 'var(--series-2)', dashed: true, values: rival.points.map(pick) }] : [mine];
  };

  const title = tapped
    ? `${analysis ? analysis.ratio.toFixed(analysis.ratio % 1 === 0 ? 0 : 1) : '?'}:1 · ${tappedTurns(design).primary} : ${summary.totalTurns} turns`
    : design.topology === 'guanella-1-1'
      ? `1:1 current balun · ${summary.totalTurns} turns`
      : `1:4 Guanella · ${summary.totalTurns} turns on ${design.positions === 2 ? 'each of two cores' : 'one core'}`;

  const send = () => {
    if (!analysis) return;
    saveImpedanceHandoff({
      name: `${title} on ${core.name}-${material.name.replace('#', '')} (radio side)`,
      savedAt: new Date().toISOString(),
      points: analysis.points.map((p) => ({ fMHz: p.fMHz, r: p.zIn.re, x: p.zIn.im })),
    });
    setSent(true);
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>Baluns and ununs</h1>
        <p className="muted">
          Pick a core, wind it, and see what it will do - match, loss and heat - before you cut any wire.
          {guide && (
            <>
              {' '}
              <a href={`#/guides/${guide.id}`}>How to use this</a>
            </>
          )}
        </p>
      </header>

      <div className="modeler">
        <aside className="panel">
          <DesignPanel
            design={design}
            materials={materials}
            analysis={analysis}
            compareId={compare ? compare.id : ''}
            onCompare={setCompareId}
            onChange={setDesign}
            onPickCore={pickCore}
            onAddMaterial={(m) => {
              setMeasured((list) => [...list.filter((x) => x.id !== m.id), m]);
              setDesign({ ...design, materialId: m.id });
            }}
            onRemoveMaterial={(id) => {
              setMeasured((list) => list.filter((x) => x.id !== id));
              if (design.materialId === id) setDesign({ ...design, materialId: '43' });
            }}
            antenna={antenna}
            onAntenna={setAntenna}
            canUndo={history.past.length > 0}
            canRedo={history.future.length > 0}
            onUndo={undo}
            onRedo={redo}
          />
        </aside>

        <div className="workspace">
          <WindingPad design={design} materialName={material.name} onDropCore={pickCore} onWindTo={(total) => setDesign({ ...design, steps: windTo(design.steps, total) })} onGesture={onGesture} />

          {issues.length > 0 && (
            <ul className="issues">
              {issues.map((issue) => (
                <li key={issue.message} className={`issue issue-${issue.severity}`}>
                  <span className="issue-mark" aria-hidden="true">
                    {issue.severity === 'error' ? '✕' : '!'}
                  </span>
                  <span className="issue-text">{issue.message}</span>
                </li>
              ))}
            </ul>
          )}

          {analysis && at && (
            <>
              <section className="panel">
                <h2 className="results-title">{title}</h2>
                <p className="muted">
                  {material.curve ? (
                    <>
                      Core behaviour from <strong>your measurement</strong> of {material.name}.
                    </>
                  ) : (
                    <>
                      Core behaviour is EMWS's <strong>built-in estimate</strong> for {material.name} (μᵢ {material.muInitial}, A<sub>L</sub>{' '}
                      {analysis.alNh.toFixed(0)} nH/N²) - a first approximation. Measure your core to replace it.
                    </>
                  )}
                </p>
                <div className="band-buttons" role="group" aria-label="Look at a band">
                  {BANDS.filter(([, f]) => f >= design.sweep.startMHz && f <= design.sweep.stopMHz).map(([name, f]) => (
                    <button key={name} type="button" className="small" aria-pressed={hover === undefined && nearest(analysis.points, f) === index} onClick={() => setLookAtMHz(f)}>
                      {name}
                    </button>
                  ))}
                </div>
                <Readout at={at} rival={rivalAt} rivalName={compare?.name} design={design} tapped={tapped} />
                {compare && !material.curve && !compare.curve && material.family === compare.family && (
                  <p className="alert-inline">
                    <strong>Do not read the loss figures as a verdict on these two mixes.</strong> Both are built-in estimates, and
                    the estimate gives every mix in the {material.family} family the same loss resistance - a limit of describing a
                    ferrite by two numbers, not a finding. The <em>match</em> comparison is meaningful; the <em>loss</em> comparison
                    is not. Measure both cores (below, left) and this becomes a real comparison.
                  </p>
                )}
                <div className="button-row">
                  <button type="button" className="small" onClick={send}>
                    Send what the radio sees to the Smith chart
                  </button>
                  {sent && (
                    <span className="muted">
                      Saved. <a href="#/smith">Open the Smith chart</a> and choose it as the load.
                    </span>
                  )}
                </div>
              </section>

              <LineChart title="SWR at the radio" unit="" fMHz={fMHz} series={pair((p) => p.swr)} floor={1} ceiling={6} guides={[1.5, 2, 3]} hover={hover} onHover={setHover} />
              {design.topology !== 'guanella-1-1' && (
                <>
                  <LineChart title="Loss inside the transformer" unit="dB" fMHz={fMHz} series={pair((p) => p.lossDb)} ceiling={6} hover={hover} onHover={setHover} />
                  <LineChart title={`Heat in the core at ${design.powerW} W`} unit="W" fMHz={fMHz} series={pair((p) => p.coreW)} hover={hover} onHover={setHover} />
                </>
              )}
              {!tapped && (
                <LineChart
                  title="Common-mode (choking) impedance"
                  unit="Ω"
                  fMHz={fMHz}
                  series={
                    rival
                      ? pair((p) => cAbs(p.zCore))
                      : [
                          { label: '|Z|', colour: 'var(--series-1)', values: analysis.points.map((p) => cAbs(p.zCore)) },
                          { label: 'resistive part', colour: 'var(--series-2)', values: analysis.points.map((p) => p.zCore.re) },
                          { label: 'reactive part (its size: it changes sign at resonance)', colour: 'var(--series-3)', values: analysis.points.map((p) => Math.abs(p.zCore.im)) },
                        ]
                  }
                  format={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0))}
                  hover={hover}
                  onHover={setHover}
                />
              )}
              <LineChart
                title={`Permeability of ${material.name}${material.curve ? ' (measured)' : ' (estimate)'}`}
                unit=""
                fMHz={fMHz}
                series={[
                  { label: 'μ′ stores', colour: 'var(--series-1)', values: analysis.points.map((p) => p.mu.real) },
                  { label: 'μ″ loses', colour: 'var(--series-3)', values: analysis.points.map((p) => p.mu.loss) },
                ]}
                hover={hover}
                onHover={setHover}
              />

              <BandTable analysis={analysis} rival={rival} rivalName={compare?.name} design={design} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Readout({ at, rival, rivalName, design, tapped }: { at: Point; rival: Point | undefined; rivalName: string | undefined; design: Design; tapped: boolean }) {
  const choke = design.topology === 'guanella-1-1';
  const percent = (p: Point) => (p.acceptedW > 0 ? ((p.coreW + p.copperW) / p.acceptedW) * 100 : 0);
  /** A headline figure, and the smaller print that qualifies it. */
  const rows: [string, (p: Point) => string, ((p: Point) => string)?][] = [
    ['Radio sees', (p) => `${formatImpedance(p.zIn)} Ω`],
    ['SWR', (p) => (Number.isFinite(p.swr) ? `${p.swr.toFixed(2)} : 1` : '∞')],
  ];
  if (!choke) {
    rows.push(
      ['Lost inside', (p) => `${p.lossDb.toFixed(2)} dB`, (p) => `${percent(p).toFixed(0)} % of what goes in`],
      ['Heat in the core', (p) => `${p.coreW.toFixed(1)} W`],
      ['Core warms by', (p) => `~${p.tempRiseC.toFixed(0)} °C`, () => 'still air, rule of thumb'],
      ['Flux density', (p) => `${p.fluxMt.toFixed(1)} mT`, (p) => `${(p.fluxOfSaturation * 100).toFixed(0)} % of saturation`],
    );
  }
  rows.push(
    tapped
      ? ['Across the radio', (p) => ohms(cAbs(p.zCore)), (p) => `${(cAbs(p.zCore) / design.z0).toFixed(1)} × the radio's impedance`]
      : ['Chokes with', (p) => ohms(cAbs(p.zCore)), (p) => `${ohms(p.zCore.re)} of it resistive`],
  );

  return (
    <>
      <p className="readout-frequency">
        At <strong>{at.fMHz.toFixed(at.fMHz < 10 ? 2 : 1)} MHz</strong>
        {rival && rivalName ? <span className="muted"> · second figure is the same winding on {rivalName}</span> : null}
      </p>
      <dl className="summary">
        {rows.map(([label, show, note]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              {show(at)}
              {rival && <span className="rival-value">{show(rival)}</span>}
            </dd>
            {note && <small>{note(at)}</small>}
          </div>
        ))}
      </dl>
      {!choke && design.dutyPct < 100 && <p className="muted">Warming is worked out at {design.dutyPct} % of the time on; heat and loss are for the carrier.</p>}
    </>
  );
}

function BandTable({ analysis, rival, rivalName, design }: { analysis: Analysis; rival: Analysis | undefined; rivalName: string | undefined; design: Design }) {
  const bands = BANDS.filter(([, f]) => f >= design.sweep.startMHz && f <= design.sweep.stopMHz);
  if (bands.length === 0) return null;
  const choke = design.topology === 'guanella-1-1';
  return (
    <details className="panel" open>
      <summary>Band by band{rival && rivalName ? ` (in brackets: on ${rivalName})` : ''}</summary>
      <table className="band-table">
        <thead>
          <tr>
            <th scope="col">Band</th>
            <th scope="col">SWR</th>
            {choke ? (
              <th scope="col">Chokes with</th>
            ) : (
              <>
                <th scope="col">Loss, dB</th>
                <th scope="col">Core heat, W</th>
                <th scope="col">Warms by, °C</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {bands.map(([name, f]) => {
            const i = nearest(analysis.points, f);
            const p = analysis.points[i]!;
            const r = rival?.points[i];
            const cell = (mine: string, theirs: string | undefined) => (
              <td>
                {mine}
                {theirs !== undefined && <span className="muted"> ({theirs})</span>}
              </td>
            );
            return (
              <tr key={name}>
                <th scope="row">{name}</th>
                {cell(p.swr.toFixed(2), r?.swr.toFixed(2))}
                {choke ? (
                  cell(ohms(cAbs(p.zCore)), r && ohms(cAbs(r.zCore)))
                ) : (
                  <>
                    {cell(p.lossDb.toFixed(2), r?.lossDb.toFixed(2))}
                    {cell(p.coreW.toFixed(1), r?.coreW.toFixed(1))}
                    {cell(p.tempRiseC.toFixed(0), r?.tempRiseC.toFixed(0))}
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </details>
  );
}
