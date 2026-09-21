// Choosing where models get solved: in this browser, by a service this site provides,
// or by one running on the user's own machine.

import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import {
  type Solver,
  type SolverChoice,
  type SolverInfo,
  NEC2_KIND,
  createSolver,
  describeChoice,
  engineFor,
  isAllowedSolverUrl,
} from '../../engine/nec2/solver';

export interface SolverPickerProps {
  choice: SolverChoice;
  onChange: (choice: SolverChoice) => void;
  /** Set when a run had to fall back to this browser. */
  fallbackNote?: string;
}

type Probe = { state: 'checking' } | { state: 'ready'; info: SolverInfo } | { state: 'failed'; message: string };

function summarise(info: SolverInfo): string {
  const nec2 = engineFor(info, NEC2_KIND);
  const bits: string[] = [];
  if (nec2) {
    bits.push(`${nec2.engine} ${nec2.version}`);
    if (nec2.build) bits.push(nec2.build);
    // Worth saying out loud: it will not give quite the browser's numbers.
    if (nec2.precision && nec2.precision !== 'double') bits.push(`${nec2.precision} precision`);
  }
  if (info.workers && info.workers > 1) bits.push(`${info.workers} workers`);
  if (info.host) bits.push(`on ${info.host}`);
  return bits.join(' · ');
}

export function SolverPicker({ choice, onChange, fallbackNote }: SolverPickerProps) {
  const [draftUrl, setDraftUrl] = useState(choice.kind === 'url' ? choice.url : 'http://127.0.0.1:8073');
  const [probe, setProbe] = useState<Probe | undefined>(undefined);
  const probed = useRef<Solver | undefined>(undefined);

  // Ask a remote solver what it is, so the user can see they are talking to the right thing.
  useEffect(() => {
    probed.current?.cancel();
    if (choice.kind === 'local') {
      setProbe(undefined);
      return;
    }
    const solver = createSolver(choice);
    probed.current = solver;
    let current = true;
    setProbe({ state: 'checking' });
    solver
      .describe()
      .then((info) => current && setProbe({ state: 'ready', info }))
      .catch((e: unknown) => current && setProbe({ state: 'failed', message: e instanceof Error ? e.message : String(e) }));
    return () => {
      current = false;
      solver.cancel();
    };
  }, [choice]);

  const pick = (e: ChangeEvent<HTMLSelectElement>) => {
    const kind = e.target.value;
    if (kind === 'local') onChange({ kind: 'local' });
    else if (kind === 'site') onChange({ kind: 'site' });
    else onChange({ kind: 'url', url: draftUrl });
  };

  const urlUsable = isAllowedSolverUrl(draftUrl);

  return (
    <div className="solver-picker">
      <label className="solver-choice">
        <span className="field-label">Solve with</span>
        <select value={choice.kind} onChange={pick} aria-label="Where to solve models">
          <option value="local">This browser</option>
          <option value="site">This site's solver</option>
          <option value="url">A solver on this machine…</option>
        </select>
      </label>

      {choice.kind === 'url' && (
        <div className="field-row">
          <label className="field">
            <span className="visually-hidden">Solver address</span>
            <span className="field-input">
              <input
                type="text"
                value={draftUrl}
                spellCheck={false}
                aria-invalid={!urlUsable}
                onChange={(e) => setDraftUrl(e.target.value)}
                onBlur={() => urlUsable && draftUrl !== choice.url && onChange({ kind: 'url', url: draftUrl })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && urlUsable) onChange({ kind: 'url', url: draftUrl });
                }}
              />
            </span>
          </label>
          <button type="button" className="small" disabled={!urlUsable} onClick={() => onChange({ kind: 'url', url: draftUrl })}>
            Check
          </button>
        </div>
      )}

      {choice.kind === 'url' && !urlUsable && (
        <p className="muted">
          Only a solver on this machine can be named here — http://127.0.0.1:8073, say. Anything else has to go through
          this site's own solver, which the person running the site sets up.
        </p>
      )}

      {probe?.state === 'checking' && <p className="muted">Asking {describeChoice(choice)}…</p>}
      {probe?.state === 'ready' && <p className="muted solver-ready">Ready: {summarise(probe.info)}</p>}
      {probe?.state === 'failed' && (
        <p className="alert-inline solver-trouble">
          {probe.message} Models will be solved in this browser until it answers.
        </p>
      )}
      {fallbackNote && <p className="alert-inline solver-fallback">{fallbackNote}</p>}
      {choice.kind !== 'local' && (
        <p className="muted">
          Your model is sent to that solver to be worked out. Everything else still happens in this browser.
        </p>
      )}
    </div>
  );
}
