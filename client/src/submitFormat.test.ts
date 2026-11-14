import { describe, expect, it } from "vitest";
import { clipTarget, submitCountdown, submitTarget } from "./submitFormat";

const live = "2026-11-19T12:00:00.000Z";
const post = (o: { missedAt?: string | null; whopSubmittedAt?: string | null; lostEarningsUsd?: number } = {}) => ({
  submit: { liveAt: live, dueBy: "2026-11-19T12:30:00.000Z", missedAt: o.missedAt ?? null },
  whopSubmittedAt: o.whopSubmittedAt ?? null,
  lostEarningsUsd: o.lostEarningsUsd ?? 0,
});
const at = (iso: string) => new Date(iso).getTime();

describe("submitCountdown", () => {
  it("counts down the 30 minutes, and turns urgent for the last 10", () => {
    expect(submitCountdown(post(), at(live))).toEqual({ state: "open", text: "Submit within 30:00" });
    expect(submitCountdown(post(), at("2026-11-19T12:07:55.000Z"))).toEqual({ state: "open", text: "Submit within 22:05" });
    expect(submitCountdown(post(), at("2026-11-19T12:20:00.000Z"))).toEqual({ state: "late", text: "Submit within 10:00" });
    expect(submitCountdown(post(), at("2026-11-19T12:29:59.000Z"))).toEqual({ state: "late", text: "Submit within 0:01" });
  });

  it("says the window was missed, with what it cost", () => {
    expect(submitCountdown(post(), at("2026-11-19T12:30:00.000Z"))?.state).toBe("missed");
    expect(submitCountdown(post({ missedAt: "2026-11-19T12:30:00.000Z", lostEarningsUsd: 16.2 }), at("2026-11-20T09:00:00.000Z"))).toEqual({
      state: "missed",
      text: "Window missed: it was not submitted within 30 minutes, so it earns nothing. About $16.20 lost.",
    });
  });

  it("says nothing for a submitted post, one that waits, or one that needs no submit", () => {
    expect(submitCountdown(post({ whopSubmittedAt: "2026-11-19T12:05:00.000Z" }), at(live))).toBeNull();
    expect(submitCountdown({ submit: { liveAt: null, dueBy: null, missedAt: null }, whopSubmittedAt: null, lostEarningsUsd: 0 }, at(live))).toBeNull();
    expect(submitCountdown({ submit: null, whopSubmittedAt: null, lostEarningsUsd: 0 }, at(live))).toBeNull();
  });
});

describe("submitTarget", () => {
  it("reads the post a push opens from the address", () => {
    expect(submitTarget("submit-12")).toBe(12);
    expect(submitTarget("submit-x")).toBeNull();
    expect(submitTarget(undefined)).toBeNull();
  });
});

describe("clipTarget", () => {
  it("reads the clip a dashboard row opens from the address", () => {
    expect(clipTarget("clip-7")).toBe(7);
    expect(clipTarget("submit-7")).toBeNull();
    expect(clipTarget(undefined)).toBeNull();
  });
});
