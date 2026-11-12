import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { campaignInput } from "../../test/helpers.js";
import { createApp } from "../app.js";
import { ClipsRepo } from "../clips/repo.js";
import { openDb } from "../db/index.js";
import { JobQueue } from "../jobs/queue.js";
import { PicksRepo } from "../picks/repo.js";
import { NO_FLAGS } from "../pipeline/picks/types.js";
import { FakePostingService } from "../publish/fake.js";
import { Publisher } from "../publish/publisher.js";
import { PostsRepo } from "../publish/repo.js";
import { VodsRepo } from "../vods/repo.js";
import { SourcesRepo } from "./repo.js";

const dir = mkdtempSync(join(tmpdir(), "clipfarm-remove-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** One source with everything the pipeline leaves behind: a VOD, transcript, pick, clip, review, jobs and files. */
function setup() {
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db);
  const vods = new VodsRepo(db);
  const picks = new PicksRepo(db);
  const clips = new ClipsRepo(db);
  const posts = new PostsRepo(db);
  const publisher = new Publisher({ sources, clips, posts, service: new FakePostingService() });
  const queue = new JobQueue(db, { handlers: { ingest: async () => {}, "render-clip": async () => {} } });
  queue.stop();
  const app = createApp({ sources, vods, picks, queue, clips, posts, publisher });

  const make = (name: string) => {
    const source = sources.create({ ...campaignInput(), creatorName: name });
    const vod = vods.create(source.id, "https://example.com/video");
    vods.saveTranscript(vod.id, [{ word: "hello", startSec: 0, endSec: 1 }], "fake", 0);
    const files = ["clip.mp4", "master.mp4", "thumb.jpg"].map((f) => join(dir, `${name}-${f}`));
    for (const f of files) writeFileSync(f, "x");
    const [filePath, masterPath, thumbPath] = files as [string, string, string];
    const clip = clips.create({ sourceId: source.id, vodId: vod.id, title: `${name} clip`, filePath, masterPath, durationSec: 20 });
    const [pick] = picks.replaceForVod(vod.id, source.id, [
      { startSec: 0, endSec: 20, title: "t", hook: "h", score: 80, reason: "r", flags: NO_FLAGS, dropReason: null, layout: "center", costUsd: 0, steps: [] },
    ]);
    picks.saveRender(pick!.id, { filePath, thumbPath, sizeBytes: 1, durationSec: 20, steps: [], clipId: clip.id });
    clips.review(clip.id, "approve");
    return { source, vod, clip, files };
  };
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { db, app, queue, posts, sources, make, count };
}

describe("DELETE /api/sources/:id", () => {
  it("removes the source with its permission, videos, picks, clips, reviews, jobs and files, and nothing else", async () => {
    const { db, app, queue, make, count } = setup();
    const keep = make("Keep");
    const gone = make("Gone");
    db.prepare("UPDATE jobs SET status = 'done'").run();
    const done = queue.enqueue("ingest", {}, { vodId: gone.vod.id });
    const rerender = queue.enqueue("render-clip", {}, { clipId: gone.clip.id });
    queue.enqueue("ingest", {}, { vodId: keep.vod.id });
    db.prepare("UPDATE jobs SET status = 'done' WHERE id IN (?, ?)").run(done.id, rerender.id);

    const res = await request(app).delete(`/api/sources/${gone.source.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: { videos: 1, clips: 1 } });

    for (const f of gone.files) expect(existsSync(f), f).toBe(false);
    for (const f of keep.files) expect(existsSync(f), f).toBe(true);
    for (const table of ["sources", "permissions", "vods", "transcript_words", "picks", "clips", "clip_reviews", "jobs"]) {
      expect(count(table), table).toBe(1);
    }
    expect((await request(app).get("/api/sources")).body.map((s: { id: number }) => s.id)).toEqual([keep.source.id]);
    expect((await request(app).get("/api/clips")).body.map((c: { id: number }) => c.id)).toEqual([keep.clip.id]);
  });

  it("keeps a source whose clips went out through a real posting service: posts are the earnings record", async () => {
    const { app, posts, make, count } = setup();
    const { source, clip, files } = make("Posted");
    posts.insert({
      clipId: clip.id,
      permissionId: source.permissions[0]!.id,
      platform: "youtube",
      accountId: "yt-1",
      accountName: "GTA VI Moments",
      service: "postiz",
      externalId: "p1",
      status: "posted",
      url: "https://example.com/p1",
      error: null,
      caption: "c",
      scheduledAt: "2026-11-19T12:00:00.000Z",
      postedAt: "2026-11-19T12:00:00.000Z",
    });
    const res = await request(app).delete(`/api/sources/${source.id}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Posted has clips that were posted, so it stays: the posts are the record of what went out.");
    expect(count("sources")).toBe(1);
    expect(count("clips")).toBe(1);
    expect(existsSync(files[0]!)).toBe(true);
  });

  it("removes posts made by the test posting service along with the source", async () => {
    const { app, posts, make, count } = setup();
    const { source, clip } = make("Fake");
    posts.insert({
      clipId: clip.id,
      permissionId: source.permissions[0]!.id,
      platform: "youtube",
      accountId: "fake-youtube",
      accountName: "GTA VI Moments",
      service: "fake",
      externalId: "fake-post-1",
      status: "posted",
      url: null,
      error: null,
      caption: "c",
      scheduledAt: "2026-11-19T12:00:00.000Z",
      postedAt: null,
    });
    await request(app).delete(`/api/sources/${source.id}`).expect(200);
    expect(count("posts")).toBe(0);
    expect(count("sources")).toBe(0);
  });

  it("waits for a job that is still working on it", async () => {
    const { app, queue, make, count } = setup();
    const { source, vod } = make("Busy");
    queue.enqueue("ingest", {}, { vodId: vod.id });
    const res = await request(app).delete(`/api/sources/${source.id}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("A job is still working on Busy. Cancel it in Jobs or wait for it, then try again.");
    expect(count("sources")).toBe(1);
  });

  it("answers 404 for a source that is not there", async () => {
    const { app } = setup();
    await request(app).delete("/api/sources/999").expect(404);
  });
});
