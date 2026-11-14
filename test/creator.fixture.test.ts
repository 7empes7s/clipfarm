import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClipsRepo } from "../server/clips/repo.js";
import { CreatorSectionDownloader, UploadAudioDownloader } from "../server/creator/media.js";
import { isAudioUrl } from "../server/creator/links.js";
import { OutputsRepo } from "../server/creator/outputs.js";
import { Creator, isOwnContent } from "../server/creator/service.js";
import { uploadIdOf, UploadsRepo } from "../server/creator/uploads.js";
import { openDb } from "../server/db/index.js";
import { JobQueue } from "../server/jobs/queue.js";
import { PicksRepo } from "../server/picks/repo.js";
import { pipelineOnFinished } from "../server/pipeline/chain.js";
import { FORMATS_JOB, formatsHandler } from "../server/pipeline/formats/job.js";
import { formatAss, renderFormat } from "../server/pipeline/formats/render.js";
import { FakeDownloader } from "../server/pipeline/ingest/fakeDownloader.js";
import { INGEST_JOB, ingestHandler } from "../server/pipeline/ingest/ingest.js";
import { FakeChatClient } from "../server/pipeline/picks/fake.js";
import { PICKS_JOB, picksHandler } from "../server/pipeline/picks/job.js";
import { LlmPicker } from "../server/pipeline/picks/llm.js";
import { RENDER_JOB, renderHandler } from "../server/pipeline/render/job.js";
import { FakeSectionDownloader } from "../server/pipeline/render/section.js";
import { FakeTranscriber } from "../server/pipeline/transcript/fake.js";
import { SourcesRepo } from "../server/sources/repo.js";
import { run } from "../server/tools/exec.js";
import { generateSample, probeVideo } from "../server/tools/ffmpeg.js";
import { VodsRepo } from "../server/vods/repo.js";
import { DEFAULT_BRAND } from "../shared/creator.js";

let tmpRoot: string;
beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "clipfarm-creator-fixture-"));
});
afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

const flags = { spoiler: false, cutscene: false, ending: false, leak: false, breaks_brief: false };

/** The whole creator path on real ffmpeg: upload → transcript → picks → 9:16 clip → other formats. */
async function pipeline() {
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db);
  const vods = new VodsRepo(db);
  const picks = new PicksRepo(db);
  const clips = new ClipsRepo(db);
  const outputs = new OutputsRepo(db);
  const mediaDir = join(tmpRoot, "media");
  const jobsDir = join(tmpRoot, "jobs");
  await mkdir(jobsDir);
  const uploads = new UploadsRepo(db, join(mediaDir, "uploads"));
  const sections = new CreatorSectionDownloader(new FakeSectionDownloader(), uploads);
  const chat = new FakeChatClient(() => ({
    picks: [{ candidate: 0, start: 30, end: 55, hook: "Wait for it", title: "The big moment", score: 80, reason: "Loud", layout: "center", flags }],
  }));
  const queue: JobQueue = new JobQueue(db, {
    handlers: {
      [INGEST_JOB]: ingestHandler({ sources, vods, downloader: new UploadAudioDownloader(new FakeDownloader(10), uploads), transcriber: new FakeTranscriber() }),
      [PICKS_JOB]: picksHandler({ sources, vods, picks, picker: new LlmPicker(chat), maxPicks: 5 }),
      [RENDER_JOB]: renderHandler({ sources, vods, picks, clips, downloader: sections, mediaDir, preset: "ultrafast" }),
      [FORMATS_JOB]: formatsHandler({
        sources,
        vods,
        picks,
        outputs,
        downloader: sections,
        audioOnly: (url) => isAudioUrl(uploads.get(uploadIdOf(url)!).fileName),
        brand: () => DEFAULT_BRAND,
        mediaDir,
        preset: "ultrafast",
      }),
    },
    tmpRoot: jobsDir,
    onFinished: pipelineOnFinished({ vods, picks, queue: () => queue, creatorMode: (id) => isOwnContent(sources.get(vods.get(id).sourceId), new Date()) }),
  });
  const creator = new Creator({ sources, vods, queue, uploads, readFeed: async () => "" });
  /** Sends a file in 1 MB pieces, as the phone does, and adds it as our own video. */
  const upload = async (file: string, fileName: string) => {
    const data = await readFile(file);
    const u = await uploads.create(1, { fileName, sizeBytes: data.length });
    for (let at = 0; at < data.length; at += 1024 * 1024) await uploads.append(u.id, at, data.subarray(at, at + 1024 * 1024));
    return creator.add(1, { sourceId: null, name: "My Show", ownerName: "Me", attested: true, link: null, uploadId: u.id });
  };
  return { queue, clips, picks, outputs, mediaDir, jobsDir, upload };
}

async function grayBox(video: string, atSec: number, box: { x: number; y: number; w: number; h: number }, out: string) {
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-ss", String(atSec), "-i", video, "-frames:v", "1",
    "-vf", `crop=${box.w}:${box.h}:${box.x}:${box.y},format=gray`, "-f", "rawvideo", out,
  ]);
  return readFile(out);
}

describe("creator mode (real ffmpeg on a generated 2-min sample)", () => {
  it("an uploaded video becomes a 9:16 short in the Inbox plus square and 16:9 cuts with titles", { timeout: 240_000 }, async () => {
    const t = await pipeline();
    const sample = join(tmpRoot, "sample.mp4");
    await generateSample(sample, 120, undefined, "640x360");
    const added = await t.upload(sample, "My episode.mp4");
    await t.queue.idle();

    expect(t.queue.list().map((j) => [j.type, j.status, j.error])).toEqual([
      [FORMATS_JOB, "done", null],
      [RENDER_JOB, "done", null],
      [PICKS_JOB, "done", null],
      [INGEST_JOB, "done", null],
    ]);
    const [pick] = t.picks.listForVod(added.vods[0]!.id);
    const len = pick!.endSec - pick!.startSec;

    // The short: 1080×1920 with sound, waiting for review in the Inbox.
    const [clip] = t.clips.list();
    expect(clip).toMatchObject({ status: "pending", title: "The big moment" });
    const short = await probeVideo(t.clips.filePath(clip!.id));
    expect([short.width, short.height, short.hasAudio]).toEqual([1080, 1920, true]);
    expect(Math.abs(short.durationSec - len)).toBeLessThanOrEqual(0.15);

    // The other formats: square and wide, same moment, each with a title, a description and a thumbnail.
    const outs = t.outputs.listForVod(added.vods[0]!.id);
    expect(outs.map((o) => [o.format, o.status, o.error])).toEqual([
      ["square", "done", null],
      ["wide", "done", null],
    ]);
    const sizes = [];
    for (const o of outs) {
      const files = t.outputs.files(o.id);
      const v = await probeVideo(files.video!);
      sizes.push([v.width, v.height, v.hasAudio]);
      expect(Math.abs(v.durationSec - len)).toBeLessThanOrEqual(0.15);
      expect(o.title).toBe("The big moment");
      expect(o.description).toContain("From My episode.");
      expect(o.thumbUrl).toBe(`/api/outputs/${o.id}/thumb`);
    }
    expect(sizes).toEqual([
      [1080, 1080, true],
      [1920, 1080, true],
    ]);
    // Only the outputs, the clip and the upload stay; the jobs' temp folders are gone.
    expect((await readdir(t.mediaDir)).sort()).toEqual(["clips", "outputs", "uploads"]);
    expect((await readdir(join(t.mediaDir, "outputs"))).length).toBe(4);
    expect(await readdir(t.jobsDir)).toEqual([]);
  });

  it("an audio-only upload becomes a captioned 9:16 audiogram clip and a square audiogram", { timeout: 240_000 }, async () => {
    const t = await pipeline();
    const sample = join(tmpRoot, "sample.mp4");
    const audio = join(tmpRoot, "episode.m4a");
    await generateSample(sample, 120, undefined, "320x180");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", sample, "-vn", "-c:a", "aac", audio]);
    const added = await t.upload(audio, "Episode 12.m4a");
    await t.queue.idle();

    expect(t.queue.list().every((j) => j.status === "done")).toBe(true);
    const [clip] = t.clips.list();
    const short = await probeVideo(t.clips.filePath(clip!.id));
    expect([short.width, short.height, short.hasAudio]).toEqual([1080, 1920, true]);

    const outs = t.outputs.listForVod(added.vods[0]!.id);
    expect(outs.map((o) => [o.format, o.status])).toEqual([["audiogram", "done"]]);
    const gram = await probeVideo(t.outputs.files(outs[0]!.id).video!);
    expect([gram.width, gram.height, gram.hasAudio]).toEqual([1080, 1080, true]);
    expect(outs[0]!.title).toBe("The big moment (podcast clip)");
    expect(await readdir(t.jobsDir)).toEqual([]);
  });

  it("burns the captions into a 16:9 cut and an audiogram", { timeout: 120_000 }, async () => {
    const sample = join(tmpRoot, "sample.mp4");
    await generateSample(sample, 8, undefined, "640x360");
    const words = "this is the part everybody asked about today".split(" ").map((w, i) => ({ word: w, startSec: 0.2 + i * 0.6, endSec: 0.7 + i * 0.6 }));
    const diffAt = async (format: "wide" | "audiogram", box: { x: number; y: number; w: number; h: number }) => {
      await writeFile(join(tmpRoot, `${format}.ass`), formatAss(words, format, "#ffd84d"));
      const common = { format, inputs: [{ file: sample, offsetSec: 0, durationSec: 6 }], src: { w: 640, h: 360 }, color: "#ffd84d", cwd: tmpRoot, preset: "ultrafast" };
      await renderFormat({ ...common, assFile: `${format}.ass`, output: join(tmpRoot, `${format}-with.mp4`) });
      await renderFormat({ ...common, assFile: null, output: join(tmpRoot, `${format}-without.mp4`) });
      const a = await grayBox(join(tmpRoot, `${format}-with.mp4`), 2, box, join(tmpRoot, "a.raw"));
      const b = await grayBox(join(tmpRoot, `${format}-without.mp4`), 2, box, join(tmpRoot, "b.raw"));
      let sum = 0;
      for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
      return sum / a.length;
    };
    // Captions sit in the lower part of the frame.
    expect(await diffAt("wide", { x: 160, y: 820, w: 1600, h: 160 })).toBeGreaterThan(5);
    expect(await diffAt("audiogram", { x: 100, y: 800, w: 880, h: 150 })).toBeGreaterThan(5);
  });
});
