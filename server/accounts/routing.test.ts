import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { accountsAllowedFor, noAccountReason } from "../../shared/routing.js";
import type { AccountChoice, ChannelAccount, ChannelSettings, NewSourceInput, PermissionKind, PostingAccount } from "../../shared/types.js";
import { PERMISSION_KINDS } from "../../shared/types.js";
import { campaignInput } from "../../test/helpers.js";
import { createApp } from "../app.js";
import { ClipsRepo } from "../clips/repo.js";
import { openDb } from "../db/index.js";
import { JobQueue } from "../jobs/queue.js";
import { PicksRepo } from "../picks/repo.js";
import { FakePostingService } from "../publish/fake.js";
import { Publisher } from "../publish/publisher.js";
import { PostsRepo } from "../publish/repo.js";
import { SourcesRepo } from "../sources/repo.js";
import { VodsRepo } from "../vods/repo.js";
import { parseChannelSettings } from "./repo.js";
import { AccountStatsStore } from "./stats.js";

const dir = mkdtempSync(join(tmpdir(), "clipfarm-routing-"));
const videoPath = join(dir, "clip.mp4");
writeFileSync(videoPath, "not really a video");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Account A is the Whop channel, account B takes everything else; C is a second TikTok account.
const A = "tt-whop";
const B = "tt-rest";
const C = "tt-spare";
const CHANNELS: PostingAccount[] = [
  { id: A, platform: "tiktok", name: "gtavi.whop", disabled: false },
  { id: B, platform: "tiktok", name: "gtavimoments", disabled: false },
  { id: C, platform: "tiktok", name: "gtavi.spare", disabled: false },
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
const NOT_WHOP = PERMISSION_KINDS.filter((k) => k !== "whop-campaign");
const NOW = new Date("2026-11-19T12:00:00.000Z");

function setup() {
  const clock = () => NOW;
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db, clock);
  const vods = new VodsRepo(db, clock);
  const clips = new ClipsRepo(db, clock);
  const posts = new PostsRepo(db, clock);
  const service = new FakePostingService(CHANNELS);
  const publisher = new Publisher({ sources, clips, posts, service, now: clock });
  const accountStats = new AccountStatsStore(db, service, posts, { now: clock, accounts: publisher.accounts });
  const queue = new JobQueue(db, { handlers: {} });
  queue.stop();
  const app = createApp({ sources, vods, picks: new PicksRepo(db), queue, clips, posts, publisher, accountStats });
  /** An approved clip from a new creator whose only permission is of this kind. */
  const clipOf = (kind: PermissionKind, name: string, perm: Partial<NewSourceInput["permission"]> = {}) => {
    const source = sources.create({
      ...campaignInput({ kind, campaignUrl: kind === "whop-campaign" ? "https://whop.com/test/campaign" : null, ...perm }),
      creatorName: name,
    });
    const clip = clips.create({ sourceId: source.id, vodId: null, title: `${name} lands the jump`, filePath: videoPath, durationSec: 24 });
    clips.setStatus(clip.id, "approved");
    return { clip, source };
  };
  const set = (id: string, s: Partial<ChannelSettings>) => request(app).put(`/api/accounts/${id}`).send({ ...DEFAULTS, ...s });
  const post = (clipId: number, accountIds: string[], when?: string) => request(app).post(`/api/clips/${clipId}/posts`).send({ accountIds, when });
  const offered = async (clipId: number) =>
    ((await request(app).get(`/api/clips/${clipId}/accounts`).expect(200)).body as AccountChoice[]).map((c) => [c.account.id, c.canPost, c.note]);
  return { app, service, publisher, sources, clipOf, set, post, offered };
}

/** A set to Whop only, B to everything else, C switched off. */
async function split(t: ReturnType<typeof setup>) {
  await request(t.app).post("/api/accounts/sync").expect(200);
  await t.set(A, { takes: ["whop-campaign"] }).expect(200);
  await t.set(B, { takes: NOT_WHOP }).expect(200);
  await t.set(C, { enabled: false }).expect(200);
}

describe("routing by permission kind", () => {
  it("every account takes every kind until it is told otherwise", async () => {
    const t = setup();
    const res = await request(t.app).post("/api/accounts/sync").expect(200);
    for (const card of res.body.cards as { account: ChannelAccount }[]) {
      expect(card.account).toMatchObject({ takes: [...PERMISSION_KINDS], pinnedCampaignIds: [] });
    }
    const whop = t.clipOf("whop-campaign", "Whop Streamer");
    expect((await t.offered(whop.clip.id)).map(([, canPost]) => canPost)).toEqual([true, true, true]);
  });

  it("a Whop clip schedules only to the Whop account, and a direct-permission clip only to the other", async () => {
    const t = setup();
    await split(t);
    const whop = t.clipOf("whop-campaign", "Whop Streamer");
    const direct = t.clipOf("direct-permission", "Direct Streamer");

    expect(await t.offered(whop.clip.id)).toEqual([
      [C, false, "Switched off"],
      [A, true, null],
      [B, false, "Does not take “Whop campaign” clips"],
    ]);
    expect(await t.offered(direct.clip.id)).toEqual([
      [C, false, "Switched off"],
      [A, false, "Does not take “Direct permission” clips"],
      [B, true, null],
    ]);

    // Asking for both accounts still sends each clip to its own channel only.
    const later = "2026-11-20T18:00:00.000Z";
    const sentWhop = (await t.post(whop.clip.id, [A, B], later).expect(201)).body;
    expect(sentWhop.posts.map((p: { accountId: string; status: string }) => [p.accountId, p.status])).toEqual([[A, "scheduled"]]);
    expect(sentWhop.skipped).toEqual([
      { accountId: B, accountName: "gtavimoments", reason: "gtavimoments does not take “Whop campaign” clips, so nothing was sent to it." },
    ]);
    const sentDirect = (await t.post(direct.clip.id, [A, B], later).expect(201)).body;
    expect(sentDirect.posts.map((p: { accountId: string }) => p.accountId)).toEqual([B]);
    expect(sentDirect.skipped.map((s: { accountId: string }) => s.accountId)).toEqual([A]);
    expect(t.service.published.map((i) => i.account.id)).toEqual([A, B]);

    // The Whop submission list knows which account posted the campaign clip.
    const posts = (await request(t.app).get("/api/posts").expect(200)).body as { accountId: string; accountName: string; campaignUrl: string | null }[];
    expect(posts.filter((p) => p.campaignUrl).map((p) => [p.accountId, p.accountName])).toEqual([[A, "gtavi.whop"]]);
  });

  it("with no account for the kind, nothing is posted and the reason is given in plain words", async () => {
    const t = setup();
    await split(t);
    await t.set(A, { takes: ["whop-campaign"], enabled: false }).expect(200);
    const whop = t.clipOf("whop-campaign", "Whop Streamer");

    expect((await t.offered(whop.clip.id)).map(([, canPost]) => canPost)).toEqual([false, false, false]);
    const res = await t.post(whop.clip.id, [B]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "No account takes “Whop campaign” clips yet. Tick it for an account in Dashboard, Posting accounts. Nothing was posted.",
    );
    expect((await request(t.app).post(`/api/clips/${whop.clip.id}/posts/dry-run`).send({ accountIds: [B] })).status).toBe(400);
    expect(t.service.calls).not.toContain("publish");
    expect((await request(t.app).get("/api/posts")).body).toEqual([]);

    const info = (await request(t.app).get("/api/posting").expect(200)).body as { accounts: ChannelAccount[] };
    expect(noAccountReason(whop.source.permissions, info.accounts, NOW)).toMatch(/^No account takes “Whop campaign” clips yet\./);
    expect(noAccountReason(t.clipOf("own-content", "Us").source.permissions, info.accounts, NOW)).toBeNull();
  });

  it("a creator with two kinds of permission posts under the one each account takes", async () => {
    const t = setup();
    await split(t);
    const { clip, source } = t.clipOf("whop-campaign", "Both Streamer");
    t.sources.addPermission(source.id, { kind: "direct-permission", allowedPlatforms: ["tiktok"] });
    const [whopId, directId] = t.sources.get(source.id).permissions.map((p) => p.id);
    const sent = (await t.post(clip.id, [A, B]).expect(201)).body;
    expect(sent.posts.map((p: { accountId: string; permissionId: number }) => [p.accountId, p.permissionId])).toEqual([
      [A, whopId],
      [B, directId],
    ]);
    expect(t.service.published.map((i) => i.paidPromotion)).toEqual([true, false]);
  });

  it("a Whop campaign pinned to an account posts only there, and waits while that account is off", async () => {
    const t = setup();
    await request(t.app).post("/api/accounts/sync").expect(200);
    const pinned = t.clipOf("whop-campaign", "Pinned Streamer");
    const free = t.clipOf("whop-campaign", "Free Streamer");
    const campaign = pinned.source.permissions[0]!;
    await t.set(A, { pinnedCampaignIds: [campaign.id] }).expect(200);

    expect(await t.offered(pinned.clip.id)).toEqual([
      [C, false, "This campaign is pinned to another account"],
      [A, true, null],
      [B, false, "This campaign is pinned to another account"],
    ]);
    // Other campaigns still go to any account that takes Whop clips.
    expect((await t.offered(free.clip.id)).map(([, canPost]) => canPost)).toEqual([true, true, true]);
    const sent = (await t.post(pinned.clip.id, [A, B]).expect(201)).body;
    expect(sent.posts.map((p: { accountId: string }) => p.accountId)).toEqual([A]);
    expect(sent.skipped[0].reason).toBe("gtavimoments is not the account this campaign is pinned to, so nothing was sent to it.");

    await t.set(A, { pinnedCampaignIds: [campaign.id], enabled: false }).expect(200);
    const info = (await request(t.app).get("/api/posting").expect(200)).body as { accounts: ChannelAccount[] };
    expect(accountsAllowedFor(campaign, info.accounts)).toEqual([]);
    expect((await t.post(pinned.clip.id, [B])).status).toBe(400);
  });

  it("stores 'every kind' as everything, and refuses routing that makes no sense", async () => {
    const t = setup();
    await request(t.app).post("/api/accounts/sync").expect(200);
    expect((await t.set(A, { takes: [] })).body.error).toBe("Tick at least one kind of clip, or switch the account off.");
    expect((await t.set(A, { takes: ["leaks" as never] })).body.error).toBe("Say which kinds of clips this account takes.");
    expect((await t.set(A, { takes: undefined })).status).toBe(400);
    expect((await t.set(A, { pinnedCampaignIds: ["x" as never] })).status).toBe(400);
    // A pin means nothing on an account that does not take Whop campaigns.
    expect(parseChannelSettings({ ...DEFAULTS, takes: ["own-content"], pinnedCampaignIds: [3, 3] })).toMatchObject({ takes: ["own-content"], pinnedCampaignIds: [] });
    expect(parseChannelSettings({ ...DEFAULTS, pinnedCampaignIds: [3, 3] }).pinnedCampaignIds).toEqual([3]);
  });
});
