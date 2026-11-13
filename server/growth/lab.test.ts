import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { type GrowthCampaignInput, NOT_AVAILABLE, STAT_OFFSETS } from "../../shared/growth.js";
import { dayOf } from "../../shared/metrics.js";
import { seeded } from "../../shared/stats.js";
import { campaignInput } from "../../test/helpers.js";
import { createApp } from "../app.js";
import { ClipsRepo } from "../clips/repo.js";
import { openDb } from "../db/index.js";
import { JobQueue } from "../jobs/queue.js";
import { PicksRepo } from "../picks/repo.js";
import { FakePostingService } from "../publish/fake.js";
import { Publisher } from "../publish/publisher.js";
import { PostsRepo } from "../publish/repo.js";
import { SourcesRepo } from "../sources/repo.js";
import { VodsRepo } from "../vods/repo.js";
import { GrowthLab } from "./lab.js";
import { FakePushSender, PushStore } from "./push.js";
import { GrowthRepo } from "./repo.js";

const dir = mkdtempSync(join(tmpdir(), "clipfarm-growth-"));
const videoPath = join(dir, "clip.mp4");
writeFileSync(videoPath, "not really a video");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const MIN = 60_000;
const HOUR = 60 * MIN;
const TT1 = "fake-tiktok";
const TT2 = "fake-tiktok-2";

const lengthTest = (o: Partial<GrowthCampaignInput> = {}): GrowthCampaignInput => ({
  name: "Short against long",
  hypothesis: "20-30 s clips beat 45-60 s clips on TikTok",
  sourceIds: [],
  accountIds: [TT1],
  postsPerDay: 4,
  times: [],
  durationDays: 5,
  variable: "length",
  variants: [
    { key: "A", label: "20-30 s", minSec: 20, maxSec: 30, words: [], times: [] },
    { key: "B", label: "45-60 s", minSec: 45, maxSec: 60, words: [], times: [] },
  ],
  assignment: "alternate",
  metric: "vph24",
  ...o,
});

function setup(start = "2026-11-20T08:00:00.000Z") {
  let now = new Date(start);
  const clock = () => now;
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db, clock);
  const vods = new VodsRepo(db, clock);
  const clips = new ClipsRepo(db, clock);
  const posts = new PostsRepo(db, clock);
  const service = new FakePostingService();
  service.today = clock;
  const publisher = new Publisher({ sources, clips, posts, service, now: clock });
  const repo = new GrowthRepo(db, clock);
  const push = new PushStore(db, clock);
  const sender = new FakePushSender();
  const lab = new GrowthLab({ repo, posts, clips, sources, publisher, push: { store: push, sender }, now: clock });
  const queue = new JobQueue(db, { handlers: {} });
  queue.stop();
  const app = createApp({ sources, vods, picks: new PicksRepo(db), queue, clips, posts, publisher, growth: { lab, push } });
  const source = sources.create(campaignInput({ allowedPlatforms: ["tiktok", "youtube"] }));
  // Plenty of approved clips of both lengths: a clip goes out once per account.
  for (let i = 0; i < 30; i++) {
    for (const [kind, sec] of [["short", 25], ["long", 50]] as const) {
      const clip = clips.create({ sourceId: source.id, vodId: null, title: `${kind} clip ${i + 1}`, filePath: videoPath, durationSec: sec, score: 80 - i });
      clips.setStatus(clip.id, "approved");
    }
  }
  /** Runs the clock forward: a scheduling round every 10 minutes, a stats read on the hour. */
  async function run(hours: number) {
    for (let i = 0; i < hours * 6; i++) {
      now = new Date(now.getTime() + 10 * MIN);
      await lab.tick();
      if (now.getUTCMinutes() === 0) await publisher.refresh();
    }
  }
  return { db, app, service, publisher, posts, clips, sources, repo, lab, push, sender, run, clock, setNow: (d: Date) => (now = d) };
}

/**
 * Stand-in platform analytics, TikTok style: views, likes, comments and shares, and nothing about
 * watch time or follows. Views grow towards a 24 h level that depends on the clip's length:
 * on the first account short clips do 2× the long ones with little noise; on the second 1.1× with a lot.
 */
function fakeAnalytics(service: FakePostingService) {
  service.metricsFor = (post, ageHours) => {
    const n = Number(post.externalId.split("-").at(-1));
    const short = service.published[n - 1]!.title.startsWith("short");
    const clear = post.accountId === TT1;
    const rand = seeded(n * 7919);
    const z = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
    const level = 2400 * (short ? (clear ? 2 : 1.1) : 1) * Math.exp((clear ? 0.3 : 0.9) * z);
    const views = Math.round(level * Math.min(3, ageHours / 24) ** 0.7);
    return { views, likes: Math.round(views * 0.08), comments: Math.round(views * 0.004), shares: Math.round(views * 0.01) };
  };
}

describe("two campaigns × two variants, 40 posts, faked posting service and analytics", async () => {
  const t = setup();
  fakeAnalytics(t.service);
  t.posts.saveRules({ maxPerDay: 4, minGapMinutes: 60 });
  const clear = t.lab.create(lengthTest());
  const noisy = t.lab.create(lengthTest({ name: "Short against long, second account", accountIds: [TT2], assignment: "random" }));
  await t.lab.start(clear.id);
  await t.lab.start(noisy.id);
  // Five days of posting, then a day and a bit so every post reaches its 24 h point.
  await t.run(5 * 24 + 26);
  const all = t.posts.list();
  const linksOf = (id: number) => t.repo.links(id).map((l) => ({ ...l, post: all.find((p) => p.id === l.postId)! }));

  it("posts every slot and finishes by itself", () => {
    expect(all).toHaveLength(40);
    expect(all.every((p) => p.status === "posted")).toBe(true);
    expect(t.repo.get(clear.id).status).toBe("finished");
    expect(t.repo.get(noisy.id).status).toBe("finished");
  });

  it("spreads the variants evenly, alternating or randomised, and each post carries a clip of its variant", () => {
    for (const c of [clear, noisy]) {
      const links = linksOf(c.id);
      expect(links.filter((l) => l.variantKey === "A")).toHaveLength(10);
      expect(links.filter((l) => l.variantKey === "B")).toHaveLength(10);
      for (const l of links) expect(l.post.clipTitle.startsWith(l.variantKey === "A" ? "short" : "long")).toBe(true);
      // Even within each day too: two of each.
      for (const day of new Set(links.map((l) => dayOf(l.post.scheduledAt)))) {
        expect(links.filter((l) => dayOf(l.post.scheduledAt) === day && l.variantKey === "A")).toHaveLength(2);
      }
      // No clip twice on one account.
      expect(new Set(links.map((l) => l.post.clipId)).size).toBe(20);
    }
    const order = (id: number) => linksOf(id).sort((a, b) => a.post.scheduledAt.localeCompare(b.post.scheduledAt)).map((l) => l.variantKey).join("");
    expect(order(clear.id)).toBe("AB".repeat(10));
    expect(order(noisy.id)).not.toBe("AB".repeat(10));
  });

  it("respects the accounts' caps and spacing", () => {
    for (const account of [TT1, TT2]) {
      const times = all.filter((p) => p.accountId === account).map((p) => new Date(p.scheduledAt).getTime()).sort((a, b) => a - b);
      const perDay = new Map<string, number>();
      for (const at of times) perDay.set(dayOf(new Date(at)), (perDay.get(dayOf(new Date(at))) ?? 0) + 1);
      expect(Math.max(...perDay.values())).toBeLessThanOrEqual(4);
      for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(60 * MIN);
    }
  });

  it("fills each post's time series at 1 h, 6 h, 24 h and 72 h, with the post's real age", () => {
    const series = t.posts.series();
    const end = t.clock().getTime();
    for (const p of all) {
      const points = series.get(p.id)!;
      const ageNow = (end - new Date(p.postedAt!).getTime()) / HOUR;
      const expected = STAT_OFFSETS.filter((o) => ageNow >= o.hours + 1).map((o) => o.key);
      expect(points.map((x) => x.offset)).toEqual(expected);
      expect(expected).toContain("24h");
      expect(expected).not.toContain("7d");
      for (const point of points) {
        const offset = STAT_OFFSETS.find((o) => o.key === point.offset)!;
        expect(point.ageHours).toBeGreaterThanOrEqual(offset.hours);
        expect(point.ageHours).toBeLessThanOrEqual(offset.hours + 1);
        expect(point.views).toBeGreaterThan(0);
      }
      // Views only ever grow from one point to the next.
      for (let i = 1; i < points.length; i++) expect(points[i]!.views!).toBeGreaterThanOrEqual(points[i - 1]!.views!);
    }
  });

  it("reads the clear 2× campaign as significant and the noisy 1.1× one as not enough data", () => {
    const a = t.lab.report(clear.id);
    expect(a.comparisons).toHaveLength(1);
    expect(a.comparisons[0]!.significant).toBe(true);
    expect(a.comparisons[0]!.text).toMatch(/^20-30 s beats 45-60 s by \d\.\d× \(9[59]% sure\)$/);
    expect(a.comparisons[0]!.ratio).toBeGreaterThan(1.5);

    const b = t.lab.report(noisy.id);
    expect(b.comparisons[0]!.significant).toBe(false);
    expect(b.comparisons[0]!.text).toMatch(/^Not enough data yet: /);
    expect(b.recommendation).toBeNull();
  });

  it("builds the report: tiles, variants, chart, top and bottom posts", () => {
    const r = t.lab.report(clear.id);
    expect(r.progress).toEqual({ day: 5, days: 5, posts: 20, planned: 20 });
    expect(r.kpis).toMatchObject({ posts: 20, scheduled: 0, measured: 20 });
    expect(r.kpis.totalViews).toBe(all.filter((p) => p.accountId === TT1).reduce((s, p) => s + p.views!, 0));
    expect(r.kpis.medianMetric).toBeGreaterThan(100);
    expect(r.variants.map((v) => [v.label, v.posts])).toEqual([["20-30 s", 10], ["45-60 s", 10]]);
    expect(r.variants[0]!.medianMetric!).toBeGreaterThan(r.variants[1]!.medianMetric! * 1.5);
    expect(r.chart.map((s) => s.label)).toEqual(["20-30 s", "45-60 s"]);
    const line = r.chart[0]!.points.map((p) => p.value);
    expect(line.length).toBeGreaterThanOrEqual(6);
    expect([...line].sort((x, y) => x - y)).toEqual(line);
    expect(line.at(-1)).toBe(r.variants[0]!.totalViews);
    expect(r.top).toHaveLength(5);
    expect(r.bottom).toHaveLength(5);
    expect(r.top[0]!.metric!).toBeGreaterThan(r.bottom[0]!.metric!);
    expect(r.top.every((p) => p.url?.startsWith("https://"))).toBe(true);
    expect(new Set([...r.top, ...r.bottom].map((p) => p.postId)).size).toBe(10);
  });

  it("shows numbers the platform did not give as not available, never 0", async () => {
    const r = t.lab.report(clear.id);
    // The stand-in platform says nothing about watch time, follows or what the clips cost.
    expect(r.kpis.avgWatchPct).toBeNull();
    expect(r.kpis.followsGained).toBeNull();
    expect(r.kpis.costUsd).toBeNull();
    expect(r.kpis.costPer1kViewsUsd).toBeNull();
    expect(NOT_AVAILABLE).toBe("not available");
    const csv = (await request(t.app).get(`/api/growth/campaigns/${clear.id}/export.csv`)).text.trim().split("\n");
    expect(csv).toHaveLength(21);
    const head = csv[0]!.split(",");
    const row = csv[1]!.split(",");
    expect(row[head.indexOf("avg_watch_pct")]).toBe("");
    expect(row[head.indexOf("views_7d")]).toBe("");
    expect(Number(row[head.indexOf("views_24h")])).toBeGreaterThan(0);
    expect(Number(row[head.indexOf("likes")])).toBeGreaterThan(0);
  });

  it("compares the two campaigns side by side", async () => {
    const res = await request(t.app).get(`/api/growth/compare?ids=${clear.id},${noisy.id}`);
    expect(res.status).toBe(200);
    expect(res.body.rows.map((r: { name: string; kpis: { posts: number } }) => [r.name, r.kpis.posts])).toEqual([
      ["Short against long", 20],
      ["Short against long, second account", 20],
    ]);
    expect(res.body.comparisons).toHaveLength(1);
    expect(res.body.comparisons[0].text).toMatch(/beats|Not enough data yet/);
    expect((await request(t.app).get(`/api/growth/compare?ids=${clear.id}`)).status).toBe(400);
  });

  it("offers a recommendation whose Apply changes the default it names, and Undo restores it", async () => {
    const info = (await request(t.app).get("/api/growth")).body;
    expect(info.recommendations).toHaveLength(1);
    const rec = info.recommendations[0];
    expect(rec).toMatchObject({ campaignId: clear.id, status: "open", text: "Make 20-30 s the default clip length" });
    expect(rec.detail).toMatch(/Measured on TikTok over 20 posts\.$/);
    expect(info.defaults).toMatchObject({ clipMinSec: null, clipMaxSec: null });

    const applied = (await request(t.app).post(`/api/growth/recommendations/${rec.id}/apply`)).body;
    expect(applied.defaults).toMatchObject({ clipMinSec: 20, clipMaxSec: 30 });
    expect(applied.recommendations[0].status).toBe("applied");
    expect((await request(t.app).post(`/api/growth/recommendations/${rec.id}/apply`)).status).toBe(400);

    const undone = (await request(t.app).post(`/api/growth/recommendations/${rec.id}/undo`)).body;
    expect(undone.defaults).toMatchObject({ clipMinSec: null, clipMaxSec: null });
    expect(undone.recommendations[0].status).toBe("open");

    const dismissed = (await request(t.app).post(`/api/growth/recommendations/${rec.id}/dismiss`)).body;
    expect(dismissed.recommendations).toEqual([]);
    // A dismissed recommendation is not offered again at the next round.
    await t.lab.tick();
    expect(t.repo.recommendations()).toEqual([]);
  });
});

describe("caps, gates and pausing", () => {
  it("never posts more than the account's own posts a day, however many the campaign asks for", async () => {
    const t = setup();
    t.posts.saveRules({ maxPerDay: 2, minGapMinutes: 120 });
    const c = t.lab.create(lengthTest({ postsPerDay: 6, durationDays: 2 }));
    await t.lab.start(c.id);
    await t.run(48);
    const times = t.posts.list().map((p) => p.scheduledAt).sort();
    expect(times).toHaveLength(4);
    expect(times.map((x) => dayOf(x))).toEqual(["2026-11-20", "2026-11-20", "2026-11-21", "2026-11-21"]);
    for (let i = 1; i < times.length; i++) expect(new Date(times[i]!).getTime() - new Date(times[i - 1]!).getTime()).toBeGreaterThanOrEqual(120 * MIN);
  });

  it("posts nothing without a permission record, and says why on the campaign", async () => {
    const t = setup();
    t.db.prepare("DELETE FROM permissions").run();
    const c = t.lab.create(lengthTest());
    await t.lab.start(c.id);
    await t.run(24);
    expect(t.posts.list()).toEqual([]);
    expect(t.service.calls).not.toContain("publish");
    expect(t.repo.get(c.id).note).toBe("Test Streamer has no permission record. Add their campaign or written permission first.");
  });

  it("keeps an experiment's clips off main accounts", async () => {
    const t = setup();
    t.db.prepare("UPDATE permissions SET kind = 'experiment'").run();
    const c = t.lab.create(lengthTest());
    await t.lab.start(c.id);
    await t.run(24);
    expect(t.posts.list()).toEqual([]);
    expect(t.service.calls).not.toContain("publish");
  });

  it("only uses approved clips of the chosen creators, and waits when none fits", async () => {
    const t = setup();
    const other = t.sources.create({ ...campaignInput(), creatorName: "Other Streamer" });
    const c = t.lab.create(lengthTest({ sourceIds: [other.id] }));
    await t.lab.start(c.id);
    await t.run(6);
    expect(t.posts.list()).toEqual([]);
    expect(t.repo.get(c.id).note).toMatch(/^No approved clip is left for "20-30 s" on gtavimoments\./);
  });

  it("Pause stops new posts, Start carries on, Stop finishes, and a draft can be changed or deleted", async () => {
    const t = setup();
    const made = await request(t.app).post("/api/growth/campaigns").send(lengthTest());
    expect(made.status).toBe(201);
    const id = made.body.id as number;
    expect(made.body.status).toBe("draft");
    expect((await request(t.app).put(`/api/growth/campaigns/${id}`).send(lengthTest({ name: "Renamed" }))).body.name).toBe("Renamed");
    expect((await request(t.app).post(`/api/growth/campaigns/${id}/pause`)).status).toBe(400);

    expect((await request(t.app).post(`/api/growth/campaigns/${id}/start`)).body).toMatchObject({ status: "running", endsAt: "2026-11-25T08:00:00.000Z" });
    await t.run(6);
    expect(t.posts.list()).toHaveLength(2);
    expect((await request(t.app).put(`/api/growth/campaigns/${id}`).send(lengthTest())).status).toBe(400);
    expect((await request(t.app).delete(`/api/growth/campaigns/${id}`)).status).toBe(400);

    expect((await request(t.app).post(`/api/growth/campaigns/${id}/pause`)).body.status).toBe("paused");
    await t.run(8);
    expect(t.posts.list()).toHaveLength(2);

    // The slots missed while paused are not posted late.
    expect((await request(t.app).post(`/api/growth/campaigns/${id}/start`)).body).toMatchObject({ status: "running", endsAt: "2026-11-25T08:00:00.000Z" });
    await t.run(12);
    expect(t.posts.list()).toHaveLength(3);

    expect((await request(t.app).post(`/api/growth/campaigns/${id}/stop`)).body.status).toBe("finished");
    await t.run(24);
    expect(t.posts.list()).toHaveLength(3);
    expect((await request(t.app).post(`/api/growth/campaigns/${id}/start`)).status).toBe(400);

    const draft = (await request(t.app).post("/api/growth/campaigns").send(lengthTest())).body.id as number;
    expect((await request(t.app).delete(`/api/growth/campaigns/${draft}`)).status).toBe(204);
    expect((await request(t.app).get(`/api/growth/campaigns/${draft}/report`)).status).toBe(404);
  });

  it("a strike on one of its posts pauses the campaign at once, with the reason", async () => {
    const t = setup();
    const c = t.lab.create(lengthTest());
    await t.lab.start(c.id);
    await t.run(3);
    const post = t.posts.list()[0]!;
    expect(post.status).toBe("posted");
    const res = await request(t.app).post(`/api/posts/${post.id}/flags`).send({ flag: "strike" });
    expect(res.status).toBe(200);
    const paused = t.repo.get(c.id);
    expect(paused.status).toBe("paused");
    expect(paused.pausedReason).toBe(`Paused on 2026-11-20: a strike on "${post.clipTitle}" (gtavimoments). Start it again when it is safe.`);
    await t.run(24);
    expect(t.posts.list()).toHaveLength(1);

    // Started again by hand, the old strike does not pause it a second time.
    await t.lab.start(c.id);
    await t.run(24);
    expect(t.repo.get(c.id)).toMatchObject({ status: "running", pausedReason: null });
    expect(t.posts.list().length).toBeGreaterThan(1);
  });

  it("refuses a campaign that cannot run, in plain words", async () => {
    const t = setup();
    const send = (o: object) => request(t.app).post("/api/growth/campaigns").send({ ...lengthTest(), ...o });
    expect((await send({ name: " " })).body.error).toBe("Give the campaign a name.");
    expect((await send({ accountIds: [] })).body.error).toBe("Pick at least one account to post from.");
    expect((await send({ variants: [lengthTest().variants[0]] })).body.error).toBe("A test needs 2 to 4 variants.");
    expect((await send({ times: ["09:00"] })).body.error).toBe("Give one time for each post of the day (4), or leave the times empty.");
    expect((await send({ times: ["9am", "1", "2", "3"] })).body.error).toBe("Write times like 09:00 or 18:30.");
    expect((await send({ variants: [{ label: "x" }, { label: "y", minSec: 5 }] })).body.error).toBe('Give "x" a shortest or longest clip length.');
    expect((await send({ variable: "time", variants: [{ label: "Morning", times: ["09:00"] }, { label: "Evening", times: [] }] })).body.error).toBe(
      'Give "Evening" at least one posting time.',
    );
  });
});

describe("a posting-time test", () => {
  it("posts each variant at its own time, evenly", async () => {
    const t = setup("2026-11-20T00:00:00.000Z");
    const c = t.lab.create(
      lengthTest({
        variable: "time",
        postsPerDay: 2,
        durationDays: 4,
        variants: [
          { key: "A", label: "Morning", minSec: null, maxSec: null, words: [], times: ["09:00"] },
          { key: "B", label: "Evening", minSec: null, maxSec: null, words: [], times: ["19:30"] },
        ],
      }),
    );
    await t.lab.start(c.id);
    await t.run(4 * 24);
    const posts = t.posts.list();
    const at = (key: string) => t.repo.links(c.id).filter((l) => l.variantKey === key).map((l) => posts.find((p) => p.id === l.postId)!.scheduledAt.slice(11, 16));
    expect(at("A")).toEqual(["09:00", "09:00", "09:00", "09:00"]);
    expect(at("B")).toEqual(["19:30", "19:30", "19:30", "19:30"]);
  });
});

describe("the daily digest", () => {
  it("says yesterday's views, the best clip, campaign progress and one recommendation, at 09:00 on the phone's clock", async () => {
    const t = setup();
    fakeAnalytics(t.service);
    t.posts.saveRules({ maxPerDay: 4, minGapMinutes: 60 });
    const c = t.lab.create(lengthTest());
    await t.lab.start(c.id);
    await t.lab.start(t.lab.create(lengthTest({ name: "Second account", accountIds: [TT2], durationDays: 7 })).id);
    await t.run(5 * 24 + 26);
    const posts = t.posts.list().filter((p) => p.status === "posted");
    expect(posts.length).toBeGreaterThanOrEqual(20);

    const digest = t.lab.digest();
    expect(digest.title).toBe("clipfarm: yesterday");
    expect(digest.lines[0]).toMatch(/^Yesterday: [\d,]+ views$/);
    expect(digest.lines[1]).toMatch(/^Best clip: "(short|long) clip \d+" \(\+[\d,]+ views\)$/);
    // The first campaign has finished; the second is on its last day.
    expect(digest.lines[2]).toMatch(/^Second account: day 7 of 7, \d+ of 28 posts$/);
    expect(digest.lines[3]).toBe("Tip: Make 20-30 s the default clip length");

    t.push.subscribe({ endpoint: "https://push.example/tokyo", p256dh: "k", auth: "a", tz: "Asia/Tokyo" });
    t.push.subscribe({ endpoint: "https://push.example/utc", p256dh: "k", auth: "a", tz: "UTC" });
    t.push.subscribe({ endpoint: "https://push.example/gone", p256dh: "k", auth: "a", tz: "UTC" });
    t.sender.gone.add("https://push.example/gone");

    // 08:50 UTC is 17:50 in Tokyo: too late there, too early in UTC.
    t.setNow(new Date("2026-11-26T08:50:00.000Z"));
    expect(await t.lab.sendDigests()).toBe(0);
    t.setNow(new Date("2026-11-26T09:05:00.000Z"));
    expect(await t.lab.sendDigests()).toBe(1);
    expect(t.sender.sent).toHaveLength(1);
    expect(t.sender.sent[0]).toMatchObject({ endpoint: "https://push.example/utc", title: "clipfarm: yesterday" });
    expect(t.sender.sent[0]!.body).toContain("Tip: Make 20-30 s the default clip length");
    // Once a day, and a subscription the browser dropped is forgotten.
    expect(await t.lab.sendDigests()).toBe(0);
    expect(t.push.list().map((s) => s.endpoint).sort()).toEqual(["https://push.example/tokyo", "https://push.example/utc"]);
    // Tokyo's turn comes at its own 09:00.
    t.setNow(new Date("2026-11-27T00:10:00.000Z"));
    expect(await t.lab.sendDigests()).toBe(1);
    expect(t.sender.sent[1]!.endpoint).toBe("https://push.example/tokyo");
  });

  it("says not available before any views were read", () => {
    const t = setup();
    expect(t.lab.digest().lines).toEqual(["Yesterday's views: not available", "No campaign is running."]);
  });
});
