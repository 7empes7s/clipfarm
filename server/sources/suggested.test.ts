import request from "supertest";
import { describe, expect, it } from "vitest";
import { campaignInput } from "../../test/helpers.js";
import { createApp } from "../app.js";
import { ClipsRepo } from "../clips/repo.js";
import { openDb } from "../db/index.js";
import { JobQueue } from "../jobs/queue.js";
import { PicksRepo } from "../picks/repo.js";
import { FakePostingService } from "../publish/fake.js";
import { Publisher } from "../publish/publisher.js";
import { PostsRepo } from "../publish/repo.js";
import { VodsRepo } from "../vods/repo.js";
import { isPublicWebUrl } from "./proof.js";
import { SourcesRepo } from "./repo.js";
import seed from "./seed/public-allowance.json" with { type: "json" };
import { parseSuggested } from "./suggested.js";
import { FakePlatformClient } from "./watchlist/platforms/fake.js";
import { WatchlistPoller } from "./watchlist/poller.js";
import { WatchlistRepo } from "./watchlist/repo.js";

const NOW = new Date("2026-11-19T23:30:00Z");

const LIST = parseSuggested([
  {
    name: "Open Streamer",
    channels: [{ platform: "kick", handle: "openstreamer" }],
    language: "en",
    proofUrl: "https://openstreamer.example/clips",
    proofQuote: "You can clip my streams and post them anywhere",
    checkedOn: "2026-11-12",
    rules: "Credit the channel.",
    allowedPlatforms: ["tiktok", "youtube"],
  },
  {
    name: "Stale Proof",
    channels: [{ platform: "twitch", handle: "staleproof" }],
    language: "en",
    proofUrl: "https://stale.example/about",
    proofQuote: "Clipping is allowed",
    checkedOn: "2026-06-01",
  },
]);

function setup() {
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db, () => NOW);
  const vods = new VodsRepo(db, () => NOW);
  const queue = new JobQueue(db, { handlers: { ingest: async () => {} } });
  queue.stop();
  const repo = new WatchlistRepo(db, sources, () => NOW);
  const poller = new WatchlistPoller({ repo, sources, vods, queue, clients: [new FakePlatformClient("kick", () => NOW)], now: () => NOW });
  const clips = new ClipsRepo(db, () => NOW);
  const posts = new PostsRepo(db, () => NOW);
  const publisher = new Publisher({ sources, clips, posts, service: new FakePostingService(), now: () => NOW });
  const app = createApp({ sources, vods, picks: new PicksRepo(db), queue, clips, posts, publisher, suggested: LIST, watchlist: { repo, poller } });
  return { sources, vods, queue, repo, poller, app };
}

describe("the starter list (server/sources/seed/public-allowance.json)", () => {
  const creators = parseSuggested(seed.creators);

  it("has 10 or more creators, each with a proof link, their words and the day it was read", () => {
    expect(creators.length).toBeGreaterThanOrEqual(10);
    expect(new Set(creators.map((c) => c.name.toLowerCase())).size).toBe(creators.length);
    for (const c of creators) {
      expect(isPublicWebUrl(c.proofUrl), c.name).toBe(true);
      expect(c.proofQuote.length, c.name).toBeGreaterThanOrEqual(12);
      expect(c.checkedOn, c.name).toMatch(/^2026-\d\d-\d\d$/);
      expect(c.channels.length, c.name).toBeGreaterThanOrEqual(1);
      expect(c.allowedPlatforms.length, c.name).toBeGreaterThanOrEqual(1);
    }
  });

  it("refuses an entry without proof", () => {
    expect(() => parseSuggested([{ name: "No Proof", channels: [{ platform: "kick", handle: "noproof" }], checkedOn: "2026-11-12" }])).toThrow(
      "Paste the link to where the creator says clipping is allowed.",
    );
  });
});

describe("Add suggested creators", () => {
  it("shows each one with its proof and adds nothing until asked", async () => {
    const { app, sources } = setup();
    const res = await request(app).get("/api/sources/suggested").expect(200);
    expect(res.body[0]).toEqual({
      name: "Open Streamer",
      channels: [{ platform: "kick", handle: "openstreamer" }],
      language: "en",
      proofUrl: "https://openstreamer.example/clips",
      proofQuote: "You can clip my streams and post them anywhere",
      checkedOn: "2026-11-12",
      rules: "Credit the channel.",
      allowedPlatforms: ["tiktok", "youtube"],
      note: "",
      added: false,
    });
    expect(sources.list()).toEqual([]);
    const none = await request(app).post("/api/sources/suggested").send({ names: [] });
    expect(none.status).toBe(400);
    expect(none.body.error).toBe("Pick at least one creator to add.");
    const unknown = await request(app).post("/api/sources/suggested").send({ names: ["Somebody Else"] });
    expect(unknown.body.error).toBe('"Somebody Else" is not on the suggested list.');
    expect(sources.list()).toEqual([]);
  });

  it("adds the source with its proof and watches the creator, so their GTA VI stream is queued through the usual gate", async () => {
    const { app, sources, repo, poller, queue, vods } = setup();
    const res = await request(app).post("/api/sources/suggested").send({ names: ["Open Streamer"] });
    expect(res.status).toBe(201);
    expect(res.body.suggested.map((s: { added: boolean }) => s.added)).toEqual([true, false]);
    const [source] = sources.list();
    expect(source).toMatchObject({
      creatorName: "Open Streamer",
      channelUrls: ["https://kick.com/openstreamer"],
      permissionState: "active",
      permissions: [
        {
          kind: "public-allowance",
          proofUrl: "https://openstreamer.example/clips",
          proofCheckedAt: "2026-11-12T00:00:00.000Z",
          expiresAt: "2027-02-10T00:00:00.000Z",
          briefRules: "Credit the channel.",
        },
      ],
    });
    expect(repo.list()).toMatchObject([
      { name: "Open Streamer", program: "public", programUrl: "https://openstreamer.example/clips", sourceId: source!.id, permissionState: "active", autoIngest: true },
    ]);

    await poller.pollAll();
    expect(vods.list().map((v) => v.url)).toEqual(["https://kick.com/openstreamer/videos/fake-gta6"]);
    expect(queue.list()).toMatchObject([{ type: "ingest", status: "queued" }]);

    // Asking twice adds nothing twice.
    await request(app).post("/api/sources/suggested").send({ names: ["open streamer"] }).expect(201);
    expect(sources.list()).toHaveLength(1);
    expect(sources.list()[0]!.permissions).toHaveLength(1);
    expect(repo.list()).toHaveLength(1);
  });

  it("adds the allowance to a creator who is already a source, keeping their other record", async () => {
    const { app, sources } = setup();
    const existing = sources.create({ ...campaignInput({ expiresAt: "2026-11-01T00:00:00.000Z" }), creatorName: "open streamer" });
    await request(app).post("/api/sources/suggested").send({ names: ["Open Streamer"] }).expect(201);
    expect(sources.list()).toHaveLength(1);
    expect(sources.get(existing.id)).toMatchObject({ permissionState: "active", permissions: [{ kind: "whop-campaign" }, { kind: "public-allowance" }] });
  });

  it("a proof read more than 90 days ago comes in expired, with auto-ingest off, until it is checked again", async () => {
    const { app, sources, repo, poller, queue } = setup();
    await request(app).post("/api/sources/suggested").send({ names: ["Stale Proof"] }).expect(201);
    expect(sources.list()[0]).toMatchObject({ permissionState: "expired" });
    expect(repo.list()[0]).toMatchObject({ permissionState: "expired", autoIngest: false });
    await poller.pollAll();
    expect(queue.list()).toEqual([]);
  });
});
