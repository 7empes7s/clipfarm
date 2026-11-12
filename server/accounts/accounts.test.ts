import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import type { AccountChoice, ChannelAccount, ChannelSettings, Permission, PostingAccount } from "../../shared/types.js";
import { PERMISSION_KINDS } from "../../shared/types.js";
import { campaignInput } from "../../test/helpers.js";
import { createApp } from "../app.js";
import { ClipsRepo } from "../clips/repo.js";
import { openDb } from "../db/index.js";
import { JobQueue } from "../jobs/queue.js";
import { PicksRepo } from "../picks/repo.js";
import { FakePostingService } from "../publish/fake.js";
import { accountStatsFromPostiz } from "../publish/postiz.js";
import { Publisher } from "../publish/publisher.js";
import { PostsRepo } from "../publish/repo.js";
import { SourcesRepo } from "../sources/repo.js";
import { VodsRepo } from "../vods/repo.js";
import { accountsAllowedFor, nicheMatches, parseChannelSettings } from "./repo.js";
import { AccountStatsStore } from "./stats.js";

const dir = mkdtempSync(join(tmpdir(), "clipfarm-accounts-"));
const videoPath = join(dir, "clip.mp4");
writeFileSync(videoPath, "not really a video");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Two TikTok and two YouTube channels under different accounts, as the posting service lists them. */
const CHANNELS: PostingAccount[] = [
  { id: "tt-a", platform: "tiktok", name: "gtavimoments", disabled: false, handle: "gtavimoments", avatarUrl: null },
  { id: "tt-b", platform: "tiktok", name: "gta.testing", disabled: false },
  { id: "yt-a", platform: "youtube", name: "GTA VI Moments", disabled: false },
  { id: "yt-b", platform: "youtube", name: "Stream Bits", disabled: false },
];
const DEFAULTS: ChannelSettings = {
  role: "main",
  niche: "",
  maxPerDay: null,
  minGapMinutes: null,
  enabled: true,
  health: "healthy",
  takes: [...PERMISSION_KINDS],
  pinnedCampaignIds: [],
};
const NOON = "2026-11-19T12:00:00.000Z";

function setup(listed: PostingAccount[] = CHANNELS) {
  const clock = () => new Date(NOON);
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db, clock);
  const vods = new VodsRepo(db, clock);
  const clips = new ClipsRepo(db, clock);
  const posts = new PostsRepo(db, clock);
  const service = new FakePostingService(listed);
  service.today = clock;
  const publisher = new Publisher({ sources, clips, posts, service, now: clock, vodTitle: (id) => vods.get(id).title });
  const accountStats = new AccountStatsStore(db, service, posts, { now: clock, accounts: publisher.accounts });
  const queue = new JobQueue(db, { handlers: {} });
  queue.stop();
  const app = createApp({ sources, vods, picks: new PicksRepo(db), queue, clips, posts, publisher, accountStats });
  const source = sources.create(campaignInput());
  const clip = clips.create({ sourceId: source.id, vodId: null, title: "He actually landed the jump in GTA 6", filePath: videoPath, durationSec: 24 });
  clips.setStatus(clip.id, "approved");
  const set = (id: string, s: Partial<ChannelSettings>) => request(app).put(`/api/accounts/${id}`).send({ ...DEFAULTS, ...s });
  const post = (accountIds: string[], when?: string) => request(app).post(`/api/clips/${clip.id}/posts`).send({ accountIds, when });
  return { app, db, service, publisher, clips, clip, source, set, post };
}

const times = (body: { posts: { accountId: string; scheduledAt: string }[] }) => body.posts.map((p) => [p.accountId, p.scheduledAt]);

describe("posting accounts", () => {
  it("syncs the service's channels, one row each, as main accounts on the shared spacing", async () => {
    const { app } = setup();
    const res = await request(app).post("/api/accounts/sync").expect(200);
    const accounts = (res.body.cards as { account: ChannelAccount }[]).map((c) => c.account);
    expect(accounts.map((a) => [a.id, a.platform, a.role, a.enabled, a.health])).toEqual([
      ["tt-b", "tiktok", "main", true, "healthy"],
      ["tt-a", "tiktok", "main", true, "healthy"],
      ["yt-a", "youtube", "main", true, "healthy"],
      ["yt-b", "youtube", "main", true, "healthy"],
    ]);
    expect(accounts[1]).toMatchObject({ name: "gtavimoments", handle: "gtavimoments", niche: "", pace: { maxPerDay: 3, minGapMinutes: 90 } });
  });

  it("keeps an account's settings across syncs and drops accounts the service no longer lists", async () => {
    const { app, set, service } = setup();
    await request(app).post("/api/accounts/sync").expect(200);
    const saved = await set("tt-b", { role: "burner", niche: "GTA VI moments", maxPerDay: 1, minGapMinutes: 240 }).expect(200);
    const burner = (saved.body.cards as { account: ChannelAccount }[]).find((c) => c.account.id === "tt-b")!;
    expect(burner).toMatchObject({ plannedLast7Days: 7, account: { role: "burner", niche: "GTA VI moments", pace: { maxPerDay: 1, minGapMinutes: 240 } } });

    (service as unknown as { accounts: PostingAccount[] }).accounts = CHANNELS.filter((c) => c.id !== "yt-b");
    const info = (await request(app).get("/api/posting").expect(200)).body as { accounts: ChannelAccount[] };
    expect(info.accounts.map((a) => [a.id, a.role])).toEqual([
      ["tt-a", "main"],
      ["tt-b", "burner"],
      ["yt-a", "main"],
    ]);
  });

  it("refuses settings that make no sense, and accounts it does not know", async () => {
    const { app, set } = setup();
    await request(app).post("/api/accounts/sync").expect(200);
    expect((await set("tt-a", { role: "spare" as never })).body.error).toBe("Pick a role: main or burner.");
    expect((await set("tt-a", { maxPerDay: 0 })).body.error).toBe("Posts a day must be a whole number from 1 to 50, or empty.");
    expect((await set("tt-a", { health: "fine" as never })).status).toBe(400);
    expect((await set("nope", {})).status).toBe(404);
    expect(parseChannelSettings({ ...DEFAULTS, niche: "  GTA VI moments ", maxPerDay: "", minGapMinutes: "45" })).toEqual({
      ...DEFAULTS,
      niche: "GTA VI moments",
      minGapMinutes: 45,
    });
  });

  it("a clip approved for 3 accounts gets 3 staggered posts, each inside its account's cap and spacing", async () => {
    const { app, set, post, service } = setup();
    await request(app).post("/api/accounts/sync").expect(200);
    await set("tt-b", { role: "burner", maxPerDay: 1, minGapMinutes: 240 }).expect(200);

    const first = await post(["tt-a", "tt-b", "yt-a"]).expect(201);
    expect(first.body.skipped).toEqual([]);
    expect(times(first.body)).toEqual([
      ["tt-a", "2026-11-19T12:00:00.000Z"],
      // The burner keeps its own 240 minutes from the clip on tt-a.
      ["tt-b", "2026-11-19T16:00:00.000Z"],
      // yt-a keeps the shared 90 minutes from both.
      ["yt-a", "2026-11-19T13:30:00.000Z"],
    ]);
    expect(first.body.posts.map((p: { status: string }) => p.status)).toEqual(["posted", "scheduled", "scheduled"]);
    expect(service.published.map((i) => i.when?.toISOString() ?? "now")).toEqual(["now", "2026-11-19T16:00:00.000Z", "2026-11-19T13:30:00.000Z"]);

    // The burner's one post a day is used up, so its next one waits for tomorrow; tt-a keeps 90 minutes
    // from its own post and from the clip on the other accounts.
    const again = await post(["tt-b", "tt-a"]).expect(201);
    expect(times(again.body)).toEqual([
      ["tt-b", "2026-11-20T00:00:00.000Z"],
      ["tt-a", "2026-11-19T17:30:00.000Z"],
    ]);
  });

  it("stops new posts to an account that is switched off, and skips a banned one with a note", async () => {
    const { app, set, post, service, clip } = setup();
    await request(app).post("/api/accounts/sync").expect(200);
    await set("tt-b", { enabled: false }).expect(200);
    await set("yt-b", { health: "banned" }).expect(200);

    const res = await post(["tt-a", "tt-b", "yt-b"]).expect(201);
    expect(res.body.posts.map((p: { accountId: string }) => p.accountId)).toEqual(["tt-a"]);
    expect(res.body.skipped).toEqual([
      { accountId: "tt-b", accountName: "gta.testing", reason: "gta.testing is switched off in Posting accounts, so nothing was sent to it." },
      { accountId: "yt-b", accountName: "Stream Bits", reason: "Stream Bits is marked banned, so it was skipped." },
    ]);
    expect(service.published.map((i) => i.account.id)).toEqual(["tt-a"]);

    const none = await post(["tt-b", "yt-b"]);
    expect(none.status).toBe(400);
    expect(none.body.error).toBe(
      "gta.testing is switched off in Posting accounts, so nothing was sent to it. Stream Bits is marked banned, so it was skipped. Nothing was posted.",
    );
    expect(service.published).toHaveLength(1);

    const dry = await request(app).post(`/api/clips/${clip.id}/posts/dry-run`).send({ accountIds: ["yt-a", "yt-b"] }).expect(200);
    expect(dry.body.wouldPost.map((p: { accountId: string }) => p.accountId)).toEqual(["yt-a"]);
    expect(dry.body.skipped).toHaveLength(1);
  });

  it("the permission gate still applies per platform, whichever account is picked", async () => {
    const { db, post, service } = setup();
    db.prepare("UPDATE permissions SET allowed_platforms = '[\"tiktok\"]'").run();
    const res = await post(["tt-a", "yt-b"]);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("The permission for Test Streamer does not allow posting to YouTube Shorts.");
    expect(service.calls).not.toContain("publish");
  });

  it("the picker suggests main accounts whose niche fits the clip and says why others cannot be picked", async () => {
    const { app, db, set, clip } = setup([...CHANNELS, { id: "ig-a", platform: "instagram", name: "gtavi.moments", disabled: false }]);
    await request(app).post("/api/accounts/sync").expect(200);
    await set("tt-a", { niche: "GTA VI moments" }).expect(200);
    await set("tt-b", { role: "burner" }).expect(200);
    await set("yt-a", { niche: "Minecraft clips", health: "limited" }).expect(200);
    await set("yt-b", { health: "banned" }).expect(200);
    db.prepare("UPDATE permissions SET allowed_platforms = '[\"tiktok\",\"youtube\"]'").run();

    const choices = (await request(app).get(`/api/clips/${clip.id}/accounts`).expect(200)).body as AccountChoice[];
    expect(choices.map((c) => [c.account.id, c.canPost, c.suggested, c.note])).toEqual([
      ["ig-a", false, false, "Not in the brief"],
      ["tt-a", true, true, null],
      // A burner is picked by hand, never suggested.
      ["tt-b", true, false, null],
      ["yt-a", true, false, "Marked limited"],
      ["yt-b", false, false, "Marked banned, so it is skipped"],
    ]);
  });

  it("shows posts, views and estimated earnings per account on the dashboard", async () => {
    const { app, post } = setup();
    await post(["tt-a"]).expect(201);
    await request(app).post("/api/posts/refresh").expect(200);
    const cards = (await request(app).get("/api/accounts").expect(200)).body.cards as { accountId: string }[];
    expect(cards.find((c) => c.accountId === "tt-a")).toMatchObject({
      posts: 1,
      avgViewsPerPost: 12000,
      estimatedEarningsUsd: 18,
      claims: null,
      account: { role: "main", health: "healthy" },
    });
    expect(cards.find((c) => c.accountId === "yt-b")).toMatchObject({ posts: 0, estimatedEarningsUsd: 0 });
  });
});

describe("accountsAllowedFor", () => {
  const account = (o: Partial<ChannelAccount>): ChannelAccount => ({
    id: "a",
    platform: "tiktok",
    name: "a",
    disabled: false,
    handle: null,
    avatarUrl: null,
    ...DEFAULTS,
    pace: { maxPerDay: 3, minGapMinutes: 90 },
    pausedReason: null,
    ...o,
  });
  const permission = { id: 1, kind: "whop-campaign", allowedPlatforms: ["tiktok", "youtube"] } as Permission;

  it("returns every account that is switched on, on the platforms the permission allows, main or burner", () => {
    const accounts = [
      account({ id: "main" }),
      account({ id: "burner", role: "burner", platform: "youtube" }),
      account({ id: "off", enabled: false }),
      account({ id: "disconnected", disabled: true }),
      account({ id: "ig", platform: "instagram" }),
    ];
    expect(accountsAllowedFor(permission, accounts).map((a) => a.id)).toEqual(["main", "burner"]);
  });
});

describe("nicheMatches", () => {
  it("matches the topic words of the niche, reading VI and 6 as the same", () => {
    expect(nicheMatches("GTA VI moments", "He landed it. GTA 6 launch day stream")).toBe(true);
    expect(nicheMatches("GTA VI moments", "GTA Online heist")).toBe(false);
    expect(nicheMatches("Minecraft clips", "GTA VI launch")).toBe(false);
  });

  it("an empty niche takes any clip", () => {
    expect(nicheMatches("", "anything")).toBe(true);
    expect(nicheMatches("Best moments", "anything")).toBe(true);
  });
});

describe("claims from the posting service", () => {
  it("reads a claims or strikes number when Postiz reports one, else leaves it unknown", () => {
    const day = [{ total: "2", date: "2026-11-19" }];
    expect(accountStatsFromPostiz("a", [{ label: "Copyright Strikes", data: day }]).claims).toBe(2);
    expect(accountStatsFromPostiz("a", [{ label: "Followers", data: day }]).claims).toBeNull();
  });
});
