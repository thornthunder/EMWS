import { type ChangeEvent, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { SimulationCancelled, recommendedWorkers } from '../../engine/nec2/client';
import {
  type Solver,
  type SolverChoice,
  SolverUnavailable,
  createSolver,
  describeChoice,
  loadSolverChoice,
  saveSolverChoice,
} from '../../engine/nec2/solver';
import { mergeRuns } from '../../engine/nec2/merge';
import { cutsOf, elevationOfTheta, frontToBackDb, mainLobe, type PatternCut } from '../../engine/nec2/pattern';
import { TRAPPED } from '../../engine/nec2/run';
import type { FrequencyResult, Nec2Run, RadiationPattern, Segment } from '../../engine/nec2/types';
import { saveImpedanceHandoff } from '../../lib/handoff';
import { DEFAULT_Z0, formatImpedance, returnLossDb, swr } from '../../lib/rf';
import { PolarPlot } from '../../ui/PolarPlot';
import { SweepChart } from '../../ui/SweepChart';
import { deckToModel, modelToDeck, planRuns } from './deck';
import { ViewGrid } from './editor/ViewGrid';
import { type Scene, sceneFromModel, sceneFromReport } from './editor/scene';
import { EXAMPLES } from './examples';
import { historyReducer, initialHistory } from './history';
import { estimateSolveMs, formatDuration, formatDurationShort, recordParallelSolve, recordSolve } from './cost';
import { type AntennaModel, DEFAULT_RADIUS, emptyModel } from './model';
import { ModelPanel } from './ModelPanel';
import { SolverPicker } from './SolverPicker';
import { type Issue, validateModel } from './validate';

const STORAGE_KEY = 'emws.antenna-modeler.v2';
const LEGACY_STORAGE_KEY = 'emws.antenna-modeler.deck';
const AUTO_RUN_KEY = 'emws.antenna-modeler.auto-run';
const AUTO_RUN_DELAY_MS = 300;
/** Auto-run stays out of the way once a solve costs more than a moment. */
const AUTO_RUN_LIMIT_MS = 3000;
/** Below this, splitting a sweep across workers costs more than it saves. */
const SPLIT_SWEEP_MS = 400;

/** The model drives the editor; a deck it can't represent runs as text instead. */
type Source = { kind: 'model' } | { kind: 'text'; deck: string; reason: string };

interface Solved {
  run: Nec2Run;
  /** The model this was solved for; undefined for a text deck. */
  model: AntennaModel | undefined;
}

interface PatternSolved {
  frequencyMHz: number;
  run: Nec2Run;
  model: AntennaModel;
}

const EMPTY_SCENE: Scene = { editable: false, wires: [], lines: [], feeds: [], ground: false, showsCurrent: false };

// ---- persistence ----

function readStorage(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined; // storage can be blocked; the tool works without it
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // see readStorage()
  }
}

function looksLikeModel(value: unknown): value is AntennaModel {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Partial<AntennaModel>;
  return (
    Array.isArray(m.wires) &&
    Array.isArray(m.feeds) &&
    Array.isArray(m.comments) &&
    Array.isArray(m.extraCards) &&
    typeof m.frequency?.startMHz === 'number' &&
    typeof m.ground?.kind === 'string' &&
    typeof m.pattern?.kind === 'string'
  );
}

interface Initial {
  model: AntennaModel;
  source: Source;
  notes: string[];
}

function fromDeck(text: string): Initial {
  const imported = deckToModel(text);
  return imported.ok
    ? { model: imported.model, source: { kind: 'model' }, notes: imported.notes }
    : { model: emptyModel(), source: { kind: 'text', deck: text, reason: imported.reason }, notes: imported.notes };
}

function loadInitial(): Initial {
  const stored = readStorage(STORAGE_KEY);
  if (stored) {
    try {
      const saved = JSON.parse(stored) as { kind?: string; model?: unknown; deck?: unknown };
      if (saved.kind === 'model' && looksLikeModel(saved.model)) return { model: saved.model, source: { kind: 'model' }, notes: [] };
      if (saved.kind === 'text' && typeof saved.deck === 'string') return fromDeck(saved.deck);
    } catch {
      // fall through to the defaults
    }
  }
  const legacy = readStorage(LEGACY_STORAGE_KEY);
  return fromDeck(legacy ?? EXAMPLES[0]?.deck ?? '');
}

// ---- results ----

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

function cutTitle(cut: PatternCut): string {
  return cut.kind === 'azimuth'
    ? `Azimuth pattern at ${elevationOfTheta(cut.fixedDeg)}° elevation`
    : `Elevation pattern at azimuth ${cut.fixedDeg}°`;
}

function bestMatchIndex(run: Nec2Run, z0: number): number {
  const swrs = run.report.frequencies.map((f) => (f.feeds[0] ? swr(f.feeds[0].impedance, z0) : Infinity));
  return Math.max(0, swrs.indexOf(Math.min(...swrs)));
}

function frequencyList(run: Nec2Run | undefined): string {
  return run?.report.frequencies.map((f) => f.frequencyMHz).join(',') ?? '';
}

/** nec2c reports feeds by absolute segment number; people count along the wire. */
function segmentAlongWire(segments: readonly Segment[], tag: number, absolute: number): number {
  const position = segments.filter((s) => s.tag === tag && s.index <= absolute).length;
  return position > 0 ? position : absolute;
}

/** Leaves the feed impedance where the Smith chart tool can pick it up. */
function shareImpedance(run: Nec2Run, model: AntennaModel | undefined): void {
  const points = run.report.frequencies
    .filter((f) => f.feeds[0])
    .map((f) => ({ fMHz: f.frequencyMHz, r: f.feeds[0]!.impedance.re, x: f.feeds[0]!.impedance.im }));
  if (points.length === 0) return;
  saveImpedanceHandoff({
    name: model?.comments[0]?.slice(0, 60) ?? 'Antenna model',
    savedAt: new Date().toISOString(),
    points,
  });
}

function download(text: string, name: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function AntennaModeler() {
  const [initial] = useState(loadInitial);
  const [history, dispatch] = useReducer(historyReducer, initial.model, initialHistory);
  const model = history.present;
  const [source, setSource] = useState<Source>(initial.source);
  const [notes, setNotes] = useState<string[]>(initial.notes);
  const [selection, setSelection] = useState<string | null>(null);
  const [tab, setTab] = useState<'model' | 'deck'>(initial.source.kind === 'text' ? 'deck' : 'model');
  const [fitKey, setFitKey] = useState(0);
  const [autoRun, setAutoRun] = useState(() => readStorage(AUTO_RUN_KEY) !== 'off');
  const [z0, setZ0] = useState(DEFAULT_Z0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [solved, setSolved] = useState<Solved>();
  const [patternSolved, setPatternSolved] = useState<PatternSolved>();
  const [failure, setFailure] = useState<string>();
  const [pending, setPending] = useState(0);
  const [startedAt, setStartedAt] = useState(0);
  const [progress, setProgress] = useState<{ done: number; total: number } | undefined>(undefined);
  const [deckDraft, setDeckDraft] = useState<string | null>(null);
  const [solverChoice, setSolverChoice] = useState<SolverChoice>(loadSolverChoice);
  const [fallbackNote, setFallbackNote] = useState<string>();

  const client = useRef<Solver | undefined>(undefined);
  /** Always here to fall back on, whatever the chosen solver does. */
  const localSolver = useRef<Solver | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);
  // Only the latest request of each kind may touch the UI.
  const mainToken = useRef(0);
  const patternToken = useRef(0);
  const solving = useRef<AntennaModel | undefined>(undefined);
  const fitWhenSolved = useRef(initial.source.kind === 'text');
  const solvedFrequencies = useRef('');
  const z0Ref = useRef(z0);
  z0Ref.current = z0;

  const isModel = source.kind === 'model';
  const plan = useMemo(() => planRuns(model), [model]);
  const solvesHere = solverChoice.kind === 'local';

  useEffect(() => {
    client.current?.cancel();
    client.current = createSolver(solverChoice);
    saveSolverChoice(solverChoice);
    setFallbackNote(undefined);
    return () => client.current?.cancel();
  }, [solverChoice]);

  /** Runs a deck on the chosen solver, and on this browser if that one lets us down. */
  const withSolver = useCallback(
    async <T,>(work: (solver: Solver) => Promise<T>): Promise<T> => {
      const solver = (client.current ??= createSolver(solverChoice));
      try {
        return await work(solver);
      } catch (e) {
        if (!(e instanceof SolverUnavailable) || solverChoice.kind === 'local') throw e;
        setFallbackNote(`${describeChoice(solverChoice)} could not be reached, so this ran in your browser. ${e.message}`);
        localSolver.current ??= createSolver({ kind: 'local' });
        return await work(localSolver.current);
      }
    },
    [solverChoice],
  );

  // How many cores this sweep can use, what it will cost, and whether to split it at all.
  const segmentCount = useMemo(() => model.wires.reduce((n, w) => n + w.segments, 0), [model]);
  const workers = useMemo(
    () => (isModel && plan.perFrequency ? recommendedWorkers(plan.perFrequency.length, segmentCount) : 1),
    [isModel, plan, segmentCount],
  );
  const splitSweep = solvesHere && workers > 1 && estimateSolveMs(segmentCount, model.frequency.steps) > SPLIT_SWEEP_MS;
  const estimateMs = useMemo(
    () => (isModel && solvesHere ? estimateSolveMs(segmentCount, Math.max(1, model.frequency.steps), splitSweep ? workers : 1) : 0),
    [isModel, solvesHere, segmentCount, model.frequency.steps, splitSweep, workers],
  );
  const tooSlowToAutoRun = estimateMs > AUTO_RUN_LIMIT_MS;

  const issues = useMemo<Issue[]>(
    () => (isModel ? validateModel(model, { workers: splitSweep ? workers : 1, estimateSpeed: solvesHere }) : []),
    [isModel, model, splitSweep, workers, solvesHere],
  );
  const blocked = issues.some((i) => i.severity === 'error');
  const activeSelection = isModel && model.wires.some((w) => w.id === selection) ? selection : null;

  // ---- running the engine ----

  const runDeck = useCallback(
    async (deck: string): Promise<Nec2Run | undefined> => {
      setStartedAt(Date.now());
      setPending((p) => p + 1);
      try {
        return await withSolver((solver) => solver.solve(deck));
      } catch (e) {
        if (e instanceof SimulationCancelled) return undefined;
        throw e;
      } finally {
        setPending((p) => p - 1);
      }
    },
    [withSolver],
  );

  const solveMain = useCallback(
    async (deck: string, forModel: AntennaModel | undefined) => {
      const token = ++mainToken.current;
      patternToken.current++; // any pattern run in flight belongs to an older model
      solving.current = forModel;
      try {
        const run = await runDeck(deck);
        if (token !== mainToken.current || !run) return;
        // Stay on the chosen frequency unless the frequencies themselves changed.
        const list = frequencyList(run);
        if (list !== solvedFrequencies.current) {
          solvedFrequencies.current = list;
          setSelectedIndex(bestMatchIndex(run, z0Ref.current));
        }
        setSolved({ run, model: forModel });
        setPatternSolved(undefined);
        recordSolve(run.report.segments.length, run.report.frequencies.length, run.raw.elapsedMs);
        shareImpedance(run, forModel);
        setFailure(failureMessage(run));
        if (fitWhenSolved.current) {
          fitWhenSolved.current = false;
          setFitKey((k) => k + 1);
        }
      } catch (e) {
        if (token === mainToken.current) setFailure(e instanceof Error ? e.message : String(e));
      } finally {
        if (token === mainToken.current) solving.current = undefined;
      }
    },
    [runDeck],
  );

  const solvePattern = useCallback(
    async (deck: string, frequencyMHz: number, forModel: AntennaModel) => {
      const token = ++patternToken.current;
      try {
        const run = await runDeck(deck);
        if (token !== patternToken.current || !run) return;
        const message = failureMessage(run);
        if (message) setFailure(message);
        setPatternSolved({ frequencyMHz, run, model: forModel });
      } catch (e) {
        if (token === patternToken.current) setFailure(e instanceof Error ? e.message : String(e));
      }
    },
    [runDeck],
  );

  /** Solves a sweep one frequency per worker, then stitches the results together. */
  const solveSweep = useCallback(
    async (decks: string[], forModel: AntennaModel, limit: number) => {
      const token = ++mainToken.current;
      patternToken.current++;
      solving.current = forModel;
      const started = performance.now();
      setStartedAt(Date.now());
      setProgress({ done: 0, total: decks.length });
      setPending((p) => p + 1);
      try {
        const runs = await withSolver((solver) =>
          solver.solveAll(decks, {
            onProgress: (done, total) => {
              if (token === mainToken.current) setProgress({ done, total });
            },
          }),
        );
        if (token !== mainToken.current) return;
        const elapsedMs = performance.now() - started;
        const run = mergeRuns(runs, { elapsedMs });
        const list = frequencyList(run);
        if (list !== solvedFrequencies.current) {
          solvedFrequencies.current = list;
          setSelectedIndex(bestMatchIndex(run, z0Ref.current));
        }
        setSolved({ run, model: forModel });
        setPatternSolved(undefined);
        // Only time our own cores: a service's wall clock says nothing about this machine.
        if (solvesHere) recordParallelSolve(run.report.segments.length, decks.length, limit, elapsedMs);
        shareImpedance(run, forModel);
        setFailure(failureMessage(run));
      } catch (e) {
        if (token !== mainToken.current || e instanceof SimulationCancelled) return;
        setFailure(e instanceof Error ? e.message : String(e));
      } finally {
        setPending((p) => p - 1);
        if (token === mainToken.current) {
          solving.current = undefined;
          setProgress(undefined);
        }
      }
    },
    [withSolver, solvesHere],
  );

  const solveModel = useCallback(
    (m: AntennaModel) => {
      const runPlan = planRuns(m);
      const segments = m.wires.reduce((n, w) => n + w.segments, 0);
      const limit = runPlan.perFrequency ? recommendedWorkers(runPlan.perFrequency.length, segments) : 1;
      // Here, splitting only pays once a sweep is big enough to be worth the extra
      // workers. A service gets the whole sweep as one batch whatever its size: it has
      // its own cores to spread it over, and the request costs the same either way.
      const worthSplitting = solvesHere
        ? limit > 1 && estimateSolveMs(segments, m.frequency.steps) > SPLIT_SWEEP_MS
        : true;
      if (runPlan.perFrequency && worthSplitting) void solveSweep(runPlan.perFrequency, m, limit);
      else void solveMain(runPlan.main, m);
    },
    [solveMain, solveSweep, solvesHere],
  );

  // Re-solve shortly after every edit (not during a drag), while the model is sound.
  const firstRun = useRef(true);
  useEffect(() => {
    if (!isModel || !autoRun || history.gesture || blocked || tooSlowToAutoRun) return;
    if (solved?.model === model || solving.current === model) return;
    const delay = firstRun.current ? 0 : AUTO_RUN_DELAY_MS;
    firstRun.current = false;
    const timer = setTimeout(() => solveModel(model), delay);
    return () => clearTimeout(timer);
  }, [isModel, autoRun, history.gesture, blocked, tooSlowToAutoRun, model, solved, solveModel]);

  // A text deck restored from the last visit runs on arrival; leaving the page stops the engine.
  useEffect(() => {
    if (initial.source.kind === 'text') void solveMain(initial.source.deck, undefined);
    return () => client.current?.cancel();
  }, [initial, solveMain]);

  const report = solved?.run.report;
  const frequencies = report?.frequencies ?? [];
  const index = Math.min(selectedIndex, Math.max(0, frequencies.length - 1));
  const frequency: FrequencyResult | undefined = frequencies[index];

  // A sweep with an automatic pattern solves the far field for the chosen frequency on its own.
  useEffect(() => {
    if (!isModel || !solved || solved.model !== model || !plan.patternDeck || !frequency) return;
    const f = frequency.frequencyMHz;
    if (patternSolved?.model === model && patternSolved.frequencyMHz === f) return;
    const deck = plan.patternDeck(f);
    const timer = setTimeout(() => void solvePattern(deck, f, model), 50);
    return () => clearTimeout(timer);
  }, [isModel, solved, model, plan, frequency, patternSolved, solvePattern]);

  // ---- persistence ----

  useEffect(() => {
    const timer = setTimeout(() => {
      writeStorage(STORAGE_KEY, JSON.stringify(source.kind === 'model' ? { kind: 'model', model } : { kind: 'text', deck: source.deck }));
    }, 300);
    return () => clearTimeout(timer);
  }, [model, source]);

  useEffect(() => writeStorage(AUTO_RUN_KEY, autoRun ? 'on' : 'off'), [autoRun]);

  // ---- loading and saving ----

  const loadDeck = (text: string) => {
    const imported = deckToModel(text);
    setSelection(null);
    setDeckDraft(null);
    setNotes(imported.notes);
    setFitKey((k) => k + 1);
    if (imported.ok) {
      dispatch({ type: 'load', model: imported.model });
      setSource({ kind: 'model' });
      setTab('model');
      if (!autoRun) solveModel(imported.model);
    } else {
      setSource({ kind: 'text', deck: text, reason: imported.reason });
      setTab('deck');
      fitWhenSolved.current = true;
      void solveMain(text, undefined);
    }
  };

  const loadExample = (e: ChangeEvent<HTMLSelectElement>) => {
    const example = EXAMPLES.find((x) => x.id === e.target.value);
    e.target.value = '';
    if (!example) return;
    // An antenna meant to be fed through a transformer is read against the impedance
    // that transformer wants, not against 50 Ω. The box stays editable: put it back to
    // 50 to see what the antenna itself presents.
    setZ0(example.z0 ?? DEFAULT_Z0);
    loadDeck(example.deck);
  };

  const openFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) loadDeck(await file.text());
  };

  const newModel = () => {
    dispatch({ type: 'load', model: emptyModel(model.frequency.startMHz) });
    setSource({ kind: 'model' });
    setSelection(null);
    setNotes([]);
    setTab('model');
    setFitKey((k) => k + 1);
  };

  const generatedDeck = useMemo(() => modelToDeck(model), [model]);
  const deckText = source.kind === 'text' ? source.deck : (deckDraft ?? generatedDeck);

  const applyDeckDraft = () => {
    if (deckDraft !== null) loadDeck(deckDraft);
  };

  const runNow = () => {
    if (source.kind === 'text') void solveMain(source.deck, undefined);
    else if (!blocked) solveModel(model);
  };

  // ---- what to show ----

  const patterns: RadiationPattern[] = useMemo(() => {
    if (
      patternSolved &&
      solved &&
      patternSolved.model === solved.model &&
      frequency &&
      patternSolved.frequencyMHz === frequency.frequencyMHz
    ) {
      return patternSolved.run.report.frequencies[0]?.patterns ?? [];
    }
    return frequency?.patterns ?? [];
  }, [patternSolved, solved, frequency]);

  const cuts = useMemo(() => patterns.flatMap(cutsOf), [patterns]);
  const stale = isModel && solved !== undefined && solved.model !== model;
  const busy = pending > 0;

  const scene: Scene = useMemo(() => {
    if (isModel) return sceneFromModel(model, solved?.model === model ? frequency?.currents : undefined);
    return report ? sceneFromReport(report, frequency) : EMPTY_SCENE;
  }, [isModel, model, solved, frequency, report]);

  const sweep = useMemo(
    () => frequencies.map((f) => ({ frequencyMHz: f.frequencyMHz, swr: f.feeds[0] ? swr(f.feeds[0].impedance, z0) : Infinity })),
    [frequencies, z0],
  );

  const lastRadius = model.wires[model.wires.length - 1]?.radius ?? DEFAULT_RADIUS;

  return (
    <div className="modeler" data-busy={busy ? 'true' : 'false'}>
      <h1 className="visually-hidden">Antenna Modeler</h1>
      <aside className="panel side-panel" aria-label="Antenna model">
        <div className="toolbar">
          <select className="example-picker" onChange={loadExample} defaultValue="" aria-label="Load an example">
            <option value="" disabled>
              Examples…
            </option>
            {EXAMPLES.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
          <button type="button" onClick={newModel} title="Start an empty model">
            New
          </button>
          <button type="button" onClick={() => fileInput.current?.click()}>
            Open
          </button>
          <button type="button" onClick={() => download(deckText, 'antenna.nec')} title="Save as a NEC-2 card deck (.nec)">
            Save
          </button>
          <input ref={fileInput} type="file" accept=".nec,.txt,text/plain" hidden onChange={openFile} />
        </div>

        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'model'} onClick={() => setTab('model')}>
            Model
          </button>
          <button type="button" role="tab" aria-selected={tab === 'deck'} onClick={() => setTab('deck')}>
            Card deck
          </button>
          <a className="tab-link" href="#/guides/antenna-modeler" title="How to use the Antenna Modeler">
            Field guide
          </a>
        </div>

        {notes.length > 0 && (
          <div className="note" role="status">
            {notes.map((n) => (
              <p key={n}>{n}</p>
            ))}
            <button type="button" className="small" onClick={() => setNotes([])}>
              OK
            </button>
          </div>
        )}

        <div className="tab-body">
          {tab === 'model' &&
            (isModel ? (
              <ModelPanel key={fitKey} model={model} dispatch={dispatch} selection={activeSelection} onSelect={setSelection} />
            ) : (
              <div className="note">
                <p>
                  <strong>This deck runs as text.</strong> {source.kind === 'text' && source.reason}
                </p>
                <button type="button" className="small" onClick={() => setTab('deck')}>
                  Show the card deck
                </button>
              </div>
            ))}

          {tab === 'deck' && (
            <div className="deck-tab">
              {source.kind === 'text' ? (
                <div className="note">
                  <p>
                    <strong>The visual editor can't show this deck.</strong> {source.reason} It runs exactly as written.
                  </p>
                  <div className="button-row">
                    <button type="button" className="small" onClick={() => loadDeck(source.deck)}>
                      Try the visual editor again
                    </button>
                    <button type="button" className="small" onClick={() => setSource({ kind: 'model' })}>
                      Back to the previous model
                    </button>
                  </div>
                </div>
              ) : (
                <p className="muted">
                  The NEC-2 cards for this model. Edit them and choose Apply to update the model, or paste a deck of your own.
                </p>
              )}
              <textarea
                className="deck-text"
                value={deckText}
                onChange={(e) =>
                  source.kind === 'text' ? setSource({ ...source, deck: e.target.value }) : setDeckDraft(e.target.value)
                }
                spellCheck={false}
                wrap="off"
                aria-label="NEC-2 card deck"
              />
              {source.kind === 'model' && deckDraft !== null && deckDraft !== generatedDeck && (
                <div className="button-row">
                  <button type="button" className="primary small" onClick={applyDeckDraft}>
                    Apply
                  </button>
                  <button type="button" className="small" onClick={() => setDeckDraft(null)}>
                    Discard changes
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="run-bar">
          <div className="run-row">
          {busy ? (
            <button type="button" className="danger" onClick={() => client.current?.cancel()}>
              Cancel
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              onClick={runNow}
              disabled={isModel && blocked}
              title={isModel && estimateMs > 1000 ? `This model takes ${formatDuration(estimateMs)} to solve` : undefined}
            >
              Run{isModel && estimateMs > 1000 ? ` (${formatDurationShort(estimateMs)})` : ''}
            </button>
          )}
          {isModel && (
            <label className="check" title={tooSlowToAutoRun ? 'Held back while this model takes so long to solve' : undefined}>
              <input type="checkbox" checked={autoRun} onChange={(e) => setAutoRun(e.target.checked)} /> Auto-run
              {autoRun && tooSlowToAutoRun && <span className="muted"> (paused)</span>}
            </label>
          )}
          <span className="muted run-status">
            {busy ? (
              <Elapsed since={startedAt} estimateMs={estimateMs} progress={progress} />
            ) : solved ? (
              `${solved.run.report.segments.length} segments · ${solved.run.raw.elapsedMs.toFixed(0)} ms${stale ? ' · model changed' : ''}`
            ) : (
              ''
            )}
          </span>
          </div>
          <SolverPicker choice={solverChoice} onChange={setSolverChoice} fallbackNote={fallbackNote} />
        </div>
      </aside>

      <div className="workspace">
        <ViewGrid
          scene={scene}
          model={isModel ? model : undefined}
          dispatch={dispatch}
          canUndo={isModel && history.past.length > 0}
          canRedo={isModel && history.future.length > 0}
          selection={activeSelection}
          onSelect={setSelection}
          fitKey={fitKey}
          newWireRadius={lastRadius}
        />

        {issues.length > 0 && <IssueList issues={issues} onSelect={setSelection} />}

        <section className={stale ? 'results stale' : 'results'} aria-live="polite">
          {failure && !stale && (
            <div className="alert" role="alert">
              <strong>Simulation failed.</strong> {failure}
            </div>
          )}
          {isModel && blocked && (
            <p className="muted">Results appear once the problems above are sorted out.</p>
          )}

          {frequency && (
            <>
              <Summary frequency={frequency} segments={report?.segments ?? []} patterns={patterns} cuts={cuts} z0={z0} onZ0={setZ0} />
              {frequency.feeds.length > 1 && <FeedTable frequency={frequency} segments={report?.segments ?? []} z0={z0} />}
              {frequencies.length > 1 && <SweepChart points={sweep} selected={index} onSelect={setSelectedIndex} z0={z0} />}
              {cuts.length > 0 ? (
                <div className="plots">
                  {cuts.map((cut, i) => (
                    <PolarPlot key={`${cut.kind}-${cut.fixedDeg}-${i}`} cut={cut} title={cutTitle(cut)} />
                  ))}
                </div>
              ) : (
                plan.patternDeck &&
                isModel && <p className="muted pattern-pending">Solving the radiation pattern at {frequency.frequencyMHz} MHz…</p>
              )}
            </>
          )}

          {solved && solved.run.raw.output !== '' && <ReportDetails text={solved.run.raw.output} />}
        </section>
      </div>
    </div>
  );
}

/** Counts up while the engine works, so a long solve never looks like a hung page. */
function Elapsed({
  since,
  estimateMs,
  progress,
}: {
  since: number;
  estimateMs: number;
  progress?: { done: number; total: number };
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, (now - since) / 1000);
  const clock = seconds < 60 ? `${seconds.toFixed(1)} s` : `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  return (
    <>
      Solving… {progress ? `${progress.done} of ${progress.total} frequencies · ` : ''}
      {clock}
      {estimateMs > 3000 && ` of ${formatDurationShort(estimateMs)}`}
    </>
  );
}

/** The report text is only put in the page when opened: a sweep's report can run to megabytes. */
function ReportDetails({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="panel" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Full nec2c report</summary>
      {open && <pre>{text}</pre>}
    </details>
  );
}

function IssueList({ issues, onSelect }: { issues: Issue[]; onSelect: (wireId: string) => void }) {
  return (
    <ul className="issues" aria-label="Design checks">
      {issues.map((issue) => (
        <li key={issue.message} className={`issue issue-${issue.severity}`}>
          <span className="issue-mark" aria-hidden="true">
            {issue.severity === 'error' ? '✕' : '!'}
          </span>
          <span className="visually-hidden">{issue.severity}: </span>
          <span className="issue-text">{issue.message}</span>
          {issue.wireIds[0] && (
            <button type="button" className="link" onClick={() => onSelect(issue.wireIds[0]!)}>
              Show
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function FeedTable({ frequency, segments, z0 }: { frequency: FrequencyResult; segments: Segment[]; z0: number }) {
  return (
    <div className="table-wrap">
      <table className="feed-table">
        <caption>Feed points</caption>
        <thead>
          <tr>
            <th scope="col">Wire</th>
            <th scope="col">Segment</th>
            <th scope="col">Impedance (Ω)</th>
            <th scope="col">SWR ({z0} Ω)</th>
            <th scope="col">Power (W)</th>
          </tr>
        </thead>
        <tbody>
          {frequency.feeds.map((f) => {
            const ratio = swr(f.impedance, z0);
            return (
              <tr key={`${f.tag}:${f.segment}`}>
                <td>{f.tag}</td>
                <td>{segmentAlongWire(segments, f.tag, f.segment)}</td>
                <td>{formatImpedance(f.impedance)}</td>
                <td>{Number.isFinite(ratio) ? ratio.toFixed(2) : '∞'}</td>
                <td>{f.powerW.toExponential(3)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface SummaryProps {
  frequency: FrequencyResult;
  segments: Segment[];
  patterns: RadiationPattern[];
  cuts: PatternCut[];
  z0: number;
  onZ0: (z0: number) => void;
}

function Summary({ frequency, segments, patterns, cuts, z0, onZ0 }: SummaryProps) {
  const feed = frequency.feeds[0];
  const peak = mainLobe(patterns.flatMap((p) => p.points));
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
            wire {feed.tag}, segment {segmentAlongWire(segments, feed.tag, feed.segment)}
            {frequency.feeds.length > 1 ? ` (1 of ${frequency.feeds.length})` : ''}
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
