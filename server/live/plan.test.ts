import { describe, expect, it } from "vitest";
import {
  coveringSegment,
  decideCapture,
  guardReason,
  isArmed,
  LEAK_REASON,
  livePriority,
  overBacklog,
  sectionWithin,
  segmentDue,
  segmentExpired,
  type CaptureCheck,
  type LaunchSettings,
} from "./plan.js";

const LAUNCH = "2026-11-19T05:00:00.000Z";
const before = new Date("2026-11-18T12:00:00Z");
const after = new Date("2026-11-19T06:00:00Z");
const launch = (manual: LaunchSettings["manual"] = null): LaunchSettings => ({ launchAt: LAUNCH, manual, off: [] });

describe("isArmed", () => {
  it("is off before launch time and arms itself at the time", () => {
    expect(isArmed(launch(), before)).toBe(false);
    expect(isArmed(launch(), new Date(LAUNCH))).toBe(true);
    expect(isArmed(launch(), after)).toBe(true);
  });

  it("follows Arm and Disarm, but a Disarm from before launch does not outlive it", () => {
    expect(isArmed(launch({ armed: true, at: before.toISOString() }), before)).toBe(true);
    expect(isArmed(launch({ armed: false, at: before.toISOString() }), before)).toBe(false);
    expect(isArmed(launch({ armed: false, at: before.toISOString() }), after)).toBe(true);
    expect(isArmed(launch({ armed: false, at: after.toISOString() }), after)).toBe(false);
  });
});

describe("decideCapture", () => {
  const ok: CaptureCheck = {
    armed: true,
    beforeLaunch: false,
    creatorOn: true,
    permission: "active",
    live: { title: "day one!!", game: "Grand Theft Auto VI" },
    games: ["GTA VI"],
  };

  it("records a permitted, switched-on creator who is live with their game", () => {
    expect(decideCapture(ok)).toEqual({ capture: true });
  });

  it("refuses GTA VI before launch time with the leak reason, armed or not", () => {
    expect(decideCapture({ ...ok, beforeLaunch: true })).toEqual({ capture: false, reason: LEAK_REASON });
    expect(decideCapture({ ...ok, beforeLaunch: true, armed: false })).toEqual({ capture: false, reason: LEAK_REASON });
    // The category can be wrong or missing: the title counts too.
    expect(decideCapture({ ...ok, beforeLaunch: true, games: ["GTA VI", "Fortnite"], live: { title: "early copy of GTA 6", game: "Fortnite" } })).toEqual({
      capture: false,
      reason: LEAK_REASON,
    });
  });

  it("lets another game be recorded before launch time once armed by hand", () => {
    const fortnite = { ...ok, beforeLaunch: true, games: ["Fortnite"], live: { title: "ranked", game: "Fortnite" } };
    expect(decideCapture(fortnite)).toEqual({ capture: true });
    expect(decideCapture({ ...fortnite, armed: false })).toEqual({ capture: false, reason: "Live mode is off until launch time" });
  });

  it("puts the permission gate first and never records a leak", () => {
    expect(decideCapture({ ...ok, permission: "none", armed: false })).toMatchObject({ capture: false, reason: "Needs permission: join their program" });
    expect(decideCapture({ ...ok, permission: "expired" })).toMatchObject({ reason: "Permission expired: renew it in their program" });
    expect(decideCapture({ ...ok, live: { title: "GTA VI LEAKED ending", game: "Grand Theft Auto VI" } })).toMatchObject({ reason: "The title mentions a leak" });
  });

  it("gives a plain reason for every other no", () => {
    expect(decideCapture({ ...ok, live: null })).toMatchObject({ reason: "Not live" });
    expect(decideCapture({ ...ok, live: { title: "chatting", game: "Just Chatting" } })).toMatchObject({ reason: "Not streaming one of their games" });
    expect(decideCapture({ ...ok, armed: false })).toMatchObject({ reason: "Live mode is disarmed" });
    expect(decideCapture({ ...ok, creatorOn: false })).toMatchObject({ reason: "Switched off for this creator" });
  });
});

describe("guardReason", () => {
  it("refuses under 10 GB of disk or 1 GB of memory, in plain words", () => {
    expect(guardReason({ freeDiskBytes: 38e9, memAvailableBytes: 3.8e9 })).toBeNull();
    expect(guardReason({ freeDiskBytes: 8.2e9, memAvailableBytes: 3.8e9 })).toBe(
      "Not recording: only 8.2 GB of disk is free, and live mode needs 10.0 GB.",
    );
    expect(guardReason({ freeDiskBytes: 38e9, memAvailableBytes: 0.7e9 })).toBe(
      "Not recording: only 0.7 GB of memory is free, and live mode needs 1.0 GB.",
    );
  });
});

describe("rolling segments", () => {
  // 10 min steps, each segment 60 s longer: [0, 660), [600, 1260), [1200, 1860).
  const segs = [0, 600, 1200].map((startSec, id) => ({ id, startSec, durationSec: 660 }));

  it("starts the first segment at once and the next every step", () => {
    expect(segmentDue(null, 0, 600)).toBe(true);
    expect(segmentDue(0, 599, 600)).toBe(false);
    expect(segmentDue(0, 600, 600)).toBe(true);
    expect(segmentDue(600, 1150, 600)).toBe(false);
  });

  it("finds a moment that crosses a boundary whole in one segment", () => {
    // 9:40-10:30 crosses the 10:00 boundary; the first segment runs to 11:00.
    expect(coveringSegment(segs, 580, 630)?.id).toBe(0);
    // The longest clip (60 s) starting just before the boundary still fits.
    expect(coveringSegment(segs, 599.9, 659.9)?.id).toBe(0);
    expect(coveringSegment(segs, 600, 660)?.id).toBe(0);
    // In the overlap both hold it: the one with more room around it wins.
    expect(coveringSegment(segs, 625, 650)?.id).toBe(1);
    expect(coveringSegment(segs, 1300, 1330)?.id).toBe(2);
    // Past what is recorded so far: not yet.
    expect(coveringSegment(segs, 1850, 1880)).toBeNull();
    expect(coveringSegment([], 10, 20)).toBeNull();
  });

  it("pads the cut inside the segment", () => {
    expect(sectionWithin(segs[1]!, 700, 730)).toEqual({ startSec: 697, endSec: 733 });
    expect(sectionWithin(segs[1]!, 601, 630)).toEqual({ startSec: 600, endSec: 633 });
    expect(sectionWithin(segs[0]!, 620, 659)).toEqual({ startSec: 617, endSec: 660 });
  });

  it("deletes a segment after the keep time, unless a clip is still to be cut from it", () => {
    const now = new Date("2026-11-19T12:00:00Z");
    expect(segmentExpired({ startedAt: "2026-11-19T08:59:00Z", pendingPicks: 0 }, now, 3)).toBe(true);
    expect(segmentExpired({ startedAt: "2026-11-19T09:01:00Z", pendingPicks: 0 }, now, 3)).toBe(false);
    expect(segmentExpired({ startedAt: "2026-11-19T06:00:00Z", pendingPicks: 1 }, now, 3)).toBe(false);
  });
});

describe("priority and backlog", () => {
  it("runs live work before VOD work, clips before segments, the biggest creator first", () => {
    expect(livePriority(40, "segment")).toBeGreaterThan(0);
    expect(livePriority(0, "segment")).toBeGreaterThan(livePriority(1, "segment"));
    expect(livePriority(40, "clip")).toBeGreaterThan(livePriority(0, "segment"));
    expect(livePriority(9999, "segment")).toBeGreaterThan(0);
  });

  it("gives up the oldest waiting segments beyond the limit", () => {
    expect(overBacklog(["a", "b"], 2)).toEqual([]);
    expect(overBacklog(["a", "b", "c", "d"], 2)).toEqual(["a", "b"]);
  });
});
