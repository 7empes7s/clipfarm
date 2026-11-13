import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Word } from "../shared/types.js";
import { DEFAULT_EFFECTS } from "../shared/types.js";
import { createApp } from "../server/app.js";
import { ClipsRepo } from "../server/clips/repo.js";
import { openDb } from "../server/db/index.js";
import { JobQueue } from "../server/jobs/queue.js";
import { PicksRepo } from "../server/picks/repo.js";
import { onRenderFinished, RENDER_CLIP_JOB, renderClip, renderClipHandler } from "../server/pipeline/rerender/render.js";
import { FakePostingService } from "../server/publish/fake.js";
import { Publisher } from "../server/publish/publisher.js";
import { PostsRepo } from "../server/publish/repo.js";
import { SourcesRepo } from "../server/sources/repo.js";
import { run } from "../server/tools/exec.js";
import { generateSample } from "../server/tools/ffmpeg.js";
import { VodsRepo } from "../server/vods/repo.js";
import { campaignInput } from "./helpers.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "clipfarm-rerender-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const WORDS: Word[] = ["no", "way", "he", "actually", "landed", "that", "jump", "chat"].map((word, i) => ({
  word,
  startSec: 2 + i * 0.4,
  endSec: 2.4 + i * 0.4,
}));

async function probe(file: string) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", file]);
  const info = JSON.parse(stdout) as { streams: { codec_type: string; width?: number; height?: number }[]; format: { duration: string } };
  const video = info.streams.find((s) => s.codec_type === "video");
  return {
    width: video?.width,
    height: video?.height,
    hasAudio: info.streams.some((s) => s.codec_type === "audio"),
    duration: Number(info.format.duration),
  };
}

/** Grey pixels of the caption box (above the bottom 20 %) at `t` seconds. */
async function captionBox(file: string, t: number): Promise<Buffer> {
  const out = join(dir, `box-${Math.random().toString(36).slice(2)}.gray`);
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(t), "-i", file, "-frames:v", "1",
    "-vf", "crop=900:300:90:1200,format=gray", "-f", "rawvideo", out]);
  return readFile(out);
}

describe("re-render an edited clip (real ffmpeg on a generated sample)", () => {
  it("cuts the trim, lays it out at 1080×1920 with audio and burns the captions in", async () => {
    const master = join(dir, "master.mp4");
    await generateSample(master, 10, undefined, "1280x720");
    const base = { clipId: 1, sourceId: 1, masterPath: master, startSec: 2, endSec: 5.5, layout: "stacked" as const, hook: "WAIT FOR IT", effects: DEFAULT_EFFECTS, peakSec: null };
    const faceCam = { x: 0.7, y: 0.05, w: 0.25, h: 0.3 };

    const withCaptions = join(dir, "with.mp4");
    const { durationSec: duration } = await renderClip({ ...base, captionWords: WORDS, faceCam }, withCaptions, dir);
    const info = await probe(withCaptions);
    expect(info).toMatchObject({ width: 1080, height: 1920, hasAudio: true });
    expect(Math.abs(info.duration - 3.5)).toBeLessThanOrEqual(0.1);
    expect(Math.abs(duration - 3.5)).toBeLessThanOrEqual(0.1);

    const without = join(dir, "without.mp4");
    await renderClip({ ...base, hook: "", captionWords: [], faceCam }, without, dir);
    const a = await captionBox(withCaptions, 1);
    const b = await captionBox(without, 1);
    let changed = 0;
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > 40) changed++;
    expect(changed / a.length).toBeGreaterThan(0.01);
  });

  it("saving an edit queues one render job; the new version comes back to the inbox and the old render is removed", async () => {
    const db = openDb(":memory:");
    const sources = new SourcesRepo(db);
    const clips = new ClipsRepo(db);
    const posts = new PostsRepo(db);
    const mediaDir = join(dir, "media");
    const queue = new JobQueue(db, {
      handlers: { [RENDER_CLIP_JOB]: renderClipHandler({ clips, sources, mediaDir }) },
      tmpRoot: dir,
      onFinished: onRenderFinished(clips),
    });
    queue.stop();
    const publisher = new Publisher({ sources, clips, posts, service: new FakePostingService() });
    const app = createApp({ sources, vods: new VodsRepo(db), picks: new PicksRepo(db), queue, clips, posts, publisher });

    const master = join(dir, "master.mp4");
    await generateSample(master, 8, undefined, "640x360");
    const source = sources.create(campaignInput());
    const clip = clips.create({ sourceId: source.id, vodId: null, title: "Old title", filePath: master, durationSec: 8, captionWords: WORDS });

    const res = await request(app)
      .post(`/api/clips/${clip.id}/edit`)
      .send({ title: "New title", hook: "NO WAY", captionText: "no way he actualy landed that jump chat", layout: "full", startSec: 1.5, endSec: 5 });
    expect(res.status).toBe(202);
    expect(res.body.clip).toMatchObject({ status: "rendering", title: "New title", startSec: 1.5, endSec: 5 });
    expect(res.body.job).toMatchObject({ type: RENDER_CLIP_JOB, status: "queued", clipId: clip.id });

    queue.start();
    await queue.idle();
    const first = clips.get(clip.id);
    expect(first).toMatchObject({ status: "pending", layout: "full" });
    expect(Math.abs(first.durationSec - 3.5)).toBeLessThanOrEqual(0.1);
    expect(first.videoUrl).not.toBe(clip.videoUrl);
    const firstFile = clips.filePath(clip.id);
    expect(firstFile.startsWith(mediaDir)).toBe(true);
    expect((await probe(firstFile)).height).toBe(1920);
    // The typo fix kept each word's timing.
    expect(first.captionWords[3]).toEqual({ word: "actualy", startSec: WORDS[3]!.startSec, endSec: WORDS[3]!.endSec });

    await request(app).post(`/api/clips/${clip.id}/edit`).send({ title: "New title", hook: "", captionText: "", layout: "center", startSec: 0, endSec: 4 }).expect(202);
    queue.start();
    await queue.idle();
    // The previous render is deleted; the master (the original file) stays for later trims.
    expect(existsSync(firstFile)).toBe(false);
    expect(existsSync(master)).toBe(true);
    expect(await readdir(mediaDir)).toHaveLength(1);
    // The job's temp folder is gone.
    expect((await readdir(dir)).filter((f) => f.startsWith("clipfarm-job-"))).toEqual([]);
    db.close();
  });
});
