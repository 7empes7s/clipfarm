import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Word } from "../shared/types.js";
import { ClipsRepo } from "../server/clips/repo.js";
import { openDb } from "../server/db/index.js";
import { JobQueue } from "../server/jobs/queue.js";
import { PicksRepo } from "../server/picks/repo.js";
import { pipelineOnFinished } from "../server/pipeline/chain.js";
import { FakeDownloader } from "../server/pipeline/ingest/fakeDownloader.js";
import { INGEST_JOB, ingestHandler } from "../server/pipeline/ingest/ingest.js";
import { FakeChatClient } from "../server/pipeline/picks/fake.js";
import { PICKS_JOB, picksHandler } from "../server/pipeline/picks/job.js";
import { LlmPicker } from "../server/pipeline/picks/llm.js";
import { buildAss, CAPTION_FONT_SIZE, SAFE } from "../server/pipeline/render/captions.js";
import { RENDER_JOB, renderHandler } from "../server/pipeline/render/job.js";
import { OUT_H, planLayout } from "../server/pipeline/render/layout.js";
import { renderClip } from "../server/pipeline/render/render.js";
import { FakeSectionDownloader } from "../server/pipeline/render/section.js";
import { FakeTranscriber } from "../server/pipeline/transcript/fake.js";
import { SourcesRepo } from "../server/sources/repo.js";
import { run } from "../server/tools/exec.js";
import { generateSample, probeVideo } from "../server/tools/ffmpeg.js";
import { VodsRepo } from "../server/vods/repo.js";
import { campaignInput } from "./helpers.js";

let tmpRoot: string;
beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "clipfarm-render-fixture-"));
});
afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

/** Grey pixels of one frame inside a box, as raw bytes. */
async function grayBox(video: string, atSec: number, box: { x: number; y: number; w: number; h: number }, out: string) {
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-ss", String(atSec), "-i", video, "-frames:v", "1",
    "-vf", `crop=${box.w}:${box.h}:${box.x}:${box.y},format=gray`, "-f", "rawvideo", out,
  ]);
  return readFile(out);
}

describe("render (real ffmpeg on a generated 10 s sample)", () => {
  it("makes a 1080×1920 H.264/AAC clip of the right length with captions burned in", { timeout: 120_000 }, async () => {
    const input = join(tmpRoot, "sample.mp4");
    await generateSample(input, 12, undefined, "1280x720");
    const words: Word[] = "no way he actually did that chat look at this clip right now okay".split(" ").map((w, i) => ({
      word: w,
      startSec: 0.2 + i * 0.6,
      endSec: 0.2 + i * 0.6 + 0.5,
    }));
    await writeFile(join(tmpRoot, "captions.ass"), buildAss(words, "He did NOT see that coming"));
    const plan = planLayout("stacked", 1280, 720, { x: 0.7, y: 0.6, w: 0.28, h: 0.35 });
    const common = { input, offsetSec: 1, durationSec: 10, plan, cwd: tmpRoot, preset: "ultrafast" };
    await renderClip({ ...common, assFile: "captions.ass", output: join(tmpRoot, "with.mp4") });
    await renderClip({ ...common, assFile: null, output: join(tmpRoot, "without.mp4") });

    const info = await probeVideo(join(tmpRoot, "with.mp4"));
    expect(info.width).toBe(1080);
    expect(info.height).toBe(1920);
    expect(info.hasAudio).toBe(true);
    expect(Math.abs(info.durationSec - 10)).toBeLessThanOrEqual(0.1);
    const { stdout } = await run("ffprobe", [
      "-v", "error", "-show_entries", "stream=codec_name,r_frame_rate", "-of", "csv=p=0", join(tmpRoot, "with.mp4"),
    ]);
    expect(stdout.trim().split("\n").sort()).toEqual(["aac,0/0", "h264,30/1"]);

    // The caption box (above the bottom 20%) differs from the caption-less render; the hook box at the
    // top shows only in the first 2 s.
    const captionBottom = OUT_H - SAFE.bottom - 340;
    const box = { x: SAFE.left, y: captionBottom - CAPTION_FONT_SIZE - 20, w: 1080 - SAFE.left - SAFE.right, h: CAPTION_FONT_SIZE + 20 };
    const diff = async (at: number, b: typeof box) => {
      const a = await grayBox(join(tmpRoot, "with.mp4"), at, b, join(tmpRoot, "a.raw"));
      const c = await grayBox(join(tmpRoot, "without.mp4"), at, b, join(tmpRoot, "b.raw"));
      let sum = 0;
      for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - c[i]!);
      return sum / a.length;
    };
    expect(await diff(4, box)).toBeGreaterThan(5);
    const hookBox = { x: SAFE.left, y: SAFE.top + 60, w: 1080 - SAFE.left - SAFE.right, h: 80 };
    expect(await diff(1, hookBox)).toBeGreaterThan(5);
    expect(await diff(5, hookBox)).toBeLessThan(1);
  });

  it("runs link → transcript → picks → render, keeping only the final clip in media/", { timeout: 120_000 }, async () => {
    const db = openDb(":memory:");
    const sources = new SourcesRepo(db);
    const vods = new VodsRepo(db);
    const picks = new PicksRepo(db);
    const clips = new ClipsRepo(db);
    const mediaDir = join(tmpRoot, "media");
    const jobsDir = join(tmpRoot, "jobs");
    await run("mkdir", [jobsDir]);
    const flags = { spoiler: false, cutscene: false, ending: false, leak: false, breaks_brief: false };
    const chat = new FakeChatClient(() => ({
      picks: [
        { candidate: 0, start: 15, end: 37, hook: "Wait for it", title: "Good one", score: 80, reason: "Loud", layout: "center", flags },
        { candidate: 0, start: 0, end: 22, hook: "x", title: "Spoiler", score: 90, reason: "y", layout: "center", flags: { ...flags, spoiler: true } },
      ],
    }));
    const sectionDownloader = new FakeSectionDownloader();
    const queue: JobQueue = new JobQueue(db, {
      handlers: {
        [INGEST_JOB]: ingestHandler({ sources, vods, downloader: new FakeDownloader(40), transcriber: new FakeTranscriber() }),
        [PICKS_JOB]: picksHandler({ sources, vods, picks, picker: new LlmPicker(chat), maxPicks: 5 }),
        [RENDER_JOB]: renderHandler({ sources, vods, picks, clips, downloader: sectionDownloader, mediaDir, preset: "ultrafast" }),
      },
      tmpRoot: jobsDir,
      onFinished: pipelineOnFinished({ vods, picks, queue: () => queue }),
    });
    const source = sources.create(campaignInput());
    const vod = vods.create(source.id, "https://www.twitch.tv/videos/1");
    queue.enqueue(INGEST_JOB, { vodId: vod.id }, { vodId: vod.id });
    await queue.idle();

    expect(queue.list().map((j) => [j.type, j.status, j.error])).toEqual([
      [RENDER_JOB, "done", null],
      [PICKS_JOB, "done", null],
      [INGEST_JOB, "done", null],
    ]);
    expect(vods.loudness(vod.id).length).toBeGreaterThanOrEqual(39);
    const [spoiler, good] = picks.listForVod(vod.id);
    expect(spoiler).toMatchObject({ status: "dropped", videoUrl: null });
    expect(good).toMatchObject({ status: "rendered", startSec: 14, endSec: 34.9, videoUrl: `/api/picks/${good!.id}/video` });
    expect(good!.steps.map((s) => s.step)).toEqual(["pick", "download", "render"]);
    // Only the kept pick's section was downloaded, with 3 s of padding.
    expect(sectionDownloader.calls).toEqual([{ startSec: 11, endSec: 37.9 }]);

    const clip = await probeVideo(join(mediaDir, "clips", `pick-${good!.id}.mp4`));
    expect([clip.width, clip.height, clip.hasAudio]).toEqual([1080, 1920, true]);
    expect(Math.abs(clip.durationSec - 20.9)).toBeLessThanOrEqual(0.1);
    expect(good!.sizeBytes).toBeGreaterThan(0);
    // The clip now waits for review in the gallery's Clips tab.
    expect(clips.list().map((c) => [c.id, c.title, c.status, c.vodId])).toEqual([[good!.clipId, "Good one", "pending", vod.id]]);
    expect(clips.filePath(good!.clipId!)).toBe(join(mediaDir, "clips", `pick-${good!.id}.mp4`));
    // The clip, its thumbnail and its master (the padded section, kept for edits in the gallery).
    expect((await readdir(mediaDir))).toEqual(["clips"]);
    expect((await readdir(join(mediaDir, "clips"))).sort()).toEqual([
      `pick-${good!.id}-master.mp4`,
      `pick-${good!.id}.jpg`,
      `pick-${good!.id}.mp4`,
    ]);
    const review = clips.get(good!.clipId!);
    // The section starts at 11 s, so the clip is 3-23.9 s of the master, captions in master seconds.
    expect(review).toMatchObject({ hook: "Wait for it", reason: "Loud", score: 80, layout: "center", startSec: 3 });
    expect(review.endSec).toBeCloseTo(23.9, 6);
    expect(review.masterDurationSec).toBeCloseTo(26.9, 6);
    expect(review.captionWords[0]).toEqual({ word: "at", startSec: 0, endSec: 0.4 });
    expect(clips.renderInput(review.id).masterPath).toBe(join(mediaDir, "clips", `pick-${good!.id}-master.mp4`));
    // Section downloads, audio and captions lived only in the jobs' temp folders.
    expect(await readdir(jobsDir)).toEqual([]);
  });
});
