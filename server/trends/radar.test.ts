import { describe, expect, it } from "vitest";
import type { Clip, Source } from "../../shared/types.js";
import { openDb } from "../db/index.js";
import { FakeChatClient } from "../pipeline/picks/fake.js";
import { DAILY_QUOTA, TrendRadar } from "./radar.js";
import { keywordHook, keywordMoment } from "./tags.js";
import { YouTubeTrendSource } from "./youtube.js";

interface FakeVideo {
  id: string;
  title: string;
  channel: string;
  views: number;
  hoursOld: number;
  duration?: string;
}

const NOW = new Date("2026-11-20T12:00:00.000Z");

/** Stands in for the YouTube Data API: answers search.list and videos.list, and records every call. No network. */
function fakeYouTube(videos: FakeVideo[]) {
  const calls: URL[] = [];
  const doFetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.pathname.endsWith("/search")) {
      return Response.json({ items: videos.map((v) => ({ id: { videoId: v.id } })) });
    }
    const ids = url.searchParams.get("id")!.split(",");
    return Response.json({
      items: videos
        .filter((v) => ids.includes(v.id))
        .map((v) => ({
          id: v.id,
          snippet: { title: v.title, channelTitle: v.channel, publishedAt: new Date(NOW.getTime() - v.hoursOld * 3_600_000).toISOString() },
          contentDetails: { duration: v.duration ?? "PT30S" },
          statistics: { viewCount: String(v.views) },
        })),
    });
  }) as typeof fetch;
  return { doFetch, calls };
}

const VIDEOS: FakeVideo[] = [
  { id: "old-big", title: "Kai Cenat LOSES IT in GTA 6", channel: "Clip Central", views: 400_000, hoursOld: 40 },
  { id: "new-small", title: "5 star police chase goes wrong", channel: "GTA Daily", views: 90_000, hoursOld: 3 },
  { id: "mid", title: "Is this the best stunt jump in GTA VI?", channel: "Kai Cenat", views: 120_000, hoursOld: 10 },
];

function setup(videos = VIDEOS, opts: { apiKey?: string; answer?: (user: string) => unknown } = {}) {
  let now = NOW;
  const yt = fakeYouTube(videos);
  const chat = opts.answer ? new FakeChatClient((req) => opts.answer!(req.user)) : null;
  const radar = new TrendRadar({
    db: openDb(":memory:"),
    source: () => new YouTubeTrendSource({ apiKey: "apiKey" in opts ? opts.apiKey : "test-key", fetch: yt.doFetch }),
    chat: () => chat,
    watchlist: () => [{ name: "Kai Cenat", channels: [{ platform: "twitch", handle: "kaicenat" }] }],
    now: () => now,
  });
  return { radar, yt, chat, setNow: (d: Date) => (now = d) };
}

describe("trend radar (faked YouTube API)", () => {
  it("asks for short GTA videos of the last 48 h by view count, and ranks them by views per hour", async () => {
    const { radar, yt } = setup();
    await radar.refresh();
    const searches = yt.calls.filter((u) => u.pathname.endsWith("/search"));
    expect(searches.map((u) => u.searchParams.get("q"))).toEqual(["GTA VI", "GTA 6"]);
    for (const u of searches) {
      expect(u.searchParams.get("videoDuration")).toBe("short");
      expect(u.searchParams.get("order")).toBe("viewCount");
      expect(u.searchParams.get("type")).toBe("video");
      expect(u.searchParams.get("publishedAfter")).toBe("2026-11-18T12:00:00.000Z");
    }
    // 90,000 views in 3 h beats 120,000 in 10 h, which beats 400,000 in 40 h.
    const ranked = radar.videos();
    expect(ranked.map((v) => v.videoId)).toEqual(["new-small", "mid", "old-big"]);
    expect(ranked.map((v) => v.viewsPerHour)).toEqual([30_000, 12_000, 10_000]);
    expect(ranked[0]).toMatchObject({ title: "5 star police chase goes wrong", channel: "GTA Daily", durationSec: 30, url: "https://www.youtube.com/shorts/new-small" });
  });

  it("marks videos from or about a watchlist streamer", async () => {
    const { radar } = setup();
    await radar.refresh();
    const by = Object.fromEntries(radar.videos().map((v) => [v.videoId, v.streamer]));
    expect(by).toEqual({ "old-big": "Kai Cenat", mid: "Kai Cenat", "new-small": null });
  });

  it("keeps the top 50 and leaves out videos that are too long to be Shorts", async () => {
    const many: FakeVideo[] = Array.from({ length: 60 }, (_, i) => ({ id: `v${i}`, title: `GTA 6 clip ${i}`, channel: "c", views: 1000 * (i + 1), hoursOld: 5 }));
    many.push({ id: "long", title: "GTA 6 full mission", channel: "c", views: 9_000_000, hoursOld: 5, duration: "PT3M30S" });
    const { radar } = setup(many);
    await radar.refresh();
    const kept = radar.videos();
    expect(kept).toHaveLength(50);
    expect(kept[0]!.videoId).toBe("v59");
    expect(kept.some((v) => v.videoId === "long")).toBe(false);
  });

  it("counts the quota it spends, shows it, and refuses a refresh that would go over the day's budget", async () => {
    const { radar, yt, setNow } = setup();
    expect(DAILY_QUOTA).toBeLessThanOrEqual(1500);
    await radar.refresh();
    // Two searches at 100 units, one videos lookup at 1.
    expect(radar.quota()).toEqual({ usedToday: 201, dailyBudget: DAILY_QUOTA, refreshCost: 202 });
    for (let i = 0; i < 5; i++) await radar.refresh();
    expect(radar.quota().usedToday).toBe(1206);
    await radar.refresh();
    expect(radar.quota().usedToday).toBe(1407);
    const before = yt.calls.length;
    await expect(radar.refresh()).rejects.toThrow(/budget.*1,407 of 1,500/);
    expect(yt.calls.length).toBe(before);
    expect(radar.quota().usedToday).toBeLessThanOrEqual(DAILY_QUOTA);
    expect(radar.due()).toBe(false);
    // The quota starts again at midnight Pacific time (08:00 UTC in November).
    setNow(new Date("2026-11-21T09:00:00.000Z"));
    expect(radar.quota().usedToday).toBe(0);
    await radar.refresh();
    expect(radar.quota().usedToday).toBe(201);
  });

  it("is due once a day, and never without a key", async () => {
    const { radar, setNow } = setup();
    expect(radar.due()).toBe(true);
    await radar.refresh();
    expect(radar.due()).toBe(false);
    setNow(new Date(NOW.getTime() + 25 * 3_600_000));
    expect(radar.due()).toBe(true);

    const none = setup(VIDEOS, { apiKey: undefined });
    expect(none.radar.due()).toBe(false);
    await expect(none.radar.refresh()).rejects.toThrow("Add your YouTube key in Settings.");
    expect(none.yt.calls).toEqual([]);
    expect(none.radar.report({ clips: [], sources: [] })).toMatchObject({ configured: false, note: "Add your YouTube key in Settings.", videos: 0 });
  });

  it("tags with the AI model against the fixed lists: a tag that is not on the list falls back to keywords", async () => {
    const { radar, chat } = setup(VIDEOS, {
      answer: () => ({
        tags: [
          { i: 0, moment: "crash", hook: "wait-for-it" }, // valid: kept as the model said
          { i: 1, moment: "dancing", hook: "clickbait" }, // not on the lists
          // nothing for 2
        ],
      }),
    });
    await radar.refresh();
    expect(chat!.requests).toHaveLength(1);
    expect(chat!.requests[0]!.user).toContain("0. 5 star police chase goes wrong");
    const [first, second, third] = radar.videos();
    expect(first).toMatchObject({ momentType: "crash", hookPattern: "wait-for-it" });
    expect(second).toMatchObject({ momentType: "stunt", hookPattern: "question" });
    expect(third).toMatchObject({ momentType: "rage", hookPattern: "name-reaction" });
    expect(radar.report({ clips: [], sources: [] }).tagger).toBe("ai");
  });

  it("tags with keywords when there is no AI key", async () => {
    const { radar } = setup();
    await radar.refresh();
    expect(radar.videos().map((v) => v.momentType)).toEqual(["police-chase", "stunt", "rage"]);
    expect(radar.report({ clips: [], sources: [] }).tagger).toBe("keywords");
    expect(keywordMoment("just walking around")).toBe("other");
    expect(keywordHook("POV: you found the secret car")).toBe("pov");
  });

  it("reports what is working today: moment types, hook patterns, rising streamers, and our clips to post", async () => {
    const { radar } = setup();
    await radar.refresh();
    const clip = (id: number, over: Partial<Clip>): Clip =>
      ({ id, sourceId: 1, title: "A clip", hook: "", reason: "", status: "approved", postCount: 0, ...over }) as Clip;
    const sources = [{ id: 1, creatorName: "Kai Cenat" }, { id: 2, creatorName: "Someone Else" }] as Source[];
    const report = radar.report({
      sources,
      clips: [
        clip(1, { title: "Kai on the beach" }),
        clip(2, { sourceId: 2, title: "The cops chase him for ten minutes" }),
        clip(3, { sourceId: 2, title: "Quiet fishing trip" }),
        clip(4, { title: "Already posted", postCount: 2 }),
        clip(5, { title: "Not reviewed yet", status: "pending" }),
      ],
    });
    expect(report.refreshedAt).toBe(NOW.toISOString());
    expect(report.videos).toBe(3);
    expect(report.momentTypes.map((g) => [g.tag, g.label, g.viewsPerHour])).toEqual([
      ["police-chase", "Police chase", 30_000],
      ["stunt", "Stunt", 12_000],
      ["rage", "Rage", 10_000],
    ]);
    expect(report.momentTypes[0]!.examples).toEqual([
      { title: "5 star police chase goes wrong", url: "https://www.youtube.com/shorts/new-small", channel: "GTA Daily", viewsPerHour: 30_000 },
    ]);
    expect(report.hookPatterns.map((g) => g.tag)).toEqual(["number", "question", "name-reaction"]);
    expect(report.streamers).toEqual([
      { name: "GTA Daily", onWatchlist: false, videos: 1, viewsPerHour: 30_000 },
      { name: "Kai Cenat", onWatchlist: true, videos: 2, viewsPerHour: 22_000 },
    ]);
    expect(report.clipsToPost).toEqual([
      { clipId: 1, title: "Kai on the beach", creatorName: "Kai Cenat", why: "Kai Cenat is rising today" },
      { clipId: 2, title: "The cops chase him for ten minutes", creatorName: "Someone Else", why: "Police chase is winning today" },
    ]);
  });

  it("gives the picker today's top moment types and hook patterns, and nothing once the data is stale", async () => {
    const { radar, setNow } = setup();
    expect(radar.boost()).toBeNull();
    await radar.refresh();
    expect(radar.boost()).toEqual({
      weight: 5,
      momentTypes: [
        { type: "police-chase", share: 1 },
        { type: "stunt", share: 0.4 },
        { type: "rage", share: 0.33 },
      ],
      hookPatterns: [
        { pattern: "number", example: "5 star police chase goes wrong" },
        { pattern: "question", example: "Is this the best stunt jump in GTA VI?" },
        { pattern: "name-reaction", example: "Kai Cenat LOSES IT in GTA 6" },
      ],
    });
    expect(radar.setWeight(12)).toBe(12);
    expect(radar.boost()!.weight).toBe(12);
    expect(() => radar.setWeight(50)).toThrow(/0 to 20/);
    setNow(new Date(NOW.getTime() + 49 * 3_600_000));
    expect(radar.boost()).toBeNull();
  });
});
