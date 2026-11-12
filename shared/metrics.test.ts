import { describe, expect, it } from "vitest";
import { average, costPerApprovedClip, etaSeconds, growth, median, mergeSeries, secondsPerReview, towards, weekStart } from "./metrics.js";

describe("growth", () => {
  it("is the change from the first to the last day, and its share of the start", () => {
    expect(growth([{ date: "2026-11-01", value: 1000 }, { date: "2026-11-02", value: 1100 }, { date: "2026-11-03", value: 1250 }])).toEqual({
      change: 250,
      pct: 0.25,
    });
  });

  it("can fall, and has no share when it started at zero", () => {
    expect(growth([{ date: "2026-11-01", value: 200 }, { date: "2026-11-02", value: 150 }])).toEqual({ change: -50, pct: -0.25 });
    expect(growth([{ date: "2026-11-01", value: 0 }, { date: "2026-11-02", value: 40 }])).toEqual({ change: 40, pct: null });
  });

  it("needs two days", () => {
    expect(growth([])).toBeNull();
    expect(growth([{ date: "2026-11-01", value: 5 }])).toBeNull();
  });
});

describe("average and median", () => {
  it("average of views per post, null without posts", () => {
    expect(average([1000, 2000, 6000])).toBe(3000);
    expect(average([])).toBeNull();
  });

  it("median of odd and even lists", () => {
    expect(median([9, 1, 5])).toBe(5);
    expect(median([4, 1, 8, 6])).toBe(5);
    expect(median([])).toBeNull();
  });
});

describe("costPerApprovedClip", () => {
  it("divides spend by approved clips, to 4 decimals", () => {
    expect(costPerApprovedClip(0.72, 6)).toBe(0.12);
    expect(costPerApprovedClip(0.1, 3)).toBe(0.0333);
  });

  it("is null before the first approval", () => {
    expect(costPerApprovedClip(0.36, 0)).toBeNull();
  });
});

describe("etaSeconds", () => {
  const now = new Date("2026-11-19T12:10:00.000Z");
  it("projects the time left from the time so far", () => {
    // 10 minutes for 25 % → 30 minutes left.
    expect(etaSeconds(0.25, "2026-11-19T12:00:00.000Z", now)).toBe(1800);
  });

  it("does not guess too early, without a start or once done", () => {
    expect(etaSeconds(0.02, "2026-11-19T12:00:00.000Z", now)).toBeNull();
    expect(etaSeconds(0.5, null, now)).toBeNull();
    expect(etaSeconds(1, "2026-11-19T12:00:00.000Z", now)).toBeNull();
  });
});

describe("secondsPerReview", () => {
  it("is the median gap between decisions, leaving out breaks", () => {
    const t = (s: number) => new Date(Date.UTC(2026, 10, 19, 12, 0, s)).toISOString();
    // Gaps 6, 8, 7 s, then a 10-minute break (ignored), then 9 s.
    const times = [t(0), t(6), t(14), t(21), new Date(Date.UTC(2026, 10, 19, 12, 10, 21)).toISOString(), new Date(Date.UTC(2026, 10, 19, 12, 10, 30)).toISOString()];
    expect(secondsPerReview(times)).toBe(7.5);
  });

  it("needs two decisions", () => {
    expect(secondsPerReview(["2026-11-19T12:00:00.000Z"])).toBeNull();
  });
});

describe("mergeSeries", () => {
  it("adds new days, replaces the same day and keeps the order", () => {
    const stored = [
      { date: "2026-11-01", value: 10 },
      { date: "2026-11-02", value: 12 },
    ];
    expect(mergeSeries(stored, [{ date: "2026-11-03", value: 15 }, { date: "2026-11-02", value: 13 }])).toEqual([
      { date: "2026-11-01", value: 10 },
      { date: "2026-11-02", value: 13 },
      { date: "2026-11-03", value: 15 },
    ]);
  });

  it("keeps only the last days asked for", () => {
    expect(mergeSeries([{ date: "2026-08-01", value: 1 }], [{ date: "2026-11-19", value: 2 }], 90)).toEqual([{ date: "2026-11-19", value: 2 }]);
  });
});

describe("weekStart and towards", () => {
  it("weeks start on Monday (UTC)", () => {
    expect(weekStart(new Date("2026-11-19T15:00:00.000Z")).toISOString()).toBe("2026-11-16T00:00:00.000Z");
    expect(weekStart(new Date("2026-11-22T23:59:00.000Z")).toISOString()).toBe("2026-11-16T00:00:00.000Z");
    expect(weekStart(new Date("2026-11-16T00:00:00.000Z")).toISOString()).toBe("2026-11-16T00:00:00.000Z");
  });

  it("progress towards a goal, capped at 1, either way round", () => {
    expect(towards(8, 10)).toBe(0.8);
    expect(towards(14, 10)).toBe(1);
    expect(towards(40, 30, true)).toBe(0.75);
    expect(towards(20, 30, true)).toBe(1);
    expect(towards(null, 10)).toBeNull();
  });
});
