// The mouse wheel on a number box: a notch nudges the last digit shown, a quick spin the
// digit above it, and a slider's long tail of digits never makes the step uselessly small.

import { describe, expect, it } from 'vitest';
import { notchesIn, nudge, wheelStep } from '../src/ui/number-step';

describe('a wheel notch on a number box', () => {
  it('steps by the last digit shown', () => {
    expect(wheelStep(120.5)).toBe(0.1);
    expect(wheelStep(47)).toBe(1);
    expect(wheelStep(3.3)).toBe(0.1);
    expect(wheelStep(1200)).toBe(1);
    expect(wheelStep(0.66)).toBe(0.01);
  });

  it('is never finer than the fourth significant figure, so a slider-set value still moves usefully', () => {
    expect(wheelStep(118.765)).toBe(0.1);
    expect(wheelStep(72.4327)).toBe(0.01);
    expect(wheelStep(2.34567)).toBe(0.001);
    expect(wheelStep(1234.5678)).toBe(1);
  });

  it('steps an integer field by whole numbers, and a zero by one', () => {
    expect(wheelStep(2.5, true)).toBe(1);
    expect(wheelStep(0)).toBe(1);
  });

  it('adds the step - ten times it for a quick spin - without floating-point crumbs', () => {
    expect(nudge(120.5, 1, 0.1, false)).toBe(120.6);
    expect(nudge(120.5, 1, 0.1, true)).toBe(121.5);
    expect(nudge(47, 1, 1, true)).toBe(57);
    expect(nudge(100, -1, 1, false)).toBe(99);
    expect(nudge(118.765, 1, 0.1, false)).toBe(118.865);
    expect(nudge(118.765, -1, 0.1, false)).toBe(118.665);
    // The step is the box's for as long as it is held: ten notches from 0.1 reach 1.1, through 1.0, not 2.
    let v = 0.1;
    const step = wheelStep(v);
    for (let n = 0; n < 10; n++) v = nudge(v, 1, step, false);
    expect(v).toBe(1.1);
    // A solver's 72.4327 nH: five slow notches and three quick ones.
    v = 72.4327;
    const fine = wheelStep(v);
    for (let n = 0; n < 5; n++) v = nudge(v, 1, fine, false);
    expect(v).toBe(72.4827);
    for (let n = 0; n < 3; n++) v = nudge(v, 1, fine, true);
    expect(v).toBe(72.7827);
  });

  it('counts a mouse click as one notch however big, merged clicks as several, and a touchpad move as none yet', () => {
    expect(notchesIn(100)).toBe(1); // Windows
    expect(notchesIn(-100)).toBe(1);
    expect(notchesIn(48)).toBe(1); // Firefox, 3 lines
    expect(notchesIn(120)).toBe(1);
    expect(notchesIn(300)).toBe(3); // three clicks the browser delivered as one event
    expect(notchesIn(12)).toBe(0);
    expect(notchesIn(0)).toBe(0);
  });
});
