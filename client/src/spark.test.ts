import { describe, expect, it } from "vitest";
import { ringDash, sparkPath } from "./spark";

describe("sparkPath", () => {
  it("spreads the values across the box, highest at the top", () => {
    expect(sparkPath([0, 10, 5], 100, 20, 2)).toBe("M0.0,18.0 L50.0,2.0 L100.0,10.0");
  });

  it("draws a flat line in the middle when nothing changes", () => {
    expect(sparkPath([4, 4], 100, 20, 2)).toBe("M0.0,10.0 L100.0,10.0");
  });

  it("has nothing to draw for fewer than two values", () => {
    expect(sparkPath([7], 100, 20)).toBe("");
    expect(sparkPath([], 100, 20)).toBe("");
  });
});

describe("ringDash", () => {
  it("fills the ring by the share done", () => {
    const c = 2 * Math.PI * 10;
    expect(ringDash(3, 5, 10)).toEqual({ dash: c * 0.6, gap: c * 0.4 });
    expect(ringDash(0, 5, 10)).toEqual({ dash: 0, gap: c });
  });

  it("never overfills, and is empty with no steps", () => {
    const c = 2 * Math.PI * 10;
    expect(ringDash(9, 5, 10)).toEqual({ dash: c, gap: 0 });
    expect(ringDash(0, 0, 10)).toEqual({ dash: 0, gap: c });
  });
});
