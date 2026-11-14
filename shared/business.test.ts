import { describe, expect, it } from "vitest";
import {
  bestClips,
  bestHooks,
  bestTimes,
  costPerApproved,
  funnelOf,
  groupPosts,
  parsePayoutCsv,
  perThousand,
  type PostFacts,
  postLinkKey,
  quotaLeft,
  statsCallAllowed,
  sumKnown,
  toCsvTable,
  totalsOf,
  usedInWindow,
} from "./business.js";

const fact = (o: Partial<PostFacts>): PostFacts => ({
  postId: 1,
  clipId: 1,
  clipTitle: "Clip",
  hook: "",
  url: null,
  platform: "tiktok",
  accountId: "tt",
  accountName: "TikTok main",
  campaignKey: "1",
  campaign: "TJR · contentrewards.com",
  sourceName: "TJR",
  workspace: "Me",
  postedAt: "2026-11-13T10:00:00.000Z",
  views: null,
  likes: null,
  comments: null,
  shares: null,
  followsGained: null,
  avgWatchPct: null,
  earningsUsd: 0,
  paidUsd: null,
  ...o,
});

describe("not available is never a zero", () => {
  it("sums only the numbers given, and is null when none was", () => {
    expect(sumKnown([null, undefined, null])).toBeNull();
    expect(sumKnown([])).toBeNull();
    expect(sumKnown([0, null])).toBe(0);
    expect(sumKnown([5, null, 7])).toBe(12);
  });

  it("totals keep a metric no platform gave as null, next to the ones they did", () => {
    const t = totalsOf([fact({ views: 1000, likes: 50 }), fact({ postId: 2, views: 3000, likes: null })]);
    expect(t.views).toBe(4000);
    expect(t.likes).toBe(50);
    expect(t.shares).toBeNull();
    expect(t.followsGained).toBeNull();
    expect(t.avgWatchPct).toBeNull();
    expect(t.paidUsd).toBeNull();
  });

  it("a CSV leaves a missing number empty", () => {
    expect(toCsvTable(["a", "b"], [[null, 0]])).toBe("a,b\n,0\n");
  });
});

describe("earnings per 1,000 views", () => {
  it("divides earnings by thousands of views, to the cent", () => {
    expect(perThousand(6, 4000)).toBe(1.5);
    expect(perThousand(1, 3000)).toBe(0.33);
  });

  it("is null without views (not $0 per 1,000)", () => {
    expect(perThousand(5, null)).toBeNull();
    expect(perThousand(0, 0)).toBeNull();
  });

  it("totals and groups carry it", () => {
    const posts = [
      fact({ platform: "tiktok", views: 10_000, earningsUsd: 13.5 }),
      fact({ postId: 2, platform: "youtube", accountId: "yt", accountName: "YT", views: 2000, earningsUsd: 2 }),
      fact({ postId: 3, platform: "youtube", accountId: "yt", accountName: "YT", views: null, earningsUsd: 0 }),
    ];
    expect(totalsOf(posts).perThousandUsd).toBe(1.29);
    const byPlatform = groupPosts(posts, "platform");
    expect(byPlatform.map((r) => [r.key, r.posts, r.views, r.perThousandUsd])).toEqual([
      ["tiktok", 1, 10_000, 1.35],
      ["youtube", 2, 2000, 1],
    ]);
  });
});

describe("the funnel", () => {
  const clips = [
    { id: 1, status: "approved" },
    { id: 2, status: "approved" },
    { id: 3, status: "rejected" },
    { id: 4, status: "pending" },
  ];

  it("counts clips made → approved → posted → paid", () => {
    const posts = [
      { clipId: 1, status: "posted", paid: true },
      { clipId: 1, status: "posted", paid: false },
      { clipId: 2, status: "failed", paid: false },
    ];
    expect(funnelOf(clips, posts)).toEqual({ made: 4, approved: 2, posted: 1, paid: 1 });
  });

  it("never lets a later step outgrow an earlier one", () => {
    // A post of a clip made before the range (not in `clips`) does not count.
    const posts = [
      { clipId: 99, status: "posted", paid: true },
      { clipId: 2, status: "scheduled", paid: true },
    ];
    const f = funnelOf(clips, posts);
    expect(f).toEqual({ made: 4, approved: 2, posted: 0, paid: 0 });
  });
});

describe("cost per approved clip", () => {
  it("is spend over approved clips", () => {
    expect(costPerApproved(1.5, 6)).toBe(0.25);
    expect(costPerApproved(0.1, 3)).toBe(0.0333);
  });

  it("is null before the first approval, not $0 or infinity", () => {
    expect(costPerApproved(2, 0)).toBeNull();
  });
});

describe("quota accounting", () => {
  it("what is left never drops below zero", () => {
    expect(quotaLeft(1600, 10_000)).toBe(8400);
    expect(quotaLeft(12_000, 10_000)).toBe(0);
    expect(quotaLeft(0, 50)).toBe(50);
  });

  it("a rolling 24 h window counts only the posts inside it", () => {
    const now = new Date("2026-11-14T12:00:00.000Z");
    const times = ["2026-11-13T11:59:00.000Z", "2026-11-13T12:30:00.000Z", "2026-11-14T11:00:00.000Z", "2026-11-14T13:00:00.000Z"];
    expect(usedInWindow(times, now, 24 * 3600_000)).toBe(2);
  });

  it("a stats call is allowed until the day's budget is spent", () => {
    expect(statsCallAllowed(0, 2)).toBe(true);
    expect(statsCallAllowed(1, 2)).toBe(true);
    expect(statsCallAllowed(2, 2)).toBe(false);
  });
});

describe("best clips, hooks and posting times", () => {
  const posts = [
    fact({ postId: 1, clipId: 1, clipTitle: "Chase", hook: "He did NOT see that", views: 9000, postedAt: "2026-11-13T18:05:00.000Z" }),
    fact({ postId: 2, clipId: 1, clipTitle: "Chase", hook: "He did NOT see that", views: 1000, postedAt: "2026-11-12T18:40:00.000Z" }),
    fact({ postId: 3, clipId: 2, clipTitle: "Heist", hook: "Wait for it", views: 4000, postedAt: "2026-11-13T09:00:00.000Z" }),
    fact({ postId: 4, clipId: 3, clipTitle: "No stats", hook: "Unknown", views: null, postedAt: "2026-11-13T03:00:00.000Z" }),
  ];

  it("ranks clips by views, leaving out clips without any", () => {
    expect(bestClips(posts).map((c) => [c.clipId, c.views, c.posts])).toEqual([
      [1, 10_000, 2],
      [2, 4000, 1],
    ]);
  });

  it("ranks hooks by median views", () => {
    expect(bestHooks(posts).map((h) => [h.hook, h.medianViews])).toEqual([
      ["He did NOT see that", 5000],
      ["Wait for it", 4000],
    ]);
  });

  it("ranks hours of the day (UTC) by median views", () => {
    expect(bestTimes(posts).map((t) => [t.hour, t.posts, t.medianViews])).toEqual([
      [18, 2, 5000],
      [9, 1, 4000],
    ]);
  });
});

describe("campaign CSV import", () => {
  it("reads links, views counted, status, payout and reason with loose headers", () => {
    const csv = [
      "Submission,Views Counted,Status,Payout ($),Rejection reason",
      'https://www.tiktok.com/@leonida/video/1,"12,400",Approved,$13.64,',
      "https://youtube.com/shorts/abc123,800,Rejected,,\"Fake views, low quality\"",
      "https://x.com/leonida/status/9,5000,Paid out,5.50,",
      "not a link,1,approved,1,",
    ].join("\n");
    const { rows, skipped } = parsePayoutCsv(csv);
    expect(skipped).toBe(1);
    expect(rows).toEqual([
      { url: "https://www.tiktok.com/@leonida/video/1", viewsCounted: 12_400, status: "approved", payoutUsd: 13.64, reason: "" },
      { url: "https://youtube.com/shorts/abc123", viewsCounted: 800, status: "rejected", payoutUsd: null, reason: "Fake views, low quality" },
      { url: "https://x.com/leonida/status/9", viewsCounted: 5000, status: "paid", payoutUsd: 5.5, reason: "" },
    ]);
  });

  it("needs a link column", () => {
    expect(() => parsePayoutCsv("views,status\n10,approved")).toThrow(/post link/);
  });

  it("matches the same post however its link was copied", () => {
    expect(postLinkKey("https://www.tiktok.com/@a/video/1/?lang=en")).toBe(postLinkKey("https://tiktok.com/@a/video/1"));
    expect(postLinkKey("https://www.youtube.com/watch?v=XyZ&t=3")).toBe("youtube.com/watch?v=xyz");
  });
});
