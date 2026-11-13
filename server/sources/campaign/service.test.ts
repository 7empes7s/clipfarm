import { readFileSync } from "node:fs";
import request from "supertest";
import type { CampaignDraft } from "../../../shared/types.js";
import { describe, expect, it } from "vitest";
import { campaignInput } from "../../../test/helpers.js";
import { createApp } from "../../app.js";
import { ClipsRepo } from "../../clips/repo.js";
import { openDb } from "../../db/index.js";
import { JobQueue } from "../../jobs/queue.js";
import { PicksRepo } from "../../picks/repo.js";
import type { ChatClient } from "../../pipeline/picks/llm.js";
import { FakePostingService } from "../../publish/fake.js";
import { Publisher } from "../../publish/publisher.js";
import { PostsRepo } from "../../publish/repo.js";
import { VodsRepo } from "../../vods/repo.js";
import { PermissionError } from "../permission.js";
import { SourcesRepo } from "../repo.js";
import { FakeCampaignFetcher } from "./fake.js";
import { Campaigns } from "./service.js";

const fixture = (name: string) => readFileSync(new URL(`../../../test/fixtures/campaigns/${name}`, import.meta.url), "utf8");
const WHOP_URL = "https://whop.com/rook-valley-clipping";
const REWARDS_URL = "https://contentrewards.com/c/night-owl-radio";
const WHOP_PAGE = fixture("whop-campaign.html");

function setup(chat?: ChatClient) {
  let now = new Date("2026-11-12T12:00:00Z");
  const clock = () => now;
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db, clock);
  // The fetch layer's fake: the two saved pages, and nothing from the network.
  const fetcher = new FakeCampaignFetcher({
    [WHOP_URL]: { status: 200, text: WHOP_PAGE },
    [REWARDS_URL]: { status: 200, text: fixture("contentrewards-campaign.html") },
  });
  const campaigns = new Campaigns({ sources, fetcher, chat: () => chat ?? null, now: clock });
  const queue = new JobQueue(db, { handlers: { ingest: async () => {} } });
  queue.stop();
  const clips = new ClipsRepo(db, clock);
  const posts = new PostsRepo(db, clock);
  const publisher = new Publisher({ sources, clips, posts, service: new FakePostingService(), now: clock });
  const app = createApp({ sources, vods: new VodsRepo(db, clock), picks: new PicksRepo(db), queue, clips, posts, publisher, campaigns });
  return { app, sources, campaigns, fetcher, setNow: (d: string) => (now = new Date(d)) };
}

/** What the form sends when the manager taps Add on a draft without changing it. */
function formOf(draft: CampaignDraft) {
  return {
    creatorName: draft.creatorName,
    channelUrls: draft.channelUrls,
    permission: {
      kind: "whop-campaign",
      campaignUrl: draft.campaignUrl,
      briefRules: draft.briefRules,
      cpmRateUsd: draft.cpmRateUsd,
      minViews: draft.minViews,
      allowedPlatforms: draft.allowedPlatforms,
      expiresAt: draft.expiresAt,
      rules: draft.rules,
    },
  };
}

describe("POST /api/campaigns/read (paste a campaign link)", () => {
  it("fills the form from the campaign's public page, with nothing left to check", async () => {
    const { app, sources } = setup();
    const res = await request(app).post("/api/campaigns/read").send({ url: WHOP_URL });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      campaignUrl: WHOP_URL,
      creatorName: "Rook Valley",
      channelUrls: ["https://www.twitch.tv/rookvalley", "https://www.youtube.com/@rookvalley"],
      cpmRateUsd: 3,
      minViews: 10000,
      allowedPlatforms: ["tiktok", "youtube", "instagram"],
      expiresAt: "2026-11-30T23:59:59.000Z",
      rules: { requiredTags: ["#RookValley", "@rookvalley"], bannedWords: ["gambling", "politics", "giveaways", "copyrighted music"], minSec: 15, maxSec: 45, budgetLeftUsd: 3750 },
      check: [],
      ended: null,
      existingSource: null,
    });
    // Reading saves nothing.
    expect(sources.list()).toEqual([]);
  });

  it('marks what the page does not say "check this" and leaves it empty', async () => {
    const { app } = setup();
    const res = await request(app).post("/api/campaigns/read").send({ url: REWARDS_URL });
    expect(res.body).toMatchObject({ creatorName: "Night Owl Radio", cpmRateUsd: 1.5, minViews: null, expiresAt: null, allowedPlatforms: ["tiktok", "x"] });
    expect(res.body.check).toEqual(["minViews", "budgetLeftUsd", "requiredLinks", "requiredText", "bannedWords", "expiresAt"]);
  });

  it("takes only whop.com and contentrewards.com links, and never fetches anything else", async () => {
    const { app, fetcher } = setup();
    let fetched = 0;
    const real = fetcher.fetchPage.bind(fetcher);
    fetcher.fetchPage = (url) => (fetched++, real(url));
    for (const url of ["https://example.com/campaign", "http://127.0.0.1/whop.com", "", undefined]) {
      const res = await request(app).post("/api/campaigns/read").send({ url });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Paste a campaign link from whop.com or contentrewards.com (starting with https://).");
    }
    expect(fetched).toBe(0);
  });

  it("says so when the page cannot be read, and reads the page's text when it is pasted instead", async () => {
    const { app } = setup();
    const blocked = await request(app).post("/api/campaigns/read").send({ url: "https://whop.com/blocked-page" });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error).toBe(
      "The campaign page could not be read (it answered 403). Copy everything on the page and paste it below, or fill the form in by hand.",
    );
    const pasted = await request(app)
      .post("/api/campaigns/read")
      .send({ url: "https://whop.com/blocked-page", text: "Creator: Harbor Lane\n$2 per 1,000 views\nPlatforms: TikTok\nEnds: 2026-12-20\nNo spoilers" });
    expect(pasted.status).toBe(200);
    expect(pasted.body).toMatchObject({ creatorName: "Harbor Lane", cpmRateUsd: 2, allowedPlatforms: ["tiktok"], expiresAt: "2026-12-20T23:59:59.000Z", rules: { bannedWords: ["spoilers"] } });
  });

  it("lets a chat model fill gaps, and carries on without it when it fails", async () => {
    const filled = setup({
      name: "fake-chat",
      complete: () => Promise.resolve({ content: JSON.stringify({ creator_name: "Night Owl Radio", required_tags: ["#NightOwlRadio"], max_seconds: 60, minimum_views: 777 }), costUsd: 0 }),
    });
    const a = await request(filled.app).post("/api/campaigns/read").send({ url: REWARDS_URL });
    // 777 is not on the page, so the minimum stays empty.
    expect(a.body).toMatchObject({ minViews: null, rules: { maxSec: 60 } });
    expect(a.body.check).toContain("minViews");

    const broken = setup({ name: "fake-chat", complete: () => Promise.reject(new Error("503 from the model")) });
    const b = await request(broken.app).post("/api/campaigns/read").send({ url: REWARDS_URL });
    expect(b.status).toBe(200);
    expect(b.body.creatorName).toBe("Night Owl Radio");
  });
});

describe("POST /api/campaigns (tap Add)", () => {
  it("creates the creator with a whop-campaign permission that ends with the campaign, and stores the rules", async () => {
    const { app, sources } = setup();
    const draft = (await request(app).post("/api/campaigns/read").send({ url: WHOP_URL })).body;
    const res = await request(app).post("/api/campaigns").send(formOf(draft));
    expect(res.status).toBe(201);
    const [source] = sources.list();
    expect(source).toMatchObject({ creatorName: "Rook Valley", channelUrls: draft.channelUrls, permissionState: "active" });
    expect(source!.permissions).toHaveLength(1);
    expect(source!.permissions[0]).toMatchObject({
      kind: "whop-campaign",
      campaignUrl: WHOP_URL,
      cpmRateUsd: 3,
      minViews: 10000,
      allowedPlatforms: ["tiktok", "youtube", "instagram"],
      expiresAt: "2026-11-30T23:59:59.000Z",
      rules: { requiredTags: ["#RookValley", "@rookvalley"], requiredLinks: ["https://rook.example/play"], minSec: 15, maxSec: 45, budgetLeftUsd: 3750 },
    });
    expect(source!.permissions[0]!.briefRules).toContain("No gambling, politics or giveaways");
  });

  it("brings the same campaign up to date instead of adding it twice, and says which creator it is", async () => {
    const { app, sources } = setup();
    const draft = (await request(app).post("/api/campaigns/read").send({ url: WHOP_URL })).body;
    await request(app).post("/api/campaigns").send(formOf(draft)).expect(201);
    const again = (await request(app).post("/api/campaigns/read").send({ url: `${WHOP_URL}/?ref=mail` })).body;
    expect(again.existingSource).toBe("Rook Valley");
    await request(app)
      .post("/api/campaigns")
      .send(formOf({ ...again, cpmRateUsd: 4, channelUrls: ["https://kick.com/rookvalley"] }))
      .expect(201);
    const all = sources.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.permissions).toHaveLength(1);
    expect(all[0]!.permissions[0]).toMatchObject({ cpmRateUsd: 4 });
    expect(all[0]!.channelUrls).toEqual([...draft.channelUrls, "https://kick.com/rookvalley"]);
  });

  it("adds a new campaign to a creator already in Sources, by name", async () => {
    const { app, sources } = setup();
    sources.create({ ...campaignInput({ campaignUrl: "https://whop.com/old-rook-campaign" }), creatorName: "rook valley" });
    const draft = (await request(app).post("/api/campaigns/read").send({ url: WHOP_URL })).body;
    expect(draft.existingSource).toBe("rook valley");
    await request(app).post("/api/campaigns").send(formOf(draft)).expect(201);
    expect(sources.list()).toHaveLength(1);
    expect(sources.list()[0]!.permissions.map((p) => p.campaignUrl)).toEqual(["https://whop.com/old-rook-campaign", WHOP_URL]);
  });

  it("needs the campaign link and clean rules", async () => {
    const { app } = setup();
    const draft = (await request(app).post("/api/campaigns/read").send({ url: WHOP_URL })).body;
    const bad = await request(app).post("/api/campaigns").send(formOf({ ...draft, rules: { ...draft.rules, minSec: 50, maxSec: 20 } }));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("The shortest clip cannot be longer than the longest clip.");
    const other = await request(app).post("/api/campaigns").send({ ...formOf(draft), permission: { kind: "own-content", allowedPlatforms: ["tiktok"] } });
    expect(other.status).toBe(400);
  });
});

describe("the daily re-check", () => {
  async function added() {
    const ctx = setup();
    const draft = (await request(ctx.app).post("/api/campaigns/read").send({ url: WHOP_URL })).body;
    const source = (await request(ctx.app).post("/api/campaigns").send(formOf(draft))).body;
    return { ...ctx, sourceId: source.id as number, permissionId: source.permissions[0].id as number };
  }

  it("pauses the source of a campaign that has ended, and says why", async () => {
    const { campaigns, sources, fetcher, sourceId, permissionId, setNow } = await added();
    expect(await campaigns.checkDue()).toBe(1);
    expect(sources.get(sourceId).permissionState).toBe("active");
    expect(sources.permission(permissionId).campaignCheckedAt).toBe("2026-11-12T12:00:00.000Z");
    // Not due again the same day.
    setNow("2026-11-13T11:00:00Z");
    expect(await campaigns.checkDue()).toBe(0);

    fetcher.set(WHOP_URL, { status: 200, text: WHOP_PAGE.replace("<h2>Requirements</h2>", "<p>This campaign has ended.</p>") });
    setNow("2026-11-13T12:00:00Z");
    expect(await campaigns.checkDue()).toBe(1);
    const source = sources.get(sourceId);
    expect(source.permissionState).toBe("needs-review");
    expect(source.permissions[0]!.reviewReason).toBe("The campaign page says it has ended.");
    // Paused means the gate refuses new streams and posts, with the reason.
    expect(() => sources.assertCanUse(sourceId)).toThrow(PermissionError);
    expect(() => sources.assertCanUse(sourceId)).toThrow(
      "The campaign for Rook Valley is paused: The campaign page says it has ended. Check it again in Sources, or add a current campaign.",
    );
  });

  it("pauses when the budget is used up, keeps the budget it read, and resumes when the page is fine again", async () => {
    const { app, campaigns, sources, fetcher, sourceId, permissionId, setNow } = await added();
    fetcher.set(WHOP_URL, { status: 200, text: WHOP_PAGE.replace("$6,250 of $10,000 paid out", "$10,000 of $10,000 paid out") });
    await campaigns.checkDue();
    expect(sources.get(sourceId).permissionState).toBe("needs-review");
    expect(sources.permission(permissionId)).toMatchObject({ reviewReason: "The campaign page says its budget is used up.", rules: { budgetLeftUsd: 0, maxSec: 45 } });

    fetcher.set(WHOP_URL, { status: 200, text: WHOP_PAGE.replace("$6,250 of $10,000 paid out", "$1,000 of $10,000 paid out") });
    setNow("2026-11-13T13:00:00Z");
    const res = await request(app).post(`/api/permissions/${permissionId}/check`);
    expect(res.body).toMatchObject({ ok: true, message: "The campaign is still running. Checked just now.", source: { permissionState: "active" } });
    expect(sources.permission(permissionId).rules).toMatchObject({ budgetLeftUsd: 9000 });
  });

  it("pauses when the page is gone or shows an end date that has passed, and changes nothing when it cannot be read", async () => {
    const { app, campaigns, sources, fetcher, sourceId, permissionId } = await added();
    fetcher.set(WHOP_URL, { status: 503, text: "Busy" });
    const busy = await request(app).post(`/api/permissions/${permissionId}/check`);
    expect(busy.body).toMatchObject({ ok: false, message: "The campaign page could not be read (it answered 503). Nothing was changed; try again later." });
    expect(sources.get(sourceId).permissionState).toBe("active");

    fetcher.set(WHOP_URL, { status: 200, text: WHOP_PAGE.replace("November 30, 2026", "November 10, 2026") });
    expect((await campaigns.check(permissionId)).message).toBe("The campaign page says it ended on 2026-11-10. The campaign is paused: no new streams or posts under it.");

    fetcher.set(WHOP_URL, { status: 404, text: "Not found" });
    await campaigns.check(permissionId);
    expect(sources.permission(permissionId).reviewReason).toBe('The campaign page is gone (it answers "404 not found").');
  });

  it("only reads campaign pages: other links and other kinds of permission are left alone", async () => {
    const { app, campaigns, sources } = setup();
    const direct = sources.create(campaignInput({ kind: "direct-permission", campaignUrl: "https://docs.example/letter" }));
    const elsewhere = sources.create(campaignInput({ campaignUrl: "https://example.com/not-whop" }));
    expect(await campaigns.checkDue()).toBe(0);
    for (const s of [direct, elsewhere]) {
      const res = await request(app).post(`/api/permissions/${s.permissions[0]!.id}/check`);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Only a campaign with a whop.com or contentrewards.com link has a page to check.");
    }
  });
});
