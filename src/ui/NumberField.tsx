// A number box that lets you type freely and commits on Enter or when you leave it.
// Accepts a decimal comma as well as a point.

import { type KeyboardEvent, useState } from 'react';

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
}

export function formatValue(value: number): string {
  return String(Number(value.toPrecision(8)));
}

export function NumberField({ label, value, onCommit, min, above, integer, unit, hideLabel, className }: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
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
    <label className={`field ${className ?? ''}`}>
      <span className={hideLabel ? 'visually-hidden' : 'field-label'}>{label}</span>
      <span className="field-input">
        <input
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
