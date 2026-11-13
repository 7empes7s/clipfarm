import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PERMISSION_KINDS, type PostingAccount, type Word } from "../shared/types.js";
import { createApp } from "../server/app.js";
import { ClipsRepo } from "../server/clips/repo.js";
import { openDb } from "../server/db/index.js";
import { HOOK_VARIANTS_JOB, HookLab } from "../server/hooklab/lab.js";
import { hookVariantsHandler, onHookVariantsFinished } from "../server/hooklab/render.js";
import { JobQueue } from "../server/jobs/queue.js";
import { PicksRepo } from "../server/picks/repo.js";
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
  dir = await mkdtemp(join(tmpdir(), "clipfarm-hooklab-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const WORDS: Word[] = ["no", "way", "he", "landed", "that"].map((word, i) => ({ word, startSec: 1 + i * 0.4, endSec: 1.4 + i * 0.4 }));
const ACCOUNTS: PostingAccount[] = [
  { id: "tt-main", platform: "tiktok", name: "gtavimoments", disabled: false },
  { id: "tt-b1", platform: "tiktok", name: "burner.one", disabled: false },
  { id: "tt-b2", platform: "tiktok", name: "burner.two", disabled: false },
];

async function probe(file: string) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", file]);
  const info = JSON.parse(stdout) as { streams: { codec_type: string; width?: number; height?: number }[]; format: { duration: string } };
  const video = info.streams.find((s) => s.codec_type === "video");
  return { width: video?.width, height: video?.height, hasAudio: info.streams.some((s) => s.codec_type === "audio"), duration: Number(info.format.duration) };
}

/** Grey pixels of the hook box (near the top) at `t` seconds. */
async function hookBox(file: string, t: number): Promise<Buffer> {
  const out = join(dir, `box-${Math.random().toString(36).slice(2)}.gray`);
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(t), "-i", file, "-frames:v", "1",
    "-vf", "crop=900:240:90:200,format=gray", "-f", "rawvideo", out]);
  return readFile(out);
}

describe("hook lab on a generated sample (real ffmpeg, faked posting)", () => {
  it("renders the other hook on the same cut, posts each variant to a burner, and leaves no stray files", async () => {
    const db = openDb(":memory:");
    const sources = new SourcesRepo(db);
    const clips = new ClipsRepo(db);
    const posts = new PostsRepo(db);
    const service = new FakePostingService(ACCOUNTS);
    const publisher = new Publisher({ sources, clips, posts, service });
    const mediaDir = join(dir, "media");
    const lab: HookLab = new HookLab({
      db, clips, sources, posts, publisher,
      enqueueRender: (testId, clipId) => queue.enqueue(HOOK_VARIANTS_JOB, { testId }, { clipId }),
    });
    const queue: JobQueue = new JobQueue(db, {
      handlers: { [HOOK_VARIANTS_JOB]: hookVariantsHandler({ lab, clips, sources, mediaDir }) },
      tmpRoot: dir,
      onFinished: onHookVariantsFinished(lab),
    });
    queue.stop();
    const app = createApp({ sources, vods: new VodsRepo(db), picks: new PicksRepo(db), queue, clips, posts, publisher, hookLab: lab });
    await publisher.syncAccounts();
    for (const id of ["tt-b1", "tt-b2"]) {
      publisher.accounts.update(id, {
        role: "burner", niche: "", maxPerDay: 50, minGapMinutes: 0, enabled: true, health: "healthy", takes: [...PERMISSION_KINDS], pinnedCampaignIds: [],
      });
    }

    const master = join(dir, "master.mp4");
    await generateSample(master, 6, undefined, "640x360");
    const source = sources.create(campaignInput());
    const clip = clips.create({
      sourceId: source.id, vodId: null, title: "He landed that", hook: "NO WAY", filePath: master, durationSec: 4,
      masterPath: master, masterDurationSec: 6, startSec: 1, endSec: 5, captionWords: WORDS,
    });
    clips.setStatus(clip.id, "approved");

    // Off by default; the Dashboard's switch turns it on.
    expect((await request(app).get("/api/hooklab").expect(200)).body.settings).toEqual({ on: false, hours: 6 });
    await request(app).put("/api/hooklab/settings").send({ on: true, hours: 2 }).expect(200);
    await request(app).put("/api/hooklab/settings").send({ hours: 100 }).expect(400);
    const started = (await request(app).post("/api/hooklab/run").expect(200)).body;
    expect(started.tests[0]).toMatchObject({ clipId: clip.id, status: "rendering" });
    expect(started.tests[0].variants.map((v: { label: string }) => v.label)).toEqual(["A", "B"]);
    expect(queue.list().map((j) => [j.type, j.status, j.clipId])).toEqual([[HOOK_VARIANTS_JOB, "queued", clip.id]]);

    queue.start();
    await queue.idle();
    queue.stop();
    // The job's end sends the variants; wait for that pass.
    await expect.poll(() => lab.info().tests[0]!.status).toBe("running");

    // B is its own video: the same cut at 1080×1920 with sound, and another hook on screen.
    expect(service.published.map((i) => i.account.id)).toEqual(["tt-b1", "tt-b2"]);
    const [a, b] = service.videos.map((v) => v.path) as [string, string];
    expect(a).toBe(master);
    expect(b.startsWith(mediaDir)).toBe(true);
    const info = await probe(b);
    expect(info).toMatchObject({ width: 1080, height: 1920, hasAudio: true });
    expect(Math.abs(info.duration - 4)).toBeLessThanOrEqual(0.1);
    const plain = join(dir, "plain.mp4");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", "1", "-i", master, "-t", "4",
      "-vf", "crop=202:360,scale=1080:1920", "-an", plain]);
    const withHook = await hookBox(b, 1);
    const without = await hookBox(plain, 1);
    let changed = 0;
    for (let i = 0; i < withHook.length; i++) if (Math.abs(withHook[i]! - without[i]!) > 40) changed++;
    expect(changed / withHook.length).toBeGreaterThan(0.01);

    // The job's temp folder is gone, and removing the creator takes the variant video with it.
    expect((await readdir(dir)).filter((f) => f.startsWith("clipfarm-job-"))).toEqual([]);
    expect(await readdir(mediaDir)).toHaveLength(1);
    await request(app).delete(`/api/sources/${source.id}`).expect(200);
    expect(existsSync(b)).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM hook_tests").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM hook_variants").get()).toEqual({ n: 0 });
    db.close();
  });
});
