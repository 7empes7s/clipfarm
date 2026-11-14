import { describe, expect, it } from "vitest";
import type { Platform } from "../../shared/types.js";
import { bestTimes, nextBestTime } from "../../shared/publishing.js";
import { type Booking, planSlot, type SlotRequest } from "./planner.js";
import { nextFreeSlot } from "./spacing.js";

const H = 3600_000;
const at = (iso: string) => new Date(iso);
const free = (t: Date) => t;

function request(platform: Platform, accountId: string, wanted: Date, bookings: Booking[], extra: Partial<SlotRequest> = {}): SlotRequest {
  return { accountId, accountName: accountId, platform, app: "service:postiz", wanted, bookings, pace: free, paceText: "keeps its spacing", ...extra };
}

/** Plans `n` posts one after another, each booked before the next is planned, like the publisher does. */
function planMany(n: number, make: (i: number, bookings: Booking[]) => SlotRequest) {
  const bookings: Booking[] = [];
  const out = [];
  for (let i = 0; i < n; i++) {
    const req = make(i, bookings);
    const slot = planSlot(req);
    bookings.push({ accountId: req.accountId, platform: req.platform, app: req.app, at: slot.at });
    out.push(slot);
  }
  return { bookings, out };
}

describe("planSlot: each platform's limits", () => {
  it("never books more than 6 YouTube uploads per API project per Pacific day, across accounts, and rolls over with a reason", () => {
    const wanted = at("2026-11-19T17:00:00.000Z"); // 09:00 in Los Angeles
    const { bookings, out } = planMany(14, (i, b) => request("youtube", `yt-${i % 3}`, wanted, b));
    const perDay = new Map<string, number>();
    for (const b of bookings) {
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(b.at);
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
    }
    expect([...perDay.values()].every((n) => n <= 6)).toBe(true);
    expect(perDay.get("2026-11-19")).toBe(6);
    // The 7th rolls to the next Pacific midnight, and says why.
    expect(out[6]!.at.toISOString()).toBe("2026-11-20T08:00:00.000Z");
    expect(out[6]!.reasons[0]).toMatch(/about 6 uploads a day/);
    expect(out[0]!.reasons).toEqual([]);
  });

  it("counts YouTube uploads per API project: another app has its own 6", () => {
    const wanted = at("2026-11-19T17:00:00.000Z");
    const full: Booking[] = Array.from({ length: 6 }, (_, i) => ({ accountId: `a${i}`, platform: "youtube", app: "group:1", at: wanted }));
    expect(planSlot(request("youtube", "b", wanted, full, { app: "group:2" })).at).toEqual(wanted);
    expect(planSlot(request("youtube", "b", wanted, full, { app: "group:1" })).at.getTime()).toBeGreaterThan(wanted.getTime());
  });

  it("keeps Instagram to 50 posts per account in any 24 hours", () => {
    const start = at("2026-11-19T00:00:00.000Z");
    const { bookings, out } = planMany(60, (i, b) => request("instagram", "ig", new Date(start.getTime() + i * 60_000), b));
    const times = bookings.map((b) => b.at.getTime()).sort((a, b) => a - b);
    for (const t of times) expect(times.filter((x) => x > t - 24 * H && x <= t).length).toBeLessThanOrEqual(50);
    // The 51st waits until the first one is 24 hours old.
    expect(out[50]!.at.getTime()).toBe(start.getTime() + 24 * H);
    expect(out[50]!.reasons[0]).toMatch(/50 posts per account in any 24 hours/);
  });

  it("an Instagram post is not squeezed in before posts that would then break the 24 hours", () => {
    const later = at("2026-11-19T12:00:00.000Z");
    const booked: Booking[] = Array.from({ length: 50 }, (_, i) => ({ accountId: "ig", platform: "instagram", app: "x", at: new Date(later.getTime() + i * 1000) }));
    const slot = planSlot(request("instagram", "ig", at("2026-11-19T06:00:00.000Z"), booked));
    const times = [...booked.map((b) => b.at.getTime()), slot.at.getTime()].sort((a, b) => a - b);
    for (const t of times) expect(times.filter((x) => x > t - 24 * H && x <= t).length).toBeLessThanOrEqual(50);
  });

  it("an unaudited TikTok app posts for at most 5 accounts a day; a 6th account rolls to tomorrow", () => {
    const wanted = at("2026-11-19T10:00:00.000Z");
    const { out } = planMany(7, (i, b) => request("tiktok", `tt-${i}`, wanted, b));
    expect(out.slice(0, 5).every((s) => s.at.getTime() === wanted.getTime())).toBe(true);
    expect(out[5]!.at.toISOString()).toBe("2026-11-20T00:00:00.000Z");
    expect(out[5]!.reasons[0]).toMatch(/at most 5 accounts a day/);
    // An account that already posts that day can post again.
    const again = planMany(6, (i, b) => request("tiktok", `tt-${i % 5}`, wanted, b)).out;
    expect(again[5]!.at).toEqual(wanted);
  });

  it("an audited TikTok app has no 5-account limit", () => {
    const wanted = at("2026-11-19T10:00:00.000Z");
    const { out } = planMany(7, (i, b) => request("tiktok", `tt-${i}`, wanted, b, { tiktokAudited: true }));
    expect(out.every((s) => s.at.getTime() === wanted.getTime())).toBe(true);
  });

  it("keeps each account's own daily cap and gap, and says so", () => {
    const rules = { maxPerDay: 2, minGapMinutes: 60 };
    const wanted = at("2026-11-19T10:00:00.000Z");
    const { out } = planMany(3, (_i, b) =>
      request("x", "x1", wanted, b, { pace: (t) => nextFreeSlot(b.map((x) => x.at), t, rules), paceText: "x1 posts 2 a day, 60 min apart" }),
    );
    expect(out.map((s) => s.at.toISOString())).toEqual(["2026-11-19T10:00:00.000Z", "2026-11-19T11:00:00.000Z", "2026-11-20T00:00:00.000Z"]);
    expect(out[2]!.reasons).toEqual(["x1 posts 2 a day, 60 min apart."]);
  });

  it("platforms without an API limit only follow the account's cap", () => {
    const wanted = at("2026-11-19T10:00:00.000Z");
    const { out } = planMany(80, (i, b) => request("bluesky", `b${i % 2}`, wanted, b));
    expect(out.every((s) => s.at.getTime() === wanted.getTime())).toBe(true);
  });

  it("snaps to the next best hour when asked, and still rolls over limits", () => {
    const tz = "Europe/Luxembourg"; // UTC+1 in November
    const best = { hours: [12, 19], timeZone: tz };
    const wanted = at("2026-11-19T07:30:00.000Z"); // 08:30 there
    expect(planSlot(request("bluesky", "b", wanted, [], { best })).at.toISOString()).toBe("2026-11-19T11:00:00.000Z");
    const full: Booking[] = Array.from({ length: 6 }, (_, i) => ({ accountId: `a${i}`, platform: "youtube", app: "service:postiz", at: at("2026-11-19T18:00:00.000Z") }));
    // Full on the 19th (Pacific): the next best hour after the Pacific midnight is 12:00 on the 20th there.
    const slot = planSlot(request("youtube", "y", at("2026-11-19T17:00:00.000Z"), full, { best }));
    expect(slot.at.toISOString()).toBe("2026-11-20T11:00:00.000Z");
    expect(slot.reasons[0]).toMatch(/6 uploads a day/);
  });
});

describe("best times", () => {
  it("uses the defaults until there are enough posts with views, then learns the best hours", () => {
    const tz = "UTC";
    const few = Array.from({ length: 9 }, () => ({ platform: "tiktok" as const, at: "2026-11-10T22:00:00.000Z", views: 9000 }));
    expect(bestTimes("tiktok", few, tz)).toEqual({ platform: "tiktok", hours: [9, 12, 19], learned: false, basedOn: 0 });
    const many = [
      ...Array.from({ length: 6 }, () => ({ platform: "tiktok" as const, at: "2026-11-10T22:00:00.000Z", views: 9000 })),
      ...Array.from({ length: 6 }, () => ({ platform: "tiktok" as const, at: "2026-11-10T07:00:00.000Z", views: 100 })),
      { platform: "youtube" as const, at: "2026-11-10T03:00:00.000Z", views: 99999 },
    ];
    const learned = bestTimes("tiktok", many, tz);
    expect(learned.learned).toBe(true);
    expect(learned.basedOn).toBe(12);
    expect(learned.hours).toEqual([7, 9, 22]);
  });

  it("nextBestTime keeps a time inside a best hour and moves others to the next one", () => {
    expect(nextBestTime(at("2026-11-19T12:40:00.000Z"), [12], "UTC").toISOString()).toBe("2026-11-19T12:40:00.000Z");
    expect(nextBestTime(at("2026-11-19T13:00:00.000Z"), [12], "UTC").toISOString()).toBe("2026-11-20T12:00:00.000Z");
  });
});
