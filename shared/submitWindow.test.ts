import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUBMIT_HOURS,
  needsManualSubmit,
  nextSubmitTime,
  parseSubmitHours,
  snoozeEnd,
  submitAction,
  type SubmitHours,
} from "./submitWindow.js";
import { NO_CAMPAIGN_RULES } from "./types.js";

const at = (iso: string) => new Date(iso);
const next = (iso: string, hours: SubmitHours = DEFAULT_SUBMIT_HOURS, snooze: string | null = null) =>
  nextSubmitTime(at(iso), hours, snooze ? at(snooze) : null).toISOString();

describe("nextSubmitTime", () => {
  it("moves 03:00 in Luxembourg to 08:00 the same morning", () => {
    // 2026-11-19 is on winter time: 03:00 there is 02:00 UTC, 08:00 is 07:00 UTC.
    expect(next("2026-11-19T02:00:00.000Z")).toBe("2026-11-19T07:00:00.000Z");
  });

  it("leaves a time inside the hours alone", () => {
    expect(next("2026-11-19T12:00:00.000Z")).toBe("2026-11-19T12:00:00.000Z");
    expect(next("2026-11-19T07:00:00.000Z")).toBe("2026-11-19T07:00:00.000Z");
  });

  it("keeps the whole 30 minutes inside the hours: the last post is half an hour before the end", () => {
    // 21:30 local still fits, 21:31 waits for the next morning.
    expect(next("2026-11-19T20:30:00.000Z")).toBe("2026-11-19T20:30:00.000Z");
    expect(next("2026-11-19T20:31:00.000Z")).toBe("2026-11-20T07:00:00.000Z");
  });

  it("uses the weekend hours on Saturday and Sunday, by the local day", () => {
    const hours: SubmitHours = { ...DEFAULT_SUBMIT_HOURS, weekends: { from: "10:00", to: "18:00" } };
    // Friday 23:00 local → Saturday 10:00 local.
    expect(next("2026-11-20T22:00:00.000Z", hours)).toBe("2026-11-21T09:00:00.000Z");
    // Sunday 19:00 local → Monday 08:00 local.
    expect(next("2026-11-22T18:00:00.000Z", hours)).toBe("2026-11-23T07:00:00.000Z");
  });

  it("follows the clock change: 08:00 is 06:00 UTC in summer and 07:00 UTC in winter", () => {
    // Spring forward on 2026-03-29: the day before is still winter time.
    expect(next("2026-03-28T03:00:00.000Z")).toBe("2026-03-28T07:00:00.000Z");
    expect(next("2026-03-29T00:30:00.000Z")).toBe("2026-03-29T06:00:00.000Z");
    // Fall back on 2026-10-25, asked in the hour that happens twice.
    expect(next("2026-10-24T03:00:00.000Z")).toBe("2026-10-24T06:00:00.000Z");
    expect(next("2026-10-25T00:30:00.000Z")).toBe("2026-10-25T07:00:00.000Z");
    // The last slot of the evening moves with it too.
    expect(next("2026-10-24T19:30:00.000Z")).toBe("2026-10-24T19:30:00.000Z");
    expect(next("2026-10-25T20:30:00.000Z")).toBe("2026-10-25T20:30:00.000Z");
  });

  it("counts the hours and the weekday in the chosen time zone, not the server's", () => {
    const la: SubmitHours = { ...DEFAULT_SUBMIT_HOURS, timeZone: "America/Los_Angeles", weekends: { from: "10:00", to: "18:00" } };
    // 03:00 UTC on Saturday is Friday 19:00 in Los Angeles: a weekday evening, inside the hours.
    expect(next("2026-11-21T03:00:00.000Z", la)).toBe("2026-11-21T03:00:00.000Z");
    // 07:00 UTC on Saturday is Friday 23:00 there: it waits for Saturday 10:00 (18:00 UTC).
    expect(next("2026-11-21T07:00:00.000Z", la)).toBe("2026-11-21T18:00:00.000Z");
    const tokyo: SubmitHours = { ...DEFAULT_SUBMIT_HOURS, timeZone: "Asia/Tokyo" };
    // 23:30 UTC is already 08:30 the next day in Tokyo.
    expect(next("2026-11-19T23:30:00.000Z", tokyo)).toBe("2026-11-19T23:30:00.000Z");
    expect(next("2026-11-19T14:00:00.000Z", tokyo)).toBe("2026-11-19T23:00:00.000Z");
  });

  it("waits for the end of a snooze, then for the hours", () => {
    expect(next("2026-11-19T12:00:00.000Z", DEFAULT_SUBMIT_HOURS, "2026-11-19T13:00:00.000Z")).toBe("2026-11-19T13:00:00.000Z");
    // Busy until midnight: the next morning.
    expect(next("2026-11-19T12:00:00.000Z", DEFAULT_SUBMIT_HOURS, "2026-11-19T23:00:00.000Z")).toBe("2026-11-20T07:00:00.000Z");
    // A snooze that is already over changes nothing.
    expect(next("2026-11-19T12:00:00.000Z", DEFAULT_SUBMIT_HOURS, "2026-11-19T11:00:00.000Z")).toBe("2026-11-19T12:00:00.000Z");
  });

  it("switched off, only a snooze moves a time", () => {
    const off = { ...DEFAULT_SUBMIT_HOURS, enabled: false };
    expect(next("2026-11-19T02:00:00.000Z", off)).toBe("2026-11-19T02:00:00.000Z");
    expect(next("2026-11-19T02:00:00.000Z", off, "2026-11-19T03:00:00.000Z")).toBe("2026-11-19T03:00:00.000Z");
  });
});

describe("snoozeEnd", () => {
  it("is 1 hour, 3 hours, or midnight in the manager's time zone", () => {
    const now = at("2026-11-19T12:10:00.000Z");
    expect(snoozeEnd(now, "1h", "Europe/Luxembourg").toISOString()).toBe("2026-11-19T13:10:00.000Z");
    expect(snoozeEnd(now, "3h", "Europe/Luxembourg").toISOString()).toBe("2026-11-19T15:10:00.000Z");
    expect(snoozeEnd(now, "today", "Europe/Luxembourg").toISOString()).toBe("2026-11-19T23:00:00.000Z");
    expect(snoozeEnd(now, "today", "America/Los_Angeles").toISOString()).toBe("2026-11-20T08:00:00.000Z");
  });
});

describe("submitAction", () => {
  const fresh = { notified: false, reminded: false };

  it("pushes when the post goes live, again at 20 minutes, and marks it missed at 30", () => {
    expect(submitAction(-1, fresh)).toBeNull();
    expect(submitAction(0, fresh)).toBe("notify");
    expect(submitAction(5, { notified: true, reminded: false })).toBeNull();
    expect(submitAction(19.9, { notified: true, reminded: false })).toBeNull();
    expect(submitAction(20, { notified: true, reminded: false })).toBe("remind");
    expect(submitAction(25, { notified: true, reminded: true })).toBeNull();
    expect(submitAction(29.9, { notified: true, reminded: true })).toBeNull();
    expect(submitAction(30, { notified: true, reminded: true })).toBe("miss");
  });

  it("first seen late, it sends one push, not two, and nothing once the window is over", () => {
    expect(submitAction(12, fresh)).toBe("notify");
    expect(submitAction(22, fresh)).toBe("remind");
    expect(submitAction(45, fresh)).toBe("miss");
  });
});

describe("needsManualSubmit", () => {
  it("is yes for a Whop / Content Rewards campaign unless its rules say no, and no for everything else", () => {
    expect(needsManualSubmit({ kind: "whop-campaign", rules: null })).toBe(true);
    expect(needsManualSubmit({ kind: "whop-campaign", rules: NO_CAMPAIGN_RULES })).toBe(true);
    expect(needsManualSubmit({ kind: "whop-campaign", rules: { ...NO_CAMPAIGN_RULES, manualSubmit: false } })).toBe(false);
    for (const kind of ["own-content", "experiment", "public-allowance", "direct-permission"] as const) {
      expect(needsManualSubmit({ kind, rules: null })).toBe(false);
    }
  });
});

describe("parseSubmitHours", () => {
  it("takes clean hours and says in plain words what is wrong with the rest", () => {
    const good = { enabled: true, timeZone: "Europe/Paris", weekdays: { from: "09:00", to: "21:30" }, weekends: { from: "10:00", to: "23:59" } };
    expect(parseSubmitHours(good)).toEqual(good);
    expect(parseSubmitHours({ ...good, timeZone: "Mars/Olympus" })).toBe("Pick a time zone from the list.");
    expect(parseSubmitHours({ ...good, weekdays: { from: "9", to: "21:30" } })).toBe("Weekday hours need a start and an end, like 08:00 and 22:00.");
    expect(parseSubmitHours({ ...good, weekends: { from: "10:00", to: "10:30" } })).toBe("Weekend hours must be at least an hour long, and end after they start.");
  });
});
