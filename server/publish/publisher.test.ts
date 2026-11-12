import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { campaignInput } from "../../test/helpers.js";
import { createApp } from "../app.js";
import { ClipsRepo } from "../clips/repo.js";
import { openDb } from "../db/index.js";
import { JobQueue } from "../jobs/queue.js";
import { PicksRepo } from "../picks/repo.js";
import { SourcesRepo } from "../sources/repo.js";
import { VodsRepo } from "../vods/repo.js";
import { FakePostingService } from "./fake.js";
import { Publisher } from "./publisher.js";
import { PostsRepo } from "./repo.js";

const dir = mkdtempSync(join(tmpdir(), "clipfarm-publisher-"));
// A dot folder, like the e2e data folder (.e2e-data/run/media).
mkdirSync(join(dir, ".data"));
const videoPath = join(dir, ".data", "clip.mp4");
writeFileSync(videoPath, "not really a video");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function setup(perm: Parameters<typeof campaignInput>[0] = {}, opts: { clipStatus?: "pending" | "approved"; now?: Date } = {}) {
  let now = opts.now ?? new Date("2026-11-19T12:00:00.000Z");
  const clock = () => now;
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db, clock);
  const vods = new VodsRepo(db, clock);
  const clips = new ClipsRepo(db, clock);
  const posts = new PostsRepo(db, clock);
  const service = new FakePostingService();
  const publisher = new Publisher({ sources, clips, posts, service, now: clock });
  const queue = new JobQueue(db, { handlers: {} });
  queue.stop();
  const app = createApp({ sources, vods, picks: new PicksRepo(db), queue, clips, posts, publisher });
  const source = sources.create(campaignInput(perm));
  const clip = clips.create({ sourceId: source.id, vodId: null, title: "He actually landed the jump", filePath: videoPath, durationSec: 24 });
  if ((opts.clipStatus ?? "approved") === "approved") clips.setStatus(clip.id, "approved");
  return { db, app, service, publisher, clip, source, posts, setNow: (d: Date) => (now = d) };
}

const YT = "fake-youtube";
const TT = "fake-tiktok";
const IG = "fake-instagram";

describe("POST /api/clips/:id/posts (gate before any service call)", () => {
  it("refuses a clip whose source has no permission record", async () => {
    const { db, app, service, clip } = setup();
    db.prepare("DELETE FROM permissions").run();
    const res = await request(app).post(`/api/clips/${clip.id}/posts`).send({ accountIds: [YT] });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Test Streamer has no permission record. Add their campaign or written permission first.");
    expect(service.calls).toEqual([]);
  });

  it("refuses when the permission expired", async () => {
    const { app, service, clip } = setup({ expiresAt: "2026-11-01T00:00:00.000Z" });
    const res = await request(app).post(`/api/clips/${clip.id}/posts`).send({ accountIds: [YT] });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/expired on 2026-11-01/);
    expect(service.calls).toEqual([]);
  });

  it("refuses a platform the brief does not allow, posting nothing", async () => {
    const { app, service, clip } = setup();
    const res = await request(app).post(`/api/clips/${clip.id}/posts`).send({ accountIds: [YT, IG] });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("The permission for Test Streamer does not allow posting to Instagram Reels.");
    expect(service.calls.filter((c) => c === "publish")).toEqual([]);
  });

  it("refuses a time after the permission ends", async () => {
    const { app, service, clip } = setup({ expiresAt: "2026-11-20T00:00:00.000Z" });
    const res = await request(app).post(`/api/clips/${clip.id}/posts`).send({ accountIds: [YT], when: "2026-11-21T10:00:00.000Z" });
    expect(res.status).toBe(403);
    expect(service.calls.filter((c) => c === "publish")).toEqual([]);
  });

  it("refuses a clip that is not approved", async () => {
    const { app, service, clip } = setup({}, { clipStatus: "pending" });
    const res = await request(app).post(`/api/clips/${clip.id}/posts`).send({ accountIds: [YT] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Approve the clip before posting it.");
    expect(service.calls).toEqual([]);
  });

  it("a dry run runs every check and says what would go out, without calling the service or storing a post", async () => {
    const { app, service, clip, source, posts } = setup({ briefRules: "Tag #ad" });
    const res = await request(app).post(`/api/clips/${clip.id}/posts/dry-run`).send({ accountIds: [YT, TT] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      dryRun: true,
      wouldPost: [
        expect.objectContaining({ accountId: YT, platform: "youtube", permissionId: source.permissions[0]!.id, scheduledAt: "2026-11-19T12:00:00.000Z" }),
        expect.objectContaining({ accountId: TT, platform: "tiktok", caption: expect.stringContaining("Credit: Test Streamer") }),
      ],
    });
    expect(service.calls.filter((c) => c === "publish")).toEqual([]);
    expect(posts.list()).toEqual([]);
  });

  it("a dry run is held to the same gate: no permission record, a time after it ends, a clip not approved", async () => {
    const lapsing = setup({ expiresAt: "2026-11-20T00:00:00.000Z" });
    const late = await request(lapsing.app)
      .post(`/api/clips/${lapsing.clip.id}/posts/dry-run`)
      .send({ accountIds: [YT], when: "2026-11-21T10:00:00.000Z" });
    expect(late.status).toBe(403);
    expect(late.body.error).toMatch(/expired on 2026-11-20/);

    const none = setup();
    none.db.prepare("DELETE FROM permissions").run();
    const noRecord = await request(none.app).post(`/api/clips/${none.clip.id}/posts/dry-run`).send({ accountIds: [YT] });
    expect(noRecord.status).toBe(403);
    expect(noRecord.body.error).toMatch(/has no permission record/);

    const pending = setup({}, { clipStatus: "pending" });
    const notApproved = await request(pending.app).post(`/api/clips/${pending.clip.id}/posts/dry-run`).send({ accountIds: [YT] });
    expect(notApproved.status).toBe(400);
    expect(notApproved.body.error).toBe("Approve the clip before posting it.");
  });

  it("posts on two accounts, storing the permission record, campaign and caption from the brief", async () => {
    const { app, service, clip, source } = setup({ briefRules: "Tag #ad, link https://whop.com/test/campaign" });
    const res = await request(app).post(`/api/clips/${clip.id}/posts`).send({ accountIds: [YT, TT] });
    expect(res.status).toBe(201);
    expect(service.published.map((i) => i.account.id)).toEqual([YT, TT]);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({
      clipId: clip.id,
      platform: "youtube",
      accountName: "GTA VI Moments",
      status: "posted",
      url: expect.stringContaining("youtube"),
      permissionId: source.permissions[0]!.id,
      campaignUrl: "https://whop.com/test/campaign",
      caption: "He actually landed the jump\n\nCredit: Test Streamer https://www.twitch.tv/teststreamer\nhttps://whop.com/test/campaign\n#ad",
    });
  });

  it("spaces posts on the same account and says so", async () => {
    const { app, clip } = setup();
    await request(app).post(`/api/clips/${clip.id}/posts`).send({ accountIds: [YT] }).expect(201);
    const second = await request(app).post(`/api/clips/${clip.id}/posts`).send({ accountIds: [YT, TT] }).expect(201);
    expect(second.body[0]).toMatchObject({ platform: "youtube", status: "scheduled", scheduledAt: "2026-11-19T13:30:00.000Z" });
    expect(second.body[1]).toMatchObject({ platform: "tiktok", status: "posted", scheduledAt: "2026-11-19T12:00:00.000Z" });
  });

  it("uses the spacing settings", async () => {
    const { app, clip } = setup();
    await request(app).put("/api/posting/rules").send({ maxPerDay: 1, minGapMinutes: 30 }).expect(200);
    await request(app).post(`/api/clips/${clip.id}/posts`).send({ accountIds: [YT] }).expect(201);
    const second = await request(app).post(`/api/clips/${clip.id}/posts`).send({ accountIds: [YT] }).expect(201);
    expect(second.body[0].scheduledAt).toBe("2026-11-20T00:00:00.000Z");
    const bad = await request(app).put("/api/posting/rules").send({ maxPerDay: 0, minGapMinutes: 30 });
    expect(bad.status).toBe(400);
  });

  it("refuses past the service's daily cap for a platform", async () => {
    const { app, clip, service } = setup();
    service.dailyCaps = { youtube: 1 };
    await request(app).post(`/api/clips/${clip.id}/posts`).send({ accountIds: [YT] }).expect(201);
    const res = await request(app).post(`/api/clips/${clip.id}/posts`).send({ accountIds: [YT] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Test posting service allows 1 YouTube Shorts post a day and 1 already went out today. Try tomorrow, or use Export to post by hand.");
  });

  it("saves nothing and explains when the service fails", async () => {
    const { app, clip, service } = setup();
    service.failWith = "Postiz refused the API key. Copy it again from Postiz > Settings > Public API into POSTIZ_API_KEY.";
    const res = await request(app).post(`/api/clips/${clip.id}/posts`).send({ accountIds: [YT] });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe(service.failWith);
    expect((await request(app).get("/api/posts")).body).toEqual([]);
  });
});

describe("tracking, Whop and stats", () => {
  it("reads views on refresh, takes views by hand, marks Whop submission and estimates earnings over the minimum", async () => {
    const { app, clip } = setup({ cpmRateUsd: 1.5, minViews: 3000 });
    const [yt, tt] = (await request(app).post(`/api/clips/${clip.id}/posts`).send({ accountIds: [YT, TT] }).expect(201)).body;

    await request(app).post("/api/posts/refresh").expect(200);
    let list = (await request(app).get("/api/posts")).body;
    expect(list.find((p: { id: number }) => p.id === yt.id)).toMatchObject({ views: 12000, viewsSource: "service", estimatedEarningsUsd: 18 });

    await request(app).post(`/api/posts/${tt.id}/views`).send({ views: 2500 }).expect(200);
    await request(app).post(`/api/posts/${tt.id}/whop`).expect(200);
    list = (await request(app).get("/api/posts")).body;
    expect(list.find((p: { id: number }) => p.id === tt.id)).toMatchObject({
      views: 2500,
      viewsSource: "manual",
      estimatedEarningsUsd: 0,
      whopSubmittedAt: "2026-11-19T12:00:00.000Z",
    });

    const stats = (await request(app).get("/api/stats")).body;
    expect(stats).toMatchObject({ posts: 2, views: 14500, estimatedEarningsUsd: 18, approvedClips: 1, costPerApprovedClipUsd: 0 });
    expect(stats.byPlatform).toEqual([
      { key: "tiktok", label: "TikTok", posts: 1, views: 2500, estimatedEarningsUsd: 0 },
      { key: "youtube", label: "YouTube Shorts", posts: 1, views: 12000, estimatedEarningsUsd: 18 },
    ]);
    expect(stats.byCampaign).toEqual([{ key: expect.any(String), label: "Test Streamer · whop.com", posts: 2, views: 14500, estimatedEarningsUsd: 18 }]);
  });

  it("does not let a later refresh overwrite views entered by hand with nothing", async () => {
    const { app, clip, service } = setup();
    const [yt] = (await request(app).post(`/api/clips/${clip.id}/posts`).send({ accountIds: [YT] }).expect(201)).body;
    service.views = null;
    await request(app).post(`/api/posts/${yt.id}/views`).send({ views: 900 }).expect(200);
    await request(app).post("/api/posts/refresh").expect(200);
    expect((await request(app).get("/api/posts")).body[0]).toMatchObject({ views: 900, viewsSource: "manual" });
  });

  it("offers the export pack only within the permission and brief", async () => {
    const { app, clip } = setup({ briefRules: "Use #ad" });
    const ok = await request(app).get(`/api/clips/${clip.id}/export?platform=tiktok`).expect(200);
    expect(ok.body).toEqual({
      clipId: clip.id,
      platform: "tiktok",
      fileName: "he-actually-landed-the-jump.mp4",
      videoUrl: `/api/clips/${clip.id}/video?download=1`,
      caption: "He actually landed the jump\n\nCredit: Test Streamer https://www.twitch.tv/teststreamer\n#ad",
    });
    const refused = await request(app).get(`/api/clips/${clip.id}/export?platform=instagram`);
    expect(refused.status).toBe(403);
  });

  it("serves the clip video to play and to download, even from a dot folder", async () => {
    const { app, clip } = setup();
    const play = await request(app).get(`/api/clips/${clip.id}/video`).expect(200);
    expect(play.headers["content-type"]).toBe("video/mp4");
    const download = await request(app).get(`/api/clips/${clip.id}/video?download=1`).expect(200);
    expect(download.headers["content-disposition"]).toContain("he-actually-landed-the-jump.mp4");
  });

  it("never sends keys to the client", async () => {
    const { app } = setup();
    const res = await request(app).get("/api/posting").expect(200);
    expect(res.body).toMatchObject({ service: "fake", rules: { maxPerDay: 3, minGapMinutes: 90 } });
    expect(JSON.stringify(res.body)).not.toMatch(/key/i);
  });
});
