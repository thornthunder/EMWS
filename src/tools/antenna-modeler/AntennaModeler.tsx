import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Nec2Client, SimulationCancelled } from '../../engine/nec2/client';
import { cutsOf, elevationOfTheta, frontToBackDb, peakOf, type PatternCut } from '../../engine/nec2/pattern';
import { TRAPPED } from '../../engine/nec2/run';
import type { FrequencyResult, Nec2Run } from '../../engine/nec2/types';
import { DEFAULT_Z0, formatImpedance, returnLossDb, swr } from '../../lib/rf';
import { PolarPlot } from '../../ui/PolarPlot';
import { SweepChart } from '../../ui/SweepChart';
import { WireView } from '../../ui/WireView';
import { EXAMPLES } from './examples';

const STORAGE_KEY = 'emws.antenna-modeler.deck';

type Status = { kind: 'idle' } | { kind: 'running' } | { kind: 'failed'; message: string };

function savedDeck(): string | undefined {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined; // storage can be blocked; the tool works without it
  }
}

function cutTitle(cut: PatternCut): string {
  return cut.kind === 'azimuth'
    ? `Azimuth pattern at ${elevationOfTheta(cut.fixedDeg)}° elevation`
    : `Elevation pattern at azimuth ${cut.fixedDeg}°`;
}

function failureMessage(run: Nec2Run): string | undefined {
  const { raw, report } = run;
  if (raw.trap !== undefined) {
    return `The NEC2 engine crashed (${raw.trap}). This usually means a malformed card - a wire with zero segments or zero length, for instance.`;
  }
  if (report.errors.length > 0) return report.errors.join(' · ');
  if (raw.exitCode !== 0 && raw.exitCode !== TRAPPED) {
    return raw.stderr || `nec2c exited with code ${raw.exitCode}.`;
  }
  if (report.frequencies.length === 0) {
    return 'The deck ran, but produced no results. It needs an FR card, an EX card, and an RP or XQ card to trigger the solution.';
  }
  return undefined;
}

export function AntennaModeler() {
  const [deck, setDeck] = useState(() => savedDeck() ?? EXAMPLES[0]?.deck ?? '');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [run, setRun] = useState<Nec2Run | undefined>();
  const [z0, setZ0] = useState(DEFAULT_Z0);
  const [selected, setSelected] = useState(0);
  const client = useRef<Nec2Client | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);

  // Only the most recently requested run may touch the UI.
  const latest = useRef(0);

  const simulate = useCallback(async (text: string) => {
    client.current ??= new Nec2Client();
    const token = ++latest.current;
    setStatus({ kind: 'running' });
    try {
      const result = await client.current.simulate(text);
      if (token !== latest.current) return;
      setRun(result);
      const message = failureMessage(result);
      setStatus(message === undefined ? { kind: 'idle' } : { kind: 'failed', message });
      // Land on the best-matched frequency of a sweep.
      const swrs = result.report.frequencies.map((f) => (f.feeds[0] ? swr(f.feeds[0].impedance) : Infinity));
      setSelected(Math.max(0, swrs.indexOf(Math.min(...swrs))));
    } catch (e) {
      if (token !== latest.current) return;
      if (e instanceof SimulationCancelled) {
        setStatus({ kind: 'idle' });
        return;
      }
      setStatus({ kind: 'failed', message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  // Show results straight away on first visit; release the worker on the way out.
  const initialDeck = useRef(deck);
  useEffect(() => {
    void simulate(initialDeck.current);
    return () => client.current?.cancel();
  }, [simulate]);

  const updateDeck = (text: string) => {
    setDeck(text);
    try {
      localStorage.setItem(STORAGE_KEY, text);
    } catch {
      // see savedDeck()
    }
  };

  const loadExample = (e: ChangeEvent<HTMLSelectElement>) => {
    const example = EXAMPLES.find((x) => x.id === e.target.value);
    if (!example) return;
    updateDeck(example.deck);
    void simulate(example.deck);
    e.target.value = '';
  };

  const openFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    updateDeck(text);
    void simulate(text);
  };

  const saveFile = () => {
    const url = URL.createObjectURL(new Blob([deck], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'antenna.nec';
    a.click();
    URL.revokeObjectURL(url);
  };

  const frequencies = run?.report.frequencies ?? [];
  const frequency: FrequencyResult | undefined = frequencies[Math.min(selected, frequencies.length - 1)];
  const sweep = useMemo(
    () =>
      frequencies.map((f) => ({
        frequencyMHz: f.frequencyMHz,
        swr: f.feeds[0] ? swr(f.feeds[0].impedance, z0) : Infinity,
      })),
    [frequencies, z0],
  );
  const cuts = useMemo(() => (frequency ? frequency.patterns.flatMap(cutsOf) : []), [frequency]);
  const running = status.kind === 'running';

  return (
    <div className="modeler">
      <section className="panel deck-panel" aria-label="NEC2 card deck">
        <div className="toolbar">
          <select onChange={loadExample} defaultValue="" aria-label="Load an example">
            <option value="" disabled>
              Load an example…
            </option>
            {EXAMPLES.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => fileInput.current?.click()}>
            Open .nec
          </button>
          <button type="button" onClick={saveFile}>
            Save
          </button>
          <input ref={fileInput} type="file" accept=".nec,.txt,text/plain" hidden onChange={openFile} />
        </div>
        <textarea
          value={deck}
          onChange={(e) => updateDeck(e.target.value)}
          spellCheck={false}
          wrap="off"
          aria-label="NEC2 card deck"
        />
        <div className="toolbar">
          {running ? (
            <button type="button" className="danger" onClick={() => client.current?.cancel()}>
              Cancel
            </button>
          ) : (
            <button type="button" className="primary" onClick={() => void simulate(deck)}>
              Run simulation
            </button>
          )}
          <span className="muted">
            {running
              ? 'Solving…'
              : run
                ? `${run.report.segments.length} segments · ${run.raw.elapsedMs.toFixed(0)} ms · solved in your browser`
                : ''}
          </span>
        </div>
      </section>

      <section className="results" aria-live="polite">
        {status.kind === 'failed' && (
          <div className="alert" role="alert">
            <strong>Simulation failed.</strong> {status.message}
          </div>
        )}

        {frequency && (
          <>
            <Summary frequency={frequency} cuts={cuts} z0={z0} onZ0={setZ0} />
            {frequencies.length > 1 && (
              <SweepChart points={sweep} selected={selected} onSelect={setSelected} z0={z0} />
            )}
            <div className="plots">
              {run && (
                <WireView
                  segments={run.report.segments}
                  currents={frequency.currents}
                  feeds={frequency.feeds}
                  environment={frequency.environment}
                />
              )}
              {cuts.map((cut, i) => (
                <PolarPlot key={`${cut.kind}-${cut.fixedDeg}-${i}`} cut={cut} title={cutTitle(cut)} />
              ))}
            </div>
          </>
        )}

        {run && run.raw.output !== '' && (
          <details className="panel">
            <summary>Full nec2c report</summary>
            <pre>{run.raw.output}</pre>
          </details>
        )}
      </section>
    </div>
  );
}

interface SummaryProps {
  frequency: FrequencyResult;
  cuts: PatternCut[];
  z0: number;
  onZ0: (z0: number) => void;
}

function Summary({ frequency, cuts, z0, onZ0 }: SummaryProps) {
  const feed = frequency.feeds[0];
  const peak = peakOf(frequency.patterns.flatMap((p) => p.points));
  const frontToBack = cuts.map(frontToBackDb).find((v) => v !== undefined);
  const ratio = feed ? swr(feed.impedance, z0) : undefined;

  return (
    <dl className="summary">
      <div>
        <dt>Frequency</dt>
        <dd>{frequency.frequencyMHz} MHz</dd>
        <small>λ = {frequency.wavelengthM.toFixed(3)} m</small>
      </div>
      {feed && (
        <div>
          <dt>Feed impedance</dt>
          <dd>{formatImpedance(feed.impedance)} Ω</dd>
          <small>
            tag {feed.tag}, segment {feed.segment}
          </small>
        </div>
      )}
      {ratio !== undefined && feed && (
        <div>
          <dt>
            SWR at{' '}
            <input
              className="z0"
              type="number"
              min={1}
              step={1}
              value={z0}
              onChange={(e) => onZ0(Math.max(1, Number(e.target.value) || DEFAULT_Z0))}
              aria-label="Reference impedance in ohms"
            />{' '}
            Ω
          </dt>
          <dd>{Number.isFinite(ratio) ? `${ratio.toFixed(2)} : 1` : '∞'}</dd>
          <small>return loss {returnLossDb(feed.impedance, z0).toFixed(1)} dB</small>
        </div>
      )}
      {peak && (
        <div>
          <dt>Peak gain</dt>
          <dd>{peak.totalDb.toFixed(2)} dBi</dd>
          <small>
            az {peak.phiDeg}°, el {elevationOfTheta(peak.thetaDeg)}°
          </small>
        </div>
      )}
      {frontToBack !== undefined && (
        <div>
          <dt>Front / back</dt>
          <dd>{Number.isFinite(frontToBack) ? `${frontToBack.toFixed(1)} dB` : '∞'}</dd>
        </div>
      )}
      {frequency.power && (
        <div>
          <dt>Efficiency</dt>
          <dd>{frequency.power.efficiencyPct.toFixed(1)} %</dd>
          <small>conductor losses only</small>
        </div>
      )}
    </dl>
  );
}
