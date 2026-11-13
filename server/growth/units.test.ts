import { describe, expect, it } from "vitest";
import { metricsFromPostizAnalytics } from "../publish/postiz.js";
import { chooseVariant, clipFits, defaultTimes, slotsForDay, slotTime } from "./plan.js";
import { YouTubeStats, youtubeVideoId } from "./platformStats.js";
import { applyPreferences } from "./preferences.js";
import { NO_DEFAULTS } from "./repo.js";
import { mergeMetrics, offsetFor } from "./series.js";
import { NO_METRICS } from "../../shared/growth.js";

describe("time series offsets", () => {
  it("files a reading under the age the post just passed, and under none when it is too late", () => {
    expect(offsetFor(0.5)).toBeNull();
    expect(offsetFor(1)).toBe("1h");
    expect(offsetFor(1.9)).toBe("1h");
    expect(offsetFor(3)).toBeNull();
    expect(offsetFor(6)).toBe("6h");
    expect(offsetFor(7.5)).toBe("6h");
    expect(offsetFor(8)).toBeNull();
    expect(offsetFor(24.2)).toBe("24h");
    expect(offsetFor(30)).toBe("24h");
    expect(offsetFor(31)).toBeNull();
    expect(offsetFor(72)).toBe("72h");
    expect(offsetFor(168)).toBe("7d");
    expect(offsetFor(211)).toBeNull();
  });

  it("keeps a number the platform left out as null, never 0", () => {
    const first = mergeMetrics(NO_METRICS, { views: 100, likes: 4 });
    expect(first).toMatchObject({ views: 100, likes: 4, shares: null, avgWatchPct: null });
    expect(mergeMetrics(first, { views: 180, avgWatchPct: Number.NaN })).toMatchObject({ views: 180, likes: 4, avgWatchPct: null });
  });

  it("reads what Postiz names and leaves the rest out", () => {
    const metrics = metricsFromPostizAnalytics([
      { label: "Likes", data: [{ total: "150", date: "2026-11-19" }, { total: "175", date: "2026-11-20" }] },
      { label: "Average view percentage", data: [{ total: "61.5", date: "2026-11-19" }, { total: "58.2", date: "2026-11-20" }] },
      { label: "Subscribers gained", data: [{ total: "12", date: "2026-11-20" }] },
      { label: "Views", data: [{ total: "900", date: "2026-11-20" }] },
      { label: "Shares", data: [] },
    ]);
    expect(metrics).toEqual({ likes: 175, avgWatchPct: 58.2, followsGained: 12 });
  });
});

describe("the planner", () => {
  const variants = [
    { key: "A", label: "A", minSec: 20, maxSec: 30, words: ["?"], times: ["09:00"] },
    { key: "B", label: "B", minSec: 45, maxSec: null, words: ["police chase"], times: ["18:00", "21:00"] },
  ];

  it("picks the variant with the fewest posts on the account, then in the campaign", () => {
    const none = new Map<string, number>();
    expect(chooseVariant(variants, none, none, "alternate", "s").key).toBe("A");
    expect(chooseVariant(variants, new Map([["A", 1]]), none, "alternate", "s").key).toBe("B");
    expect(chooseVariant(variants, new Map([["A", 1], ["B", 1]]), new Map([["A", 3], ["B", 2]]), "alternate", "s").key).toBe("B");
    // Random draws only among the variants that are level, and the same draw every time for a slot.
    expect(chooseVariant(variants, new Map([["B", 2]]), none, "random", "s").key).toBe("A");
    const draws = new Set(Array.from({ length: 40 }, (_, i) => chooseVariant(variants, none, none, "random", `slot-${i}`).key));
    expect(draws).toEqual(new Set(["A", "B"]));
    expect(chooseVariant(variants, none, none, "random", "slot-7")).toBe(chooseVariant(variants, none, none, "random", "slot-7"));
  });

  it("lays out a day's slots and their times", () => {
    const slots = slotsForDay({ accountIds: ["a", "b"], postsPerDay: 2 }, "2026-11-20");
    expect(slots.map((s) => s.key)).toEqual(["2026-11-20#a#0", "2026-11-20#a#1", "2026-11-20#b#0", "2026-11-20#b#1"]);
    expect(defaultTimes(1)).toEqual(["15:00"]);
    expect(defaultTimes(3)).toEqual(["09:00", "15:00", "21:00"]);
    expect(defaultTimes(4)).toEqual(["09:00", "13:00", "17:00", "21:00"]);
    const iso = (d: Date) => d.toISOString();
    expect(iso(slotTime(slots[1]!, "length", variants[0]!, [], [], 2))).toBe("2026-11-20T21:00:00.000Z");
    expect(iso(slotTime(slots[1]!, "length", variants[0]!, ["10:00", "16:30"], [], 2))).toBe("2026-11-20T16:30:00.000Z");
    // The default post times (changed by a recommendation) are used when they fit the day.
    expect(iso(slotTime(slots[0]!, "length", variants[0]!, [], ["07:00", "19:00"], 2))).toBe("2026-11-20T07:00:00.000Z");
    expect(iso(slotTime(slots[1]!, "time", variants[1]!, ["10:00", "16:30"], [], 2))).toBe("2026-11-20T21:00:00.000Z");
  });

  it("matches clips to a variant by length, hook words or niche", () => {
    const clip = { durationSec: 25, hook: "Did he just do that?", text: "GTA 6 police chase goes wrong Streamer" };
    expect(clipFits("length", variants[0]!, clip)).toBe(true);
    expect(clipFits("length", variants[1]!, clip)).toBe(false);
    expect(clipFits("hook", variants[0]!, clip)).toBe(true);
    expect(clipFits("hook", variants[1]!, clip)).toBe(false);
    expect(clipFits("niche", variants[1]!, clip)).toBe(true);
    expect(clipFits("niche", { ...variants[1]!, words: ["heist"] }, clip)).toBe(false);
    expect(clipFits("time", variants[1]!, clip)).toBe(true);
  });

  it("ranks picks inside the preferred length, or with a favoured word, higher", () => {
    const picks = [
      { startSec: 0, endSec: 25, title: "A calm drive", hook: "", score: 60 },
      { startSec: 100, endSec: 150, title: "Police chase downtown", hook: "", score: 60 },
      { startSec: 200, endSec: 228, title: "Police chase at the docks", hook: "", score: 95 },
    ];
    expect(applyPreferences(picks, NO_DEFAULTS)).toEqual(picks);
    const ranked = applyPreferences(picks, { ...NO_DEFAULTS, clipMinSec: 20, clipMaxSec: 30, boostWords: ["police chase"] });
    expect(ranked.map((p) => p.score)).toEqual([69, 66, 100]);
  });
});

describe("platform stats", () => {
  it("finds the video id in every kind of YouTube link", () => {
    expect(youtubeVideoId("https://www.youtube.com/shorts/abc123XYZ_-")).toBe("abc123XYZ_-");
    expect(youtubeVideoId("https://youtu.be/abc123XYZ_-?t=3")).toBe("abc123XYZ_-");
    expect(youtubeVideoId("https://www.youtube.com/watch?feature=share&v=abc123XYZ_-")).toBe("abc123XYZ_-");
    expect(youtubeVideoId("https://www.tiktok.com/@a/video/123")).toBeNull();
  });

  it("reads views, likes and comments from the YouTube Data API, and nothing it does not give", async () => {
    const urls: string[] = [];
    const fake = ((url: string) => {
      urls.push(url);
      return Promise.resolve(
        new Response(JSON.stringify({ items: [{ id: "vidAAAAAAA1", statistics: { viewCount: "5400", likeCount: "210" } }, { id: "unknownvid0", statistics: {} }] })),
      );
    }) as typeof fetch;
    const yt = new YouTubeStats({ apiKey: () => "secret-key", fetch: fake });
    expect(yt.ready()).toBe(true);
    expect(new YouTubeStats({ apiKey: () => undefined }).ready()).toBe(false);
    const stats = await yt.stats([
      { id: 7, url: "https://www.youtube.com/shorts/vidAAAAAAA1" },
      { id: 8, url: "https://example.com/not-youtube" },
    ]);
    expect([...stats]).toEqual([[7, { views: 5400, likes: 210 }]]);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("part=statistics&id=vidAAAAAAA1");
  });

  it("never puts the key in an error", async () => {
    const yt = new YouTubeStats({ apiKey: () => "secret-key", fetch: (() => Promise.resolve(new Response("no", { status: 403 }))) as typeof fetch });
    await expect(yt.stats([{ id: 1, url: "https://youtu.be/vidAAAAAAA1" }])).rejects.toThrow("YouTube answered 403 when asked for video stats.");
  });
});
