import request from "supertest";
import { describe, expect, it } from "vitest";
import { campaignInput } from "../../test/helpers.js";
import { createApp } from "../app.js";
import { openDb } from "../db/index.js";
import { JobQueue } from "../jobs/queue.js";
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
  return { sources, vods, picks, app: createApp({ sources, vods, picks, queue }) };
}

describe("face cam API", () => {
  it("saves, checks and clears the face cam box", async () => {
    const { sources, app } = setup();
    const s = sources.create(campaignInput());
    expect(s).toMatchObject({ faceCam: null, hasFrame: false });

    const saved = await request(app).put(`/api/sources/${s.id}/face-cam`).send({ faceCam: { x: 0.7, y: 0.6, w: 0.25, h: 0.3 } });
    expect(saved.status).toBe(200);
    expect(saved.body.faceCam).toEqual({ x: 0.7, y: 0.6, w: 0.25, h: 0.3 });

    for (const bad of [{}, { faceCam: { x: 0.9, y: 0, w: 0.3, h: 0.3 } }, { faceCam: { x: 0, y: 0, w: 0.01, h: 0.5 } }]) {
      const res = await request(app).put(`/api/sources/${s.id}/face-cam`).send(bad);
      expect(res.status).toBe(400);
    }
    expect(sources.get(s.id).faceCam).toEqual({ x: 0.7, y: 0.6, w: 0.25, h: 0.3 });

    const cleared = await request(app).put(`/api/sources/${s.id}/face-cam`).send({ faceCam: null });
    expect(cleared.body.faceCam).toBeNull();
    expect((await request(app).get(`/api/sources/${s.id}/frame`)).status).toBe(404);
  });
});

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
