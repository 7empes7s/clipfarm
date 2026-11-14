import { describe, expect, it } from "vitest";
import { canRedo, canUndo, push, redo, start, undo } from "./history";

describe("edit history (Studio undo/redo)", () => {
  it("undoes and redoes changes in order; a new change after an undo drops the redo", () => {
    let h = start({ n: 0 });
    expect(canUndo(h)).toBe(false);
    h = push(h, { n: 1 });
    h = push(h, { n: 2 });
    h = undo(h);
    expect(h.present).toEqual({ n: 1 });
    expect(canRedo(h)).toBe(true);
    h = redo(h);
    expect(h.present).toEqual({ n: 2 });
    h = undo(undo(h));
    expect(h.present).toEqual({ n: 0 });
    expect(undo(h)).toBe(h);
    h = push(h, { n: 5 });
    expect(canRedo(h)).toBe(false);
    expect(redo(h)).toBe(h);
  });

  it("keeps at most 100 steps", () => {
    let h = start(0);
    for (let i = 1; i <= 150; i++) h = push(h, i);
    expect(h.past).toHaveLength(100);
    expect(h.past[0]).toBe(50);
  });
});
