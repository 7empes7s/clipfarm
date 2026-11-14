import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import type { OpsInfo, OpsLevel } from "../../shared/ops.js";
import type { PostingAccount } from "../../shared/types.js";
import { campaignInput } from "../../test/helpers.js";
import { createApp } from "../app.js";
import { ClipsRepo } from "../clips/repo.js";
import { openDb } from "../db/index.js";
import { JobQueue } from "../jobs/queue.js";
import { PicksRepo } from "../picks/repo.js";
import { AutopilotRepo } from "../publish/autopilotRepo.js";
import { Autopilot } from "../publish/autopilotService.js";
import { FakePostingService } from "../publish/fake.js";
import { Publisher } from "../publish/publisher.js";
import { PostsRepo } from "../publish/repo.js";
import { SubmitWatch } from "../publish/submitWatch.js";
import { SourcesRepo } from "../sources/repo.js";
import { WatchlistRepo } from "../sources/watchlist/repo.js";
import { VodsRepo } from "../vods/repo.js";
import { FakeNotifier } from "../live/notify.js";
import { diskLevel, type KeyState, memoryLevel, Operations, type Resources, type ServiceProbe } from "./operations.js";
import { fakeProbes } from "./probes.js";
import { OpsState } from "./state.js";

const dir = mkdtempSync(join(tmpdir(), "clipfarm-ops-"));
const videoPath = join(dir, "clip.mp4");
writeFileSync(videoPath, "not really a video");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const NOW = new Date("2026-11-14T12:00:00.000Z");
const GB = 1024 ** 3;
const ACCOUNTS: PostingAccount[] = [
  { id: "tt-main", platform: "tiktok", name: "gtavimoments", disabled: false },
  { id: "yt-main", platform: "youtube", name: "GTA VI Moments", disabled: false },
];
const WHO = { "cf-access-authenticated-user-email": "boss@example.com" };

function setup(o: { probes?: ServiceProbe[]; keys?: KeyState[]; resources?: Resources } = {}) {
  let now = NOW;
  const clock = () => now;
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db, clock);
  const vods = new VodsRepo(db, clock);
  const clips = new ClipsRepo(db, clock);
  const posts = new PostsRepo(db, clock);
  posts.submitDefaults = { ...posts.submitDefaults, timeZone: "UTC" };
  const service = new FakePostingService(ACCOUNTS);
  service.today = clock;
  const publisher = new Publisher({ sources, clips, posts, service, now: clock, holdLater: true });
  const state = new OpsState(db, clock);
  const ran: number[] = [];
  const queue = new JobQueue(db, {
    handlers: {
      ingest: async ({ job }) => void ran.push(job.id),
      render: async ({ job }) => void ran.push(job.id),
    },
    now: clock,
    paused: () => state.isOn("worker_paused"),
  });
  queue.stop();
  const watchRepo = new WatchlistRepo(db, sources, clock);
  const checked: number[] = [];
  let keys = o.keys ?? [{ id: "openai", label: "OpenAI", configured: true, result: { ok: true, message: "Working", at: NOW.toISOString() } }];
  const operations = new Operations({
    state,
    queue,
    vods,
    clips,
    sources,
    posts,
    publisher,
    watchlist: { repo: watchRepo, checkNow: async (id) => void checked.push(id) },
    keys: () => keys,
    testKeys: async () => {
      keys = keys.map((k) => ({ ...k, result: { ok: false, message: "OpenAI says: invalid key.", at: NOW.toISOString() } }));
    },
    probes: o.probes ?? fakeProbes(new Set()),
    resources: async () => o.resources ?? { diskFreeBytes: 80 * GB, diskTotalBytes: 150 * GB, memAvailableBytes: 4 * GB, memTotalBytes: 8 * GB },
    now: clock,
    probeCacheMs: 0,
  });
  const app = createApp({ sources, vods, picks: new PicksRepo(db), queue, clips, posts, publisher, operations });
  const source = sources.create(campaignInput({ allowedPlatforms: ["tiktok", "youtube"], minViews: 0 }));
  const makeClip = (title = "He landed the jump") => {
    const c = clips.create({ sourceId: source.id, vodId: null, title, filePath: videoPath, durationSec: 24, score: 90, quality: { issues: [], fix: null } });
    clips.setStatus(c.id, "approved");
    return c;
  };
  const expirePermission = () => db.prepare("UPDATE permissions SET expires_at = '2026-11-01T00:00:00.000Z'").run();
  const page = async () => (await request(app).get("/api/ops").expect(200)).body as OpsInfo;
  return { db, app, sources, vods, clips, posts, service, publisher, state, queue, ran, watchRepo, checked, operations, source, makeClip, expirePermission, page, setNow: (d: Date) => (now = d) };
}

const level = (info: OpsInfo, id: string): OpsLevel | undefined =>
  [...info.status.services, ...info.status.resources, ...info.status.keys].find((c) => c.id === id)?.level;

describe("status at a glance", () => {
  it("is green when every service, key and headroom is fine", async () => {
    const t = setup();
    // A worker that holds the lease has checked in.
    t.db.prepare("INSERT INTO queue_worker (id, owner, beat_at) VALUES (1, 'w', ?)").run(NOW.toISOString());
    const info = await t.page();
    expect(info.status.services.map((s) => [s.id, s.level])).toEqual([
      ["clipfarm", "ok"],
      ["worker", "ok"],
      ["postiz", "ok"],
      ["postiz-backend", "ok"],
    ]);
    expect(level(info, "key:openai")).toBe("ok");
    expect(level(info, "disk")).toBe("ok");
    // No live proof here: "not set up" does not turn the page red.
    expect(info.status.proof.level).toBe("off");
    expect(info.status.level).toBe("ok");
  });

  it("turns red when a (fake) service is down", async () => {
    const t = setup({ probes: fakeProbes(new Set(["postiz-backend"])) });
    t.db.prepare("INSERT INTO queue_worker (id, owner, beat_at) VALUES (1, 'w', ?)").run(NOW.toISOString());
    const info = await t.page();
    expect(level(info, "postiz-backend")).toBe("down");
    expect(info.status.level).toBe("down");
  });

  it("turns red when a (fake) key fails its test, and the test is logged", async () => {
    const t = setup();
    t.db.prepare("INSERT INTO queue_worker (id, owner, beat_at) VALUES (1, 'w', ?)").run(NOW.toISOString());
    expect((await t.page()).status.level).toBe("ok");
    const info = (await request(t.app).post("/api/ops/keys/test").set(WHO).expect(200)).body as OpsInfo;
    expect(info.status.keys[0]).toMatchObject({ id: "key:openai", level: "down", detail: "OpenAI says: invalid key." });
    expect(info.status.level).toBe("down");
    expect(info.activity[0]).toMatchObject({ who: "boss@example.com", action: "Tested keys" });
  });

  it("shows a worker that has not checked in as down, and low disk as red", async () => {
    const t = setup({ resources: { diskFreeBytes: 1 * GB, diskTotalBytes: 150 * GB, memAvailableBytes: 4 * GB, memTotalBytes: 8 * GB } });
    const info = await t.page();
    expect(level(info, "worker")).toBe("down");
    expect(level(info, "disk")).toBe("down");
    expect(info.status.level).toBe("down");
  });

  it("a probe that throws reads as down, not as a broken page", async () => {
    const t = setup({ probes: [{ id: "postiz", label: "Postiz", check: () => Promise.reject(new Error("Not reachable (ECONNREFUSED)")) }] });
    expect(level(await t.page(), "postiz")).toBe("down");
  });

  it("headroom levels", () => {
    expect(diskLevel(80 * GB, 150 * GB)).toBe("ok");
    expect(diskLevel(10 * GB, 150 * GB)).toBe("warn");
    expect(diskLevel(1.5 * GB, 150 * GB)).toBe("down");
    expect(memoryLevel(4 * GB, 8 * GB)).toBe("ok");
    expect(memoryLevel(1.2 * GB, 8 * GB)).toBe("warn");
    expect(memoryLevel(0.5 * GB, 8 * GB)).toBe("down");
  });

  it("remembers the last rollback after the next deploy went live", async () => {
    const t = setup();
    const file = join(dir, "deploy-status.json");
    const ops = new Operations({ ...(t.operations as unknown as { deps: ConstructorParameters<typeof Operations>[0] }).deps, deployStatusFile: file });
    const write = (sha: string, result: string, at: string) =>
      writeFileSync(file, JSON.stringify({ sha, at, result, reason: result === "live" ? "" : "It did not start.", keys: [], check: { ok: true, problems: [] }, postiz: { state: "healthy", detail: "" } }));
    write("abc1234", "rolled back", "2026-11-14T10:00:00.000Z");
    expect((await ops.info()).status.deploy).toMatchObject({ sha: "abc1234", result: "rolled back", lastRollback: { sha: "abc1234" } });
    write("def5678", "live", "2026-11-14T11:00:00.000Z");
    expect((await ops.info()).status.deploy).toMatchObject({ sha: "def5678", result: "live", lastRollback: { sha: "abc1234", reason: "It did not start." } });
  });
});

describe("pipeline controls", () => {
  it("retries a failed job, logged with who and when", async () => {
    const t = setup();
    const vod = t.vods.create(t.source.id, "https://www.twitch.tv/videos/1");
    const job = t.queue.enqueue("ingest", { vodId: vod.id }, { vodId: vod.id });
    t.db.prepare("UPDATE jobs SET status = 'failed', error = 'yt-dlp: 403' WHERE id = ?").run(job.id);
    expect((await t.page()).jobs[0]).toMatchObject({ id: job.id, step: "Transcript", status: "failed", error: "yt-dlp: 403", canRetry: true });
    const info = (await request(t.app).post(`/api/ops/jobs/${job.id}/retry`).set(WHO).expect(200)).body as OpsInfo;
    expect(info.jobs[0]).toMatchObject({ id: job.id, status: "queued" });
    expect(info.activity[0]).toMatchObject({ who: "boss@example.com", action: "Retried job", target: `Transcript #${job.id}`, at: NOW.toISOString() });
  });

  it("will not retry a job whose creator no longer has an active permission record", async () => {
    const t = setup();
    const vod = t.vods.create(t.source.id, "https://www.twitch.tv/videos/1");
    const job = t.queue.enqueue("ingest", { vodId: vod.id }, { vodId: vod.id });
    t.db.prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").run(job.id);
    t.expirePermission();
    const res = await request(t.app).post(`/api/ops/jobs/${job.id}/retry`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/expired/);
    expect(t.queue.get(job.id).status).toBe("failed");
  });

  it("cancel asks for confirmation first", async () => {
    const t = setup();
    const job = t.queue.enqueue("ingest", {});
    expect((await request(t.app).post(`/api/ops/jobs/${job.id}/cancel`).send({}).expect(400)).body.error).toMatch(/Confirm first/);
    expect(t.queue.get(job.id).status).toBe("queued");
    await request(t.app).post(`/api/ops/jobs/${job.id}/cancel`).send({ confirm: true }).expect(200);
    expect(t.queue.get(job.id).status).toBe("cancelled");
  });

  it("move to top puts a waiting job first in line, and it runs first", async () => {
    const t = setup();
    const a = t.queue.enqueue("ingest", {});
    const b = t.queue.enqueue("render", {});
    let info = await t.page();
    expect(info.jobs.map((j) => [j.id, j.canMoveTop])).toEqual([
      [a.id, false],
      [b.id, true],
    ]);
    info = (await request(t.app).post(`/api/ops/jobs/${b.id}/top`).expect(200)).body as OpsInfo;
    expect(info.jobs.map((j) => j.id)).toEqual([b.id, a.id]);
    t.queue.start();
    await t.queue.idle();
    t.queue.stop();
    expect(t.ran).toEqual([b.id, a.id]);
  });

  it("a paused worker starts nothing new until it is resumed", async () => {
    const t = setup();
    await request(t.app).post("/api/ops/worker").send({ paused: true }).expect(200);
    const job = t.queue.enqueue("ingest", {});
    t.queue.start();
    await t.queue.idle();
    expect(t.ran).toEqual([]);
    expect(t.queue.get(job.id).status).toBe("queued");
    const info = (await request(t.app).post("/api/ops/worker").send({ paused: false }).expect(200)).body as OpsInfo;
    await t.queue.idle();
    t.queue.stop();
    expect(t.ran).toEqual([job.id]);
    expect(info.activity.map((a) => a.action)).toEqual(["Resumed the worker", "Paused the worker"]);
  });
});

describe("publishing controls", () => {
  async function failedPost(t: ReturnType<typeof setup>) {
    const res = await request(t.app).post(`/api/clips/${t.makeClip().id}/posts`).send({ accountIds: ["tt-main"] }).expect(201);
    const id = res.body.posts[0].id as number;
    t.posts.settle(id, { status: "failed", error: "TikTok refused the upload" });
    return id;
  }

  it("lists failed posts per account, and Retry sends the clip again", async () => {
    const t = setup();
    const id = await failedPost(t);
    let info = await t.page();
    expect(info.publishing.accounts).toEqual([expect.objectContaining({ accountId: "tt-main", failed: [expect.objectContaining({ id, error: "TikTok refused the upload" })], scheduled: [] })]);
    info = (await request(t.app).post(`/api/ops/posts/${id}/retry`).set(WHO).expect(200)).body as OpsInfo;
    expect(info.publishing.accounts).toEqual([]);
    expect(t.posts.list().find((p) => p.id !== id)).toMatchObject({ accountId: "tt-main", status: "posted" });
    expect(info.activity[0]).toMatchObject({ action: "Retried post", who: "boss@example.com" });
  });

  it("Retry still needs a permission record: an expired one posts nothing", async () => {
    const t = setup();
    const id = await failedPost(t);
    t.expirePermission();
    const before = t.service.calls.filter((c) => c === "publish").length;
    expect((await request(t.app).post(`/api/ops/posts/${id}/retry`)).status).toBe(403);
    expect(t.service.calls.filter((c) => c === "publish").length).toBe(before);
  });

  it("Skip asks for confirmation, then takes the post off the list for good", async () => {
    const t = setup();
    const id = await failedPost(t);
    await request(t.app).post(`/api/ops/posts/${id}/skip`).send({}).expect(400);
    const info = (await request(t.app).post(`/api/ops/posts/${id}/skip`).send({ confirm: true }).expect(200)).body as OpsInfo;
    expect(info.publishing.accounts).toEqual([]);
    expect(t.posts.get(id).error).toBe("Skipped in Operations by manager.");
  });

  it("Reschedule and Skip a post that waits in clipfarm; a skipped one never goes out", async () => {
    const t = setup();
    const when = new Date("2026-11-15T09:00:00.000Z");
    const res = await request(t.app).post(`/api/clips/${t.makeClip().id}/posts`).send({ accountIds: ["tt-main"], when: when.toISOString() }).expect(201);
    const id = res.body.posts[0].id as number;
    let info = await t.page();
    expect(info.publishing.accounts[0]!.scheduled).toEqual([expect.objectContaining({ id, movable: true })]);
    info = (await request(t.app).post(`/api/ops/posts/${id}/reschedule`).send({ at: "2026-11-16T10:00:00.000Z" }).expect(200)).body as OpsInfo;
    expect(new Date(info.publishing.accounts[0]!.scheduled[0]!.scheduledAt).getTime()).toBeGreaterThanOrEqual(new Date("2026-11-16T10:00:00.000Z").getTime());
    await request(t.app).post(`/api/ops/posts/${id}/skip`).send({ confirm: true }).expect(200);
    t.setNow(new Date("2026-11-17T00:00:00.000Z"));
    const before = t.service.calls.filter((c) => c === "publish").length;
    expect(await t.publisher.sendDueHeld()).toBe(0);
    expect(t.service.calls.filter((c) => c === "publish").length).toBe(before);
  });

  it("Pause all publishing asks for confirmation; while on, autopilot and held posts do not fire", async () => {
    const t = setup();
    await request(t.app).post("/api/ops/publishing").send({ paused: true }).expect(400);
    const info = (await request(t.app).post("/api/ops/publishing").send({ paused: true, confirm: true }).expect(200)).body as OpsInfo;
    expect(info.publishing.paused).toBe(true);
    const paused = () => t.state.isOn("publishing_paused");

    // Autopilot: a rule that would post stays, but its tick does nothing.
    const autopilot = new Autopilot({ repo: new AutopilotRepo(t.db, () => NOW), publisher: t.publisher, clips: t.clips, sources: t.sources, paused, now: () => NOW });
    await t.publisher.syncAccounts();
    await autopilot.create({ name: "All TikTok", enabled: true, dryRun: false, accountIds: ["tt-main"], minScore: 0, creatorIds: [], maxPerDay: 5 });
    t.makeClip("Fresh one");
    await autopilot.tick();
    expect(t.service.calls).not.toContain("publish");
    expect(autopilot.info().rules).toHaveLength(1);

    // A held post whose time has come waits too.
    const res = await request(t.app).post(`/api/clips/${t.makeClip().id}/posts`).send({ accountIds: ["yt-main"], when: "2026-11-14T13:00:00.000Z" }).expect(201);
    t.setNow(new Date("2026-11-14T14:00:00.000Z"));
    const watch = new SubmitWatch({ posts: t.posts, publisher: t.publisher, notifier: new FakeNotifier(), paused, now: () => new Date("2026-11-14T14:00:00.000Z") });
    await watch.tick();
    expect(t.posts.get(res.body.posts[0].id).status).toBe("scheduled");
    expect(t.service.calls).not.toContain("publish");

    await request(t.app).post("/api/ops/publishing").send({ paused: false }).expect(200);
    await watch.tick();
    expect(t.posts.get(res.body.posts[0].id).status).toBe("posted");
  });
});

describe("campaigns", () => {
  function livePost(t: ReturnType<typeof setup>, minutesAgo: number) {
    const clip = t.makeClip();
    const at = new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
    return t.posts.insert({
      clipId: clip.id,
      permissionId: t.source.permissions[0]!.id,
      platform: "tiktok",
      accountId: "tt-main",
      accountName: "gtavimoments",
      service: "fake",
      externalId: "x1",
      status: "posted",
      url: "https://tiktok.com/@a/video/1",
      error: null,
      caption: "",
      scheduledAt: at,
      postedAt: at,
      needsSubmit: true,
    });
  }

  it("shows the open submit window and Submit now marks it sent", async () => {
    const t = setup();
    const post = livePost(t, 5);
    let info = await t.page();
    expect(info.campaigns).toEqual([expect.objectContaining({ creatorName: "Test Streamer", windowMin: 30, missed: 0, open: [expect.objectContaining({ postId: post.id })] })]);
    info = (await request(t.app).post(`/api/ops/posts/${post.id}/submit`).set(WHO).expect(200)).body as OpsInfo;
    expect(info.campaigns[0]!.open).toEqual([]);
    expect(info.campaigns[0]!.payout.submitted).toBe(1);
    expect(info.activity[0]).toMatchObject({ action: "Submitted to campaign", who: "boss@example.com" });
  });

  it("Submit now is refused without an active permission record", async () => {
    const t = setup();
    const post = livePost(t, 5);
    t.expirePermission();
    expect((await request(t.app).post(`/api/ops/posts/${post.id}/submit`)).status).toBe(403);
    expect(t.posts.get(post.id).whopSubmittedAt).toBeNull();
  });

  it("counts missed windows and refuses to submit them", async () => {
    const t = setup();
    const post = livePost(t, 45);
    t.posts.markSubmit(post.id, "missed");
    expect((await t.page()).campaigns[0]).toMatchObject({ missed: 1, open: [] });
    expect((await request(t.app).post(`/api/ops/posts/${post.id}/submit`).expect(400)).body.error).toMatch(/window has passed/);
  });
});

describe("sources", () => {
  it("Check now checks that creator; Pause keeps them out of the regular checks", async () => {
    const t = setup();
    const c = t.watchRepo.create({ name: "Test Streamer", channels: [{ platform: "twitch", handle: "teststreamer" }], language: "en", games: ["GTA VI"], program: "none", programUrl: null, note: "", sourceId: null });
    expect((await t.page()).sources).toEqual([expect.objectContaining({ id: c.id, paused: false, permissionState: "active" })]);
    await request(t.app).post(`/api/ops/sources/${c.id}/check`).expect(200);
    expect(t.checked).toEqual([c.id]);
    const info = (await request(t.app).post(`/api/ops/sources/${c.id}/pause`).send({ paused: true }).expect(200)).body as OpsInfo;
    expect(info.sources[0]!.paused).toBe(true);
    expect(info.activity.map((a) => a.action)).toEqual(["Paused source", "Checked source"]);
  });
});
