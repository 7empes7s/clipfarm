import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LOOK, fillerCuts } from "../shared/studio.js";
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
import { TemplatesRepo } from "../server/studio/templates.js";
import { run } from "../server/tools/exec.js";
import { generateSample, probeVideo } from "../server/tools/ffmpeg.js";
import { VodsRepo } from "../server/vods/repo.js";
import { campaignInput } from "./helpers.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "clipfarm-studio-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// Speech from 0.5 s to 9.5 s, with an "um" at 3 s and a 2 s pause from 5 s to 7 s.
const WORDS: Word[] = [
  ...["no", "way", "he", "did"].map((word, i) => ({ word, startSec: 0.5 + i * 0.6, endSec: 1 + i * 0.6 })),
  { word: "um", startSec: 3, endSec: 3.5 },
  ...["that", "jump", "chat"].map((word, i) => ({ word, startSec: 3.6 + i * 0.45, endSec: 4.0 + i * 0.45 })),
  ...["look", "at", "this", "clip", "right", "now"].map((word, i) => ({ word, startSec: 7 + i * 0.4, endSec: 7.35 + i * 0.4 })),
];

/** Grey pixels of the caption band (above the bottom safe area) at `t` seconds. */
async function captionBox(file: string, t: number): Promise<Buffer> {
  const out = join(dir, `box-${Math.random().toString(36).slice(2)}.gray`);
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "crop=900:300:90:1200,format=gray", "-f", "rawvideo", out]);
  return readFile(out);
}

describe("Studio: render an edited clip (real ffmpeg on a generated sample)", () => {
  it("cuts the filler word and the long pause, lays it out at 1080×1920 with audio, and burns the styled captions in", { timeout: 120_000 }, async () => {
    const master = join(dir, "master.mp4");
    await generateSample(master, 10, undefined, "1280x720");
    const cuts = fillerCuts(WORDS, 0, 10);
    // "um" (0.5 s) and the 2.1 s pause minus 0.15 s each side (1.8 s) come out: 10 - 2.3 = 7.7 s.
    expect(cuts).toEqual([{ startSec: 3, endSec: 3.5 }, { startSec: 5.05, endSec: 6.85 }]);
    const look = { ...DEFAULT_LOOK, watermark: "@gtavimoments", captionStyle: { ...DEFAULT_LOOK.captionStyle, color: "#00FF00", wordByWord: true } };
    const base = { clipId: 1, sourceId: 1, masterPath: master, startSec: 0, endSec: 10, layout: "center" as const, hook: "", effects: { ...DEFAULT_EFFECTS, loopEnding: false }, peakSec: null, faceCam: null };

    const edited = join(dir, "edited-out.mp4");
    const { durationSec } = await renderClip({ ...base, cuts, look, captionWords: WORDS }, edited, dir);
    const info = await probeVideo(edited);
    expect([info.width, info.height, info.hasAudio]).toEqual([1080, 1920, true]);
    const expected = 7.7;
    expect(Math.abs(info.durationSec - expected)).toBeLessThanOrEqual(0.15);
    expect(Math.abs(durationSec - expected)).toBeLessThanOrEqual(0.15);

    // Captions are burned in: the caption band differs from the same edit rendered without words.
    const bare = join(dir, "bare-out.mp4");
    await renderClip({ ...base, cuts, look: { ...look, watermark: "" }, captionWords: [] }, bare, dir);
    const a = await captionBox(edited, 1);
    const b = await captionBox(bare, 1);
    let changed = 0;
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > 40) changed++;
    expect(changed / a.length).toBeGreaterThan(0.01);
  });

  it("an export from the Studio API queues one render; the new version plays and the old one is kept", { timeout: 120_000 }, async () => {
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
    const app = createApp({ sources, vods: new VodsRepo(db), picks: new PicksRepo(db), queue, clips, posts, publisher, templates: new TemplatesRepo(db) });
    const master = join(dir, "master.mp4");
    await generateSample(master, 10, undefined, "640x360");
    const source = sources.create(campaignInput());
    const clip = clips.create({ sourceId: source.id, vodId: null, title: "Jump", filePath: master, durationSec: 10, captionWords: WORDS });

    await request(app)
      .post(`/api/clips/${clip.id}/studio`)
      .send({ title: "Jump", hook: "NO WAY", layout: "center", startSec: 0, endSec: 10, cuts: fillerCuts(WORDS, 0, 10), effects: DEFAULT_EFFECTS, look: DEFAULT_LOOK })
      .expect(202);
    queue.start();
    await queue.idle();
    const done = clips.get(clip.id);
    expect(done.status).toBe("pending");
    expect(Math.abs(done.durationSec - 7.7)).toBeLessThanOrEqual(0.15);
    const versions = clips.versions(clip.id);
    expect(versions.map((v) => [v.n, v.current])).toEqual([[1, true], [0, false]]);
    const played = await request(app).get(versions[0]!.videoUrl).expect(200);
    expect(played.headers["content-type"]).toBe("video/mp4");
    expect(existsSync(master)).toBe(true);
    // No stray files: the job's temp folder (with the joined edit) is gone.
    expect((await readdir(dir)).filter((f) => f.startsWith("clipfarm-job-"))).toEqual([]);
    db.close();
  });
});
