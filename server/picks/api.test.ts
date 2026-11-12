import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { campaignInput } from "../../test/helpers.js";
import { createApp } from "../app.js";
import { openDb } from "../db/index.js";
import { ClipsRepo } from "../clips/repo.js";
import { JobQueue } from "../jobs/queue.js";
import { FakePostingService } from "../publish/fake.js";
import { Publisher } from "../publish/publisher.js";
import { PostsRepo } from "../publish/repo.js";
import { NO_FLAGS } from "../pipeline/picks/types.js";
import { SourcesRepo } from "../sources/repo.js";
import { VodsRepo } from "../vods/repo.js";
import { PicksRepo } from "./repo.js";

function setup() {
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db);
  const vods = new VodsRepo(db);
  const picks = new PicksRepo(db);
  const queue = new JobQueue(db, { handlers: {} });
  const clips = new ClipsRepo(db);
  const posts = new PostsRepo(db);
  const publisher = new Publisher({ sources, clips, posts, service: new FakePostingService() });
  return { sources, vods, picks, clips, app: createApp({ sources, vods, picks, queue, clips, posts, publisher }) };
}

describe("picks API", () => {
  it("lists picks per VOD and has no video until a clip is rendered", async () => {
    const { sources, vods, picks, app } = setup();
    const s = sources.create(campaignInput());
    const v = vods.create(s.id, "https://www.twitch.tv/videos/1");
    const [p] = picks.replaceForVod(v.id, s.id, [
      { startSec: 1, endSec: 30, title: "T", hook: "H", score: 70, reason: "R", flags: NO_FLAGS, dropReason: null,
        layout: "center", costUsd: 0.01, steps: [] },
    ]);
    const list = await request(app).get(`/api/vods/${v.id}/picks`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ title: "T", status: "picked", videoUrl: null, thumbUrl: null });
    expect((await request(app).get("/api/picks")).body).toHaveLength(1);
    expect((await request(app).get(`/api/picks/${p!.id}/video`)).status).toBe(404);
    expect((await request(app).get(`/api/vods/999/picks`)).status).toBe(404);
  });
});

describe("clip files", () => {
  it("serves a rendered clip even when the media folder sits under a dot-folder", async () => {
    const { sources, vods, picks, clips, app } = setup();
    const dir = await mkdtemp(join(tmpdir(), "clipfarm-api-"));
    try {
      const media = join(dir, ".hidden", "media");
      await mkdir(media, { recursive: true });
      await writeFile(join(media, "a.mp4"), "video");
      await writeFile(join(media, "a.jpg"), "jpg");
      const s = sources.create(campaignInput());
      const v = vods.create(s.id, "https://www.twitch.tv/videos/1");
      const [p] = picks.replaceForVod(v.id, s.id, [
        { startSec: 1, endSec: 30, title: "T", hook: "", score: 1, reason: "", flags: NO_FLAGS, dropReason: null,
          layout: "center", costUsd: 0, steps: [] },
      ]);
      const clip = clips.create({ sourceId: s.id, vodId: v.id, title: "T", filePath: join(media, "a.mp4"), durationSec: 29 });
      picks.saveRender(p!.id, {
        filePath: join(media, "a.mp4"), thumbPath: join(media, "a.jpg"), sizeBytes: 5, durationSec: 29, steps: [], clipId: clip.id,
      });
      const res = await request(app).get(`/api/picks/${p!.id}/video`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("video/mp4");
      expect((await request(app).get(`/api/picks/${p!.id}/thumb`)).status).toBe(200);

      // After an edit in the gallery re-renders the clip (and deletes the old file), the pick plays the new version.
      await writeFile(join(media, "b.mp4"), "new version");
      clips.setRendered(clip.id, join(media, "b.mp4"), 20);
      const edited = await request(app).get(`/api/picks/${p!.id}/video`).buffer(true).parse((r, cb) => {
        let data = "";
        r.on("data", (c: Buffer) => (data += c.toString()));
        r.on("end", () => cb(null, data));
      });
      expect(edited.status).toBe(200);
      expect(edited.body).toBe("new version");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
