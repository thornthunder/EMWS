// How far a mouse-wheel notch nudges a number: by its last digit shown, or by the digit
// above it for a quick spin. Written as a pure function so it can be held to examples.
//
// Public domain (The Unlicense). By ZR1JT.

/** Below this many milliseconds between notches, the wheel is being spun, not clicked. */
export const QUICK_SPIN_MS = 120;
/** A mouse gives about this much travel a click (Windows 100 px, Firefox 3 lines = 48). */
export const CLICK_PX = 100;
/** Travel that counts as a notch at all: a touchpad's many small moves add up to it. */
export const NOTCH_PX = 40;

/**
 * How many notches one wheel event is worth. A mouse click is one event of a notch or more:
 * one notch - or several when the browser has merged clicks it was too busy to deliver one
 * by one. Smaller moves (a touchpad) are returned as 0 and left to accumulate.
 */
export function notchesIn(travelPx: number): number {
  const size = Math.abs(travelPx);
  return size >= NOTCH_PX ? Math.max(1, Math.round(size / CLICK_PX)) : 0;
}

/** Decimal places a value shows, as the number box shows it (8 significant figures, no trailing noise). */
function shownDecimals(value: number): number {
  const text = String(Number(value.toPrecision(8)));
  if (/e/i.test(text)) return 0;
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

/**
 * The step for one slow notch, decided ONCE when the box is clicked and kept until it is
 * left. A value typed as 120.5 steps by 0.1, 47 by 1; a value a slider left as 118.765
 * steps by 0.1 rather than 0.001, because the step is never finer than the fourth
 * significant figure; an integer field by at least 1. A quick spin steps by ten times it.
 *
 * Decided once, because a value's "last digit shown" changes as it is nudged - 0.9 + 0.1 is
 * 1, whose last digit is a whole one - and a step that followed it coarsened mid-spin.
 */
export function wheelStep(value: number, integer = false): number {
  let decimals = shownDecimals(value);
  if (value !== 0) decimals = Math.min(decimals, Math.max(0, 3 - Math.floor(Math.log10(Math.abs(value)))));
  if (integer) decimals = 0;
  return 10 ** -decimals;
}

/** The value after a notch of a step, tidied so 0.1 + 0.1 is 0.2 and not 0.30000000000000004 later. */
export function nudge(value: number, direction: 1 | -1, step: number, quick: boolean): number {
  return Number((value + direction * (quick ? step * 10 : step)).toPrecision(10));
}
