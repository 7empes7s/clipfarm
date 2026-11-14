/** Undo/redo for the Studio: every change to the edit is a step. */
export interface History<T> {
  past: T[];
  present: T;
  future: T[];
}

const LIMIT = 100;

export const start = <T>(present: T): History<T> => ({ past: [], present, future: [] });

export const push = <T>(h: History<T>, next: T): History<T> => ({ past: [...h.past, h.present].slice(-LIMIT), present: next, future: [] });

export const canUndo = <T>(h: History<T>) => h.past.length > 0;
export const canRedo = <T>(h: History<T>) => h.future.length > 0;

export function undo<T>(h: History<T>): History<T> {
  if (!canUndo(h)) return h;
  return { past: h.past.slice(0, -1), present: h.past.at(-1)!, future: [h.present, ...h.future] };
}

export function redo<T>(h: History<T>): History<T> {
  if (!canRedo(h)) return h;
  return { past: [...h.past, h.present], present: h.future[0]!, future: h.future.slice(1) };
}
