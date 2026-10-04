// Undo/redo over any immutable model.
//
// A drag in a view is a "gesture": it updates the model on every pointer move, but
// the whole drag is one undo step, and a click that moved nothing leaves no step at all.
// The Antenna Modeler and the field sandbox both run on this.

const LIMIT = 200;

export interface GenericHistory<T> {
  past: T[];
  present: T;
  future: T[];
  /** True between gesture-start and gesture-end. */
  gesture: boolean;
}

export type GenericHistoryAction<T> =
  /** One undoable edit. A recipe that returns the same model records nothing. */
  | { type: 'edit'; recipe: (model: T) => T }
  /** Load a different model (an example, a file, a new model). Undoable. */
  | { type: 'load'; model: T }
  | { type: 'gesture-start' }
  | { type: 'gesture-update'; model: T }
  | { type: 'gesture-end' }
  | { type: 'undo' }
  | { type: 'redo' };

export function initialHistory<T>(model: T): GenericHistory<T> {
  return { past: [], present: model, future: [], gesture: false };
}

function push<T>(history: GenericHistory<T>, next: T): GenericHistory<T> {
  if (next === history.present) return history;
  return { ...history, past: [...history.past, history.present].slice(-LIMIT), present: next, future: [] };
}

export function historyReducer<T>(history: GenericHistory<T>, action: GenericHistoryAction<T>): GenericHistory<T> {
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
