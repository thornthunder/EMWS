// Undo/redo for the antenna model: the generic history in src/lib/history.ts, typed.
//
// A drag in a view is a "gesture": it updates the model on every pointer move, but
// the whole drag is one undo step, and a click that moved nothing leaves no step at all.

import { type GenericHistory, type GenericHistoryAction, historyReducer as reduce, initialHistory as initial } from '../../lib/history';
import type { AntennaModel } from './model';

export type History = GenericHistory<AntennaModel>;
export type HistoryAction = GenericHistoryAction<AntennaModel>;

export function initialHistory(model: AntennaModel): History {
  return initial(model);
}

export function historyReducer(history: History, action: HistoryAction): History {
  return reduce(history, action);
}
