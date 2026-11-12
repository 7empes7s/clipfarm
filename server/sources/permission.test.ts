import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Permission } from "../../shared/types.js";
import { campaignInput } from "../../test/helpers.js";
import { createApp } from "../app.js";
import { openDb } from "../db/index.js";
import { JobQueue } from "../jobs/queue.js";
import { PicksRepo } from "../picks/repo.js";
import { VodsRepo } from "../vods/repo.js";
import { PermissionError, permissionState, requireActivePermission } from "./permission.js";
import { parseNewSource, SourcesRepo } from "./repo.js";

const NOW = new Date("2026-11-12T12:00:00Z");

function perm(overrides: Partial<Permission> = {}): Permission {
  return {
    id: 1,
    sourceId: 1,
    kind: "whop-campaign",
    campaignUrl: "https://whop.com/x",
    briefRules: "",
    cpmRateUsd: 1,
    minViews: 3000,
    allowedPlatforms: ["tiktok"],
    expiresAt: null,
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

describe("requireActivePermission", () => {
  it("refuses a source with no permission record", () => {
    expect(() => requireActivePermission("Ana", [], NOW)).toThrow(PermissionError);
    expect(() => requireActivePermission("Ana", [], NOW)).toThrow("Ana has no permission record");
  });

  it("refuses when every record has expired, naming the date", () => {
    const expired = perm({ expiresAt: "2026-11-01T00:00:00.000Z" });
    expect(() => requireActivePermission("Ana", [expired], NOW)).toThrow("expired on 2026-11-01");
    expect(permissionState([expired], NOW)).toBe("expired");
  });

  it("accepts a record with no end date or a future one", () => {
    expect(requireActivePermission("Ana", [perm()], NOW).id).toBe(1);
    const future = perm({ id: 2, expiresAt: "2026-12-01T00:00:00.000Z" });
    expect(requireActivePermission("Ana", [future], NOW).id).toBe(2);
    expect(permissionState([future], NOW)).toBe("active");
  });

  it("treats the exact expiry moment as expired", () => {
    expect(() => requireActivePermission("Ana", [perm({ expiresAt: NOW.toISOString() })], NOW)).toThrow(PermissionError);
  });

  it("refuses a platform the active permission does not allow", () => {
    expect(() => requireActivePermission("Ana", [perm()], NOW, "instagram")).toThrow(
      "does not allow posting to Instagram Reels",
    );
    expect(requireActivePermission("Ana", [perm()], NOW, "tiktok").id).toBe(1);
  });
});

describe("parseNewSource", () => {
  it("requires the Whop link for a Whop campaign", () => {
    expect(() => parseNewSource({ ...campaignInput({ campaignUrl: "" }) })).toThrow("Paste the Whop campaign link.");
  });

  it("requires at least one platform", () => {
    expect(() => parseNewSource(campaignInput({ allowedPlatforms: [] }))).toThrow("Pick at least one platform");
  });

  it("allows own content without a campaign link", () => {
    const parsed = parseNewSource(campaignInput({ kind: "own-content", campaignUrl: null }));
    expect(parsed.permission.kind).toBe("own-content");
  });
});

describe("POST /api/vods (server-side permission gate)", () => {
  function setup() {
    const db = openDb(":memory:");
    const sources = new SourcesRepo(db, () => NOW);
    const vods = new VodsRepo(db, () => NOW);
    // No handler runs: the queue is never started, we only check what gets enqueued.
    const queue = new JobQueue(db, { handlers: { ingest: async () => {} } });
    queue.stop();
    return { db, sources, app: createApp({ sources, vods, picks: new PicksRepo(db), queue }) };
  }

  it("refuses a source without any permission record, with a plain error", async () => {
    const { db, app } = setup();
    db.prepare("INSERT INTO sources (creator_name, created_at) VALUES ('Nobody', ?)").run(NOW.toISOString());
    const res = await request(app).post("/api/vods").send({ sourceId: 1, url: "https://www.twitch.tv/videos/1" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Nobody has no permission record. Add their campaign or written permission first.");
    expect(db.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 0 });
  });

  it("refuses a source whose permission expired", async () => {
    const { db, sources, app } = setup();
    const s = sources.create(campaignInput({ expiresAt: "2026-10-01T00:00:00.000Z" }));
    const res = await request(app).post("/api/vods").send({ sourceId: s.id, url: "https://www.twitch.tv/videos/1" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/expired on 2026-10-01/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM vods").get()).toEqual({ n: 0 });
  });

  it("accepts a source with an active permission and queues an ingest job", async () => {
    const { sources, app } = setup();
    const s = sources.create(campaignInput());
    const res = await request(app).post("/api/vods").send({ sourceId: s.id, url: "https://www.twitch.tv/videos/1" });
    expect(res.status).toBe(201);
    expect(res.body.job).toMatchObject({ type: "ingest", status: "queued", vodId: res.body.vod.id });
  });

  it("refuses links that are not web links", async () => {
    const { sources, app } = setup();
    const s = sources.create(campaignInput());
    const res = await request(app).post("/api/vods").send({ sourceId: s.id, url: "file:///etc/passwd" });
    expect(res.status).toBe(400);
  });
});
