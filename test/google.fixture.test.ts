import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClipsRepo } from "../server/clips/repo.js";
import { openDb } from "../server/db/index.js";
import { FakeGemini } from "../server/google/fake.js";
import { PROXY_MAX_HEIGHT, PROXY_MAX_SEC, proxyMaker, proxyWindow } from "../server/google/rerank.js";
import { GoogleAi } from "../server/google/service.js";
import { COVER_SIZE, THUMBS_JOB, thumbsHandler, ThumbsRepo, WIDE_SIZE } from "../server/google/thumbs.js";
import { JobQueue } from "../server/jobs/queue.js";
import { FakeSectionDownloader } from "../server/pipeline/render/section.js";
import { SourcesRepo } from "../server/sources/repo.js";
import { generateSample, probeVideo } from "../server/tools/ffmpeg.js";
import { campaignInput } from "./helpers.js";

let tmpRoot: string;
beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "clipfarm-google-fixture-"));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("the proxy Gemini watches (real ffmpeg on a generated sample)", () => {
  it("is 360p and 40 s at most, has sound, and leaves no temp files behind", { timeout: 120_000 }, async () => {
    const jobDir = join(tmpRoot, "job");
    await mkdir(jobDir);
    // A 60 s pick: the window is cut to 40 s; the stand-in download is a 1280×720 test pattern of that length.
    const window = proxyWindow({ startSec: 100, endSec: 160 }, 600);
    const downloader = new FakeSectionDownloader();
    const bytes = await proxyMaker(downloader)("https://example.test/vod", window, jobDir);
    expect(downloader.calls).toEqual([{ startSec: 97, endSec: 137 }]);
    expect(await readdir(jobDir)).toEqual([]);

    const proxy = join(tmpRoot, "proxy.mp4");
    await writeFile(proxy, bytes);
    const info = await probeVideo(proxy);
    expect(info.height).toBeLessThanOrEqual(PROXY_MAX_HEIGHT);
    expect(info).toMatchObject({ width: 640, height: 360, hasAudio: true });
    expect(info.durationSec).toBeLessThanOrEqual(PROXY_MAX_SEC + 0.1);
    expect(info.durationSec).toBeGreaterThan(38);
    // 1 frame a second and quiet mono sound: small enough to send inline many times a day.
    expect(bytes.length).toBeLessThan(1_500_000);
  });

  it("never makes a small video bigger, and removes its files when the download fails", { timeout: 60_000 }, async () => {
    const small = { name: "small", downloadSection: async (_u: string, s: { startSec: number; endSec: number }, dir: string) => {
      const file = join(dir, "section.mp4");
      await generateSample(file, s.endSec - s.startSec, undefined, "320x180");
      return file;
    } };
    const bytes = await proxyMaker(small)("u", { startSec: 0, endSec: 4 }, tmpRoot);
    const proxy = join(tmpRoot, "small.mp4");
    await writeFile(proxy, bytes);
    expect(await probeVideo(proxy)).toMatchObject({ width: 320, height: 180 });
    await rm(proxy);

    const failing = { name: "down", downloadSection: async (_u: string, _s: unknown, dir: string) => {
      await writeFile(join(dir, "section.mp4.part"), "half");
      throw new Error("yt-dlp failed");
    } };
    await expect(proxyMaker(failing)("u", { startSec: 0, endSec: 4 }, tmpRoot)).rejects.toThrow("yt-dlp failed");
    expect(await readdir(tmpRoot)).toEqual([]);
  });
});

describe("thumbnails (faked Gemini image, real ffmpeg)", () => {
  async function setup() {
    const db = openDb(":memory:");
    const sources = new SourcesRepo(db);
    const clips = new ClipsRepo(db);
    const thumbs = new ThumbsRepo(db);
    const gemini = new FakeGemini();
    const google = new GoogleAi({ client: () => gemini });
    google.bind(db);
    const mediaDir = join(tmpRoot, "media");
    const jobsDir = join(tmpRoot, "jobs");
    await mkdir(jobsDir);
    const queue = new JobQueue(db, { handlers: { [THUMBS_JOB]: thumbsHandler({ clips, thumbs, google, mediaDir }) }, tmpRoot: jobsDir });
    const source = sources.create(campaignInput());
    const video = join(tmpRoot, "clip.mp4");
    await generateSample(video, 3, undefined, "540x960");
    const clip = clips.create({ sourceId: source.id, vodId: null, title: "Kai jumps", filePath: video, durationSec: 3, hook: "He actually JUMPED" });
    const make = async (noAi = false) => {
      const job = queue.enqueue(THUMBS_JOB, { clipId: clip.id, noAi }, { clipId: clip.id, maxAttempts: 1 });
      await queue.idle();
      const done = queue.list().find((j) => j.id === job.id)!;
      expect(done.error).toBeNull();
      return done;
    };
    return { clip, thumbs, gemini, google, make, mediaDir, jobsDir, sources, source };
  }

  it("makes two options from a frame and the hook, each at 1080×1920 and 1280×720, and one can be picked", { timeout: 120_000 }, async () => {
    const { clip, thumbs, gemini, make, mediaDir, jobsDir } = await setup();
    expect((await make()).status).toBe("done");

    expect(gemini.imageCalls).toHaveLength(2);
    expect(gemini.imageCalls[0]).toMatchObject({ aspectRatio: "9:16", image: { mimeType: "image/jpeg" } });
    expect(gemini.imageCalls[0]!.prompt).toContain('"He actually JUMPED"');
    expect(gemini.imageCalls[1]!.prompt).not.toBe(gemini.imageCalls[0]!.prompt);

    const options = thumbs.listForClip(clip.id);
    expect(options.map((o) => [o.label, o.ai, o.chosen])).toEqual([
      ["Option A", true, false],
      ["Option B", true, false],
    ]);
    for (const o of options) {
      const files = thumbs.files(o.id);
      expect(await probeVideo(files.cover)).toMatchObject(COVER_SIZE);
      expect(await probeVideo(files.wide)).toMatchObject(WIDE_SIZE);
    }
    expect(thumbs.choose(options[1]!.id).map((o) => o.chosen)).toEqual([false, true]);
    expect(thumbs.choose(options[0]!.id).map((o) => o.chosen)).toEqual([true, false]);
    // Only the four pictures are kept; the job's temp folder is gone.
    expect(await readdir(join(mediaDir, "thumbs"))).toHaveLength(4);
    expect(await readdir(jobsDir)).toEqual([]);
  });

  it("at the daily cap the job still finishes, with a frame of the clip as the option; a new set replaces the old files", { timeout: 120_000 }, async () => {
    const { clip, thumbs, gemini, google, make, mediaDir, sources, source } = await setup();
    await make();
    google.saveSettings({ dailyCapEur: 0 });
    expect((await make()).status).toBe("done");
    expect(gemini.imageCalls).toHaveLength(2);
    const options = thumbs.listForClip(clip.id);
    expect(options.map((o) => [o.label, o.ai])).toEqual([["Frame from the clip", false]]);
    expect(await probeVideo(thumbs.files(options[0]!.id).cover)).toMatchObject(COVER_SIZE);
    expect(await probeVideo(thumbs.files(options[0]!.id).wide)).toMatchObject(WIDE_SIZE);
    expect(await readdir(join(mediaDir, "thumbs"))).toHaveLength(2);
    // Removing the creator takes the thumbnails with it.
    sources.remove(source.id);
    expect(await readdir(join(mediaDir, "thumbs"))).toEqual([]);
  });

  it("a campaign that bans AI content gets a frame of the clip and Gemini is never asked", { timeout: 60_000 }, async () => {
    const { clip, thumbs, gemini, make } = await setup();
    expect((await make(true)).status).toBe("done");
    expect(gemini.imageCalls).toHaveLength(0);
    expect(thumbs.listForClip(clip.id).map((o) => [o.label, o.ai])).toEqual([["Frame from the clip", false]]);
  });

  it("when Google fails the job does not: the frame is used", { timeout: 60_000 }, async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { clip, thumbs, make, google } = await setup();
    vi.spyOn(google, "image").mockRejectedValue(new Error("Google says: internal error."));
    expect((await make()).status).toBe("done");
    expect(thumbs.listForClip(clip.id).map((o) => o.label)).toEqual(["Frame from the clip"]);
  });
});
