// Undo/redo for the antenna model.
//
// A drag in a view is a "gesture": it updates the model on every pointer move, but
// the whole drag is one undo step, and a click that moved nothing leaves no step at all.

import type { AntennaModel } from './model';

const LIMIT = 200;

export interface History {
  past: AntennaModel[];
  present: AntennaModel;
  future: AntennaModel[];
  /** True between gesture-start and gesture-end. */
  gesture: boolean;
}

export type HistoryAction =
  /** One undoable edit. A recipe that returns the same model records nothing. */
  | { type: 'edit'; recipe: (model: AntennaModel) => AntennaModel }
  /** Load a different model (an example, a file, a new model). Undoable. */
  | { type: 'load'; model: AntennaModel }
  | { type: 'gesture-start' }
  | { type: 'gesture-update'; model: AntennaModel }
  | { type: 'gesture-end' }
  | { type: 'undo' }
  | { type: 'redo' };

export function initialHistory(model: AntennaModel): History {
  return { past: [], present: model, future: [], gesture: false };
}

function push(history: History, next: AntennaModel): History {
  if (next === history.present) return history;
  return { ...history, past: [...history.past, history.present].slice(-LIMIT), present: next, future: [] };
}

export function historyReducer(history: History, action: HistoryAction): History {
  switch (action.type) {
    case 'edit':
      return push(history, action.recipe(history.present));
    case 'load':
      return push({ ...history, gesture: false }, action.model);
    case 'gesture-start':
      if (history.gesture) return history;
      // Checkpoint now; gesture-end drops it again if nothing changed.
      return { ...history, past: [...history.past, history.present].slice(-LIMIT), future: [], gesture: true };
    case 'gesture-update':
      return history.gesture ? { ...history, present: action.model } : push(history, action.model);
    case 'gesture-end': {
      if (!history.gesture) return history;
      const checkpoint = history.past[history.past.length - 1];
      const past = checkpoint === history.present ? history.past.slice(0, -1) : history.past;
      return { ...history, past, gesture: false };
    }
    case 'undo': {
      const previous = history.past[history.past.length - 1];
      if (!previous || history.gesture) return history;
      return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future], gesture: false };
    }
    case 'redo': {
      const [next, ...rest] = history.future;
      if (!next || history.gesture) return history;
      return { past: [...history.past, history.present], present: next, future: rest, gesture: false };
    }
  }
}
