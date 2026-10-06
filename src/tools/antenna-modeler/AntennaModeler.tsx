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
import type { Complex } from '../../lib/complex';
import { DEFAULT_Z0, formatImpedance, returnLossDb, swr } from '../../lib/rf';
import { Pattern3D } from './Pattern3D';
import { checkConvergence } from './convergence';
import { decodeMaa, encodeMaa, maaToModel, modelToMaa } from './maa';
import { ExposurePanel } from './ExposurePanel';
import type { OptimiseRequest } from './ModelPanel';
import { applyAll, describeMeasured, optimise } from './optimise';
import { SweepPanel } from './SweepPanel';
import { CommunityPanel } from '../../ui/CommunityPanel';
import { packModel, unpackModel } from './shared-model';
import { type LineSide, throughLine, toolboxDatasheetCable } from './feedline';
import { type Cable, cableById, catalogueGroups, runPowers } from '../toolbox/coax';
import { LineChart } from '../../ui/LineChart';
import { loadName, loadRatings } from './ratings';
import { type RadioSide, type ThroughOption, balunStrain, radioSide, throughOptions } from './through';
import { type TuneRequest, applyVariable, currentValue, describeVariable, formatTunedValue, tune } from './tune';
import { PolarPlot } from '../../ui/PolarPlot';
import { SweepChart } from '../../ui/SweepChart';
import { deckToModel, modelToDeck, planRuns } from './deck';
import { ViewGrid } from './editor/ViewGrid';
import { type Scene, sceneFromModel, sceneFromReport } from './editor/scene';
import { EXAMPLES } from './examples';
import { historyReducer, initialHistory } from './history';
import { estimateSolveMs, formatDuration, formatDurationShort, recordParallelSolve, recordSolve } from './cost';
import { type AntennaModel, DEFAULT_RADIUS, emptyModel } from './model';
import { ComparePanel, type Measurement } from './ComparePanel';
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

const EMPTY_SCENE: Scene = { editable: false, wires: [], lines: [], feeds: [], loads: [], ground: false, showsCurrent: false };

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
      // Models saved before loads existed have none; give them the field rather than refuse them.
      if (saved.kind === 'model' && looksLikeModel(saved.model)) return { model: { ...saved.model, loads: Array.isArray(saved.model.loads) ? saved.model.loads : [] }, source: { kind: 'model' }, notes: [] };
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
  // Your saved baluns, for "SWR through". Read when the page opens: the balun tool is where they change.
  const [baluns] = useState<ThroughOption[]>(() => throughOptions());
  const [throughId, setThroughId] = useState('');
  const through = baluns.find((o) => o.saved.id === throughId && o.material !== undefined);
  /** A measurement of the real antenna, to hold the model against. Not kept between visits. */
  const [measurement, setMeasurement] = useState<Measurement | undefined>();
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
  /** Transmit power the load ratings and the feed-line budget are worked out for. */
  const [powerW, setPowerW] = useState(100);
  /** The convergence check: busy while its two solves run, then a verdict in words. */
  const [convergence, setConvergence] = useState<{ busy: boolean; note?: string }>({ busy: false });
  const [optimising, setOptimising] = useState<{ busy: boolean; progress?: string; note?: string }>({ busy: false });
  /** The run of coax between the radio and the feed (or the balun on it): '' = none. */
  const [lineCableId, setLineCableId] = useState('');
  const [lineLengthM, setLineLengthM] = useState(30);
  // Read once, like the baluns: the RF toolbox is where the datasheet cable changes.
  const [datasheetCable] = useState<Cable>(() => toolboxDatasheetCable());
  const lineCable = lineCableId === '' ? undefined : lineCableId === 'datasheet' ? datasheetCable : cableById(lineCableId);
  const [tuning, setTuning] = useState<{ busy: boolean; progress?: string; note?: string }>({ busy: false });

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

  /** Stops whichever solver is running: the chosen one, and the local one a fallback may have started. */
  const cancelSolvers = useCallback(() => {
    client.current?.cancel();
    localSolver.current?.cancel();
  }, []);

  useEffect(() => {
    cancelSolvers();
    client.current = createSolver(solverChoice);
    saveSolverChoice(solverChoice);
    setFallbackNote(undefined);
    return cancelSolvers;
  }, [solverChoice, cancelSolvers]);

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
            // The memory-aware limit: without it the local solver would guess from the
            // deck count alone and could exhaust the browser on a big model.
            workers: limit,
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

  /** Changes one thing about the model, solve by solve, until the goal is met: one undo step. */
  const tuneModel = useCallback(
    (request: TuneRequest) => {
      const start = model;
      setTuning({ busy: true, progress: 'starting…' });
      setPending((p) => p + 1);
      tune(
        start,
        request,
        (deck) => withSolver((solver) => solver.solve(deck)),
        (done, best) => {
          const bestText = best ? formatTunedValue(request.variable, best.value) + ': ' + best.readout : '…';
          setTuning({ busy: true, progress: done + ' solves · best so far ' + bestText });
        },
      )
        .then((result) => {
          // Apply the found value to whatever the model is by now, not to a stale copy.
          dispatch({ type: 'edit', recipe: (m) => (m === start ? result.model : applyVariable(m, request.variable, result.value)) });
          const edge = result.atEdge ? ' That is at the edge of the range, so the real best is probably beyond it: widen the range and tune again.' : '';
          const cut = result.truncated ? ' Stopped at the solve limit before settling.' : '';
          setTuning({
            busy: false,
            note: 'Set ' + describeVariable(start, request.variable) + ' to ' + formatTunedValue(request.variable, result.value) + ': ' + result.readout + ', in ' + result.evaluations.length + ' solves.' + edge + cut,
          });
        })
        .catch((e: unknown) => {
          setTuning({ busy: false, note: e instanceof SimulationCancelled ? 'Tuning stopped; nothing was changed.' : 'Tuning failed: ' + (e instanceof Error ? e.message : String(e)) });
        })
        .finally(() => setPending((p) => p - 1));
    },
    [model, withSolver, dispatch],
  );

  /** Several things at once against a weighted goal; the result is one undo step. */
  const optimiseModel = useCallback(
    (request: OptimiseRequest) => {
      const start = model;
      const current = request.vars.map((v) => currentValue(start, v.variable) ?? v.range.min);
      setOptimising({ busy: true, progress: 'starting…' });
      setPending((p) => p + 1);
      optimise(
        start,
        request.vars,
        request.goal,
        current,
        (deck) => withSolver((solver) => solver.solve(deck)),
        (count, best) => setOptimising({ busy: true, progress: `${count} trials · best so far ${best ? describeMeasured(best) : '…'}` }),
        request.maxEvaluations,
      )
        .then((result) => {
          const trials = ` (${result.evaluations} trials)`;
          if (!result.improved) {
            setOptimising({ busy: false, note: `Nothing in those ranges beat the model as it is - ${describeMeasured(result.before)} - so it is unchanged${trials}.` });
            return;
          }
          // Applied to whatever the model is by now, not to a stale copy - as Tune does.
          dispatch({ type: 'edit', recipe: (m) => (m === start ? result.model : applyAll(m, request.vars, result.values)) });
          const changed = request.vars
            .map((v, i) => `${describeVariable(start, v.variable)} ${formatTunedValue(v.variable, current[i]!)} → ${formatTunedValue(v.variable, result.values[i]!)}`)
            .join('; ');
          const edge = result.atEdge.length
            ? ` ${result.atEdge.map((i) => describeVariable(start, request.vars[i]!.variable)).join(' and ')} ended at the edge of its range: the real best is probably beyond it.`
            : '';
          const cut = result.truncated ? ' Stopped at the trial limit before settling: run it again to carry on from here.' : '';
          setOptimising({ busy: false, note: `Changed ${changed}. ${describeMeasured(result.before)} → ${describeMeasured(result.after)}${trials}.${edge}${cut}` });
        })
        .catch((e: unknown) => {
          setOptimising({ busy: false, note: e instanceof SimulationCancelled ? 'Optimising stopped; nothing was changed.' : `Optimising failed: ${e instanceof Error ? e.message : String(e)}` });
        })
        .finally(() => setPending((p) => p - 1));
    },
    [model, withSolver, dispatch],
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
  /** What to measure by default: the model's sweep, or a band either side of a single frequency. */
  const compareSweep = useMemo(() => {
    const f0 = model.frequency.startMHz;
    const f1 = f0 + model.frequency.stepMHz * Math.max(0, model.frequency.steps - 1);
    return f1 > f0 * 1.001 ? { startMHz: f0, stopMHz: f1 } : { startMHz: Number((f0 * 0.95).toPrecision(4)), stopMHz: Number((f0 * 1.05).toPrecision(4)) };
  }, [model.frequency]);
  const measuredSwr = useMemo(
    () => measurement?.points.map((p) => ({ frequencyMHz: p.fMHz, swr: swr(p.z, z0) })),
    [measurement, z0],
  );
  const index = Math.min(selectedIndex, Math.max(0, frequencies.length - 1));
  const frequency: FrequencyResult | undefined = frequencies[index];

  /** A one-off solve beside the main results (the exposure map): busy while it runs, cancellable. */
  const solveSideJob = useCallback(
    async (deck: string): Promise<Nec2Run> => {
      setPending((p) => p + 1);
      try {
        return await withSolver((solver) => solver.solve(deck));
      } finally {
        setPending((p) => p - 1);
      }
    },
    [withSolver],
  );

  /** The mesh-refinement check: two fresh solves at the frequency on screen, one verdict. */
  const checkModel = useCallback(() => {
    const fMHz = frequency?.frequencyMHz ?? model.frequency.startMHz;
    setConvergence({ busy: true });
    setPending((p) => p + 1);
    checkConvergence(model, fMHz, (deck) => withSolver((solver) => solver.solve(deck)))
      .then((report) => setConvergence({ busy: false, note: report.words }))
      .catch((e: unknown) =>
        setConvergence({
          busy: false,
          note: e instanceof SimulationCancelled ? 'Check stopped; nothing was changed.' : `Check failed: ${e instanceof Error ? e.message : String(e)}`,
        }),
      )
      .finally(() => setPending((p) => p - 1));
  }, [model, frequency, withSolver]);

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
    if (!file) return;
    if (/\.maa$/i.test(file.name)) {
      const imported = maaToModel(decodeMaa(new Uint8Array(await file.arrayBuffer())));
      if (!imported.ok) {
        // Nothing to fall back on: a .maa is not a deck. Keep the model there was.
        setNotes([`${file.name} could not be opened: ${imported.reason}`]);
        return;
      }
      setSelection(null);
      setDeckDraft(null);
      setNotes(imported.notes);
      setFitKey((k) => k + 1);
      setZ0(imported.z0 ?? DEFAULT_Z0);
      dispatch({ type: 'load', model: imported.model });
      setSource({ kind: 'model' });
      setTab('model');
      if (!autoRun) solveModel(imported.model);
      return;
    }
    loadDeck(await file.text());
  };

  /** The model as an MMANA-GAL file, in the single-byte code page MMANA reads on Windows. */
  const saveMaa = () => {
    const out = modelToMaa(model, z0);
    if (!out.ok) {
      setNotes([`Not saved as .maa: ${out.reason}`]);
      return;
    }
    const url = URL.createObjectURL(new Blob([encodeMaa(out.text)], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'antenna.maa';
    a.click();
    URL.revokeObjectURL(url);
    setNotes(['Saved for MMANA-GAL as antenna.maa.', ...out.notes]);
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

  // The modelled impedance at every solved frequency...
  const antennaPoints = useMemo(() => frequencies.flatMap((f) => (f.feeds[0] ? [{ fMHz: f.frequencyMHz, z: f.feeds[0].impedance }] : [])), [frequencies]);
  // ...seen through the chosen balun...
  const radio: RadioSide[] | undefined = useMemo(() => {
    if (!through?.material) return undefined;
    return radioSide({ saved: through.saved, material: through.material }, antennaPoints);
  }, [through, antennaPoints]);
  const radioAt = frequency && radio?.find((r) => r.fMHz === frequency.frequencyMHz);
  // ...and then down the feed line, which hangs between the radio and whatever the rest is.
  const line: LineSide[] | undefined = useMemo(() => {
    if (!lineCable || !(lineLengthM > 0)) return undefined;
    const feedSide = radio ? radio.map((r) => ({ fMHz: r.fMHz, z: r.z })) : antennaPoints;
    return feedSide.length > 0 ? throughLine(lineCable, lineLengthM, feedSide) : undefined;
  }, [lineCable, lineLengthM, radio, antennaPoints]);
  const lineAt = frequency && line?.find((l) => l.fMHz === frequency.frequencyMHz);

  const sweep = useMemo(
    () =>
      frequencies.map((f) => {
        const z = line
          ? line.find((l) => l.fMHz === f.frequencyMHz)?.z
          : radio
            ? radio.find((r) => r.fMHz === f.frequencyMHz)?.z
            : f.feeds[0]?.impedance;
        return { frequencyMHz: f.frequencyMHz, swr: z ? swr(z, z0) : Infinity };
      }),
    [frequencies, radio, line, z0],
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
          {isModel && (
            <button type="button" onClick={saveMaa} title="Save for MMANA-GAL (.maa)">
              Save .maa
            </button>
          )}
          <input ref={fileInput} type="file" accept=".nec,.maa,.txt,text/plain" hidden onChange={openFile} />
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
              <ModelPanel
                key={fitKey}
                model={model}
                dispatch={dispatch}
                selection={activeSelection}
                onSelect={setSelection}
                z0={z0}
                tune={{ busy: tuning.busy, progress: tuning.progress, note: tuning.note, run: tuneModel, cancel: cancelSolvers }}
                convergence={{ busy: convergence.busy, note: convergence.note, run: checkModel, cancel: cancelSolvers }}
                optimiser={{ busy: optimising.busy, progress: optimising.progress, note: optimising.note, run: optimiseModel, cancel: cancelSolvers }}
              />
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
            <button type="button" className="danger" onClick={cancelSolvers}>
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
              <Summary
                frequency={frequency}
                segments={report?.segments ?? []}
                patterns={patterns}
                cuts={cuts}
                z0={z0}
                onZ0={setZ0}
                baluns={baluns}
                throughId={throughId}
                onThrough={setThroughId}
                through={through && radioAt ? { name: through.saved.name, powerW: through.saved.design.powerW, ...radioAt } : undefined}
                line={lineCable && lineAt ? { name: lineCable.name, lengthM: lineLengthM, powerW, balunDb: radioAt?.lossDb, ...lineAt } : undefined}
              />
              <p className="muted feedline-row">
                Feed line{' '}
                <select
                  className="feedline-cable"
                  value={lineCableId}
                  onChange={(e) => setLineCableId(e.target.value)}
                  aria-label="Feed line between the radio and the feed point"
                >
                  <option value="">none — the radio is at the feed point</option>
                  {catalogueGroups().map((g) => (
                    <optgroup key={g.group} label={g.group}>
                      {g.cables.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                  <option value="datasheet">{datasheetCable.name} — your datasheet cable, from the RF toolbox</option>
                </select>
                {lineCable && (
                  <>
                    {' of '}
                    <input
                      className="z0 feedline-length"
                      type="number"
                      min={0.1}
                      step={1}
                      value={lineLengthM}
                      onChange={(e) => setLineLengthM(Math.max(0.1, Number(e.target.value) || 0.1))}
                      aria-label="Feed line length, metres"
                    />{' '}
                    m between the radio and the {through ? 'balun' : 'feed point'}.
                    {lineCable.loss.kind === 'geometry'
                      ? ' Its loss is calculated from the geometry - a floor; a real braided cable loses somewhat more.'
                      : ' Its loss follows the two datasheet points, exactly.'}
                  </>
                )}
              </p>
              {frequency.feeds.length > 1 && <FeedTable frequency={frequency} segments={report?.segments ?? []} z0={z0} />}
              {isModel && model.loads.length > 0 && <LoadRatingsCard model={model} frequency={frequency} powerW={powerW} onPower={setPowerW} />}
              {frequencies.length > 1 && (
                <SweepChart points={sweep} selected={index} onSelect={setSelectedIndex} z0={z0} measured={measuredSwr} measuredLabel="measured" />
              )}
              {frequencies.length > 1 && line && line.length > 1 && <PowerBudgetChart line={line} radio={radio} powerW={powerW} onPower={setPowerW} />}
              {cuts.length > 0 ? (
                <div className="plots">
                  {cuts.map((cut, i) => (
                    <PolarPlot key={`${cut.kind}-${cut.fixedDeg}-${i}`} cut={cut} title={cutTitle(cut)} />
                  ))}
                  <Pattern3D patterns={patterns} lines={scene.lines} ground={scene.ground} frequencyMHz={frequency.frequencyMHz} />
                </div>
              ) : (
                plan.patternDeck &&
                isModel && <p className="muted pattern-pending">Solving the radiation pattern at {frequency.frequencyMHz} MHz…</p>
              )}
              {isModel && model.wires.length > 0 && model.feeds.length > 0 && (
                <SweepPanel
                  key={`sweep-${fitKey}`}
                  model={model}
                  fMHz={frequency.frequencyMHz}
                  z0={z0}
                  solve={solveSideJob}
                  onCancel={cancelSolvers}
                  onApply={(variable, value) => dispatch({ type: 'edit', recipe: (m) => applyVariable(m, variable, value) })}
                />
              )}
              {isModel && model.wires.length > 0 && model.feeds.length > 0 && (
                <ExposurePanel
                  key={fitKey}
                  model={model}
                  fMHz={frequency.frequencyMHz}
                  powerW={powerW}
                  onPower={setPowerW}
                  deliveredShare={10 ** (-((lineAt?.lossDb ?? 0) + (radioAt?.lossDb ?? 0)) / 10)}
                  through={[lineCable && lineAt ? `${lineLengthM} m of ${lineCable.name}` : undefined, through && radioAt ? through.saved.name : undefined].filter(Boolean).join(' and ') || undefined}
                  solve={solveSideJob}
                  onCancel={cancelSolvers}
                />
              )}
            </>
          )}

          {isModel && (
            <ComparePanel
              measurement={measurement}
              onMeasurement={setMeasurement}
              modelled={frequency?.feeds[0] ? { fMHz: frequency.frequencyMHz, z: frequency.feeds[0].impedance } : undefined}
              z0={z0}
              sweep={compareSweep}
            />
          )}
          <CommunityPanel
            title="Club library"
            shelves={[
              {
                kind: 'antenna-model',
                title: 'Antenna models',
                local:
                  model.wires.length > 0 || source.kind === 'text'
                    ? [
                        {
                          id: 'this-model',
                          name: (isModel ? model.comments[0] : undefined)?.slice(0, 120) || 'Untitled antenna',
                          summary: isModel
                            ? `${model.wires.length} wire${model.wires.length === 1 ? '' : 's'}, ${model.frequency.startMHz} MHz, ${model.ground.kind === 'free-space' ? 'free space' : model.ground.kind === 'perfect' ? 'perfect ground' : 'real ground'}`
                            : 'a NEC deck',
                          payload: () => packModel(deckText, z0),
                        },
                      ]
                    : [],
                emptyLocal: 'Draw or open an antenna and it can be kept here, or shared. Its first line of notes is its name.',
                takeLabel: 'Open it',
                // A shared model is a NEC deck: opening it is exactly opening a .nec file.
                onTake: (payload, item) => {
                  const { deck, z0: reference } = unpackModel(payload);
                  setZ0(reference ?? DEFAULT_Z0);
                  loadDeck(deck);
                  setNotes((n) => [`From the club library: ${item.name}, shared CC0 by ${item.callsign}.`, ...n]);
                },
              },
            ]}
          />
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
  /** Saved baluns to look through, and which one is chosen ('' for none). */
  baluns: ThroughOption[];
  throughId: string;
  onThrough: (id: string) => void;
  /** The radio side of the chosen balun at this frequency, when one is chosen and usable. */
  through?: RadioSide & { name: string; powerW: number };
  /** The radio end of the feed line at this frequency, when a cable is chosen. */
  line?: LineSide & { name: string; lengthM: number; powerW: number; balunDb: number | undefined };
}

const STRAIN_WORDS = {
  ok: { mark: '✓', word: 'Within expected range' },
  hot: { mark: '!', word: 'Risk of thermal runaway' },
  burn: { mark: '✕', word: 'Likely to burn out' },
} as const;

/** The balun's loss, and a verdict on how hard it is working: green, orange or red, always with a word. */
function BalunLossCard({ through }: { through: RadioSide & { name: string; powerW: number } }) {
  const strain = balunStrain(through);
  const words = STRAIN_WORDS[strain.level];
  return (
    <div className={`balun-strain balun-strain-${strain.level}`} data-strain={strain.level}>
      <dt>Balun loss</dt>
      <dd>{Number.isFinite(through.lossDb) ? `${through.lossDb.toFixed(2)} dB` : '∞'}</dd>
      <small>
        <strong className="strain-word">
          <span aria-hidden="true">{words.mark}</span> {words.word}
        </strong>{' '}
        — estimated at {through.powerW} W: {strain.reason}. {through.coreW.toFixed(2)} W heats the core.
      </small>
    </div>
  );
}

/** What the chosen run of coax costs: matched loss, what the mismatch adds, and the watts. */
function FeedLineCard({ line }: { line: NonNullable<SummaryProps['line']> }) {
  const { deliveredW, heatW } = runPowers(line.lossDb, line.powerW);
  const antennaW = line.balunDb !== undefined ? deliveredW * 10 ** (-line.balunDb / 10) : deliveredW;
  return (
    <div className="feedline-card">
      <dt>Feed line loss</dt>
      <dd>{Number.isFinite(line.lossDb) ? `${line.lossDb.toFixed(2)} dB` : '∞'}</dd>
      <small>
        {line.lengthM} m of {line.name}: matched {line.matchedDb.toFixed(2)} dB, the mismatch adds{' '}
        {Number.isFinite(line.lossDb) ? (line.lossDb - line.matchedDb).toFixed(2) : '∞'} dB. At {line.powerW} W:{' '}
        {heatW.toFixed(1)} W warms the cable, {antennaW.toFixed(1)} W reaches the antenna
        {line.balunDb !== undefined ? ', balun included' : ''}.
      </small>
    </div>
  );
}

/** Watts out of the radio, frequency by frequency: what arrives and what heats what. */
function PowerBudgetChart({ line, radio, powerW, onPower }: { line: LineSide[]; radio: RadioSide[] | undefined; powerW: number; onPower: (watts: number) => void }) {
  const [hover, setHover] = useState<number | undefined>();
  const balunDb = (fMHz: number) => radio?.find((r) => r.fMHz === fMHz)?.lossDb ?? 0;
  const toFeedSide = line.map((l) => 10 ** (-l.lossDb / 10));
  const series = [
    { label: 'reaches the antenna', colour: 'var(--series-1)', values: line.map((l, i) => powerW * toFeedSide[i]! * 10 ** (-balunDb(l.fMHz) / 10)) },
    { label: 'heats the cable', colour: 'var(--series-3)', values: line.map((_, i) => powerW * (1 - toFeedSide[i]!)) },
    ...(radio ? [{ label: 'heats the balun', colour: 'var(--series-2)', values: line.map((l, i) => powerW * toFeedSide[i]! * (1 - 10 ** (-balunDb(l.fMHz) / 10))) }] : []),
  ];
  return (
    <div className="power-budget">
      <LineChart title={`Where ${powerW} W from the radio goes`} unit="W" fMHz={line.map((l) => l.fMHz)} series={series} hover={hover} onHover={setHover} />
      <p className="muted">
        With{' '}
        <input className="z0" type="number" min={0} step={10} value={powerW} onChange={(e) => onPower(Math.max(0, Number(e.target.value) || 0))} aria-label="Power out of the radio, watts" />{' '}
        W out of the radio, for a steady carrier.
      </p>
    </div>
  );
}

function Summary({ frequency, segments, patterns, cuts, z0, onZ0, baluns, throughId, onThrough, through, line }: SummaryProps) {
  const feed = frequency.feeds[0];
  const peak = mainLobe(patterns.flatMap((p) => p.points));
  const frontToBack = cuts.map(frontToBackDb).find((v) => v !== undefined);
  // The SWR the radio sees: at the feed point, through the balun, or at the far end of the line.
  const seen: Complex | undefined = line ? line.z : through ? through.z : feed?.impedance;
  const ratio = seen ? swr(seen, z0) : undefined;
  const path = line ? `${line.lengthM} m of ${line.name}${through ? ` and ${through.name}` : ''}` : through ? through.name : undefined;

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
            {baluns.length > 0 && (
              <>
                {' '}
                <select className="z0 through" value={throughId} onChange={(e) => onThrough(e.target.value)} aria-label="Seen through one of your baluns">
                  <option value="">at the feed</option>
                  {baluns.map((b) => (
                    <option key={b.saved.id} value={b.saved.id} disabled={b.material === undefined}>
                      through {b.saved.name}
                      {b.material === undefined ? ' (its measured core is gone)' : ''}
                    </option>
                  ))}
                </select>
              </>
            )}
          </dt>
          <dd>{Number.isFinite(ratio) ? `${ratio.toFixed(2)} : 1` : '∞'}</dd>
          <small>
            {seen && path
              ? `${formatImpedance(seen)} Ω at the radio through ${path}`
              : `return loss ${returnLossDb(feed.impedance, z0).toFixed(1)} dB`}
          </small>
        </div>
      )}
      {through && <BalunLossCard through={through} />}
      {line && <FeedLineCard line={line} />}
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
          <small>losses in wires and loads; the ground is not counted</small>
        </div>
      )}
    </dl>
  );
}


/** Volts across, current through and heat in every load, at the power you type. */
function LoadRatingsCard({ model, frequency, powerW, onPower }: { model: AntennaModel; frequency: FrequencyResult; powerW: number; onPower: (watts: number) => void }) {
  const ratings = loadRatings(model, frequency, powerW);
  if (ratings.length === 0) return null;
  return (
    <details className="panel ratings" open>
      <summary>What the loads must survive</summary>
      <p className="muted">
        With{' '}
        <input className="z0" type="number" min={0} step={10} value={powerW} onChange={(e) => onPower(Math.max(0, Number(e.target.value) || 0))} aria-label="Power into the feed point, watts" />{' '}
        W into the feed point at {frequency.frequencyMHz} MHz. Peak volts are what a capacitor is rated for; the heat is the average for a steady
        carrier - speech and CW average less.
      </p>
      <table className="band-table ratings-table">
        <thead>
          <tr>
            <th scope="col">Load</th>
            <th scope="col">Where</th>
            <th scope="col">Current, A rms</th>
            <th scope="col">Volts, peak</th>
            <th scope="col">Heat, W</th>
          </tr>
        </thead>
        <tbody>
          {ratings.map((r) => (
            <tr key={r.load.id}>
              <th scope="row">{loadName(r.load)}</th>
              <td>{r.where}</td>
              <td>{r.ampsRms.toFixed(2)}</td>
              <td>{Number.isFinite(r.voltsPeak) ? r.voltsPeak.toFixed(0) : '∞'}</td>
              <td>{Number.isFinite(r.heatW) ? r.heatW.toFixed(2) : '∞'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
