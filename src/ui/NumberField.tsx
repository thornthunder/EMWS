// A number box that lets you type freely and commits on Enter or when you leave it.
// Accepts a decimal comma as well as a point. With `wheel`, the mouse wheel nudges the
// value while the box has focus - a notch by its last digit shown, a quick spin by the
// digit above - and leaves an unfocused box alone, so scrolling the page never edits anything.

import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { NOTCH_PX, QUICK_SPIN_MS, notchesIn, nudge, wheelStep } from './number-step';

export interface NumberFieldProps {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  /** Reject values below this. */
  min?: number;
  /** Reject values at or below this. */
  above?: number;
  integer?: boolean;
  unit?: string;
  /** Visually hide the label (it is still read out). */
  hideLabel?: boolean;
  className?: string;
  /** A sentence shown when the pointer rests on the field: what it is and what it does. */
  hint?: string;
  /** Let the mouse wheel nudge the value while the box has focus (see number-step.ts). */
  wheel?: boolean;
}

const WHEEL_HINT =
  'Click it and roll the mouse wheel to nudge the value: a notch moves the last digit shown (never finer than the fourth significant figure), a quick spin the digit before it.';

export function formatValue(value: number): string {
  return String(Number(value.toPrecision(8)));
}

export function NumberField({ label, value, onCommit, min, above, integer, unit, hideLabel, className, hint, wheel }: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // The wheel listener is native (React's is passive and cannot stop the page scrolling),
  // so it reads the latest props through a ref rather than closing over a render's.
  const latest = useRef({ value, onCommit, min, above, integer });
  latest.current = { value, onCommit, min, above, integer };
  useEffect(() => {
    const input = inputRef.current;
    if (!wheel || !input) return;
    let travel = 0;
    let lastStamp = -Infinity;
    // The step is decided from the value the box held when clicked, and kept until it is left.
    let step: number | undefined;
    const onFocus = () => {
      step = undefined;
      travel = 0;
    };
    const onWheel = (e: WheelEvent) => {
      if (document.activeElement !== input) return;
      e.preventDefault();
      step ??= wheelStep(latest.current.value, latest.current.integer);
      const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      let notches = notchesIn(delta);
      if (notches === 0) {
        travel += delta;
        if (Math.abs(travel) < NOTCH_PX) return;
        notches = 1;
        travel = 0;
      }
      // Wheel up (negative travel) raises the value, as a spin box would. Quickness comes
      // from the events' own timestamps, not from when they were handled: a busy page can
      // take longer than the window to redraw between two clicks of a spinning wheel.
      const direction: 1 | -1 = delta < 0 ? 1 : -1;
      let quick = e.timeStamp - lastStamp < QUICK_SPIN_MS;
      lastStamp = e.timeStamp;
      for (let n = 0; n < notches; n++, quick = true) {
        const p = latest.current;
        const next = nudge(p.value, direction, step, quick);
        if ((p.min !== undefined && next < p.min) || (p.above !== undefined && next <= p.above)) continue;
        setDraft(null);
        p.onCommit(next);
        latest.current = { ...p, value: next };
      }
    };
    input.addEventListener('focus', onFocus);
    input.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      input.removeEventListener('focus', onFocus);
      input.removeEventListener('wheel', onWheel);
    };
  }, [wheel]);
  const parsed = draft === null ? value : Number(draft.trim().replace(',', '.'));
  const valid =
    draft === null ||
    (draft.trim() !== '' &&
      Number.isFinite(parsed) &&
      (min === undefined || parsed >= min) &&
      (above === undefined || parsed > above) &&
      (!integer || Number.isInteger(parsed)));

  const commit = () => {
    if (draft === null) return;
    if (valid && parsed !== value) onCommit(parsed);
    setDraft(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      setDraft(null);
    }
  };

  return (
    <label className={`field ${className ?? ''}`} title={wheel ? (hint ? `${hint} ${WHEEL_HINT}` : WHEEL_HINT) : hint}>
      <span className={hideLabel ? 'visually-hidden' : 'field-label'}>{label}</span>
      <span className="field-input">
        <input
          ref={inputRef}
          type="text"
          inputMode={integer ? 'numeric' : 'decimal'}
          value={draft ?? formatValue(value)}
          aria-invalid={!valid}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
          spellCheck={false}
        />
        {unit && <span className="field-unit">{unit}</span>}
      </span>
    </label>
  );
}
