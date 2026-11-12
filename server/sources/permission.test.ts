import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Permission } from "../../shared/types.js";
import { allowanceInput, campaignInput } from "../../test/helpers.js";
import { createApp } from "../app.js";
import { ClipsRepo } from "../clips/repo.js";
import { openDb } from "../db/index.js";
import { JobQueue } from "../jobs/queue.js";
import { PicksRepo } from "../picks/repo.js";
import { FakePostingService } from "../publish/fake.js";
import { Publisher } from "../publish/publisher.js";
import { PostsRepo } from "../publish/repo.js";
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
    proofUrl: null,
    proofQuote: null,
    proofCheckedAt: null,
    reviewReason: null,
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

describe("requireActivePermission with a public allowance", () => {
  const allowance = (o: Partial<Permission> = {}) =>
    perm({
      kind: "public-allowance",
      campaignUrl: null,
      cpmRateUsd: null,
      minViews: null,
      proofUrl: "https://openstreamer.example/clips",
      proofQuote: "You can clip my streams",
      proofCheckedAt: "2026-11-10T00:00:00.000Z",
      expiresAt: "2027-02-08T00:00:00.000Z",
      ...o,
    });

  it("treats it like the other kinds: active, held to its platforms", () => {
    expect(requireActivePermission("Ana", [allowance()], NOW, "tiktok").kind).toBe("public-allowance");
    expect(() => requireActivePermission("Ana", [allowance()], NOW, "x")).toThrow("does not allow posting to X");
    expect(permissionState([allowance()], NOW)).toBe("active");
  });

  it("refuses one that ran out without a new check", () => {
    const old = allowance({ expiresAt: "2026-11-11T00:00:00.000Z" });
    expect(() => requireActivePermission("Ana", [old], NOW)).toThrow("expired on 2026-11-11");
    expect(permissionState([old], NOW)).toBe("expired");
  });

  it("refuses one that needs review, saying why", () => {
    const held = allowance({ reviewReason: 'The page no longer says "You can clip my streams".' });
    expect(() => requireActivePermission("Ana", [held], NOW)).toThrow(
      new PermissionError(
        'The clipping allowance for Ana needs review: The page no longer says "You can clip my streams". Check it again in Sources.',
      ),
    );
    expect(() => requireActivePermission("Ana", [held], NOW, "tiktok")).toThrow(PermissionError);
    expect(permissionState([held], NOW)).toBe("needs-review");
  });

  it("another active record still covers a source whose allowance needs review", () => {
    const held = allowance({ id: 2, reviewReason: "The page with their words is gone." });
    expect(requireActivePermission("Ana", [held, perm()], NOW, "tiktok").id).toBe(1);
    expect(permissionState([held, perm()], NOW)).toBe("active");
  });
});

describe("parseNewSource", () => {
  it("takes a public allowance with its proof and ends it 90 days after the check", () => {
    const sources = new SourcesRepo(openDb(":memory:"), () => NOW);
    const { permissions } = sources.create(parseNewSource(allowanceInput(), NOW));
    expect(permissions[0]).toMatchObject({
      kind: "public-allowance",
      proofUrl: "https://openstreamer.example/clips",
      proofQuote: "You can clip my streams and post them anywhere",
      proofCheckedAt: "2026-11-10T00:00:00.000Z",
      expiresAt: "2027-02-08T00:00:00.000Z",
      briefRules: "Credit the channel.",
      allowedPlatforms: ["tiktok", "youtube"],
    });
  });

  it("refuses a public allowance without proof, in plain words", () => {
    expect(() => parseNewSource(allowanceInput({ proofUrl: "" }), NOW)).toThrow("Paste the link to where the creator says clipping is allowed.");
    expect(() => parseNewSource(allowanceInput({ proofUrl: "their discord" }), NOW)).toThrow("The proof link is not a web link.");
    expect(() => parseNewSource(allowanceInput({ proofQuote: "  " }), NOW)).toThrow("Copy the creator's words that allow clipping from that page.");
    expect(() => parseNewSource(allowanceInput({ proofCheckedAt: null }), NOW)).toThrow("Enter the date you checked the proof.");
    expect(() => parseNewSource(allowanceInput({ proofCheckedAt: "2026-12-25" }), NOW)).toThrow("The check date cannot be in the future.");
  });

  it("the repo itself refuses a public allowance without proof", () => {
    const sources = new SourcesRepo(openDb(":memory:"), () => NOW);
    expect(() => sources.create(allowanceInput({ proofQuote: null }))).toThrow("A public clipping allowance needs its proof");
    expect(sources.list()).toEqual([]);
  });

  it("keeps proof off the other kinds", () => {
    const parsed = parseNewSource(campaignInput({ proofUrl: "https://x.example", proofQuote: "hi", proofCheckedAt: "2026-11-10" }), NOW);
    expect(parsed.permission).toMatchObject({ proofUrl: null, proofQuote: null, proofCheckedAt: null, expiresAt: null });
  });

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
    const clips = new ClipsRepo(db, () => NOW);
    const posts = new PostsRepo(db, () => NOW);
    const publisher = new Publisher({ sources, clips, posts, service: new FakePostingService(), now: () => NOW });
    return { db, sources, app: createApp({ sources, vods, picks: new PicksRepo(db), queue, clips, posts, publisher }) };
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

  it("takes a link for a source with only a public allowance (with proof)", async () => {
    const { sources, app } = setup();
    const created = await request(app).post("/api/sources").send(allowanceInput());
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ permissionState: "active", permissions: [{ kind: "public-allowance", reviewReason: null }] });
    const res = await request(app).post("/api/vods").send({ sourceId: created.body.id, url: "https://kick.com/openstreamer/videos/1" });
    expect(res.status).toBe(201);
    expect(res.body.job).toMatchObject({ type: "ingest", status: "queued" });
    expect(sources.list()).toHaveLength(1);
  });

  it("does not save a public allowance without proof", async () => {
    const { db, app } = setup();
    const res = await request(app).post("/api/sources").send(allowanceInput({ proofUrl: null }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Paste the link to where the creator says clipping is allowed.");
    expect(db.prepare("SELECT COUNT(*) AS n FROM sources").get()).toEqual({ n: 0 });
  });

  it("refuses a link once the allowance needs review or has run out", async () => {
    const { db, sources, app } = setup();
    const held = sources.create(allowanceInput());
    sources.flagForReview(held.permissions[0]!.id, "The page with their words is gone.");
    const res = await request(app).post("/api/vods").send({ sourceId: held.id, url: "https://kick.com/openstreamer/videos/1" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(
      "The clipping allowance for Open Streamer needs review: The page with their words is gone. Check it again in Sources.",
    );
    // Read more than 90 days ago and never checked since.
    const old = sources.create({ ...allowanceInput({ proofCheckedAt: "2026-08-01" }), creatorName: "Old Proof" });
    const late = await request(app).post("/api/vods").send({ sourceId: old.id, url: "https://kick.com/oldproof/videos/1" });
    expect(late.status).toBe(403);
    expect(late.body.error).toMatch(/expired on 2026-10-30/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM vods").get()).toEqual({ n: 0 });
  });

  it("refuses links that are not web links", async () => {
    const { sources, app } = setup();
    const s = sources.create(campaignInput());
    const res = await request(app).post("/api/vods").send({ sourceId: s.id, url: "file:///etc/passwd" });
    expect(res.status).toBe(400);
  });
});
