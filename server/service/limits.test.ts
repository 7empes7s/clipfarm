import { describe, expect, it } from "vitest";
import type { Usage } from "../../shared/service.js";
import { assertBrand, assertCanProcess, assertPlatform, currentPeriod, mrrCents, planProblem, processProblem, UpgradeRequired } from "./limits.js";
import { DEFAULT_PLANS, parsePlan } from "./plans.js";

const starter = DEFAULT_PLANS.find((p) => p.id === "starter")!;
const managed = DEFAULT_PLANS.find((p) => p.id === "managed-views")!;
const usage = (u: Partial<Usage> = {}): Usage => ({ periodStart: "2026-11-01T00:00:00.000Z", periodEnd: "2026-12-01T00:00:00.000Z", minutes: 0, clips: 0, posts: 0, views: 0, ...u });

describe("plan limits", () => {
  it("nothing starts without a plan in force, and a failed payment says to update the card", () => {
    expect(planProblem(null, "none")).toMatch(/Pick a plan/);
    expect(planProblem(starter, "none")).toMatch(/Pick a plan/);
    expect(planProblem(starter, "incomplete")).toMatch(/Pick a plan/);
    expect(planProblem(starter, "past_due")).toMatch(/Update your card/);
    expect(planProblem(starter, "canceled")).toMatch(/ended/);
    expect(planProblem(starter, "active")).toBeNull();
    expect(planProblem(starter, "trialing")).toBeNull();
  });

  it("minutes and clips run out at the plan's numbers, with an upgrade prompt and the reset date", () => {
    expect(processProblem(starter, "active", usage({ minutes: 119, clips: 59 }))).toBeNull();
    expect(processProblem(starter, "active", usage({ minutes: 120 }))).toBe("You used all 120 minutes of Starter this month. Upgrade for more, or wait until 2026-12-01.");
    expect(processProblem(starter, "active", usage({ clips: 60 }))).toMatch(/all 60 clips of Starter.*Upgrade/);
    expect(() => assertCanProcess(starter, "active", usage({ minutes: 500 }))).toThrow(UpgradeRequired);
    try {
      assertCanProcess(starter, "active", usage({ minutes: 500 }));
    } catch (err) {
      expect((err as UpgradeRequired).status).toBe(402);
    }
  });

  it("a plan without limits never runs out", () => {
    expect(processProblem(managed, "active", usage({ minutes: 100_000, clips: 100_000 }))).toBeNull();
  });

  it("platforms and the brand kit follow the plan", () => {
    expect(() => assertPlatform(starter, "active", "youtube")).not.toThrow();
    expect(() => assertPlatform(starter, "active", "instagram")).toThrow("Starter does not post to Instagram Reels. Upgrade to add it.");
    expect(() => assertPlatform(starter, "none", "youtube")).toThrow(/Pick a plan/);
    expect(() => assertBrand(starter, "active")).not.toThrow();
    expect(() => assertBrand({ ...starter, brandTemplates: 0 }, "active")).toThrow(/no brand kit/);
  });

  it("MRR counts monthly prices of plans in force (and in arrears), not metered views", () => {
    expect(mrrCents(starter, "active")).toBe(1900);
    expect(mrrCents(starter, "past_due")).toBe(1900);
    expect(mrrCents(starter, "canceled")).toBe(0);
    expect(mrrCents(managed, "active")).toBe(0);
    expect(mrrCents(null, "active")).toBe(0);
  });
});

describe("billing period", () => {
  const now = new Date("2026-11-14T10:00:00Z");
  it("is the calendar month until Stripe sends one", () => {
    expect(currentPeriod(null, null, now)).toEqual({ start: new Date("2026-11-01T00:00:00Z"), end: new Date("2026-12-01T00:00:00Z") });
  });
  it("is Stripe's while it holds now, and rolls forward by months when a renewal was missed", () => {
    expect(currentPeriod("2026-11-03T08:00:00.000Z", "2026-12-03T08:00:00.000Z", now)).toEqual({ start: new Date("2026-11-03T08:00:00Z"), end: new Date("2026-12-03T08:00:00Z") });
    expect(currentPeriod("2026-09-03T08:00:00.000Z", "2026-10-03T08:00:00.000Z", now)).toEqual({ start: new Date("2026-11-03T08:00:00Z"), end: new Date("2026-12-03T08:00:00Z") });
  });
});

describe("plans set in the admin", () => {
  const body = { id: "plus", name: "Plus", kind: "self-serve", blurb: "x", currency: "EUR", monthlyCents: 2900, minutes: "300", clips: "", platforms: ["youtube"], brandTemplates: 2 };
  it("are checked and cleaned", () => {
    expect(parsePlan(body, null)).toMatchObject({ id: "plus", currency: "eur", minutes: 300, clips: null, per1kViewsCents: null, active: true, stripePriceId: null });
    expect(() => parsePlan({ ...body, platforms: [] }, null)).toThrow(/platform/);
    expect(() => parsePlan({ ...body, monthlyCents: 0 }, null)).toThrow(/monthly price, a price per 1,000 views/);
    expect(() => parsePlan({ ...body, kind: "free" }, null)).toThrow(/self-serve or managed/);
    expect(() => parsePlan({ ...body, minutes: -1 }, null)).toThrow(/whole number/);
  });
  it("keep their Stripe price while the price stays, and drop it when the price changes", () => {
    const old = { ...parsePlan(body, null), stripePriceId: "price_1" };
    expect(parsePlan({ ...body, name: "Plus+" }, old).stripePriceId).toBe("price_1");
    expect(parsePlan({ ...body, monthlyCents: 3900 }, old).stripePriceId).toBeNull();
  });
});
