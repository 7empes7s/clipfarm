import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { ClipsRepo } from "../clips/repo.js";
import { openDb } from "../db/index.js";
import { JobQueue } from "../jobs/queue.js";
import { PicksRepo } from "../picks/repo.js";
import { FakePostingService } from "../publish/fake.js";
import { Publisher } from "../publish/publisher.js";
import { PostsRepo } from "../publish/repo.js";
import { SourcesRepo } from "../sources/repo.js";
import { PlatformError } from "../sources/watchlist/platforms/types.js";
import { VodsRepo } from "../vods/repo.js";
import { TrendRadar } from "./radar.js";
import { FakeTrendSource, type TrendSource } from "./youtube.js";

function setup(source: TrendSource = new FakeTrendSource()) {
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db);
  const clips = new ClipsRepo(db);
  const posts = new PostsRepo(db);
  const queue = new JobQueue(db, { handlers: {} });
  queue.stop();
  const trends = new TrendRadar({ db, source: () => source });
  const publisher = new Publisher({ sources, clips, posts, service: new FakePostingService() });
  return createApp({ sources, vods: new VodsRepo(db), picks: new PicksRepo(db), queue, clips, posts, publisher, trends });
}

describe("/api/trends", () => {
  it("is empty until the first refresh, then shows what is working and the quota spent", async () => {
    const app = setup();
    const before = (await request(app).get("/api/trends").expect(200)).body;
    expect(before).toMatchObject({ configured: true, refreshedAt: null, videos: 0, momentTypes: [], boostWeight: 5 });
    expect(before.quota).toEqual({ usedToday: 0, dailyBudget: 1500, refreshCost: 202 });

    const after = (await request(app).post("/api/trends/refresh").expect(200)).body;
    expect(after.videos).toBe(6);
    expect(after.quota.usedToday).toBe(201);
    expect(after.momentTypes[0]).toMatchObject({ tag: "police-chase", label: "Police chase" });
    expect(after.momentTypes[0].examples[0].url).toMatch(/^https:\/\/www\.youtube\.com\/shorts\//);
  });

  it("saves the boost weight, and refuses one that is out of range", async () => {
    const app = setup();
    expect((await request(app).put("/api/trends/weight").send({ weight: 0 }).expect(200)).body.boostWeight).toBe(0);
    const res = await request(app).put("/api/trends/weight").send({ weight: 99 }).expect(400);
    expect(res.body.error).toBe("The boost must be a whole number from 0 to 20.");
  });

  it("says in plain words why a refresh failed, and keeps it on the report", async () => {
    const down: TrendSource = {
      missing: null,
      maxUnits: () => 202,
      fetch: ({ spend }) => {
        spend(100);
        return Promise.reject(new PlatformError("YouTube refused the request (HTTP 403). Check its keys."));
      },
    };
    const app = setup(down);
    const res = await request(app).post("/api/trends/refresh").expect(502);
    expect(res.body.error).toBe("YouTube refused the request (HTTP 403). Check its keys.");
    const report = (await request(app).get("/api/trends").expect(200)).body;
    // The failed search still cost quota.
    expect(report).toMatchObject({ error: "YouTube refused the request (HTTP 403). Check its keys.", quota: { usedToday: 100 } });
  });
});
