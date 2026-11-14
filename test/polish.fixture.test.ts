import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_EFFECTS, type Word } from "../shared/types.js";
import { createApp } from "../server/app.js";
import { ClipsRepo } from "../server/clips/repo.js";
import { openDb } from "../server/db/index.js";
import { JobQueue } from "../server/jobs/queue.js";
import { PicksRepo } from "../server/picks/repo.js";
import { parseDetected, checkQuality, detectArgs } from "../server/pipeline/polish/quality.js";
import { preparePolish } from "../server/pipeline/polish/run.js";
import { buildAss } from "../server/pipeline/render/captions.js";
import { planLayout } from "../server/pipeline/render/layout.js";
import { renderClip } from "../server/pipeline/render/render.js";
import { onRenderFinished, RENDER_CLIP_JOB, renderClipHandler } from "../server/pipeline/rerender/render.js";
import { FakePostingService } from "../server/publish/fake.js";
import { Publisher } from "../server/publish/publisher.js";
import { PostsRepo } from "../server/publish/repo.js";
import { SourcesRepo } from "../server/sources/repo.js";
import { run } from "../server/tools/exec.js";
import { generateSample, probeVideo } from "../server/tools/ffmpeg.js";
import { VodsRepo } from "../server/vods/repo.js";
import { campaignInput } from "./helpers.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "clipfarm-polish-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const WORDS: Word[] = "no way he actually did that chat look at this clip right now okay".split(" ").map((word, i) => ({
  word,
  startSec: 0.2 + i * 0.6,
  endSec: 0.7 + i * 0.6,
}));

/** Mean brightness (0-255) of a box of one frame. */
async function brightness(video: string, atSec: number, box: string): Promise<number> {
  const out = join(dir, "box.gray");
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(atSec), "-i", video, "-frames:v", "1", "-vf", `crop=${box},format=gray`, "-f", "rawvideo", out]);
  const px = await readFile(out);
  return px.reduce((a, b) => a + b, 0) / px.length;
}

describe("clip polish (real ffmpeg on generated testsrc + sine)", () => {
  it("renders a pick at 1080×1920, -14 LUFS, the pick's length, with the hook card in the first 1.5 s, and passes the check", { timeout: 120_000 }, async () => {
    const input = join(dir, "sample.mp4");
    await generateSample(input, 12, undefined, "1280x720");
    // The pick: 10 s starting 1 s into the download.
    const pick = { offsetSec: 1, durationSec: 10 };
    const polish = await preparePolish({ input, ...pick, effects: DEFAULT_EFFECTS, hook: "He did NOT see that coming", words: WORDS, peakSec: 4, hasAudio: true, tmpDir: dir });
    // Two-pass loudness (measured values), the punch-in at the peak and a quick zoom on "no".
    expect(polish.audio).toMatch(/measured_I=-\d+(\.\d+)?:.*linear=true/);
    expect(polish.zooms.map((z) => [z.atSec, z.amount])).toEqual([[0.2, 0.06], [4, 0.15]]);
    expect(polish).toMatchObject({ hookCard: true, progressBar: true });

    const ass = buildAss(WORDS, "He did NOT see that coming");
    expect(ass).toContain("Dialogue: 1,0:00:00.00,0:00:01.50,Hook,,0,0,0,,HE DID NOT SEE THAT COMING");
    await writeFile(join(dir, "captions.ass"), ass);
    const out = join(dir, "clip.mp4");
    const plan = planLayout("center", 1280, 720);
    await renderClip({ input, ...pick, plan, assFile: "captions.ass", cwd: dir, output: out, preset: "ultrafast", polish });

    const info = await probeVideo(out);
    expect([info.width, info.height, info.hasAudio]).toEqual([1080, 1920, true]);
    expect(Math.abs(info.durationSec - pick.durationSec)).toBeLessThanOrEqual(0.1);
    const { stderr } = await run("ffmpeg", detectArgs(out, true));
    const measured = parseDetected(stderr, info.durationSec);
    expect(Math.abs(measured.lufs! - -14)).toBeLessThanOrEqual(1);
    expect(measured.truePeak!).toBeLessThanOrEqual(-1);
    expect(await checkQuality(out, { ass, effects: DEFAULT_EFFECTS, startSec: 1 })).toEqual({ issues: [], fix: null });

    // Against a render without zooms and bar: the punch-in is on screen at 5 s and gone by 8 s, and
    // the progress bar along the top has reached 80% at 8 s.
    const flat = join(dir, "flat.mp4");
    await renderClip({ input, ...pick, plan, assFile: "captions.ass", cwd: dir, output: flat, preset: "ultrafast", polish: { ...polish, zooms: [], progressBar: false } });
    const differs = async (atSec: number, box: string) => Math.abs((await brightness(out, atSec, box)) - (await brightness(flat, atSec, box)));
    const edge = "100:800:60:300";
    expect(await differs(5, edge)).toBeGreaterThan(10);
    expect(await differs(8, edge)).toBeLessThan(3);
    expect(await differs(8, "300:6:40:2")).toBeGreaterThan(40);
    expect(await differs(8, "150:6:920:2")).toBeLessThan(3);
  });

  it("flags a clip with 1 s of black and 2 s of silence and offers to trim to the clean part", { timeout: 60_000 }, async () => {
    const bad = join(dir, "bad.mp4");
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=duration=10:size=1080x1920:rate=30,drawbox=color=black:t=fill:enable='between(t,1,2)'",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=10,volume=volume=0:enable='between(t,2.5,4.5)'",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", bad,
    ]);
    const quality = await checkQuality(bad, { ass: null, effects: DEFAULT_EFFECTS, startSec: 0 });
    const reasons = quality.issues.map((i) => i.reason);
    expect(reasons).toContain("Black screen for 1.0 s at 0:01.");
    expect(reasons).toContain("No sound for 2.0 s at 0:02.");
    expect(quality.issues.map((i) => i.code)).not.toContain("frozen");
    expect(quality.fix).toMatchObject({ label: "Trim to the clean 5.5 s", endSec: 10 });
    expect(quality.fix!.startSec).toBeCloseTo(4.5, 1);
  });

  it("Fix remakes the clip with the suggested change, and the warning is gone", { timeout: 120_000 }, async () => {
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
    const publisher = new Publisher({ sources, clips, posts, service: new FakePostingService() });
    const app = createApp({ sources, vods: new VodsRepo(db), picks: new PicksRepo(db), queue, clips, posts, publisher });
    const master = join(dir, "master.mp4");
    await generateSample(master, 8, undefined, "640x360");
    const clip = clips.create({ sourceId: sources.create(campaignInput()).id, vodId: null, title: "Quiet one", filePath: master, durationSec: 8, captionWords: WORDS });
    expect(clip).toMatchObject({ effects: DEFAULT_EFFECTS, quality: null });
    await request(app).post(`/api/clips/${clip.id}/fix`).expect(400);

    // Loudness turned off in Edit: the raw tone is too quiet, and the check says so.
    const edit = { title: "Quiet one", hook: "LISTEN", captionText: "", layout: "center", startSec: 1, endSec: 6 };
    await request(app).post(`/api/clips/${clip.id}/edit`).send({ ...edit, effects: { loudness: false } }).expect(202);
    await queue.idle();
    const quiet = clips.get(clip.id);
    expect(quiet.effects).toEqual({ ...DEFAULT_EFFECTS, loudness: false });
    expect(quiet.quality).toEqual({
      issues: [{ code: "loudness", reason: expect.stringMatching(/^The sound is too quiet \(-2\d\.\d LUFS, the target is -14\)\.$/) }],
      fix: { label: "Even out the loudness", effects: { loudness: true } },
    });

    const res = await request(app).post(`/api/clips/${clip.id}/fix`).expect(202);
    expect(res.body.clip).toMatchObject({ status: "rendering", effects: DEFAULT_EFFECTS });
    expect(res.body.job).toMatchObject({ type: RENDER_CLIP_JOB, clipId: clip.id });
    await queue.idle();
    expect(clips.get(clip.id)).toMatchObject({ status: "pending", startSec: 1, endSec: 6, quality: { issues: [], fix: null } });
    // Measurements, frames and captions lived only in the jobs' temp folders.
    expect((await readdir(dir)).sort()).toEqual(["master.mp4", "media"]);
    // Both renders are kept as versions (Studio), the fixed one in use.
    expect(await readdir(mediaDir)).toHaveLength(2);
    expect(clips.versions(clip.id).map((v) => [v.n, v.current])).toEqual([[2, true], [1, false], [0, false]]);
    db.close();
  });
});
