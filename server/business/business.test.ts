import request from "supertest";
import { describe, expect, it } from "vitest";
import { PLATFORMS, type Platform } from "../../shared/types.js";
import { campaignInput } from "../../test/helpers.js";
import { createApp } from "../app.js";
import { ClipsRepo } from "../clips/repo.js";
import { openDb } from "../db/index.js";
import { GrowthLab } from "../growth/lab.js";
import { FakePlatformStats, STATS_CAPABILITIES } from "../growth/platformStats.js";
import { GrowthRepo } from "../growth/repo.js";
import type { Isolation } from "../isolation/isolation.js";
import { JobQueue } from "../jobs/queue.js";
import { PicksRepo } from "../picks/repo.js";
import { FakePostingService } from "../publish/fake.js";
import { Publisher } from "../publish/publisher.js";
import { PostsRepo } from "../publish/repo.js";
import { SourcesRepo } from "../sources/repo.js";
import { VodsRepo } from "../vods/repo.js";
import { BusinessRepo } from "./repo.js";
import { BusinessService } from "./service.js";

const NOW = new Date("2026-11-14T12:00:00.000Z");
const HOUR = 3600_000;

function setup(stats: FakePlatformStats[] = []) {
  let now = NOW;
  const clock = () => now;
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db, clock);
  const vods = new VodsRepo(db, clock);
  const clips = new ClipsRepo(db, clock);
  const posts = new PostsRepo(db, clock);
  const service = new FakePostingService();
  const publisher = new Publisher({ sources, clips, posts, service, now: clock });
  const noop = async () => undefined;
  const queue = new JobQueue(db, { handlers: { render: noop, ingest: noop } });
  queue.stop();
  const growth: GrowthLab = new GrowthLab({
    repo: new GrowthRepo(db, clock),
    posts,
    clips,
    sources,
    publisher,
    platformStats: stats,
    digestLines: () => business.digestLines(),
    now: clock,
  });
  // Only the parts of isolation the health page reads: YouTube units per group.
  const isolation = {
    list: () => [{ id: 1, name: "Main" }],
    quotaUsed: () => 3200,
    quotaReset: () => new Date("2026-11-15T08:00:00.000Z"),
  } as unknown as Isolation;
  const repo = new BusinessRepo(db, clock);
  const business: BusinessService = new BusinessService({
    repo,
    clips,
    posts,
    sources,
    jobs: () => queue.list(500),
    publisher,
    isolation,
    growth,
    eurPerUsd: 0.92,
    computeUsdPerHour: 0.01,
    demo: false,
    now: clock,
  });
  const app = createApp({ sources, vods, picks: new PicksRepo(db), queue, clips, posts, publisher, growth, business });
  const source = sources.create(campaignInput({ cpmRateUsd: 1.5, minViews: 0, allowedPlatforms: ["tiktok", "youtube", "instagram", "x"] }));
  const permissionId = source.permissions[0]!.id;
  const clip = (title: string, status: "approved" | "rejected" | "pending" = "approved", hook = "") => {
    const c = clips.create({ sourceId: source.id, vodId: null, title, hook, filePath: "/nowhere.mp4", durationSec: 25, score: 70 });
    if (status !== "pending") clips.setStatus(c.id, status);
    return c;
  };
  const post = (clipId: number, platform: Platform, o: { url?: string; hoursAgo?: number; status?: "posted" | "failed" | "scheduled"; error?: string; accountId?: string } = {}) =>
    posts.insert({
      clipId,
      permissionId,
      platform,
      accountId: o.accountId ?? `fake-${platform}`,
      accountName: `${platform} main`,
      service: "fake",
      externalId: null,
      status: o.status ?? "posted",
      url: o.url ?? null,
      error: o.error ?? null,
      caption: "",
      scheduledAt: new Date(now.getTime() - (o.hoursAgo ?? 2) * HOUR).toISOString(),
      postedAt: (o.status ?? "posted") === "posted" ? new Date(now.getTime() - (o.hoursAgo ?? 2) * HOUR).toISOString() : null,
    });
  return { db, sources, clips, posts, publisher, queue, growth, repo, business, app, clip, post, permissionId, setNow: (d: Date) => (now = d) };
}

describe("stats ingestion from each platform's API (fakes)", () => {
  it("keeps exactly what each platform's API gives, and nothing it does not", async () => {
    const fakes = PLATFORMS.map((p) => new FakePlatformStats(p));
    const t = setup(fakes);
    const c = t.clip("Chase");
    const ids = Object.fromEntries(PLATFORMS.map((p, i) => [p, t.post(c.id, p, { url: `https://example.com/${p}/${i}` }).id]));
    expect(await t.growth.collectPlatformStats()).toBe(4);
    const metrics = t.posts.metrics();
    for (const p of PLATFORMS) {
      const m = metrics.get(ids[p]!)!;
      for (const [key, value] of Object.entries(m)) {
        if (STATS_CAPABILITIES[p].metrics.includes(key as never)) expect(value, `${p} ${key}`).not.toBeNull();
        else expect(value, `${p} ${key} is not given by its API`).toBeNull();
      }
    }
    // Watch time and followers gained: no API here gives them, so the dashboard says "not available".
    const board = t.business.board("7d");
    expect(board.totals.avgWatchPct).toBeNull();
    expect(board.totals.followsGained).toBeNull();
    expect(board.totals.views).toBe(1000 * Object.values(ids).reduce((s, id) => s + id, 0));
  });

  it("stays inside each platform's daily call budget, counting failed calls too", async () => {
    const yt = new FakePlatformStats("youtube");
    const t = setup([yt]);
    const c = t.clip("Chase");
    t.post(c.id, "youtube", { url: "https://youtube.com/shorts/a" });
    t.growth.repo.spendStatsCalls("2026-11-14", "youtube", STATS_CAPABILITIES.youtube.callsPerDay - 1);
    yt.fail = "YouTube answered 500 when asked for video stats.";
    await t.growth.collectPlatformStats();
    expect(yt.calls).toBe(1);
    expect(t.growth.statsErrors.get("youtube")).toMatch(/500/);
    yt.fail = null;
    await t.growth.collectPlatformStats();
    expect(yt.calls).toBe(1);
    expect(t.growth.lastStatsError).toMatch(/budget for YouTube Shorts is used up/);
    // A new UTC day starts a new budget.
    t.setNow(new Date("2026-11-15T01:00:00.000Z"));
    await t.growth.collectPlatformStats();
    expect(yt.calls).toBe(2);
  });

  it("a platform that is not connected is never asked and its numbers stay not available", async () => {
    const tt = new FakePlatformStats("tiktok", { ready: false });
    const t = setup([tt]);
    const c = t.clip("Chase");
    t.post(c.id, "tiktok", { url: "https://tiktok.com/@a/video/1" });
    expect(await t.growth.collectPlatformStats()).toBe(0);
    expect(tt.calls).toBe(0);
    const health = t.business.health();
    expect(health.stats.find((s) => s.platform === "tiktok")).toMatchObject({ connected: false, metrics: [], note: "No stats source is connected." });
    const board = t.business.board("7d");
    expect(board.totals.views).toBeNull();
    expect(board.totals.perThousandUsd).toBeNull();
  });
});

describe("money", () => {
  it("cost per approved clip and profit come from recorded spend and server time", () => {
    const t = setup();
    const a = t.clip("A");
    t.clip("B");
    t.clip("C", "rejected");
    t.db.prepare("INSERT INTO vods (source_id, url, status, transcript_cost_usd, created_at) VALUES (1, 'https://twitch.tv/v/1', 'ready', 0.3, ?)").run(NOW.toISOString());
    t.db
      .prepare("INSERT INTO google_calls (at, kind, model, in_tokens, out_tokens, cost_eur) VALUES (?, 'rerank', 'gemini-2.5-flash', 1, 1, 0.092)")
      .run(NOW.toISOString());
    // A 2-hour job at $0.01 an hour.
    t.db
      .prepare("INSERT INTO jobs (type, status, created_at, updated_at, started_at, finished_at) VALUES ('render', 'done', ?, ?, ?, ?)")
      .run(NOW.toISOString(), NOW.toISOString(), new Date(NOW.getTime() - 2 * HOUR).toISOString(), new Date(NOW.getTime() - 1000).toISOString());
    const p = t.post(a.id, "tiktok", { url: "https://tiktok.com/@a/video/1" });
    t.posts.addReading(p.id, { views: 4000 });
    const { money, funnel } = t.business.board("today");
    expect(funnel).toEqual({ made: 3, approved: 2, posted: 1, paid: 0 });
    // 0.3 transcript + 0.1 Gemini (0.092 € at 0.92 € a dollar) + 0.02 server time.
    expect(money.costUsd).toBeCloseTo(0.42, 3);
    expect(money.costPerApprovedClipUsd).toBeCloseTo(0.21, 3);
    // 4,000 views × $1.50 per 1,000, less Whop's 10 %.
    expect(money.earningsUsd).toBe(5.4);
    expect(money.perThousandUsd).toBe(1.35);
    expect(money.profitUsd).toBe(4.98);
    expect(money.costLines.find((l) => l.label.startsWith("Claude"))?.usd).toBeNull();
  });

  it("an imported campaign CSV fills views counted, approvals, rejections and payouts", async () => {
    const t = setup();
    const a = t.clip("A");
    const b = t.clip("B");
    const pa = t.post(a.id, "tiktok", { url: "https://www.tiktok.com/@a/video/1" });
    const pb = t.post(b.id, "youtube", { url: "https://youtube.com/shorts/xyz" });
    t.posts.addReading(pa.id, { views: 12_000 });
    const csv = [
      "link,views counted,status,payout,reason",
      "https://tiktok.com/@a/video/1?lang=en,11000,paid,14.85,",
      "https://youtube.com/shorts/xyz,300,rejected,,Fake views",
      "https://tiktok.com/@someone-else/video/9,10,approved,,",
    ].join("\n");
    const res = await request(t.app).post("/api/business/payouts").set("Content-Type", "text/csv").send(csv);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ imported: 3, matched: 2, skipped: 0 });
    expect(t.posts.get(pa.id).whopPaidAt).not.toBeNull();
    expect(t.posts.get(pa.id).whopApprovedAt).not.toBeNull();
    expect(t.posts.get(pb.id).whopApprovedAt).toBeNull();

    const board = t.business.board("7d");
    expect(board.funnel.paid).toBe(1);
    expect(board.money.paidUsd).toBe(14.85);
    expect(board.money.byCampaign).toEqual([
      expect.objectContaining({ posts: 2, viewsCounted: 11_300, approved: 1, rejected: 1, paidUsd: 14.85 }),
    ]);
    const risk = t.business.health().atRisk.find((r) => r.kind === "rejected");
    expect(risk).toMatchObject({ accountName: "youtube main", reason: "Rejected by the campaign: Fake views", clipId: b.id });
  });

  it("refuses a file without a link column", async () => {
    const t = setup();
    const res = await request(t.app).post("/api/business/payouts").set("Content-Type", "text/csv").send("views,status\n1,paid");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/post link/);
  });
});

describe("dashboard ranges, groups and exports", () => {
  it("today, 7 and 30 days take the posts of their range; experiment posts stay out", async () => {
    const t = setup();
    const a = t.clip("A", "approved", "He did NOT see that");
    for (const [hoursAgo, views] of [
      [2, 100],
      [3 * 24, 1000],
      [20 * 24, 10_000],
    ] as const) {
      const p = t.post(a.id, "tiktok", { hoursAgo, url: `https://tiktok.com/@a/video/${hoursAgo}` });
      t.posts.addReading(p.id, { views });
    }
    const views = async (range: string) => (await request(t.app).get(`/api/business?range=${range}`)).body.totals.views;
    expect(await views("today")).toBe(100);
    expect(await views("7d")).toBe(1100);
    expect(await views("30d")).toBe(11_100);
    const board = (await request(t.app).get("/api/business?range=30d")).body;
    expect(board.days).toHaveLength(30);
    expect(board.groups.platform[0]).toMatchObject({ label: "TikTok", posts: 3 });
    expect(board.groups.workspace[0]).toMatchObject({ label: "Me" });
    expect(board.bestClips[0]).toMatchObject({ clipId: a.id, views: 11_100 });
    expect(board.bestHooks[0]).toMatchObject({ hook: "He did NOT see that" });
  });

  it("every table downloads as CSV, with not available left empty", async () => {
    const t = setup();
    const a = t.clip("A");
    t.post(a.id, "instagram", { url: "https://instagram.com/reel/1" });
    for (const table of ["posts", "platform", "account", "campaign", "source", "workspace", "campaigns", "costs", "health"]) {
      const res = await request(t.app).get(`/api/business/export/${table}.csv?range=7d`);
      expect(res.status, table).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/csv/);
    }
    const platform = (await request(t.app).get("/api/business/export/platform.csv")).text.split("\n");
    expect(platform[1]).toBe("Instagram Reels,1,,,,,,,0,,");
    expect((await request(t.app).get("/api/business/export/secrets.csv")).status).toBe(404);
  });
});

describe("health", () => {
  it("shows failures by step, the queue, posting failures, quota left and accounts at risk", () => {
    const t = setup();
    const a = t.clip("A");
    t.queue.enqueue("render", {});
    const failed = t.queue.enqueue("ingest", {});
    t.db.prepare("UPDATE jobs SET status = 'failed', error = 'yt-dlp could not read the video', finished_at = ? WHERE id = ?").run(NOW.toISOString(), failed.id);
    t.post(a.id, "tiktok", { status: "failed", error: "Inauthentic content: this video reuses content without changes." });
    for (let i = 0; i < 3; i++) t.post(a.id, "instagram", { url: `https://instagram.com/reel/${i}`, hoursAgo: 1 + i, accountId: "fake-instagram" });
    const struck = t.post(a.id, "youtube", { url: "https://youtube.com/shorts/s" });
    t.posts.setFlag(struck.id, "strike", true);
    t.publisher.accounts.sync("fake", [{ id: "fake-instagram", platform: "instagram", name: "IG main", disabled: false }]);

    const h = t.business.health();
    expect(h.queueLength).toBe(1);
    expect(h.failuresByStep).toEqual([{ step: "Transcript", failed: 1, lastError: "yt-dlp could not read the video", lastAt: NOW.toISOString() }]);
    expect(h.postingFailures).toHaveLength(1);
    expect(h.quotas.find((q) => q.platform === "youtube")).toMatchObject({ used: 3200, limit: 10_000, left: 6800 });
    expect(h.quotas.find((q) => q.platform === "instagram")).toMatchObject({ label: "IG main", used: 3, limit: 50, left: 47 });
    expect(h.atRisk.map((r) => r.kind).sort()).toEqual(["strike", "warning"]);
  });
});

describe("daily digest", () => {
  it("says what posted, earned and failed yesterday and what's next", () => {
    const t = setup();
    const a = t.clip("A");
    t.clip("Waiting", "pending");
    const p = t.post(a.id, "tiktok", { url: "https://tiktok.com/@a/video/1", hoursAgo: 20 });
    t.posts.addReading(p.id, { views: 10_000 });
    t.post(a.id, "youtube", { status: "failed", error: "Upload refused", hoursAgo: 20 });
    t.post(a.id, "instagram", { status: "scheduled", hoursAgo: -3 });
    const lines = t.growth.digest().lines;
    expect(lines).toEqual(
      expect.arrayContaining([
        "Posted: 1 clip (TikTok)",
        "Earned so far on them: $13.50 (estimate)",
        "Failed: 1 post, 0 pipeline jobs",
        "Next: 1 post in the next 24 h, 1 clip waiting for review",
      ]),
    );
    expect(t.business.board("today").digest.lines).toEqual(lines);
  });
});
