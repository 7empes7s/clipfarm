import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WatchPlatform } from "../../shared/types.js";
import { allowanceInput, campaignInput } from "../../test/helpers.js";
import { createApp } from "../app.js";
import { ClipsRepo } from "../clips/repo.js";
import { openDb } from "../db/index.js";
import { JobQueue } from "../jobs/queue.js";
import { FakeLiveCapturer } from "../live/capturer.js";
import { LIVE_SEGMENT_JOB } from "../live/job.js";
import { LiveManager } from "../live/manager.js";
import { FakeNotifier } from "../live/notify.js";
import { LiveRepo } from "../live/repo.js";
import { PicksRepo } from "../picks/repo.js";
import { INGEST_JOB } from "../pipeline/ingest/ingest.js";
import { FakePostingService } from "../publish/fake.js";
import { Publisher } from "../publish/publisher.js";
import { PostsRepo } from "../publish/repo.js";
import { SourcesRepo } from "../sources/repo.js";
import type { ChannelCheck, PlatformClient, RemoteVod } from "../sources/watchlist/platforms/types.js";
import { parseWatchedCreator, WatchlistRepo } from "../sources/watchlist/repo.js";
import { VodsRepo } from "../vods/repo.js";
import {
  dailyDue,
  EMPTY_METRICS,
  engineLabel,
  judgeVod,
  type KeyCheck,
  launchReadiness,
  nextDailyAt,
  parseMemUsedMb,
  proofMaxPicks,
  vodTargets,
} from "./plan.js";
import { ProofRepo } from "./repo.js";
import { ProofRunner } from "./service.js";

const LAUNCH = "2026-11-19T05:00:00.000Z";
const START = new Date("2026-11-13T06:00:00Z").getTime();

describe("the proof's targets (O1: 10 clips per hour of video in under 30 minutes)", () => {
  it("scales with the video, and never asks under 30 minutes or one clip", () => {
    expect(vodTargets(3600)).toEqual({ budgetMin: 30, wantClips: 10 });
    expect(vodTargets(2 * 3600)).toEqual({ budgetMin: 60, wantClips: 20 });
    expect(vodTargets(20)).toEqual({ budgetMin: 30, wantClips: 1 });
    // Enough moments are asked of the picker to meet the target after the rules leave some out.
    expect(proofMaxPicks(3 * 3600, 15)).toBe(39);
    expect(proofMaxPicks(600, 15)).toBe(15);
    expect(proofMaxPicks(null, 15)).toBe(15);
  });

  it("names what a run missed, with the step, in plain words", () => {
    const met = { ...EMPTY_METRICS, vodSec: 3600, allClipsMin: 29, clips: 10 };
    expect(judgeVod(met)).toEqual([]);
    expect(judgeVod({ ...met, allClipsMin: 41 }, { slowestStep: "download and transcript (33 min)" })).toEqual([
      { kind: "slow", text: "Too slow: 41 min for a 1h 0m video; the target is under 30 min. The slowest step was download and transcript (33 min)." },
    ]);
    expect(judgeVod({ ...met, clips: 6 }, { leftOut: 5, failedCuts: 1 })).toEqual([
      { kind: "few", text: "Too few clips: 6 from a 1h 0m video; the target is at least 10. 5 picked moments were left out by the rules, 1 could not be cut." },
    ]);
    expect(judgeVod({ ...met, clips: 6 })[0]!.text).toMatch(/The picking step found too few moments\.$/);
  });

  it("reads the server's memory in use, and says which engine did the work", () => {
    expect(parseMemUsedMb("MemTotal:        8000000 kB\nMemFree: 100 kB\nMemAvailable:    3904000 kB\n")).toBe(4000);
    expect(parseMemUsedMb("nothing")).toBeNull();
    const use = (step: string, label: string) => ({ step, label, count: 2, audioSec: 60, ms: 1000, peakMb: null, note: "" });
    const report = (kind: "stt" | "picks", ...uses: ReturnType<typeof use>[]) => ({ kind, language: "en", uses, fallbacks: [], summary: "" });
    expect(engineLabel([report("stt", use("moonshine", "Moonshine")), report("picks", use("writer", "Qwen"))], false)).toBe("Local (Moonshine, Qwen)");
    expect(engineLabel([report("stt", use("cloud", "Cloud (OpenAI)")), report("picks", use("cloud-picker", "Cloud picker"))], false)).toBe("Cloud (Cloud (OpenAI), Cloud picker)");
    expect(engineLabel([report("stt", use("moonshine", "Moonshine")), report("picks", use("cloud-picker", "Cloud picker"))], false)).toBe("Local and cloud (Moonshine, Cloud picker)");
    expect(engineLabel([], true)).toBe("Stand-in (demo)");
  });

  it("the daily timer is due once a day, from its hour on", () => {
    const at = (h: number, day = 13) => new Date(2026, 10, day, h, 30);
    expect(dailyDue(at(5), null, 6)).toBe(false);
    expect(dailyDue(at(6), null, 6)).toBe(true);
    expect(dailyDue(at(9), at(6).toISOString(), 6)).toBe(false);
    expect(dailyDue(at(7, 14), at(6).toISOString(), 6)).toBe(true);
    expect(nextDailyAt(at(9), at(6).toISOString(), 6)).toEqual(new Date(2026, 10, 14, 6, 0));
    expect(nextDailyAt(at(5), at(6, 12).toISOString(), 6)).toEqual(new Date(2026, 10, 13, 6, 0));
  });
});

describe("Launch ready", () => {
  const good = {
    watchlist: [{ permissionState: "active" as const }],
    keys: [{ label: "Twitch", ok: true, message: "Working" }],
    proof: [{ status: "passed", label: "TJR", problems: [] }] as never,
    drill: { status: "passed", problems: [], step: "" } as never,
    guard: null,
    push: { possible: true, subscribers: 1 },
  };

  it("is yes only when nothing stands in the way", () => {
    expect(launchReadiness(good)).toEqual({ ready: true, reasons: [] });
  });

  it("turns red when the watchlist is empty or nobody on it has permission", () => {
    expect(launchReadiness({ ...good, watchlist: [] })).toEqual({ ready: false, reasons: ["The launch-day watchlist is empty, so nobody would be recorded."] });
    expect(launchReadiness({ ...good, watchlist: [{ permissionState: "none" }] }).reasons).toEqual([
      "Nobody on the watchlist has a permission record in force, so nobody would be recorded.",
    ]);
  });

  it("turns red when a key fails, and says which", () => {
    const keys = [...good.keys, { label: "OpenAI", ok: false, message: "OpenAI says: Incorrect API key provided: ***." }];
    expect(launchReadiness({ ...good, keys })).toEqual({ ready: false, reasons: ["The OpenAI key fails: OpenAI says: Incorrect API key provided: ***."] });
    expect(launchReadiness({ ...good, keys: null }).ready).toBe(false);
  });

  it("turns red without a finished proof, without a passed drill, when the server is short, and when no phone gets alerts", () => {
    expect(launchReadiness({ ...good, proof: [] }).reasons).toEqual(["No proof has finished yet."]);
    expect(launchReadiness({ ...good, drill: null }).reasons).toEqual(["No live drill has run yet. Run one while an allowed creator is live."]);
    expect(launchReadiness({ ...good, guard: "Not recording: only 2.0 GB of disk is free, and live mode needs 10.0 GB." }).ready).toBe(false);
    expect(launchReadiness({ ...good, push: { possible: true, subscribers: 0 } }).reasons).toEqual(["No phone has notifications turned on, so alerts would reach nobody."]);
  });
});

/** A platform whose channels have the videos and live streams the test gives them. */
class ScriptedPlatform implements PlatformClient {
  readonly missing = null;
  readonly channels = new Map<string, ChannelCheck>();
  constructor(readonly platform: WatchPlatform) {}
  check(handle: string): Promise<ChannelCheck> {
    return Promise.resolve(this.channels.get(handle.toLowerCase()) ?? { vods: [], live: null });
  }
}

const vod = (handle: string, title: string, category: string, durationSec: number, id = title): RemoteVod => ({
  platform: "kick",
  externalId: id,
  url: `https://kick.com/${handle}/videos/${encodeURIComponent(id)}`,
  title,
  category,
  publishedAt: "2026-11-12T20:00:00Z",
  durationSec,
});

let tmpRoot: string;
beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "clipfarm-proof-test-"));
});
afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

/** What the stand-in pipeline does with a video: how long it takes, how many clips it makes, or how it fails. */
interface Script {
  minutes?: number;
  clips?: number;
  badQuality?: number;
  fail?: string;
}

function setup() {
  let nowMs = START;
  const clock = () => new Date(nowMs);
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db, clock);
  const vods = new VodsRepo(db, clock);
  const picks = new PicksRepo(db, clock);
  const clips = new ClipsRepo(db, clock);
  const posts = new PostsRepo(db);
  const watchlist = new WatchlistRepo(db, sources, clock);
  const liveRepo = new LiveRepo(db, LAUNCH);
  const notifier = new FakeNotifier();
  const kick = new ScriptedPlatform("kick");
  const scripts = new Map<string, Script>();
  let keys: KeyCheck[] = [];
  const makeClips = (vodId: number, sourceId: number, n: number, bad = 0, live = false) => {
    for (let i = 0; i < n; i++) {
      clips.create({
        sourceId,
        vodId,
        title: `Moment ${i + 1}`,
        filePath: join(tmpRoot, `clip-${vodId}-${i}.mp4`),
        durationSec: 25,
        score: 90 - i,
        quality: { issues: i < bad ? [{ code: "silence", reason: "No sound for 4 s" }] : [], fix: null },
        // A LIVE clip lands four minutes after its moment.
        live: live ? { streamSec: 30, momentAt: new Date(clock().getTime() - 240_000).toISOString() } : null,
      });
    }
  };
  const queue: JobQueue = new JobQueue(db, {
    now: clock,
    pollMs: 5,
    tmpRoot,
    handlers: {
      [INGEST_JOB]: async ({ payload }) => {
        const { vodId } = payload as { vodId: number };
        const v = vods.get(vodId);
        const script = scripts.get(v.url) ?? {};
        const remote = [...kick.channels.values()].flatMap((c) => c.vods).find((r) => r.url === v.url);
        vods.saveMeta(vodId, { title: remote?.title ?? "", durationSec: remote?.durationSec ?? null, chapters: [] });
        nowMs += (script.minutes ?? 10) * 60_000;
        if (script.fail) throw new Error(script.fail);
        makeClips(vodId, v.sourceId, script.clips ?? 10, script.badQuality);
      },
      [LIVE_SEGMENT_JOB]: async ({ payload }) => {
        const seg = liveRepo.segment((payload as { segmentId: number }).segmentId);
        const capture = liveRepo.capture(seg.captureId);
        liveRepo.setSegmentStatus(seg.id, "done", "1 clip");
        makeClips(capture.vodId, capture.sourceId, 1, 0, true);
      },
    },
  });
  const system = { disk: 38e9, mem: 3.8e9 };
  const live = new LiveManager({
    repo: liveRepo,
    watchlist,
    sources,
    vods,
    queue,
    // A stream of one short segment of generated test video, cut short as when a stream ends: the drill ends with it.
    capturer: new FakeLiveCapturer({ maxSegments: 1, lastSegmentSec: 1, size: "160x90" }),
    system: { freeDiskBytes: async () => system.disk, memAvailableBytes: async () => system.mem },
    notifier,
    mediaDir: join(tmpRoot, "media"),
    segmentSec: 2,
    overlapSec: 1,
    now: clock,
  });
  const repo = new ProofRepo(db);
  let memMb = 4000;
  const runner = new ProofRunner({
    repo,
    sources,
    vods,
    picks,
    clips,
    queue,
    watchlist,
    live,
    liveRepo,
    clients: [kick],
    notifier,
    testKeys: async () => keys,
    engineReports: () => [],
    campaignChannel: "https://kick.com/tjr",
    maxPicks: 15,
    maxVodHours: 4,
    dailyHour: null,
    computeUsdPerHour: 0.6,
    demo: true,
    // Climbs while the run is on, so the peak is not the first reading.
    memUsedMb: () => (memMb += 100),
    pollMs: 5,
    now: clock,
  });
  queue.start();
  const tjr = sources.create({ ...campaignInput(), creatorName: "TJR", channelUrls: ["https://kick.com/tjr"] });
  const open = sources.create(allowanceInput());
  return {
    db,
    sources,
    clips,
    queue,
    watchlist,
    liveRepo,
    live,
    notifier,
    kick,
    scripts,
    repo,
    runner,
    tjr,
    open,
    system,
    setKeys: (k: KeyCheck[]) => (keys = k),
    advance: (ms: number) => (nowMs += ms),
    async close() {
      runner.stop();
      live.stop();
      queue.stop();
      await runner.work();
      await live.settled();
      await queue.idle();
      db.close();
    },
  };
}

describe("a proof run", () => {
  it("runs the campaign channel's latest video and a GTA V video, and records every metric against O1", async () => {
    const s = setup();
    const tjrVod = vod("tjr", "TJR goes off", "Slots", 3600);
    const gtaVod = vod("openstreamer", "NoPixel heist night", "Grand Theft Auto V", 7200);
    s.kick.channels.set("tjr", { vods: [tjrVod, vod("tjr", "Older stream", "Slots", 3000)], live: null });
    // Not the GTA VI video (before launch that is a leak), not the chat stream: the GTA V one.
    s.kick.channels.set("openstreamer", { vods: [vod("openstreamer", "GTA VI early copy", "Grand Theft Auto VI", 3600), vod("openstreamer", "Just chatting", "Just Chatting", 3600), gtaVod], live: null });
    s.scripts.set(tjrVod.url, { minutes: 21, clips: 12, badQuality: 3 });
    s.scripts.set(gtaVod.url, { minutes: 50, clips: 22 });

    const asked = s.runner.request("ops");
    expect(asked.map((r) => [r.kind, r.target, r.status])).toEqual([
      ["vod", "campaign", "waiting"],
      ["vod", "gta", "waiting"],
    ]);
    // One proof at a time.
    expect(() => s.runner.request("app")).toThrow("A proof is already running");
    await s.runner.work();

    const info = s.runner.info();
    expect(info.busy).toBe(false);
    const [campaign, gta] = info.runs;
    expect(campaign).toMatchObject({ status: "passed", label: "TJR: TJR goes off", url: tjrVod.url, askedBy: "ops", problems: [], approved: 0, rejected: 0 });
    expect(campaign!.metrics).toEqual({
      ...EMPTY_METRICS,
      vodSec: 3600,
      firstClipMin: 21,
      allClipsMin: 21,
      clips: 12,
      qualityChecked: 12,
      qualityPassed: 9,
      engine: "Stand-in (demo)",
      // 21 minutes of the server at $0.60 an hour.
      costUsd: 0.21,
      ramPeakMb: campaign!.metrics.ramPeakMb,
    });
    expect(campaign!.metrics.ramPeakMb).toBeGreaterThan(4100);
    expect(campaign!.clipIds).toHaveLength(12);
    expect(Object.fromEntries(campaign!.checks.map((c) => [c.label, [c.value, c.target, c.ok]]))).toMatchObject({
      "Video length": ["1h 0m", "", null],
      Clips: ["12", "at least 10", true],
      "Time to all clips": ["21 min", "under 30 min", true],
      "Quality check": ["9 of 12 passed", "", false],
      "Approved by you": ["No swipes yet", "half", null],
      Engine: ["Stand-in (demo)", "", null],
      Cost: ["$0.21", "", null],
    });
    expect(gta).toMatchObject({ status: "passed", label: "Open Streamer: NoPixel heist night", url: gtaVod.url });
    expect(gta!.metrics).toMatchObject({ vodSec: 7200, allClipsMin: 50, clips: 22 });
    expect(s.notifier.sent).toEqual([]);

    // The clips wait in the Inbox like any other, tagged Proof; nothing was posted.
    const all = s.clips.list();
    expect(all).toHaveLength(34);
    expect(all.every((c) => c.proof && c.status === "pending" && c.postCount === 0)).toBe(true);
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM posts").get()).toEqual({ n: 0 });
    // The approve rate comes from the manager's swipes.
    s.clips.setStatus(campaign!.clipIds[0]!, "approved");
    s.clips.setStatus(campaign!.clipIds[1]!, "rejected");
    s.clips.setStatus(campaign!.clipIds[2]!, "rejected");
    const swiped = s.runner.info().runs[0]!;
    expect([swiped.approved, swiped.rejected]).toEqual([1, 2]);
    expect(swiped.checks.find((c) => c.label === "Approved by you")).toEqual({ label: "Approved by you", value: "1 of 3", target: "half", ok: false });
    // The 7-day trend ends with today.
    expect(s.runner.info().days).toHaveLength(7);
    expect(s.runner.info().days.at(-1)).toMatchObject({ status: "passed", clips: 34, clipsPerHour: 11.3, minPerHour: 23.7, approved: 1, rejected: 2 });
    expect(s.runner.info().days[0]).toMatchObject({ status: "none", clips: 0 });

    // The next day's proof takes the next video it has not clipped yet, and none twice.
    s.scripts.set(vod("tjr", "Older stream", "Slots", 3000).url, { clips: 9 });
    s.runner.request("timer");
    await s.runner.work();
    const [next, none] = s.runner.info().runs;
    expect(next).toMatchObject({ status: "passed", label: "TJR: Older stream" });
    expect(none).toMatchObject({ status: "skipped", step: "No creator with a public clipping allowance has a new GTA V or GTA RP video." });
    await s.close();
  });

  it("pushes an alert with the failing step when a run fails", async () => {
    const s = setup();
    const v = vod("tjr", "TJR goes off", "Slots", 3600);
    s.kick.channels.set("tjr", { vods: [v], live: null });
    s.scripts.set(v.url, { fail: "The download was refused (HTTP 403)." });
    s.runner.request("timer");
    await s.runner.work();

    const [run] = s.runner.info().runs;
    expect(run).toMatchObject({ status: "failed", problems: [{ kind: "failed", text: "The download and transcript step failed: The download was refused (HTTP 403)." }] });
    expect(s.notifier.sent).toEqual([
      { title: "Proof failed: TJR: TJR goes off", body: "The download and transcript step failed: The download was refused (HTTP 403).", url: "/#dashboard" },
    ]);
    await s.close();
  });

  it("pushes an alert when it takes more than 30 minutes per video hour", async () => {
    const s = setup();
    const v = vod("tjr", "TJR goes off", "Slots", 3600);
    s.kick.channels.set("tjr", { vods: [v], live: null });
    s.scripts.set(v.url, { minutes: 41, clips: 12 });
    s.runner.request("timer");
    await s.runner.work();

    expect(s.runner.info().runs[0]).toMatchObject({ status: "failed", metrics: { allClipsMin: 41, clips: 12 } });
    expect(s.notifier.sent).toEqual([
      {
        title: "Proof too slow: TJR: TJR goes off",
        body: "Too slow: 41 min for a 1h 0m video; the target is under 30 min. The slowest step was download and transcript (41 min).",
        url: "/#dashboard",
      },
    ]);
    await s.close();
  });

  it("pushes an alert when it gives fewer than 10 clips per video hour", async () => {
    const s = setup();
    const v = vod("tjr", "TJR goes off", "Slots", 3600);
    s.kick.channels.set("tjr", { vods: [v], live: null });
    s.scripts.set(v.url, { minutes: 12, clips: 6 });
    s.runner.request("timer");
    await s.runner.work();

    expect(s.runner.info().runs[0]).toMatchObject({ status: "failed", metrics: { clips: 6 } });
    expect(s.notifier.sent).toEqual([
      {
        title: "Proof: too few clips: TJR: TJR goes off",
        body: "Too few clips: 6 from a 1h 0m video; the target is at least 10. The picking step found too few moments.",
        url: "/#dashboard",
      },
    ]);
    await s.close();
  });

  it("never runs on a source without a permission record in force, and skips with the reason", async () => {
    const s = setup();
    s.kick.channels.set("tjr", { vods: [vod("tjr", "TJR goes off", "Slots", 3600)], live: null });
    s.db.prepare("UPDATE permissions SET expires_at = '2026-01-01T00:00:00.000Z' WHERE source_id = ?").run(s.tjr.id);
    s.runner.request("timer");
    await s.runner.work();

    const [campaign, gta] = s.runner.info().runs;
    expect(campaign).toMatchObject({ status: "failed", vodId: null });
    expect(campaign!.problems[0]!.text).toMatch(/permission/i);
    expect(gta).toMatchObject({ status: "skipped" });
    expect(s.clips.list()).toEqual([]);
    expect(s.queue.list()).toEqual([]);
    await s.close();
  });

  it("the daily timer starts one proof a day at its hour, and a restart closes a run it cut off", async () => {
    const s = setup();
    const hour = new Date(START).getHours();
    const timed = new ProofRunner({ ...(s.runner as unknown as { deps: ConstructorParameters<typeof ProofRunner>[0] }).deps, dailyHour: hour });
    timed.tick();
    await timed.work();
    timed.tick();
    await timed.work();
    expect(s.repo.list().map((r) => [r.askedBy, r.status])).toEqual([
      ["timer", "skipped"],
      ["timer", "skipped"],
    ]);
    expect(timed.info().nextAt).toBe(new Date(new Date(START).setHours(hour + 24, 0, 0, 0)).toISOString());

    const cut = s.repo.add("vod", "campaign", "app", new Date(START));
    s.repo.claim(cut.id, new Date(START));
    s.runner.recover();
    expect(s.repo.get(cut.id)).toMatchObject({ status: "failed", problems: [{ kind: "failed", text: "The server restarted during the proof." }] });
    await s.close();
  });
});

describe("the launch drill", () => {
  const watch = (s: ReturnType<typeof setup>, name: string, handle: string, sourceId: number | null) =>
    s.watchlist.create({ ...parseWatchedCreator({ name, channels: [{ platform: "kick", handle }], language: "en", games: ["GTA VI"] }), sourceId });

  it("records an allowed creator who is live now and reports the time from moment to LIVE clip, dropped segments and memory", async () => {
    const s = setup();
    watch(s, "Nobody Allowed", "nobody", null);
    watch(s, "Open Streamer", "openstreamer", s.open.id);
    const live = { platform: "kick" as const, title: "GTA RP all night", game: "Grand Theft Auto V", startedAt: new Date(START - 3600_000).toISOString(), url: "https://kick.com/openstreamer" };
    // Live with a game that is not on their list, and live mode is not armed: a drill records anyway.
    s.kick.channels.set("openstreamer", { vods: [], live });
    s.kick.channels.set("nobody", { vods: [], live: { ...live, url: "https://kick.com/nobody" } });

    s.runner.requestDrill("ops", { minutes: 15 });
    await s.runner.work();

    const drill = s.runner.info().drill!;
    expect(drill).toMatchObject({ kind: "drill", status: "passed", label: "Open Streamer: GTA RP all night", problems: [] });
    // The stand-in LIVE clip lands four minutes after its moment.
    expect(drill.metrics).toMatchObject({ clips: 1, segments: 1, dropped: 0, firstLatencySec: 240, worstLatencySec: 240 });
    expect(drill.metrics.ramPeakMb).toBeGreaterThan(4000);
    expect(drill.checks.find((c) => c.label === "Moment to LIVE clip")).toMatchObject({ target: "under 15 min", ok: true });
    expect(drill.checks.find((c) => c.label === "Segments dropped")).toEqual({ label: "Segments dropped", value: "0 of 1", target: "none", ok: true });
    // The recording is closed and its LIVE clips wait in the Inbox, tagged Proof.
    expect(s.liveRepo.activeCaptures()).toEqual([]);
    expect(s.clips.list().map((c) => [c.proof, c.status, c.live !== null])).toEqual([[true, "pending", true]]);
    await s.close();
  });

  it("is skipped, not failed, when nobody allowed is live", async () => {
    const s = setup();
    watch(s, "Open Streamer", "openstreamer", s.open.id);
    s.runner.requestDrill("ops");
    await s.runner.work();
    expect(s.runner.info().drill).toMatchObject({ status: "skipped", step: "No allowed creator is live right now. Try again when one is." });
    expect(s.notifier.sent).toEqual([]);
    await s.close();
  });

  it("never records a GTA VI stream before launch time or a leak, drill or not", async () => {
    const s = setup();
    watch(s, "Open Streamer", "openstreamer", s.open.id);
    s.kick.channels.set("openstreamer", { vods: [], live: { platform: "kick", title: "GTA 6 early!!", game: "Grand Theft Auto VI", startedAt: null, url: "https://kick.com/openstreamer" } });
    s.runner.requestDrill("ops");
    await s.runner.work();
    const drill = s.runner.info().drill!;
    expect(drill.status).toBe("skipped");
    expect(drill.step).toContain("GTA VI before launch time counts as a leak");
    expect(s.liveRepo.activeCaptures()).toEqual([]);
    expect(s.clips.list()).toEqual([]);
    await s.close();
  });

  it("fails with an alert when a LIVE clip takes longer than 15 minutes", async () => {
    const s = setup();
    watch(s, "Open Streamer", "openstreamer", s.open.id);
    s.kick.channels.set("openstreamer", { vods: [], live: { platform: "kick", title: "GTA RP", game: "Grand Theft Auto V", startedAt: null, url: "https://kick.com/openstreamer" } });
    const create = s.clips.create.bind(s.clips);
    // The clips of this drill land 20 minutes after their moments.
    s.clips.create = (c) => create({ ...c, live: c.live && { ...c.live, momentAt: new Date(new Date(c.live.momentAt).getTime() - 16 * 60_000).toISOString() } });
    s.runner.requestDrill("ops");
    await s.runner.work();
    const drill = s.runner.info().drill!;
    expect(drill.status).toBe("failed");
    expect(drill.problems[0]).toMatchObject({ kind: "slow" });
    expect(s.notifier.sent.map((n) => n.title)).toEqual(["Live mode started: Open Streamer", "Launch drill: Open Streamer: GTA RP"]);
    expect(s.notifier.sent[1]!.body).toMatch(/^Too slow: a LIVE clip reached the Inbox 20 min after its moment; the target is under 15 min\.$/);
    await s.close();
  });
});

describe("Launch ready on the Proof card", () => {
  it("is red with the reasons until the watchlist, the keys, a proof and a drill are all good", async () => {
    const s = setup();
    const app = createApp({
      sources: s.sources,
      vods: new VodsRepo(s.db),
      picks: new PicksRepo(s.db),
      queue: s.queue,
      clips: s.clips,
      posts: new PostsRepo(s.db),
      publisher: new Publisher({ sources: s.sources, clips: s.clips, posts: new PostsRepo(s.db), service: new FakePostingService() }),
      proof: s.runner,
    });
    const before = (await request(app).get("/api/proof").expect(200)).body;
    expect(before).toMatchObject({ busy: false, runs: [], drill: null, nextAt: null });
    expect(before.launch).toEqual({
      ready: false,
      reasons: [
        "The launch-day watchlist is empty, so nobody would be recorded.",
        "The keys have not been tested yet. The next proof tests them.",
        "No proof has finished yet.",
        "No live drill has run yet. Run one while an allowed creator is live.",
      ],
    });

    s.watchlist.create({ ...parseWatchedCreator({ name: "Open Streamer", channels: [{ platform: "kick", handle: "openstreamer" }], language: "en", games: ["GTA VI"] }), sourceId: s.open.id });
    const v = vod("tjr", "TJR goes off", "Slots", 3600);
    s.kick.channels.set("tjr", { vods: [v], live: null });
    s.kick.channels.set("openstreamer", { vods: [], live: { platform: "kick", title: "GTA RP", game: "Grand Theft Auto V", startedAt: null, url: "https://kick.com/openstreamer" } });
    s.setKeys([{ label: "OpenAI", ok: false, message: "OpenAI says: Incorrect API key provided: ***." }]);

    // "Run proof now" on the Dashboard.
    const asked = await request(app).post("/api/proof/run").expect(202);
    expect(asked.body.busy).toBe(true);
    await request(app).post("/api/proof/run").expect(409);
    await s.runner.work();
    await request(app).post("/api/proof/drill").expect(202);
    await s.runner.work();
    const failing = (await request(app).get("/api/proof").expect(200)).body;
    expect(failing.runs.map((r: { status: string }) => r.status)).toEqual(["passed", "skipped"]);
    expect(failing.drill.status).toBe("passed");
    expect(failing.launch).toEqual({ ready: false, reasons: ["The OpenAI key fails: OpenAI says: Incorrect API key provided: ***."] });

    // The key is fixed; the next proof tests it again.
    s.setKeys([{ label: "OpenAI", ok: true, message: "Working" }]);
    s.kick.channels.set("tjr", { vods: [vod("tjr", "Next stream", "Slots", 3600), v], live: null });
    await request(app).post("/api/proof/run").expect(202);
    await s.runner.work();
    expect((await request(app).get("/api/proof")).body.launch).toEqual({ ready: true, reasons: [] });

    // And red again when the watchlist is emptied.
    for (const c of s.watchlist.list()) s.watchlist.remove(c.id);
    expect((await request(app).get("/api/proof")).body.launch).toEqual({ ready: false, reasons: ["The launch-day watchlist is empty, so nobody would be recorded."] });
    await s.close();
  });
});
