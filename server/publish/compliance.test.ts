import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import type { CampaignRules } from "../../shared/types.js";
import { NO_CAMPAIGN_RULES } from "../../shared/types.js";
import { campaignInput } from "../../test/helpers.js";
import { createApp } from "../app.js";
import { ClipsRepo } from "../clips/repo.js";
import { openDb } from "../db/index.js";
import { JobQueue } from "../jobs/queue.js";
import { PicksRepo } from "../picks/repo.js";
import { SourcesRepo } from "../sources/repo.js";
import { VodsRepo } from "../vods/repo.js";
import { buildCaption } from "./caption.js";
import { campaignProblems, pickerBrief } from "./compliance.js";
import { estimateEarnings } from "./earnings.js";
import { FakePostingService } from "./fake.js";
import { Publisher } from "./publisher.js";
import { PostsRepo } from "./repo.js";

const dir = mkdtempSync(join(tmpdir(), "clipfarm-compliance-"));
const videoPath = join(dir, "clip.mp4");
writeFileSync(videoPath, "not really a video");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const rules = (o: Partial<CampaignRules> = {}): CampaignRules => ({ ...NO_CAMPAIGN_RULES, ...o });
const YT = "fake-youtube";
const TT = "fake-tiktok";

describe("campaignProblems", () => {
  const base = {
    rules: rules({ requiredTags: ["#ad", "@rookvalley"], requiredLinks: ["https://rook.example/play"], requiredText: ["Clipped from Rook Valley"], bannedWords: ["gambling"], minSec: 15, maxSec: 45 }),
    allowedPlatforms: ["tiktok" as const, "youtube" as const],
    platform: "tiktok" as const,
    caption: "He landed it\n\nClipped from Rook Valley\nhttps://rook.example/play\n#AD @RookValley",
    title: "He landed it",
    hook: "No way",
    transcript: "oh my god he actually landed it",
    durationSec: 24,
  };

  it("passes a clip that keeps every rule", () => {
    expect(campaignProblems(base)).toEqual([]);
  });

  it("names a missing required tag, link or caption text", () => {
    expect(campaignProblems({ ...base, caption: "He landed it #adventure @rookvalley https://rook.example/play Clipped from Rook Valley" })).toEqual([
      "the caption is missing the required tag #ad",
    ]);
    expect(campaignProblems({ ...base, caption: "He landed it" })).toEqual([
      "the caption is missing the required tag #ad",
      "the caption is missing the required tag @rookvalley",
      "the caption is missing the required link https://rook.example/play",
      "the caption must say “Clipped from Rook Valley”",
    ]);
  });

  it("names a platform the campaign does not take, a length outside its limits and a banned word", () => {
    expect(campaignProblems({ ...base, platform: "x" })).toEqual(["the campaign does not take X posts"]);
    expect(campaignProblems({ ...base, durationSec: 52.04 })).toEqual(["the clip is 52 s long and the campaign takes 45 s at most"]);
    expect(campaignProblems({ ...base, durationSec: 9 })).toEqual(["the clip is 9 s long and the campaign takes 15 s at least"]);
    expect(campaignProblems({ ...base, title: "His GAMBLING arc" })).toEqual(["the title says “gambling”, which the campaign bans"]);
    expect(campaignProblems({ ...base, transcript: "this is not gambling, chat" })).toEqual(["“gambling” is said in the clip, which the campaign bans"]);
    // Part of another word is not the banned word.
    expect(campaignProblems({ ...base, transcript: "the gamblingest man alive" })).toEqual([]);
  });
});

describe("the campaign's rules in captions and picks", () => {
  it("puts the required tags, link and words in the caption, so an untouched clip complies", () => {
    const r = rules({ requiredTags: ["#ad"], requiredLinks: ["https://rook.example/play"], requiredText: ["Clipped from Rook Valley"] });
    const caption = buildCaption({ title: "He landed it", creatorName: "Rook Valley", channelUrl: null, briefRules: "Use #ad", rules: r, platform: "x" });
    expect(caption).toBe("He landed it\n\nCredit: Rook Valley\nClipped from Rook Valley\nhttps://rook.example/play\n#ad");
  });

  it("tells the picker the campaign's length and what it bans", () => {
    const permission = { briefRules: "Credit the streamer.", rules: rules({ minSec: 15, maxSec: 45, bannedWords: ["gambling", "politics"] }) };
    expect(pickerBrief(permission as never)).toBe("Credit the streamer.\nClip length: at least 15 s, at most 45 s.\nNever pick a moment about: gambling, politics.");
    expect(pickerBrief({ briefRules: "Credit the streamer.", rules: null } as never)).toBe("Credit the streamer.");
  });
});

describe("earnings on a Whop campaign", () => {
  it("are views × rate × 0.9: Whop keeps 10%", () => {
    expect(estimateEarnings(24_000, 1.5, 3000, 0.1)).toBe(24 * 1.5 * 0.9);
    expect(estimateEarnings(100_000, 3, null, 0.1)).toBe(270);
    expect(estimateEarnings(2999, 1.5, 3000, 0.1)).toBe(0);
  });
});

function setup(campaignRules: Partial<CampaignRules>, clip: { title?: string; durationSec?: number; said?: string } = {}) {
  const now = new Date("2026-11-19T12:00:00.000Z");
  const clock = () => now;
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db, clock);
  const clips = new ClipsRepo(db, clock);
  const posts = new PostsRepo(db, clock);
  const service = new FakePostingService();
  const publisher = new Publisher({ sources, clips, posts, service, now: clock });
  const queue = new JobQueue(db, { handlers: {} });
  queue.stop();
  const app = createApp({ sources, vods: new VodsRepo(db, clock), picks: new PicksRepo(db), queue, clips, posts, publisher });
  const source = sources.create(campaignInput({ rules: rules(campaignRules), cpmRateUsd: 2, minViews: 1000 }));
  const durationSec = clip.durationSec ?? 24;
  const made = clips.create({
    sourceId: source.id,
    vodId: null,
    title: clip.title ?? "He actually landed the jump",
    filePath: videoPath,
    durationSec,
    endSec: durationSec,
    captionWords: (clip.said ?? "oh my god he landed it").split(" ").map((word, i) => ({ word, startSec: i, endSec: i + 1 })),
  });
  clips.setStatus(made.id, "approved");
  return { app, service, sources, source, permission: source.permissions[0]!, clip: made };
}

describe("the compliance check before posting to the Whop channel", () => {
  it("posts a clip that keeps the rules, with the required tag in its caption", async () => {
    const { app, clip } = setup({ requiredTags: ["#RookValley"], maxSec: 45, bannedWords: ["gambling"] });
    const res = await request(app).post(`/api/clips/${clip.id}/posts`).send({ accountIds: [YT] });
    expect(res.status).toBe(201);
    expect(res.body.posts[0].caption).toContain("#RookValley");
  });

  it("blocks a clip that is longer than the campaign takes, posting nothing, and says why", async () => {
    const { app, service, clip } = setup({ maxSec: 20 });
    const res = await request(app).post(`/api/clips/${clip.id}/posts`).send({ accountIds: [YT, TT] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "GTA VI Moments was left out. The clip breaks the campaign's rules (the clip is 24 s long and the campaign takes 20 s at most). " +
        "gtavimoments was left out. The clip breaks the campaign's rules (the clip is 24 s long and the campaign takes 20 s at most). Nothing was posted.",
    );
    expect(service.calls.filter((c) => c === "publish")).toEqual([]);
    expect((await request(app).get("/api/posts")).body).toEqual([]);
  });

  it("blocks a clip whose title or words carry something the campaign bans", async () => {
    const said = setup({ bannedWords: ["gambling"] }, { said: "chat this is gambling now" });
    const a = await request(said.app).post(`/api/clips/${said.clip.id}/posts`).send({ accountIds: [YT] });
    expect(a.status).toBe(400);
    expect(a.body.error).toContain("“gambling” is said in the clip, which the campaign bans");
    const titled = setup({ bannedWords: ["gambling"] }, { title: "The gambling stream" });
    const b = await request(titled.app).post(`/api/clips/${titled.clip.id}/posts/dry-run`).send({ accountIds: [YT] });
    expect(b.status).toBe(400);
    expect(b.body.error).toContain("the title says “gambling”, which the campaign bans");
  });

  it("shows the reason on each account in the picker, and refuses the export too", async () => {
    const { app, clip } = setup({ maxSec: 20 });
    const choices = (await request(app).get(`/api/clips/${clip.id}/accounts`)).body as { account: { id: string }; canPost: boolean; note: string }[];
    expect(choices.find((c) => c.account.id === YT)).toMatchObject({
      canPost: false,
      note: "The clip breaks the campaign's rules (the clip is 24 s long and the campaign takes 20 s at most).",
    });
    const pack = await request(app).get(`/api/clips/${clip.id}/export?platform=youtube`);
    expect(pack.status).toBe(400);
    expect(pack.body.error).toContain("the clip is 24 s long and the campaign takes 20 s at most");
  });

  it("refuses to mark a post sent to Whop when its caption misses a tag the campaign now requires", async () => {
    const { app, sources, source, permission, clip } = setup({});
    const [post] = (await request(app).post(`/api/clips/${clip.id}/posts`).send({ accountIds: [YT] }).expect(201)).body.posts;
    // The campaign is imported again, and now asks for a tag the post went out without.
    sources.saveCampaign({ creatorName: source.creatorName, channelUrls: [], permission: { ...campaignInput().permission, rules: rules({ requiredTags: ["#ad"] }) } });
    expect(sources.permission(permission.id).rules!.requiredTags).toEqual(["#ad"]);
    const res = await request(app).post(`/api/posts/${post.id}/whop`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Not marked as sent. The clip breaks the campaign's rules (the caption is missing the required tag #ad).");
    expect((await request(app).get("/api/posts")).body[0].whopSubmittedAt).toBeNull();
  });
});

describe("the Whop steps on a post", () => {
  it("go sent, approved, paid by tap, in order, with the payout date 10 days after approval and the fee taken off", async () => {
    const { app, clip } = setup({ requiredTags: ["#ad"] });
    const [post] = (await request(app).post(`/api/clips/${clip.id}/posts`).send({ accountIds: [YT] }).expect(201)).body.posts;
    await request(app).post(`/api/posts/${post.id}/views`).send({ views: 50_000 }).expect(200);
    const step = (s: string, on = true) => request(app).post(`/api/posts/${post.id}/whop`).send({ step: s, on });

    const early = await step("approved");
    expect(early.status).toBe(400);
    expect(early.body.error).toBe("Mark it sent to Whop first.");
    expect((await step("paid")).body.error).toBe("Mark it approved by Whop first.");

    expect((await step("submitted")).body).toMatchObject({ whopSubmittedAt: "2026-11-19T12:00:00.000Z", whopApprovedAt: null, whopPayoutAt: null });
    expect((await step("approved")).body).toMatchObject({ whopApprovedAt: "2026-11-19T12:00:00.000Z", whopPayoutAt: "2026-11-29T12:00:00.000Z" });
    const paid = (await step("paid")).body;
    // 50,000 views × $2 per 1,000 × 0.9.
    expect(paid).toMatchObject({ whopPaidAt: "2026-11-19T12:00:00.000Z", estimatedEarningsUsd: 90 });

    // Taking "approved" back takes "paid" with it; "sent" stays.
    expect((await step("approved", false)).body).toMatchObject({ whopSubmittedAt: "2026-11-19T12:00:00.000Z", whopApprovedAt: null, whopPaidAt: null, whopPayoutAt: null });
    expect((await step("refunded")).status).toBe(400);
  });
});
