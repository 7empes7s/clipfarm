import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LiveNow, WatchPlatform } from "../../shared/types.js";
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
import { parseWatchedCreator, WatchlistRepo } from "../sources/watchlist/repo.js";
import { VodsRepo } from "../vods/repo.js";
import { FakeLiveCapturer } from "./capturer.js";
import { LIVE_SEGMENT_JOB, liveOnFinished } from "./job.js";
import { LiveManager } from "./manager.js";
import { FakeNotifier } from "./notify.js";
import { LEAK_REASON, SKIP_REASON } from "./plan.js";
import { LiveRepo } from "./repo.js";

const LAUNCH = "2026-11-19T05:00:00.000Z";
const BEFORE = new Date("2026-11-18T20:00:00Z");
const AFTER = new Date("2026-11-19T05:00:00Z");

let tmpRoot: string;
beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "clipfarm-live-test-"));
});
afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

function setup(opts: { maxSegments?: number; maxBacklog?: number; maxStreams?: number } = {}) {
  let now = BEFORE;
  const clock = () => now;
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db, clock);
  const vods = new VodsRepo(db, clock);
  const picks = new PicksRepo(db, clock);
  const watchlist = new WatchlistRepo(db, sources, clock);
  const repo = new LiveRepo(db, LAUNCH);
  const notifier = new FakeNotifier();
  // Never started: these tests look at what is recorded and queued, not at the heavy work.
  const queue = new JobQueue(db, {
    handlers: { [LIVE_SEGMENT_JOB]: async () => {}, ingest: async () => {} },
    onFinished: liveOnFinished({ repo, picks, sources, notifier }),
  });
  queue.stop();
  // 2 s segments of generated test video: tiny, and no network.
  const capturer = new FakeLiveCapturer({ maxSegments: opts.maxSegments, size: "160x90" });
  const system = { disk: 38e9, mem: 3.8e9 };
  const mediaDir = join(tmpRoot, "media");
  const manager = new LiveManager({
    repo,
    watchlist,
    sources,
    vods,
    queue,
    capturer,
    system: { freeDiskBytes: async () => system.disk, memAvailableBytes: async () => system.mem },
    notifier,
    mediaDir,
    segmentSec: 1,
    overlapSec: 1,
    maxBacklog: opts.maxBacklog,
    maxStreams: opts.maxStreams,
    now: clock,
  });
  const look = async () => {
    await manager.sync();
    await manager.settled();
  };
  /** Adds a creator to the watchlist; `live` puts them on stream, `allowed` gives them a permission record. */
  const watch = (name: string, o: { live?: Partial<LiveNow> | false; allowed?: boolean; platform?: WatchPlatform; games?: string[] } = {}) => {
    const platform = o.platform ?? "twitch";
    if (o.allowed !== false) sources.create({ ...campaignInput(), creatorName: name });
    const creator = watchlist.create(parseWatchedCreator({ name, channels: [{ platform, handle: name.toLowerCase() }], games: o.games }));
    if (o.live !== false) {
      watchlist.setLive(creator.id, {
        platform,
        title: "day one",
        game: "Grand Theft Auto VI",
        startedAt: null,
        url: `https://example.com/${name.toLowerCase()}`,
        ...o.live,
      });
    }
    return creator.id;
  };
  const status = (id: number) => manager.info().creators.find((c) => c.creatorId === id);
  return { db, sources, vods, picks, watchlist, repo, notifier, queue, capturer, system, mediaDir, manager, look, watch, status, at: (d: Date) => (now = d) };
}

describe("launch control", () => {
  it("refuses a GTA VI stream before launch time with the leak reason, then arms itself at the time", async () => {
    const t = setup();
    const kai = t.watch("Kai");
    await t.look();
    expect(t.capturer.calls).toEqual([]);
    expect(t.repo.activeCaptures()).toEqual([]);
    expect(t.status(kai)).toMatchObject({ recording: false, reason: LEAK_REASON });
    expect(t.manager.info()).toMatchObject({ armed: false, beforeLaunch: true, launchAt: LAUNCH });

    // Arm does not get around the leak rule.
    await t.manager.arm(true);
    await t.manager.settled();
    expect(t.capturer.calls).toEqual([]);
    expect(t.status(kai)).toMatchObject({ recording: false, reason: LEAK_REASON });
    await t.manager.arm(false);

    t.at(AFTER);
    await t.look();
    expect(t.manager.info()).toMatchObject({ armed: true, beforeLaunch: false });
    expect(t.status(kai)).toMatchObject({ recording: true, reason: null, segments: 1 });
    expect(t.capturer.calls).toEqual([{ target: { platform: "twitch", handle: "kai", url: "https://example.com/kai" }, durationSec: 2 }]);
    // The recorded segment waits for the one heavy job, ahead of VOD work.
    expect(t.queue.queued(LIVE_SEGMENT_JOB)).toMatchObject([{ priority: 1500 }]);
    expect(t.notifier.sent.map((n) => n.title)).toEqual(["Live mode started: Kai"]);
  });

  it("records another game before launch time once armed by hand", async () => {
    const t = setup();
    const id = t.watch("Fort", { games: ["Fortnite"], live: { title: "ranked", game: "Fortnite" } });
    await t.look();
    expect(t.status(id)).toMatchObject({ recording: false, reason: "Live mode is off until launch time" });
    await t.manager.arm(true);
    await t.manager.settled();
    expect(t.status(id)).toMatchObject({ recording: true });
  });

  it("never records a creator without an active permission record", async () => {
    const t = setup();
    t.at(AFTER);
    const none = t.watch("Speed", { allowed: false });
    const expired = t.watch("Old", { allowed: false });
    t.sources.create({ ...campaignInput({ expiresAt: "2026-11-01T00:00:00Z" }), creatorName: "Old" });
    await t.look();
    expect(t.capturer.calls).toEqual([]);
    expect(t.vods.list()).toEqual([]);
    // No permission record at all: left off the card, counted instead.
    expect(t.status(none)).toBeUndefined();
    expect(t.manager.info().needPermission).toBe(1);
    expect(t.status(expired)).toMatchObject({ recording: false, reason: "Permission expired: renew it in their program" });
  });

  it("stops on Disarm and on the creator's own switch, and Arm starts again", async () => {
    const t = setup();
    t.at(AFTER);
    const kai = t.watch("Kai");
    const adin = t.watch("Adin");
    await t.look();
    expect(t.repo.activeCaptures().map((c) => c.creatorId)).toEqual([kai, adin]);

    await t.manager.setCreator(adin, false);
    await t.manager.settled();
    expect(t.status(adin)).toMatchObject({ on: false, recording: false, reason: "Switched off for this creator" });
    expect(t.status(kai)).toMatchObject({ recording: true });

    await t.manager.arm(false);
    await t.manager.settled();
    expect(t.repo.activeCaptures()).toEqual([]);
    expect(t.status(kai)).toMatchObject({ recording: false, reason: "Live mode is disarmed" });

    await t.manager.arm(true);
    await t.manager.settled();
    expect(t.repo.activeCaptures().map((c) => c.creatorId)).toEqual([kai]);
  });
});

describe("memory and disk guard", () => {
  it("refuses to start a recording with too little disk or memory, and says why", async () => {
    const t = setup();
    t.at(AFTER);
    const kai = t.watch("Kai");
    t.system.disk = 8.2e9;
    await t.look();
    expect(t.capturer.calls).toEqual([]);
    expect(t.vods.list()).toEqual([]);
    const disk = "Not recording: only 8.2 GB of disk is free, and live mode needs 10.0 GB.";
    expect(t.status(kai)).toMatchObject({ recording: false, reason: disk });
    expect(t.manager.info().guard).toBe(disk);

    t.system.disk = 38e9;
    t.system.mem = 0.7e9;
    await t.look();
    expect(t.capturer.calls).toEqual([]);
    expect(t.status(kai)?.reason).toBe("Not recording: only 0.7 GB of memory is free, and live mode needs 1.0 GB.");

    t.system.mem = 3.8e9;
    await t.look();
    expect(t.status(kai)).toMatchObject({ recording: true });
    expect(t.manager.info().guard).toBeNull();
  });
});

describe("rolling and falling behind", () => {
  it("records only so many streams at once, the biggest creators first", async () => {
    const t = setup({ maxStreams: 2 });
    t.at(AFTER);
    const ids = ["Big", "Middle", "Small"].map((name) => t.watch(name));
    await t.look();
    expect(t.repo.activeCaptures().map((c) => c.creatorId)).toEqual(ids.slice(0, 2));
    expect(t.status(ids[2]!)).toMatchObject({ recording: false, reason: "Waiting: 2 streams are being recorded, the most this server takes at once" });
    // A place opens: the next creator is recorded.
    await t.manager.setCreator(ids[0]!, false);
    await t.manager.settled();
    expect(t.repo.activeCaptures().map((c) => c.creatorId)).toEqual(ids.slice(1));
  });

  it("rolls a new segment every step, the biggest creator's work first in the queue", async () => {
    const t = setup({ maxBacklog: 10 });
    t.at(AFTER);
    t.watch("Big");
    t.watch("Small");
    await t.look();
    // Not yet a step later: nothing new.
    t.at(new Date(AFTER.getTime() + 500));
    t.manager.roll();
    await t.manager.settled();
    expect(t.capturer.calls).toHaveLength(2);
    t.at(new Date(AFTER.getTime() + 1000));
    t.manager.roll();
    await t.manager.settled();
    const [big, small] = t.repo.activeCaptures();
    expect(t.repo.segments(big!.id).map((s) => [s.idx, s.startSec, s.status])).toEqual([[0, 0, "queued"], [1, 1, "queued"]]);
    expect(t.repo.segments(small!.id)).toHaveLength(2);
    // Whichever recording finished first, the bigger creator's segments carry the higher priority.
    expect(t.queue.queued(LIVE_SEGMENT_JOB).map((j) => [j.vodId === big!.vodId ? "big" : "small", j.priority]).sort()).toEqual([
      ["big", 1500],
      ["big", 1500],
      ["small", 1499],
      ["small", 1499],
    ]);
  });

  it("skips the oldest waiting segment instead of piling up, and says so in the job list", async () => {
    const t = setup({ maxBacklog: 2 });
    t.at(AFTER);
    t.watch("Kai");
    await t.look();
    for (const ms of [1000, 2000]) {
      t.at(new Date(AFTER.getTime() + ms));
      t.manager.roll();
      await t.manager.settled();
    }
    const [capture] = t.repo.activeCaptures();
    expect(t.repo.segments(capture!.id).map((s) => [s.idx, s.status, s.note])).toEqual([
      [0, "skipped", SKIP_REASON],
      [1, "queued", null],
      [2, "queued", null],
    ]);
    const jobs = t.queue.list().reverse();
    expect(jobs.map((j) => [j.status, j.error])).toEqual([["cancelled", SKIP_REASON], ["queued", null], ["queued", null]]);
    expect(t.status(capture!.creatorId)).toMatchObject({ segments: 3, skipped: 1 });
  });

  it("ends the recording when the stream ends, leaves no empty stream behind, and waits before trying again", async () => {
    const t = setup({ maxSegments: 1 });
    t.at(AFTER);
    const kai = t.watch("Kai");
    await t.look();
    t.at(new Date(AFTER.getTime() + 1000));
    t.manager.roll();
    await t.manager.settled();
    expect(t.repo.activeCaptures()).toEqual([]);
    expect(t.status(kai)).toMatchObject({ recording: false, reason: "The stream could not be recorded (The stream has ended.)", segments: 1 });
    expect(t.vods.list()).toHaveLength(1);

    // Still shown as live: no new recording (and no empty stream in the lists) while it waits.
    await t.look();
    expect(t.vods.list()).toHaveLength(1);
    expect(t.status(kai)?.reason).toBe("The stream could not be recorded (The stream has ended.) Trying again soon.");
    // After the wait it tries, fails at once, and tidies up after itself.
    t.at(new Date(AFTER.getTime() + 6 * 60_000));
    await t.look();
    expect(t.vods.list()).toHaveLength(1);
    expect(t.repo.lastCapture(kai)).toMatchObject({ status: "ended" });
    expect(existsSync(join(t.mediaDir, "live", "capture-2"))).toBe(false);
    expect(t.notifier.sent).toHaveLength(1);
  });

  it("closes what a restart cut off", async () => {
    const t = setup();
    t.at(AFTER);
    const kai = t.watch("Kai");
    await t.look();
    const [capture] = t.repo.activeCaptures();
    t.repo.addSegment(capture!.id, 1, AFTER);
    await t.manager.start(60_000, 60_000);
    await t.manager.settled();
    t.manager.stop();
    expect(t.repo.segments(capture!.id).map((s) => s.status)).toEqual(["queued", "failed"]);
    expect(t.repo.capture(capture!.id)).toMatchObject({ status: "ended", endReason: "The server restarted." });
    // Still live: a new recording picked up, without a second notification.
    expect(t.repo.lastCapture(kai)).toMatchObject({ status: "recording" });
    expect(t.notifier.sent).toHaveLength(1);
  });
});

describe("live API", () => {
  it("shows the card's state and takes the switches, the launch time and notification sign-ups", async () => {
    const t = setup();
    const kai = t.watch("Kai");
    const clips = new ClipsRepo(t.db);
    const posts = new PostsRepo(t.db);
    const publisher = new Publisher({ sources: t.sources, clips, posts, service: new FakePostingService() });
    const app = createApp({ sources: t.sources, vods: t.vods, picks: t.picks, queue: t.queue, clips, posts, publisher, live: { manager: t.manager, repo: t.repo } });

    const info = await request(app).get("/api/live");
    expect(info.body).toMatchObject({ launchAt: LAUNCH, armed: false, beforeLaunch: true, push: { publicKey: null, subscribers: 0 } });
    expect(info.body.creators).toMatchObject([{ creatorId: kai, name: "Kai", on: true, recording: false, reason: LEAK_REASON }]);

    expect((await request(app).put("/api/live/launch").send({ launchAt: "soon" })).status).toBe(400);
    // The date moved: the launch time is now behind us, so live mode arms itself and records.
    const moved = await request(app).put("/api/live/launch").send({ launchAt: "2026-11-18T19:00:00Z" });
    await t.manager.settled();
    expect(moved.body).toMatchObject({ launchAt: "2026-11-18T19:00:00.000Z", armed: true, beforeLaunch: false });
    expect((await request(app).get("/api/live")).body.creators).toMatchObject([{ recording: true }]);

    expect((await request(app).put(`/api/live/creators/${kai}`).send({ on: false })).body.creators).toMatchObject([{ on: false, recording: false }]);
    expect((await request(app).put("/api/live/creators/999").send({ on: false })).status).toBe(404);
    expect((await request(app).post("/api/live/disarm")).body).toMatchObject({ armed: false });
    expect((await request(app).post("/api/live/arm")).body).toMatchObject({ armed: true });

    expect((await request(app).post("/api/live/push").send({ endpoint: "http://push.example/x", keys: { p256dh: "a", auth: "b" } })).status).toBe(400);
    const sub = { endpoint: "https://push.example/abc", keys: { p256dh: "a", auth: "b" } };
    expect((await request(app).post("/api/live/push").send(sub)).body.push).toEqual({ publicKey: null, subscribers: 1 });
    expect((await request(app).post("/api/live/push").send(sub)).body.push.subscribers).toBe(1);
    expect((await request(app).delete("/api/live/push").send({ endpoint: sub.endpoint })).body.push.subscribers).toBe(0);
  });
});
