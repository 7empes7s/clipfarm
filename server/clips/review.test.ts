import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import type { Clip, Source } from "../../shared/types.js";
import { campaignInput } from "../../test/helpers.js";
import { createApp } from "../app.js";
import { openDb } from "../db/index.js";
import { ValidationError } from "../errors.js";
import { JobQueue } from "../jobs/queue.js";
import { FakePostingService } from "../publish/fake.js";
import { Publisher } from "../publish/publisher.js";
import { PostsRepo } from "../publish/repo.js";
import { parseFaceCam, SourcesRepo } from "../sources/repo.js";
import { VodsRepo } from "../vods/repo.js";
import { parseClipEdit, retimeCaptions } from "./edit.js";
import { ClipsRepo } from "./repo.js";

const dir = mkdtempSync(join(tmpdir(), "clipfarm-review-"));
const videoPath = join(dir, "clip.mp4");
writeFileSync(videoPath, "not really a video");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function setup() {
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db);
  const clips = new ClipsRepo(db);
  const posts = new PostsRepo(db);
  const service = new FakePostingService();
  const publisher = new Publisher({ sources, clips, posts, service });
  const queue = new JobQueue(db, { handlers: { "render-clip": async () => {}, "demo-clips": async () => {} } });
  queue.stop();
  const app = createApp({ sources, vods: new VodsRepo(db), queue, clips, posts, publisher });
  const source = sources.create(campaignInput());
  const make = (title: string) => clips.create({ sourceId: source.id, vodId: null, title, filePath: videoPath, durationSec: 20 });
  return { db, app, clips, sources, source, service, queue, make };
}

describe("review decisions", () => {
  it("stores approvals and rejections with their reason", async () => {
    const { app, clips, make } = setup();
    const a = make("A");
    const b = make("B");
    await request(app).post(`/api/clips/${a.id}/approve`).expect(200);
    const res = await request(app).post(`/api/clips/${b.id}/reject`).send({ reason: "spoiler" });
    expect(res.body).toMatchObject({ status: "rejected", rejectReason: "spoiler" });
    expect(clips.reviews(a.id)).toEqual([{ action: "approve", reason: null, undone: false }]);
    expect(clips.reviews(b.id)).toEqual([{ action: "reject", reason: "spoiler", undone: false }]);
  });

  it("refuses an unknown reject reason", async () => {
    const { app, make } = setup();
    const res = await request(app).post(`/api/clips/${make("A").id}/reject`).send({ reason: "meh" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Pick a reason/);
  });

  it("undo takes back only the last decision, then the one before", async () => {
    const { app, clips, make } = setup();
    const a = make("A");
    const b = make("B");
    await request(app).post(`/api/clips/${a.id}/approve`);
    await request(app).post(`/api/clips/${b.id}/reject`).send({ reason: "boring" });

    let res = await request(app).post("/api/clips/undo");
    expect(res.body).toMatchObject({ id: b.id, status: "pending", rejectReason: null });
    expect(clips.get(a.id).status).toBe("approved");
    expect(clips.reviews(b.id)[0]).toMatchObject({ undone: true });

    res = await request(app).post("/api/clips/undo");
    expect(res.body).toMatchObject({ id: a.id, status: "pending" });
    res = await request(app).post("/api/clips/undo");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("There is nothing to undo.");
  });

  it("undo brings back the earlier reject reason when a rejected clip was approved", async () => {
    const { clips, make } = setup();
    const a = make("A");
    clips.review(a.id, "reject", "bad-crop");
    clips.review(a.id, "approve");
    expect(clips.undoLastReview()).toMatchObject({ status: "rejected", rejectReason: "bad-crop" });
  });

  it("a clip being re-rendered cannot be approved yet", () => {
    const { clips, make } = setup();
    const a = make("A");
    clips.setStatus(a.id, "rendering");
    expect(() => clips.review(a.id, "approve")).toThrow(ValidationError);
  });
});

describe("edit endpoint", () => {
  it("queues one render job and marks the clip as rendering", async () => {
    const { app, queue, make } = setup();
    const a = make("A");
    const res = await request(app)
      .post(`/api/clips/${a.id}/edit`)
      .send({ title: " Better title ", hook: "WAIT", captionText: "", layout: "center", startSec: 0.5, endSec: 19.5 });
    expect(res.status).toBe(202);
    expect(res.body.clip).toMatchObject({ status: "rendering", title: "Better title", startSec: 0.5, endSec: 19.5, masterDurationSec: 20 });
    expect(queue.list()).toHaveLength(1);
    expect(queue.list()[0]).toMatchObject({ type: "render-clip", clipId: a.id, status: "queued" });
  });

  it("refuses the stacked layout until the creator's face cam is set", async () => {
    const { app, sources, source, make } = setup();
    const a = make("A");
    const body = { title: "A", hook: "", captionText: "", layout: "stacked", startSec: 0, endSec: 10 };
    let res = await request(app).post(`/api/clips/${a.id}/edit`).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/face cam/);
    sources.setFaceCam(source.id, { x: 0.7, y: 0, w: 0.3, h: 0.3 });
    res = await request(app).post(`/api/clips/${a.id}/edit`).send(body);
    expect(res.status).toBe(202);
  });
});

describe("face cam", () => {
  it("is saved on the source through the API", async () => {
    const { app, source } = setup();
    const res = await request(app).put(`/api/sources/${source.id}/face-cam`).send({ x: 0.7, y: 0.05, w: 0.25, h: 0.3 });
    expect(res.status).toBe(200);
    expect(res.body.faceCam).toEqual({ x: 0.7, y: 0.05, w: 0.25, h: 0.3 });
    const cleared = await request(app).put(`/api/sources/${source.id}/face-cam`).send({ clear: true });
    expect(cleared.body.faceCam).toBeNull();
  });

  it("refuses boxes outside the frame or too small", () => {
    expect(() => parseFaceCam({ x: 0.8, y: 0, w: 0.3, h: 0.3 })).toThrow("inside the frame");
    expect(() => parseFaceCam({ x: 0.1, y: 0.1, w: 0.01, h: 0.3 })).toThrow("too small");
    expect(() => parseFaceCam({})).toThrow("Drag a box");
  });
});

describe("demo clips", () => {
  it("can never be posted: the demo campaign allows no platform", async () => {
    const { app, sources, clips, service } = setup();
    const demo = sources.create({
      creatorName: "Demo Streamer A",
      channelUrls: [],
      permission: { kind: "direct-permission", briefRules: "Demo only.", allowedPlatforms: [] },
    });
    const clip = clips.create({ sourceId: demo.id, vodId: null, title: "Demo", filePath: videoPath, durationSec: 5 });
    clips.review(clip.id, "approve");
    const res = await request(app).post(`/api/clips/${clip.id}/posts`).send({ accountIds: ["fake-youtube"] });
    expect(res.status).toBe(403);
    // Only the account list was read; nothing was uploaded or posted.
    expect(service.calls).toEqual(["listAccounts"]);
  });

  it("are made by a queued job", async () => {
    const { app, queue } = setup();
    const res = await request(app).post("/api/demo");
    expect(res.status).toBe(201);
    expect(queue.list()[0]).toMatchObject({ type: "demo-clips", status: "queued", maxAttempts: 1 });
  });
});

describe("retimeCaptions", () => {
  const words = [
    { word: "hello", startSec: 1, endSec: 1.5 },
    { word: "wrld", startSec: 1.5, endSec: 2 },
    { word: "later", startSec: 9, endSec: 9.5 },
  ];

  it("keeps each word's timing when only typos change", () => {
    expect(retimeCaptions(words, "hello world", 0, 5)).toEqual([
      { word: "hello", startSec: 1, endSec: 1.5 },
      { word: "world", startSec: 1.5, endSec: 2 },
      { word: "later", startSec: 9, endSec: 9.5 },
    ]);
  });

  it("spreads a different number of words over the old span, keeping words outside the clip", () => {
    expect(retimeCaptions(words, "hi there big world", 0, 5)).toEqual([
      { word: "hi", startSec: 1, endSec: 1.25 },
      { word: "there", startSec: 1.25, endSec: 1.5 },
      { word: "big", startSec: 1.5, endSec: 1.75 },
      { word: "world", startSec: 1.75, endSec: 2 },
      { word: "later", startSec: 9, endSec: 9.5 },
    ]);
  });

  it("empty text removes the captions inside the clip only", () => {
    expect(retimeCaptions(words, "  ", 0, 5)).toEqual([{ word: "later", startSec: 9, endSec: 9.5 }]);
  });
});

describe("parseClipEdit", () => {
  const clip = { status: "pending", postCount: 0, masterDurationSec: 30 } as Clip;
  const source = { creatorName: "Ana", faceCam: null } as Source;
  const ok = { title: "T", hook: "", captionText: "", layout: "full", startSec: 1, endSec: 20 };

  it("accepts a valid trim and clamps a tiny overshoot to the end of the video", () => {
    expect(parseClipEdit({ ...ok, endSec: 30.04 }, clip, source)).toMatchObject({ startSec: 1, endSec: 30 });
  });

  it.each([
    [{ startSec: -0.5 }, "before the beginning"],
    [{ endSec: 31 }, "after the end"],
    [{ startSec: 10, endSec: 12 }, "at least 3 seconds"],
    [{ startSec: 0, endSec: 30, layout: "huge" }, "Pick a layout"],
    [{ title: "  " }, "Enter the title"],
  ])("refuses %o", (patch, message) => {
    expect(() => parseClipEdit({ ...ok, ...patch }, clip, source)).toThrow(message);
  });

  it("refuses clips longer than 60 s and posted clips", () => {
    expect(() => parseClipEdit({ ...ok, startSec: 0, endSec: 61 }, { ...clip, masterDurationSec: 90 }, source)).toThrow("60 seconds");
    expect(() => parseClipEdit(ok, { ...clip, postCount: 1 }, source)).toThrow("already posted");
  });
});
