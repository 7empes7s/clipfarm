import { describe, expect, it } from "vitest";
import { bootstrapRatioRange, compareGroups, mannWhitney, morePostsNeeded, normalCdf, seeded } from "./stats.js";

/** Heavy-tailed, like views: exp(mean + sd × z), from a seeded generator. */
function lognormal(n: number, median: number, sd: number, seed: number): number[] {
  const rand = seeded(seed);
  return Array.from({ length: n }, () => {
    const z = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
    return median * Math.exp(sd * z);
  });
}

describe("mannWhitney", () => {
  it("gives the textbook answer for fully separated groups", () => {
    const r = mannWhitney([1, 2, 3, 4, 5], [6, 7, 8, 9, 10])!;
    expect(r.superiority).toBe(1);
    // U = 0 with 5 and 5: z = (12.5 - 0.5) / sqrt(22.92) = 2.51, two-sided p = 0.012.
    expect(r.pValue).toBeCloseTo(0.0122, 3);
  });

  it("sees no difference between identical groups, and handles ties", () => {
    expect(mannWhitney([3, 3, 3], [3, 3, 3])).toEqual({ superiority: 0.5, pValue: 1 });
    expect(mannWhitney([1, 2, 2, 3], [2, 2, 3, 4])!.superiority).toBeCloseTo(0.71875, 5);
    expect(mannWhitney([], [1])).toBeNull();
  });

  it("uses a correct normal curve", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 4);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 4);
  });
});

describe("compareGroups", () => {
  it("flags a clear 2× winner as significant, in plain words", () => {
    const a = { label: "A", values: lognormal(10, 100, 0.35, 1) };
    const b = { label: "B", values: lognormal(10, 200, 0.35, 2) };
    const c = compareGroups(a, b);
    expect(c.significant).toBe(true);
    expect(c.winner.label).toBe("B");
    expect(c.ratio).toBeGreaterThan(1.5);
    expect(c.ratioRange![0]).toBeGreaterThan(1);
    expect(c.text).toMatch(/^B beats A by \d\.\d× \(9[59]% sure\)$/);
    // The order the groups are given in does not change the read.
    expect(compareGroups(b, a).text).toBe(c.text);
  });

  it("calls a noisy 1.1× 'not enough data' and says how many more posts it needs", () => {
    const a = { label: "A", values: lognormal(10, 100, 0.8, 3) };
    const b = { label: "B", values: lognormal(10, 110, 0.8, 4) };
    const c = compareGroups(a, b);
    expect(c.significant).toBe(false);
    expect(c.text).toMatch(/^Not enough data yet: (~\d+ more posts needed|no clear difference so far)$/);
  });

  it("never calls a winner on fewer than 5 posts a side, however far apart", () => {
    const c = compareGroups({ label: "A", values: [1, 2, 3] }, { label: "B", values: [100, 200, 300] });
    expect(c.significant).toBe(false);
    expect(c.morePostsNeeded).toBeGreaterThanOrEqual(4);
    expect(c.text).toMatch(/^Not enough data yet: ~\d+ more posts needed$/);
  });

  it("copes with an empty side", () => {
    const c = compareGroups({ label: "A", values: [] }, { label: "B", values: [5, 6] });
    expect(c).toMatchObject({ significant: false, pValue: null, ratio: null });
    expect(c.text).toBe("Not enough data yet: ~8 more posts needed");
  });
});

describe("helpers", () => {
  it("bootstraps a range around the true ratio, the same every time", () => {
    const a = lognormal(30, 100, 0.3, 5);
    const b = lognormal(30, 200, 0.3, 6);
    const range = bootstrapRatioRange(a, b)!;
    expect(range[0]).toBeLessThan(2.2);
    expect(range[1]).toBeGreaterThan(1.8);
    expect(bootstrapRatioRange(a, b)).toEqual(range);
    expect(bootstrapRatioRange([1], [2])).toBeNull();
  });

  it("needs fewer further posts the bigger the edge, and none countable without one", () => {
    expect(morePostsNeeded(0.5, 20)).toBeNull();
    expect(morePostsNeeded(0.6, 20)!).toBeGreaterThan(morePostsNeeded(0.75, 20)!);
    expect(morePostsNeeded(0.9, 20)).toBe(2);
  });
});
