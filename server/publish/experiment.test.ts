import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import type { AccountChoice, ChannelSettings, Dashboard, NewPermissionInput, Post, PostingAccount } from "../../shared/types.js";
import { campaignInput } from "../../test/helpers.js";
import { AccountStatsStore } from "../accounts/stats.js";
import { createApp } from "../app.js";
import { ClipsRepo } from "../clips/repo.js";
import { earningsRows } from "../dashboard/build.js";
import { openDb } from "../db/index.js";
import { JobQueue } from "../jobs/queue.js";
import { PicksRepo } from "../picks/repo.js";
import { parsePermission, SourcesRepo } from "../sources/repo.js";
import { VodsRepo } from "../vods/repo.js";
import { FakePostingService } from "./fake.js";
import { Publisher } from "./publisher.js";
import { PostsRepo } from "./repo.js";

const dir = mkdtempSync(join(tmpdir(), "clipfarm-experiment-"));
const videoPath = join(dir, "clip.mp4");
writeFileSync(videoPath, "not really a video");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const CHANNELS: PostingAccount[] = [
  { id: "tt-main", platform: "tiktok", name: "gtavimoments", disabled: false },
  { id: "tt-burner", platform: "tiktok", name: "gta.testing", disabled: false },
  { id: "yt-main", platform: "youtube", name: "GTA VI Moments", disabled: false },
  { id: "yt-burner", platform: "youtube", name: "Stream Bits", disabled: false },
];
const DEFAULTS: ChannelSettings = { role: "main", niche: "", maxPerDay: null, minGapMinutes: null, enabled: true, health: "healthy" };
const BURNER: ChannelSettings = { ...DEFAULTS, role: "burner" };
const NOON = new Date("2026-11-19T12:00:00.000Z");
const EXPERIMENT: NewPermissionInput = { kind: "experiment", note: "Does Content ID claim a 20 s reaction clip?", allowedPlatforms: ["tiktok", "youtube"] };

/** A creator with only an experiment record, one approved clip, and the given accounts marked burner. */
function setup(burners: string[] = ["tt-burner", "yt-burner"]) {
  let now = NOON;
  const clock = () => now;
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db, clock);
  const vods = new VodsRepo(db, clock);
  const clips = new ClipsRepo(db, clock);
  const posts = new PostsRepo(db, clock);
  const service = new FakePostingService(CHANNELS);
  service.today = clock;
  const publisher = new Publisher({ sources, clips, posts, service, now: clock });
  const accountStats = new AccountStatsStore(db, service, posts, { now: clock, accounts: publisher.accounts });
  const queue = new JobQueue(db, { handlers: { ingest: async () => {} } });
  queue.stop();
  const app = createApp({ sources, vods, picks: new PicksRepo(db), queue, clips, posts, publisher, accountStats });
  const source = sources.create({ creatorName: "Big Streamer", channelUrls: [], permission: parsePermission(EXPERIMENT, now) });
  const clip = clips.create({ sourceId: source.id, vodId: null, title: "He actually landed the jump", filePath: videoPath, durationSec: 24 });
  clips.setStatus(clip.id, "approved");
  const set = (id: string, s: ChannelSettings) => request(app).put(`/api/accounts/${id}`).send(s);
  const post = (accountIds: string[], when?: string, clipId = clip.id) => request(app).post(`/api/clips/${clipId}/posts`).send({ accountIds, when });
  const flag = (postId: number, name: string, on = true) => request(app).post(`/api/posts/${postId}/flags`).send({ flag: name, on });
  const ready = async () => {
    await publisher.syncAccounts();
    for (const id of burners) await set(id, BURNER);
  };
  return { app, db, sources, clips, posts, service, publisher, source, clip, set, post, flag, ready, setNow: (d: Date) => (now = d) };
}

const published = (service: FakePostingService) => service.calls.filter((c) => c === "publish").length;

describe("an experiment record", () => {
  it("needs no proof, only a note, and ends after 30 days unless a date is given", () => {
    expect(parsePermission(EXPERIMENT, NOON)).toMatchObject({
      kind: "experiment",
      campaignUrl: null,
      note: "Does Content ID claim a 20 s reaction clip?",
      expiresAt: "2026-12-19T12:00:00.000Z",
    });
    expect(parsePermission({ ...EXPERIMENT, expiresAt: "2026-11-25T00:00:00.000Z" }, NOON).expiresAt).toBe("2026-11-25T00:00:00.000Z");
    expect(() => parsePermission({ ...EXPERIMENT, note: "  " }, NOON)).toThrow("Add a short note on what this experiment tests.");
  });

  it("can be added to a creator we already have, and their streams can be ingested", async () => {
    const { app, sources } = setup();
    const other = sources.create(campaignInput({ expiresAt: "2026-11-01T00:00:00.000Z" }));
    const res = await request(app).post(`/api/sources/${other.id}/permissions`).send(EXPERIMENT);
    expect(res.status).toBe(201);
    expect(res.body.permissionState).toBe("active");
    expect(res.body.permissions.at(-1)).toMatchObject({ kind: "experiment", note: EXPERIMENT.note });
    const vod = await request(app).post("/api/vods").send({ sourceId: other.id, url: "https://www.twitch.tv/videos/1" });
    expect(vod.status).toBe(201);
  });

  it("marks the creator's clips as experiment clips, until a real permission is in force", async () => {
    const { app, sources, source } = setup();
    expect((await request(app).get("/api/clips")).body[0].experiment).toBe(true);
    sources.addPermission(source.id, campaignInput().permission);
    expect((await request(app).get("/api/clips")).body[0].experiment).toBe(false);
  });
});

describe("posting an experiment clip", () => {
  it("is refused with the reason when no burner account is switched on, and nothing is sent", async () => {
    const { post, set, service, ready } = setup([]);
    await ready();
    const none = await post(["tt-main"]);
    expect(none.status).toBe(403);
    expect(none.body.error).toBe(
      "Big Streamer is an experiment, which posts only to burner accounts, and no burner account is switched on. Mark an account as Burner in Dashboard, Accounts first.",
    );
    await set("tt-burner", { ...BURNER, enabled: false });
    expect((await post(["tt-burner"])).status).toBe(403);
    expect(published(service)).toBe(0);
  });

  it("offers burner accounts only: main accounts are not in the picker", async () => {
    const { app, clip, ready } = setup();
    await ready();
    const choices = (await request(app).get(`/api/clips/${clip.id}/accounts`)).body as AccountChoice[];
    expect(choices.map((c) => [c.account.id, c.canPost, c.suggested])).toEqual([
      ["tt-burner", true, true],
      ["yt-burner", true, true],
    ]);
  });

  it("refuses a main account even when it is picked by id next to a burner, posting nothing", async () => {
    const { post, service, posts, ready } = setup();
    await ready();
    const res = await post(["tt-burner", "yt-main"]);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(
      "Big Streamer is an experiment: its clips go only to burner accounts, through Post. Nothing is exported or sent to a main account.",
    );
    expect(published(service)).toBe(0);
    expect(posts.list()).toEqual([]);
  });

  it("goes out on burner accounts, now or scheduled, under the experiment record", async () => {
    const { post, source, ready } = setup();
    await ready();
    const res = await post(["tt-burner", "yt-burner"], "2026-11-20T10:00:00.000Z");
    expect(res.status).toBe(201);
    expect(res.body.posts.map((p: Post) => [p.accountId, p.experiment, p.permissionId, p.status])).toEqual([
      ["tt-burner", true, source.permissions[0]!.id, "scheduled"],
      ["yt-burner", true, source.permissions[0]!.id, "scheduled"],
    ]);
  });

  it("is refused once the experiment has run out", async () => {
    const { post, service, ready } = setup();
    await ready();
    const res = await post(["tt-burner"], "2026-12-20T10:00:00.000Z");
    expect(res.status).toBe(403);
    expect(published(service)).toBe(0);
  });

  it("with a real permission too, main accounts post under it and never under the experiment", async () => {
    const { post, sources, source, ready } = setup();
    await ready();
    sources.addPermission(source.id, campaignInput().permission);
    const real = sources.get(source.id).permissions.find((p) => p.kind === "whop-campaign")!;
    const res = await post(["tt-main", "tt-burner"]);
    expect(res.status).toBe(201);
    expect(res.body.posts.map((p: Post) => [p.accountId, p.permissionId, p.experiment])).toEqual([
      ["tt-main", real.id, false],
      ["tt-burner", real.id, false],
    ]);
  });
});

describe("exports and Whop never include experiment clips", () => {
  it("refuses the export pack for every platform", async () => {
    const { app, clip, ready } = setup();
    await ready();
    for (const platform of ["tiktok", "youtube"]) {
      const res = await request(app).get(`/api/clips/${clip.id}/export?platform=${platform}`);
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/is an experiment: its clips go only to burner accounts/);
    }
  });

  it("refuses to mark an experiment post as sent to Whop, and leaves it out of the earnings rows", async () => {
    const { app, post, posts, sources, ready } = setup();
    await ready();
    const made = (await post(["tt-burner"])).body.posts[0] as Post;
    const res = await request(app).post(`/api/posts/${made.id}/whop`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Experiment posts are never sent to Whop.");
    expect(posts.get(made.id).whopSubmittedAt).toBeNull();
    expect(earningsRows(posts.list(), sources.list(), NOON)).toEqual([]);
  });
});

describe("claims, removals and strikes", () => {
  it("a strike on a burner pauses it and says why; switching it on again clears the reason", async () => {
    const { app, post, flag, set, publisher, service, ready } = setup();
    await ready();
    const made = (await post(["tt-burner"])).body.posts[0] as Post;
    const res = await flag(made.id, "strike");
    expect(res.status).toBe(200);
    expect(res.body.flags.strike).toBe(NOON.toISOString());

    const paused = publisher.accounts.list().find((a) => a.id === "tt-burner")!;
    expect(paused.enabled).toBe(false);
    expect(paused.pausedReason).toBe(
      'Paused on 2026-11-19: a strike on "He actually landed the jump". Switch it on again in its settings when it is safe.',
    );
    const choices = (await request(app).get(`/api/clips/${made.clipId}/accounts`)).body as AccountChoice[];
    expect(choices.find((c) => c.account.id === "tt-burner")).toMatchObject({ canPost: false, note: "Paused after a strike" });
    const again = await post(["tt-burner"]);
    expect(again.status).toBe(400);
    expect(again.body.error).toMatch(/is paused after a strike/);
    expect(published(service)).toBe(1);

    // Taking the strike back does not switch the account on: the manager does that.
    await flag(made.id, "strike", false);
    expect(publisher.accounts.list().find((a) => a.id === "tt-burner")!.enabled).toBe(false);
    await set("tt-burner", BURNER);
    expect(publisher.accounts.list().find((a) => a.id === "tt-burner")).toMatchObject({ enabled: true, pausedReason: null });
  });

  it("a strike the posting service reports pauses the burner too", async () => {
    const { post, publisher, service, posts, ready } = setup();
    await ready();
    await post(["yt-burner"]);
    service.flags.set("fake-post-1", ["claim", "strike"]);
    await publisher.refresh();
    expect(posts.list()[0]!.flags).toEqual({ claim: NOON.toISOString(), removal: null, strike: NOON.toISOString() });
    expect(publisher.accounts.list().find((a) => a.id === "yt-burner")!.enabled).toBe(false);
  });

  it("are only taken for a post that went out, and for a known kind", async () => {
    const { post, flag, ready } = setup();
    await ready();
    const scheduled = (await post(["tt-burner"], "2026-11-20T10:00:00.000Z")).body.posts[0] as Post;
    expect((await flag(scheduled.id, "claim")).status).toBe(400);
    const sent = (await post(["yt-burner"])).body.posts[0] as Post;
    expect((await flag(sent.id, "takedown")).status).toBe(400);
  });

  it("add up in the Experiment view, per burner account and per creator, with the time to the first claim", async () => {
    const { app, db, sources, clips, post, flag, ready, setNow } = setup();
    await ready();
    const other = sources.create({ creatorName: "Other Streamer", channelUrls: [], permission: parsePermission(EXPERIMENT, NOON) });
    const otherClip = clips.create({ sourceId: other.id, vodId: null, title: "Chat lost it", filePath: videoPath, durationSec: 20 });
    clips.setStatus(otherClip.id, "approved");
    // A cleared creator on a main account: never part of the experiment numbers.
    const cleared = sources.create(campaignInput());
    const clearedClip = clips.create({ sourceId: cleared.id, vodId: null, title: "Cleared", filePath: videoPath, durationSec: 20 });
    clips.setStatus(clearedClip.id, "approved");
    await post(["tt-main"], undefined, clearedClip.id);

    const [tt, yt] = (await post(["tt-burner", "yt-burner"])).body.posts as Post[];
    const third = (await post(["yt-burner"], undefined, otherClip.id)).body.posts[0] as Post;
    for (const [p, views] of [[tt, 1000], [yt, 500], [third, 250]] as const) {
      await request(app).post(`/api/posts/${p!.id}/views`).send({ views });
    }
    // Spacing queues the later posts; say they all went out at noon, so the time to a claim is exact.
    db.prepare("UPDATE posts SET status = 'posted', posted_at = ?").run(NOON.toISOString());

    setNow(new Date("2026-11-19T15:00:00.000Z"));
    await flag(yt!.id, "claim");
    setNow(new Date("2026-11-19T18:00:00.000Z"));
    await flag(tt!.id, "claim");
    await flag(tt!.id, "removal");
    await flag(third!.id, "strike");

    const { experiment } = (await request(app).get("/api/dashboard")).body as Dashboard;
    const pick = (r: Dashboard["experiment"]["total"]) => [r.label, r.posts, r.views, r.claims, r.removals, r.strikes, r.firstClaimSec];
    expect(pick(experiment.total)).toEqual(["All experiment posts", 3, 1750, 2, 1, 1, 3 * 3600]);
    expect(experiment.byAccount.map(pick)).toEqual([
      ["Stream Bits · YouTube Shorts", 2, 750, 1, 0, 1, 3 * 3600],
      ["gta.testing · TikTok", 1, 1000, 1, 1, 0, 6 * 3600],
    ]);
    expect(experiment.byCreator.map(pick)).toEqual([
      ["Big Streamer", 2, 1500, 2, 1, 0, 3 * 3600],
      ["Other Streamer", 1, 250, 0, 0, 1, null],
    ]);
    expect(experiment.byAccount.map((r) => r.pausedReason !== null)).toEqual([true, false]);
  });
});
