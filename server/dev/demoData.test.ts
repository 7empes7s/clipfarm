import request from "supertest";
import { describe, expect, it } from "vitest";
import { AccountStatsStore } from "../accounts/stats.js";
import { createApp } from "../app.js";
import { ClipsRepo } from "../clips/repo.js";
import { openDb } from "../db/index.js";
import { JobQueue } from "../jobs/queue.js";
import { FakePostingService } from "../publish/fake.js";
import { Publisher } from "../publish/publisher.js";
import { PostsRepo } from "../publish/repo.js";
import { SourcesRepo } from "../sources/repo.js";
import { VodsRepo } from "../vods/repo.js";
import { DEMO_DATA_JOB, seedDemoHistory } from "./demoData.js";

// The clips part of "Load demo data" needs ffmpeg (covered by the e2e run); this checks the history
// around them on plain records.
function setup() {
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db);
  const vods = new VodsRepo(db);
  const clips = new ClipsRepo(db);
  const posts = new PostsRepo(db);
  const service = new FakePostingService();
  const accountStats = new AccountStatsStore(db, service, posts);
  const publisher = new Publisher({ sources, clips, posts, service });
  const queue = new JobQueue(db, { handlers: { [DEMO_DATA_JOB]: async () => {} } });
  queue.stop();
  const app = createApp({ sources, vods, queue, clips, posts, publisher, accountStats });
  // What makeDemoClips makes: two creators whose record allows no platform, ten clips.
  const made = {
    sources: ["Demo Streamer A", "Demo Streamer B"].map((creatorName) =>
      sources.create({ creatorName, channelUrls: [], permission: { kind: "direct-permission", allowedPlatforms: [] } }),
    ),
    clips: [] as ReturnType<ClipsRepo["create"]>[],
  };
  for (let i = 0; i < 10; i++) {
    made.clips.push(clips.create({ sourceId: made.sources[i % 2]!.id, vodId: null, title: `Demo ${i}`, filePath: "/nowhere.mp4", durationSec: 5 }));
  }
  return { app, service, made, deps: { db, sources, vods, clips, accountStats, mediaDir: "/nowhere" } };
}

describe("demo data", () => {
  it("an empty database offers it; once loaded the dashboard has every section filled", async () => {
    const { app, made, deps } = setup();
    expect((await request(app).get("/api/dashboard")).body).toMatchObject({ demoLoaded: false });
    seedDemoHistory(deps, made, new Date());

    const d = (await request(app).get("/api/dashboard")).body;
    expect(d.demoLoaded).toBe(true);
    expect(d.today).toMatchObject({ waiting: 2, approved: 2 });
    expect(d.today.earningsWeekUsd).toBeGreaterThanOrEqual(0);
    expect(d.vods).toHaveLength(2);
    expect(d.vods[0].stages.every((s: { state: string }) => s.state === "done")).toBe(true);
    expect(d.goals.every((g: { value: number | null }) => g.value !== null)).toBe(true);
    expect(d.earnings.rows.length).toBeGreaterThan(0);

    const accounts = (await request(app).get("/api/accounts")).body;
    const demo = accounts.cards.filter((c: { demo: boolean }) => c.demo);
    expect(demo).toHaveLength(3);
    expect(demo[0].followersSeries).toHaveLength(30);

    expect((await request(app).post("/api/demo-data")).status).toBe(400);
  });

  it("demo clips can never be posted: the demo campaign has ended", async () => {
    const { app, service, made, deps } = setup();
    seedDemoHistory(deps, made, new Date());
    const approved = made.clips[0]!;
    const res = await request(app).post(`/api/clips/${approved.id}/posts`).send({ accountIds: ["fake-youtube"] });
    expect(res.status).toBe(403);
    expect(service.calls).not.toContain("publish");
  });
});
