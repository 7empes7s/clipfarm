import { readFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Post, PostingAccount } from "../../shared/types.js";
import { campaignInput } from "../../test/helpers.js";
import { createApp } from "../app.js";
import { ClipsRepo } from "../clips/repo.js";
import { openDb } from "../db/index.js";
import { JobQueue } from "../jobs/queue.js";
import { PicksRepo } from "../picks/repo.js";
import { FakePostingService } from "../publish/fake.js";
import { accountStatsFromPostiz, type PostizAnalytics, PostizService } from "../publish/postiz.js";
import { Publisher } from "../publish/publisher.js";
import { DEFAULT_RULES, PostsRepo } from "../publish/repo.js";
import type { PostingService } from "../publish/types.js";
import { accountStatsFromUploadPost, type UploadPostAnalyticsResponse } from "../publish/uploadPost.js";
import { SourcesRepo } from "../sources/repo.js";
import { VodsRepo } from "../vods/repo.js";
import { AccountStatsStore, dueAccounts, isDue, toCard, type AccountStatsRow } from "./stats.js";

const fixture = <T>(name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "../../test/fixtures", name), "utf8")) as T;
const now = new Date("2026-11-19T15:00:00.000Z");
const HOUR = 3600_000;

const row = (o: Partial<AccountStatsRow>): AccountStatsRow => ({
  accountId: "int-yt",
  platform: "youtube",
  name: "GTA VI Moments",
  claims: null,
  followers: [],
  views: [],
  manualFollowers: [],
  fetchedAt: "2026-11-19T14:00:00.000Z",
  demo: false,
  ...o,
});

const post = (o: Partial<Post>): Post => ({
  id: 1,
  clipId: 1,
  clipTitle: "He landed the jump",
  sourceId: 1,
  creatorName: "Streamer",
  platform: "youtube",
  accountId: "int-yt",
  accountName: "GTA VI Moments",
  service: "postiz",
  status: "posted",
  url: "https://youtube.com/shorts/a",
  error: null,
  caption: "",
  scheduledAt: "2026-11-18T12:00:00.000Z",
  postedAt: "2026-11-18T12:00:00.000Z",
  permissionId: 1,
  campaignUrl: null,
  views: null,
  viewsUpdatedAt: null,
  viewsSource: null,
  whopSubmittedAt: null,
  experiment: false,
  flags: { claim: null, removal: null, strike: null },
  estimatedEarningsUsd: 0,
  ...o,
});

describe("mapping the posting service's analytics to account cards", () => {
  it("Postiz: subscribers become followers with growth, views per day, plus our posts", () => {
    const stats = accountStatsFromPostiz("int-yt", fixture<PostizAnalytics[]>("postiz/analytics-platform.json"));
    expect(stats.followers).toEqual([
      { date: "2026-11-17", value: 1250 },
      { date: "2026-11-18", value: 1280 },
      { date: "2026-11-19", value: 1342 },
    ]);
    expect(stats.views.at(-1)).toEqual({ date: "2026-11-19", value: 8100 });

    const posts = [
      ...[900, 4000, 12_500, 300, 7000, 2500].map((views, i) => post({ id: i + 1, clipId: i + 1, clipTitle: `Clip ${i + 1}`, views })),
      post({ id: 7, clipId: 7, views: null }),
      post({ id: 8, status: "failed", views: 99_999 }),
      post({ id: 9, accountId: "int-tt", views: 50_000 }),
      // Older than 7 days: not in the cadence.
      post({ id: 10, clipId: 10, views: 100, scheduledAt: "2026-11-01T12:00:00.000Z" }),
    ];
    const card = toCard(row({}), row({ followers: stats.followers, views: stats.views }), posts, DEFAULT_RULES, now);
    expect(card).toMatchObject({
      followers: 1342,
      followersGrowth: { change: 92, pct: 92 / 1250 },
      followersSource: "service",
      viewsSource: "service",
      posts: 8,
      avgViewsPerPost: Math.round((900 + 4000 + 12_500 + 300 + 7000 + 2500 + 100) / 7),
      postsLast7Days: 7,
      plannedLast7Days: 21,
      updatedAt: "2026-11-19T14:00:00.000Z",
    });
    expect(card.topClips.map((c) => c.views)).toEqual([12_500, 7000, 4000, 2500, 900]);
    expect(card.viewsPerDay).toHaveLength(3);
  });

  it("Upload-Post: today's follower count (and its series where given), views from the time series", () => {
    const accounts: PostingAccount[] = [
      { id: "me:tiktok", platform: "tiktok", name: "me (TikTok)", disabled: false },
      { id: "me:instagram", platform: "instagram", name: "me (Instagram Reels)", disabled: false },
      { id: "me:youtube", platform: "youtube", name: "me (YouTube Shorts)", disabled: false },
    ];
    const stats = accountStatsFromUploadPost(fixture<UploadPostAnalyticsResponse>("upload-post/analytics.json"), accounts, "2026-11-19");
    expect(stats).toEqual([
      {
        accountId: "me:tiktok",
        followers: [{ date: "2026-11-19", value: 2410 }],
        views: [
          { date: "2026-11-18", value: 1200 },
          { date: "2026-11-19", value: 2200 },
        ],
      },
      {
        accountId: "me:instagram",
        // The top-level count is today's and wins over the series' value for the same day.
        followers: [
          { date: "2026-11-18", value: 40 },
          { date: "2026-11-19", value: 47 },
        ],
        views: [
          { date: "2026-11-18", value: 900 },
          { date: "2026-11-19", value: 1100 },
        ],
      },
    ]);
  });

  it("marks numbers typed in by hand, and says when there is no data", () => {
    const manual = toCard(row({}), row({ manualFollowers: [{ date: "2026-11-19", value: 640 }] }), [], DEFAULT_RULES, now);
    expect(manual).toMatchObject({ followers: 640, followersSource: "manual", viewsSource: "none", avgViewsPerPost: null });
    const none = toCard(row({}), null, [], DEFAULT_RULES, now);
    expect(none).toMatchObject({ followers: null, followersSource: "none", followersGrowth: null, updatedAt: null });
  });
});

describe("the cache/limit guard", () => {
  const acc = (id: string, disabled = false): PostingAccount => ({ id, platform: "youtube", name: id, disabled });

  it("is due with no read yet or once the interval has passed", () => {
    expect(isDue(null, now, 6 * HOUR)).toBe(true);
    expect(isDue("2026-11-19T09:00:00.000Z", now, 6 * HOUR)).toBe(true);
    expect(isDue("2026-11-19T09:00:01.000Z", now, 6 * HOUR)).toBe(false);
  });

  it("picks due accounts, stalest first, never disabled ones, and at most the per-read limit", () => {
    const fetched = new Map<string, string | null>([
      ["fresh", "2026-11-19T14:00:00.000Z"],
      ["old", "2026-11-18T01:00:00.000Z"],
      ["older", "2026-11-17T01:00:00.000Z"],
      ["never", null],
    ]);
    const accounts = [acc("fresh"), acc("old"), acc("older"), acc("never"), acc("off", true)];
    expect(dueAccounts(accounts, fetched, now, 6 * HOUR, 10).map((a) => a.id)).toEqual(["never", "older", "old"]);
    expect(dueAccounts(accounts, fetched, now, 6 * HOUR, 2).map((a) => a.id)).toEqual(["never", "older"]);
  });
});

function setup<S extends PostingService = FakePostingService>(service: S = new FakePostingService() as unknown as S) {
  let clock = now;
  if (service instanceof FakePostingService) service.today = () => clock;
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db, () => clock);
  const clips = new ClipsRepo(db, () => clock);
  const posts = new PostsRepo(db, () => clock);
  const store = new AccountStatsStore(db, service, posts, { now: () => clock, refreshHours: 6, days: 7 });
  const publisher = new Publisher({ sources, clips, posts, service, now: () => clock });
  const queue = new JobQueue(db, { handlers: {} });
  queue.stop();
  const app = createApp({ sources, vods: new VodsRepo(db), picks: new PicksRepo(db), queue, clips, posts, publisher, accountStats: store });
  return { db, sources, clips, posts, store, app, service, tick: (ms: number) => (clock = new Date(clock.getTime() + ms)) };
}

describe("AccountStatsStore", () => {
  it("calls the service once per interval, however often the dashboard asks", async () => {
    const { app, service, tick } = setup();
    const first = await request(app).get("/api/accounts");
    expect(first.status).toBe(200);
    expect(first.body.cards).toHaveLength(5);
    expect(first.body.cards[0]).toMatchObject({ followers: 1240, followersSource: "service", followersGrowth: { change: 240 } });
    expect(service.calls).toEqual(["listAccounts", "accountStats"]);

    await request(app).get("/api/accounts");
    tick(5 * HOUR);
    await request(app).get("/api/accounts");
    expect(service.calls).toEqual(["listAccounts", "accountStats"]);

    tick(HOUR);
    await request(app).get("/api/accounts");
    expect(service.calls).toEqual(["listAccounts", "accountStats", "listAccounts", "accountStats"]);
  });

  it("shares one read between requests that arrive together", async () => {
    const { store, service } = setup();
    expect(await Promise.all([store.refresh(), store.refresh(), store.refresh()])).toEqual([5, 5, 5]);
    expect(service.calls).toEqual(["listAccounts", "accountStats"]);
  });

  it("reads at most the service's per-read limit of accounts at a time", async () => {
    const service = new FakePostingService();
    Object.assign(service, { maxStatsAccountsPerRead: 3 });
    const asked: string[][] = [];
    const real = service.accountStats.bind(service);
    service.accountStats = (accounts, days) => {
      asked.push(accounts.map((a) => a.id));
      return real(accounts, days);
    };
    const { store } = setup(service);
    expect(await store.refresh()).toBe(3);
    expect(await store.refresh()).toBe(2);
    expect(await store.refresh()).toBe(0);
    expect(asked).toEqual([["fake-youtube", "fake-tiktok", "fake-tiktok-2"], ["fake-instagram", "fake-x"]]);
  });

  it("keeps the error to show, waits before asking again, and never sends the key", async () => {
    const key = "pz-secret-key-123";
    const fetch = (async () => new Response(JSON.stringify({ msg: `bad key ${key}` }), { status: 500 })) as unknown as typeof globalThis.fetch;
    const service = new PostizService({ url: "https://postiz.example.com", apiKey: key, fetch });
    const { app, store, tick } = setup(service);
    const res = await request(app).get("/api/accounts");
    expect(res.status).toBe(200);
    expect(res.body.error).toBe("Postiz answered with an error (HTTP 500): bad key ***");
    expect(JSON.stringify(res.body)).not.toContain(key);
    const dash = await request(app).get("/api/dashboard");
    expect(JSON.stringify(dash.body)).not.toContain(key);

    const spy = { n: 0 };
    service.listAccounts = () => {
      spy.n++;
      return Promise.resolve([]);
    };
    await store.refresh();
    expect(spy.n).toBe(0);
    tick(16 * 60_000);
    await store.refresh();
    expect(spy.n).toBe(1);
  });

  it("stores followers typed in by hand and shows accounts we posted to", async () => {
    const { app, sources, clips, posts } = setup(new FakePostingService([]));
    const source = sources.create(campaignInput());
    const clip = clips.create({ sourceId: source.id, vodId: null, title: "Clip", filePath: "/nowhere.mp4", durationSec: 20 });
    posts.insert({
      clipId: clip.id,
      permissionId: source.permissions[0]!.id,
      platform: "tiktok",
      accountId: "old-tt",
      accountName: "old tiktok",
      service: "fake",
      externalId: null,
      status: "posted",
      url: null,
      error: null,
      caption: "",
      scheduledAt: now.toISOString(),
      postedAt: now.toISOString(),
    });
    let res = await request(app).get("/api/accounts");
    expect(res.body.cards).toEqual([expect.objectContaining({ accountId: "old-tt", followersSource: "none", posts: 1 })]);

    expect((await request(app).post("/api/accounts/old-tt/followers").send({ followers: -1 })).status).toBe(400);
    expect((await request(app).post("/api/accounts/nobody/followers").send({ followers: 5 })).status).toBe(404);
    res = await request(app).post("/api/accounts/old-tt/followers").send({ followers: 830 });
    expect(res.status).toBe(200);
    expect(res.body.cards[0]).toMatchObject({ followers: 830, followersSource: "manual" });
  });
});
