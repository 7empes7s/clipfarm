import { describe, expect, it } from "vitest";
import { Backoff, backoffDelayMs } from "./backoff.js";
import { decideIngest, type IngestCheck, matchVod, mentionsGame, NEEDS_PERMISSION, sameBroadcast } from "./match.js";

describe("matching a VOD to the game or campaign", () => {
  it("finds GTA VI under its usual names, in the title or the category", () => {
    for (const title of ["GTA VI LAUNCH NIGHT!!", "gta 6 day one", "#GTA6 heists", "Grand Theft Auto VI first look", "GTAVI w/ chat"]) {
      expect(matchVod({ title, category: null }, ["GTA VI"])).toEqual({ matched: true, game: "GTA VI" });
    }
    expect(matchVod({ title: "day 1", category: "Grand Theft Auto VI" }, ["GTA VI"]).matched).toBe(true);
  });

  it("never mistakes GTA V (or VII) for GTA VI", () => {
    expect(mentionsGame("NoPixel GTA V RP", "GTA VI")).toBe(false);
    expect(mentionsGame("Grand Theft Auto V", "GTA VI")).toBe(false);
    expect(mentionsGame("GTA VII someday", "GTA VI")).toBe(false);
    expect(mentionsGame("gta 60 fps", "GTA VI")).toBe(false);
  });

  it("matches a campaign's own game by name", () => {
    expect(matchVod({ title: "Fortnite with the boys", category: null }, ["GTA VI", "Fortnite"])).toEqual({ matched: true, game: "Fortnite" });
    expect(matchVod({ title: "Just chatting", category: "Just Chatting" }, ["GTA VI"])).toEqual({ matched: false });
  });
});

const ok: IngestCheck = {
  permission: "active",
  autoIngest: true,
  title: "GTA VI launch",
  match: { matched: true, game: "GTA VI" },
  tooOld: false,
  duplicateOf: null,
};

describe("decideIngest: the permission gate comes first", () => {
  it("queues a matching new VOD of a creator with permission and auto-ingest on", () => {
    expect(decideIngest(ok)).toEqual({ queue: true });
  });

  it("never queues without an active permission record, even with everything else on", () => {
    expect(decideIngest({ ...ok, permission: "none" })).toEqual({ queue: false, reason: NEEDS_PERMISSION });
    expect(decideIngest({ ...ok, permission: "expired" })).toMatchObject({ queue: false, reason: expect.stringMatching(/expired/) });
  });

  it("skips leaks, other games, old VODs, duplicates and creators with auto-ingest off", () => {
    expect(decideIngest({ ...ok, title: "GTA VI leaked footage reaction" })).toMatchObject({ queue: false, reason: "The title mentions a leak" });
    expect(decideIngest({ ...ok, match: { matched: false } })).toMatchObject({ reason: "Not one of their games" });
    expect(decideIngest({ ...ok, tooOld: true })).toMatchObject({ reason: "Too old" });
    expect(decideIngest({ ...ok, duplicateOf: "kick" })).toMatchObject({ reason: "Same stream already queued from Kick" });
    expect(decideIngest({ ...ok, autoIngest: false })).toMatchObject({ reason: "Auto-ingest is off" });
  });
});

describe("sameBroadcast (de-duplication across platforms)", () => {
  const twitch = { platform: "twitch" as const, publishedAt: "2026-11-19T20:00:00Z", durationSec: 4 * 3600 };

  it("treats a simulcast on another platform as the same stream", () => {
    expect(sameBroadcast(twitch, { platform: "kick", publishedAt: "2026-11-19T20:04:00Z", durationSec: 4 * 3600 - 300 })).toBe(true);
    expect(sameBroadcast(twitch, { platform: "youtube", publishedAt: "2026-11-19T20:10:00Z", durationSec: null })).toBe(true);
  });

  it("keeps different streams apart", () => {
    expect(sameBroadcast(twitch, { platform: "kick", publishedAt: "2026-11-19T23:00:00Z", durationSec: 4 * 3600 })).toBe(false);
    expect(sameBroadcast(twitch, { platform: "kick", publishedAt: "2026-11-19T20:00:00Z", durationSec: 3600 })).toBe(false);
    expect(sameBroadcast(twitch, { ...twitch })).toBe(false);
  });
});

describe("polling backoff", () => {
  it("doubles the wait after each error in a row, up to a cap", () => {
    expect([0, 1, 2, 3, 4].map((n) => backoffDelayMs(n, 60_000))).toEqual([0, 60_000, 120_000, 240_000, 480_000]);
    expect(backoffDelayMs(30, 60_000, 3600_000)).toBe(3600_000);
  });

  it("waits, honours a longer Retry-After and resets on success", () => {
    const now = new Date("2026-11-19T20:00:00Z");
    const b = new Backoff(60_000);
    expect(b.ready(now)).toBe(true);
    b.fail(now, "Kick could not be reached.");
    expect(b.ready(new Date(now.getTime() + 59_000))).toBe(false);
    expect(b.ready(new Date(now.getTime() + 60_000))).toBe(true);
    b.fail(now, "Kick asked us to slow down.", 900);
    expect(b.until?.toISOString()).toBe("2026-11-19T20:15:00.000Z");
    b.succeed();
    expect(b.ready(now)).toBe(true);
    expect(b.failures).toBe(0);
  });
});
