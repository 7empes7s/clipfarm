import request from "supertest";
import { describe, expect, it } from "vitest";
import type { WatchPlatform } from "../../../shared/types.js";
import { campaignInput } from "../../../test/helpers.js";
import { createApp } from "../../app.js";
import { ClipsRepo } from "../../clips/repo.js";
import { openDb } from "../../db/index.js";
import { JobQueue } from "../../jobs/queue.js";
import { FakePostingService } from "../../publish/fake.js";
import { Publisher } from "../../publish/publisher.js";
import { PostsRepo } from "../../publish/repo.js";
import { PicksRepo } from "../../picks/repo.js";
import { VodsRepo } from "../../vods/repo.js";
import { SourcesRepo } from "../repo.js";
import { NEEDS_PERMISSION } from "./match.js";
import { FakePlatformClient } from "./platforms/fake.js";
import { type ChannelCheck, PlatformError, type PlatformClient, type RemoteVod } from "./platforms/types.js";
import { WatchlistPoller } from "./poller.js";
import { parseWatchedCreator, WatchlistRepo } from "./repo.js";
import seed from "./seed.json" with { type: "json" };

const NOW = new Date("2026-11-19T23:30:00Z");

class StubClient implements PlatformClient {
  missing: string | null = null;
  calls = 0;
  vods = new Map<string, RemoteVod[]>();
  error: PlatformError | null = null;
  constructor(readonly platform: WatchPlatform) {}
  check(handle: string): Promise<ChannelCheck> {
    this.calls++;
    if (this.error) return Promise.reject(this.error);
    return Promise.resolve({ vods: this.vods.get(handle) ?? [], live: null });
  }
}

function vod(platform: WatchPlatform, id: string, publishedAt: string, title = "GTA VI launch night"): RemoteVod {
  return { platform, externalId: id, url: `https://example.com/${platform}/${id}`, title, category: null, publishedAt, durationSec: 3600 };
}

function setup(clients: PlatformClient[]) {
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db, () => NOW);
  const vods = new VodsRepo(db, () => NOW);
  // Never started: we only check what gets queued, and in what order.
  const queue = new JobQueue(db, { handlers: { ingest: async () => {} } });
  queue.stop();
  const repo = new WatchlistRepo(db, sources, () => NOW);
  const poller = new WatchlistPoller({ repo, sources, vods, queue, clients, now: () => NOW, backoffBaseMs: 60_000 });
  const jobs = () => queue.list().reverse();
  const watch = (name: string, channels: { platform: WatchPlatform; handle: string }[]) =>
    repo.create(parseWatchedCreator({ name, channels }));
  const allow = (name: string) => sources.create({ ...campaignInput(), creatorName: name });
  return { db, sources, vods, queue, repo, poller, jobs, watch, allow };
}

describe("watchlist poller", () => {
  it("watches a creator without permission but never queues their VOD", async () => {
    const twitch = new StubClient("twitch");
    twitch.vods.set("speed", [vod("twitch", "1", "2026-11-19T20:00:00Z")]);
    const { repo, poller, jobs, watch } = setup([twitch]);
    const c = watch("IShowSpeed", [{ platform: "twitch", handle: "speed" }]);
    // Even with auto-ingest forced on in the database, the gate holds.
    repo.setAutoIngest(c.id, true);
    await poller.pollAll();
    expect(jobs()).toEqual([]);
    expect(repo.get(c.id)).toMatchObject({ permissionState: "none", lastVod: { status: "skipped", skipReason: NEEDS_PERMISSION } });
  });

  it("queues a matching VOD once permission and auto-ingest are on, and never twice", async () => {
    const twitch = new StubClient("twitch");
    twitch.vods.set("kai", [vod("twitch", "1", "2026-11-19T20:00:00Z"), vod("twitch", "0", "2026-11-19T15:00:00Z", "Just chatting")]);
    const { repo, poller, jobs, watch, allow, vods } = setup([twitch]);
    const c = watch("Kai Cenat", [{ platform: "twitch", handle: "kai" }]);
    allow("Kai Cenat");
    await poller.pollAll();
    expect(repo.get(c.id).lastVod).toMatchObject({ status: "skipped", skipReason: "Auto-ingest is off" });
    expect(jobs()).toEqual([]);

    repo.setAutoIngest(c.id, true);
    await poller.pollCreator(c.id);
    await poller.pollAll();
    expect(jobs()).toHaveLength(1);
    expect(vods.get(jobs()[0]!.vodId!).url).toBe("https://example.com/twitch/1");
    expect(repo.get(c.id).lastVod).toMatchObject({ status: "queued", vodId: jobs()[0]!.vodId });
  });

  it("queues a simulcast once across platforms", async () => {
    const twitch = new StubClient("twitch");
    const kick = new StubClient("kick");
    twitch.vods.set("xqc", [vod("twitch", "t1", "2026-11-19T20:00:00Z")]);
    kick.vods.set("xqc", [vod("kick", "k1", "2026-11-19T20:03:00Z")]);
    const { db, repo, poller, jobs, watch, allow } = setup([twitch, kick]);
    const c = watch("xQc", [
      { platform: "twitch", handle: "xqc" },
      { platform: "kick", handle: "xqc" },
    ]);
    allow("xQc");
    repo.setAutoIngest(c.id, true);
    await poller.pollAll();
    await poller.pollAll();
    expect(jobs()).toHaveLength(1);
    const rows = db.prepare("SELECT platform, status, skip_reason FROM detected_vods ORDER BY platform").all();
    expect(rows).toEqual([
      { platform: "kick", status: "queued", skip_reason: null },
      { platform: "twitch", status: "skipped", skip_reason: "Same stream already queued from Kick" },
    ]);
  });

  it("does not queue a VOD that was already added by hand", async () => {
    const twitch = new StubClient("twitch");
    twitch.vods.set("kai", [vod("twitch", "1", "2026-11-19T20:00:00Z")]);
    const { repo, poller, jobs, watch, allow, vods } = setup([twitch]);
    const c = watch("Kai Cenat", [{ platform: "twitch", handle: "kai" }]);
    const s = allow("Kai Cenat");
    const manual = vods.create(s.id, "https://example.com/twitch/1");
    repo.setAutoIngest(c.id, true);
    await poller.pollAll();
    expect(jobs()).toEqual([]);
    expect(repo.get(c.id).lastVod).toMatchObject({ status: "queued", vodId: manual.id });
  });

  it("queues newest first across creators and skips VODs older than the look-back", async () => {
    const twitch = new StubClient("twitch");
    twitch.vods.set("aa", [vod("twitch", "a1", "2026-11-19T12:00:00Z"), vod("twitch", "a0", "2026-11-10T12:00:00Z")]);
    twitch.vods.set("bb", [vod("twitch", "b1", "2026-11-19T21:00:00Z")]);
    const { repo, poller, jobs, watch, allow, vods } = setup([twitch]);
    for (const n of ["aa", "bb"]) {
      repo.setAutoIngest(watch(n, [{ platform: "twitch", handle: n }]).id, true);
      allow(n);
    }
    await poller.pollAll();
    expect(jobs().map((j) => vods.get(j.vodId!).url)).toEqual(["https://example.com/twitch/b1", "https://example.com/twitch/a1"]);
  });

  it("backs off a failing platform, honours Retry-After, and recovers", async () => {
    const kick = new StubClient("kick");
    kick.error = new PlatformError("Kick asked us to slow down.", { retryAfterSec: 600 });
    const { poller, watch } = setup([kick]);
    watch("3mr", [{ platform: "kick", handle: "3mr" }]);
    await poller.pollAll();
    await poller.pollAll();
    expect(kick.calls).toBe(1);
    const status = poller.status().find((p) => p.platform === "kick")!;
    expect(status.nextTryAt).toBe("2026-11-19T23:40:00.000Z");
    expect(status.note).toMatch(/slow down/);
  });

  it("skips platforms without keys and says what to set", async () => {
    const yt = new StubClient("youtube");
    yt.missing = "Set YOUTUBE_API_KEY on the server.";
    const { poller, watch } = setup([yt]);
    watch("IShowSpeed", [{ platform: "youtube", handle: "IShowSpeed" }]);
    await poller.pollAll();
    expect(yt.calls).toBe(0);
    expect(poller.status().find((p) => p.platform === "youtube")).toMatchObject({ configured: false, note: "Set YOUTUBE_API_KEY on the server." });
  });

  it("records who is live", async () => {
    const { repo, poller, watch } = setup([new FakePlatformClient("kick", () => NOW)]);
    const live = watch("absi", [{ platform: "kick", handle: "absi" }]);
    const off = watch("sxb", [{ platform: "kick", handle: "sxb" }]);
    await poller.pollAll();
    expect(repo.get(live.id).live).toMatchObject({ platform: "kick", game: "Grand Theft Auto VI", url: "https://kick.com/absi" });
    expect(repo.get(off.id).live).toBeNull();
  });
});

describe("watchlist repo and seed", () => {
  it("accepts channel links and @handles", () => {
    const parsed = parseWatchedCreator({
      name: " Speed ",
      channels: [
        { platform: "youtube", handle: "https://www.youtube.com/@IShowSpeed" },
        { platform: "kick", handle: "@n3on" },
      ],
    });
    expect(parsed).toMatchObject({ name: "Speed", games: ["GTA VI"], program: "none", channels: [{ handle: "IShowSpeed" }, { handle: "n3on" }] });
    expect(() => parseWatchedCreator({ name: "x", channels: [{ platform: "kick", handle: "https://twitch.tv/x" }] })).toThrow(/not a channel/);
    expect(() => parseWatchedCreator({ name: "x", channels: [] })).toThrow(/Add their channel/);
  });

  it("seeds names and handles once, with the most-clipped and top GTA streamers", () => {
    const { repo } = setup([]);
    expect(repo.seedOnce(seed.creators)).toBeGreaterThanOrEqual(25);
    const names = repo.list().map((c) => c.name);
    for (const n of ["IShowSpeed", "Kai Cenat", "N3on", "CaseOh", "Adin Ross", "xQc", "JLTomy", "3mr"]) expect(names).toContain(n);
    // Removed people stay removed after a restart.
    repo.remove(repo.list()[0]!.id);
    expect(repo.seedOnce(seed.creators)).toBe(0);
    expect(repo.list()).toHaveLength(names.length - 1);
    expect(seed.sources.length).toBeGreaterThan(0);
  });

  it("finds the campaign by name, or the one linked by hand", () => {
    const { repo, watch, allow, sources } = setup([]);
    const c = watch("Kai Cenat", [{ platform: "twitch", handle: "kaicenat" }]);
    expect(repo.get(c.id).permissionState).toBe("none");
    const s = allow("kai cenat");
    expect(repo.get(c.id)).toMatchObject({ permissionState: "active", sourceId: s.id });
    const other = sources.create({ ...campaignInput({ expiresAt: "2026-11-01T00:00:00.000Z" }), creatorName: "KC (old deal)" });
    expect(repo.update(c.id, { ...parseWatchedCreator(c), sourceId: other.id }).permissionState).toBe("expired");
  });
});

describe("watchlist API", () => {
  function app() {
    const ctx = setup([new FakePlatformClient("twitch", () => NOW), new FakePlatformClient("kick", () => NOW)]);
    const clips = new ClipsRepo(ctx.db, () => NOW);
    const posts = new PostsRepo(ctx.db, () => NOW);
    const picks = new PicksRepo(ctx.db);
    const publisher = new Publisher({ sources: ctx.sources, clips, posts, service: new FakePostingService(), now: () => NOW });
    const http = createApp({ ...ctx, clips, posts, picks, publisher, watchlist: { repo: ctx.repo, poller: ctx.poller } });
    return { ...ctx, http };
  }

  it("refuses auto-ingest for a creator without permission", async () => {
    const { http, watch, jobs } = app();
    const c = watch("N3on", [{ platform: "kick", handle: "n3on" }]);
    const res = await request(http).put(`/api/watchlist/${c.id}/auto-ingest`).send({ on: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Needs permission/);
    expect(jobs()).toEqual([]);
  });

  it("turning auto-ingest on queues the creator's new VOD right away, once for a simulcast", async () => {
    const { http, watch, allow, jobs } = app();
    const c = watch("xQc", [
      { platform: "twitch", handle: "xqc" },
      { platform: "kick", handle: "xqc" },
    ]);
    allow("xQc");
    const res = await request(http).put(`/api/watchlist/${c.id}/auto-ingest`).send({ on: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ autoIngest: true, lastVod: { status: "queued" } });
    expect(jobs()).toHaveLength(1);
  });

  it("adds, edits and removes creators", async () => {
    const { http } = app();
    const created = await request(http)
      .post("/api/watchlist")
      .send({ name: "New Streamer", channels: [{ platform: "twitch", handle: "newstreamer" }], language: "EN" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ language: "en", permissionState: "none", autoIngest: false });
    const edited = await request(http)
      .put(`/api/watchlist/${created.body.id}`)
      .send({ ...created.body, program: "whop", programUrl: "https://whop.com/new/clips" });
    expect(edited.body).toMatchObject({ program: "whop", programUrl: "https://whop.com/new/clips" });
    expect((await request(http).delete(`/api/watchlist/${created.body.id}`)).status).toBe(204);
    expect((await request(http).get("/api/watchlist")).body.creators).toEqual([]);
  });
});
