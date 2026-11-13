import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIVE_TARGET_LATENCY_SEC } from "../shared/types.js";
import { ClipsRepo } from "../server/clips/repo.js";
import { openDb } from "../server/db/index.js";
import { type JobHandler, JobQueue } from "../server/jobs/queue.js";
import { FakeLiveCapturer } from "../server/live/capturer.js";
import { liveCutter, liveOnFinished, LIVE_SEGMENT_JOB, liveSegmentHandler } from "../server/live/job.js";
import { LiveManager } from "../server/live/manager.js";
import { FakeNotifier } from "../server/live/notify.js";
import { LiveRepo } from "../server/live/repo.js";
import { PicksRepo } from "../server/picks/repo.js";
import { NO_FLAGS, type Picker, type PickInput, type RawPick } from "../server/pipeline/picks/types.js";
import { onRenderFinished, RENDER_JOB, renderHandler } from "../server/pipeline/render/job.js";
import { FakeSectionDownloader } from "../server/pipeline/render/section.js";
import { FakeTranscriber } from "../server/pipeline/transcript/fake.js";
import { SourcesRepo } from "../server/sources/repo.js";
import { parseWatchedCreator, WatchlistRepo } from "../server/sources/watchlist/repo.js";
import { probeVideo } from "../server/tools/ffmpeg.js";
import { VodsRepo } from "../server/vods/repo.js";
import { campaignInput } from "./helpers.js";

let tmpRoot: string;
beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "clipfarm-live-fixture-"));
});
afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

const T0 = new Date("2026-11-19T05:00:00Z");
const pick = (startSec: number, endSec: number, title: string, score: number, flags = NO_FLAGS): RawPick => ({
  startSec,
  endSec,
  title,
  hook: "Wait for it",
  score,
  reason: "Loud",
  layout: "center",
  flags,
});

describe("live mode (real ffmpeg on a generated stream, every outside service faked)", () => {
  it(
    "rolls overlapping segments, cuts a moment across a boundary whole, tags clips LIVE with their latency, runs before VOD work and deletes old segments",
    { timeout: 180_000 },
    async () => {
      let now = T0;
      const clock = () => now;
      const db = openDb(":memory:");
      const sources = new SourcesRepo(db, clock);
      const vods = new VodsRepo(db, clock);
      const picks = new PicksRepo(db, clock);
      const clips = new ClipsRepo(db, clock);
      const watchlist = new WatchlistRepo(db, sources, clock);
      const repo = new LiveRepo(db, T0.toISOString());
      const notifier = new FakeNotifier();
      const mediaDir = join(tmpRoot, "media");
      const jobsDir = join(tmpRoot, "jobs");
      await mkdir(jobsDir);

      // What the picker is asked, and what it answers, per segment. Times count from the start of what it is shown.
      const asked: Pick<PickInput, "durationSec" | "maxPicks">[] = [];
      const answers: RawPick[][] = [
        // Segment 1 of the stream: a moment across the 0:40 boundary, and a leak the gate must drop.
        [pick(26, 52, "Across the boundary", 90), pick(4, 24, "Leaked ending", 95, { ...NO_FLAGS, leak: true })],
        // Segment 2, shown with segment 1 for context: the same moment again, and a new one.
        [pick(26, 52, "Across the boundary, again", 90), pick(75, 100, "Second moment", 80)],
      ];
      const picker: Picker = {
        name: "scripted",
        pick: async (input) => {
          asked.push({ durationSec: input.durationSec, maxPicks: input.maxPicks });
          return { costUsd: 0.03, picks: answers.shift() ?? [] };
        },
      };

      const ran: string[] = [];
      let running = 0;
      let mostAtOnce = 0;
      const tracked = (type: string, handler: JobHandler): JobHandler => async (ctx) => {
        ran.push(type);
        mostAtOnce = Math.max(mostAtOnce, ++running);
        try {
          await handler(ctx);
        } finally {
          running--;
        }
      };
      const renderFailed = onRenderFinished(picks);
      const liveFinished = liveOnFinished({ repo, picks, sources, notifier, now: clock });
      const queue: JobQueue = new JobQueue(db, {
        handlers: {
          vod: tracked("vod", async () => {}),
          [LIVE_SEGMENT_JOB]: tracked(
            LIVE_SEGMENT_JOB,
            liveSegmentHandler({ repo, sources, vods, picks, transcriber: new FakeTranscriber(), picker, queue: () => queue, maxPicks: 3, contextSec: 80 }),
          ),
          [RENDER_JOB]: tracked(
            RENDER_JOB,
            renderHandler({ sources, vods, picks, clips, downloader: new FakeSectionDownloader(), liveCut: liveCutter(repo, "ultrafast"), mediaDir, preset: "ultrafast" }),
          ),
        },
        tmpRoot: jobsDir,
        onFinished: (job, payload) => {
          renderFailed(job, payload);
          liveFinished(job, payload);
        },
      });
      // Held until both segments are recorded, with a VOD job already waiting in front.
      queue.stop();
      queue.enqueue("vod", {});

      // The "live" stream: a generated test pattern, two segments long. A new segment every 40 s, each 30 s longer.
      const capturer = new FakeLiveCapturer({ maxSegments: 2 });
      const manager = new LiveManager({
        repo,
        watchlist,
        sources,
        vods,
        queue,
        capturer,
        system: { freeDiskBytes: async () => 50e9, memAvailableBytes: async () => 4e9 },
        notifier,
        mediaDir,
        segmentSec: 40,
        overlapSec: 30,
        keepHours: 3,
        now: clock,
      });
      const source = sources.create(campaignInput());
      const creator = watchlist.create(parseWatchedCreator({ name: "Test Streamer", channels: [{ platform: "twitch", handle: "teststreamer" }] }));
      // On stream for an hour already when launch time arrives.
      watchlist.setLive(creator.id, {
        platform: "twitch",
        title: "GTA VI day one",
        game: "Grand Theft Auto VI",
        startedAt: new Date(T0.getTime() - 3600_000).toISOString(),
        url: "https://www.twitch.tv/teststreamer",
      });

      // Launch time: live mode arms itself and records the first segment; 40 s later the second.
      await manager.sync();
      await manager.settled();
      now = new Date(T0.getTime() + 40_000);
      manager.roll();
      await manager.settled();
      const [capture] = repo.activeCaptures();
      expect(capturer.calls.map((c) => c.durationSec)).toEqual([70, 70]);
      const recorded = repo.segments(capture!.id);
      expect(recorded.map((s) => [s.idx, s.startSec, Math.round(s.durationSec!), s.status])).toEqual([
        [0, 0, 70, "queued"],
        [1, 40, 70, "queued"],
      ]);
      const liveDir = join(mediaDir, "live", `capture-${capture!.id}`);
      expect((await readdir(liveDir)).sort()).toEqual(["segment-0.mp4", "segment-1.mp4"]);

      // Five minutes after launch the heavy work gets its turn.
      now = new Date(T0.getTime() + 300_000);
      queue.start();
      await queue.idle();

      // Live segments and their clips ran before the VOD job that was queued first, one job at a time.
      expect(ran).toEqual([LIVE_SEGMENT_JOB, RENDER_JOB, LIVE_SEGMENT_JOB, RENDER_JOB, "vod"]);
      expect(mostAtOnce).toBe(1);
      expect(queue.list().map((j) => j.error)).toEqual([null, null, null, null, null]);

      // The second segment's picks were made with the first for context, and more were asked for than kept.
      expect(asked).toEqual([{ durationSec: 70, maxPicks: 9 }, { durationSec: 110, maxPicks: 9 }]);
      const vod = vods.detail(capture!.vodId);
      expect(vod).toMatchObject({ sourceId: source.id, status: "ready", title: "LIVE: GTA VI day one", durationSec: 110 });
      // One running transcript: the overlap (0:40-1:10) is there once, in order.
      expect(vod.words).toHaveLength(80 + 140);
      expect(vod.words.every((w, i) => i === 0 || w.startSec > vod.words[i - 1]!.startSec)).toBe(true);
      expect(vods.loudness(vod.id).length).toBeGreaterThanOrEqual(109);

      // The leak is dropped and never rendered; the repeated moment is not picked twice.
      const all = picks.listForVod(vod.id);
      expect(all.map((p) => [p.title, p.status, p.dropReason, p.startSec, p.endSec])).toEqual([
        ["Leaked ending", "dropped", "Left out: leaked content", 4, 24],
        ["Across the boundary", "rendered", null, 28, 48.9],
        ["Second moment", "rendered", null, 75, 102.9],
      ]);
      expect(all[1]!.steps.map((s) => s.step)).toEqual(["pick", "download", "render"]);
      expect(all[1]!.costUsd).toBe(0.03);

      // The moment across the 0:40 boundary is whole: all 20.9 s, cut from the first segment's overlap.
      const [second, across] = clips.list();
      const file = await probeVideo(clips.filePath(across!.id));
      expect([file.width, file.height, file.hasAudio]).toEqual([1080, 1920, true]);
      expect(Math.abs(file.durationSec - 20.9)).toBeLessThanOrEqual(0.1);
      expect(across).toMatchObject({ title: "Across the boundary", status: "pending", vodId: vod.id, startSec: 3 });
      expect(across!.masterDurationSec).toBeCloseTo(26.9, 6);
      expect((await probeVideo(clips.masterPath(across!.id))).durationSec).toBeCloseTo(26.9, 0);
      expect(across!.captionWords.length).toBeGreaterThan(40);

      // Tagged LIVE with the stream time (1:00:28 into a stream that began an hour before) and the
      // time from the moment to the Inbox, inside the 15 minute target.
      expect(across!.live).toEqual({ streamSec: 3628, momentAt: "2026-11-19T05:00:48.900Z", latencySec: 251 });
      expect(second).toMatchObject({ title: "Second moment", live: { streamSec: 3675, momentAt: "2026-11-19T05:01:42.900Z", latencySec: 197 } });
      expect(across!.live!.latencySec).toBeLessThan(LIVE_TARGET_LATENCY_SEC);

      expect(notifier.sent.map((n) => n.title)).toEqual(["Live mode started: Test Streamer", "First LIVE clip: Test Streamer"]);
      expect(manager.info().creators).toMatchObject([{ name: "Test Streamer", recording: true, segments: 2, skipped: 0, clips: 2 }]);
      // Cut sections, audio and captions lived only in the jobs' temp folders.
      expect(await readdir(jobsDir)).toEqual([]);

      // Four hours on, a clip is still to be cut from the second segment: only the first is deleted.
      const [waiting] = picks.add(vod.id, source.id, [
        { ...pick(80, 100, "Still to cut", 70), dropReason: null, costUsd: 0, steps: [] },
      ]);
      now = new Date(T0.getTime() + 4 * 3600_000);
      await manager.sync();
      await manager.settled();
      expect(await readdir(liveDir)).toEqual(["segment-1.mp4"]);
      expect(repo.segments(capture!.id).map((s) => s.deletedAt !== null)).toEqual([true, false, false]);
      // The stream is over by now: the recording closed itself.
      expect(repo.capture(capture!.id)).toMatchObject({ status: "ended" });

      // Once nothing needs it, the second goes too, and the clips keep their own files.
      picks.setStatus(waiting!.id, "failed", "gave up");
      await manager.sync();
      await manager.settled();
      expect(existsSync(liveDir)).toBe(false);
      expect((await readdir(join(mediaDir, "clips"))).length).toBe(6);
      expect(existsSync(clips.filePath(across!.id))).toBe(true);
      expect(await readdir(jobsDir)).toEqual([]);
    },
  );
});
