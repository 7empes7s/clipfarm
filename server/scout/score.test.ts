import { describe, expect, it } from "vitest";
import type { ScoutFacts } from "../../shared/scout.js";
import { scoutUrls } from "../config.js";
import { planAuto } from "./auto.js";
import { agencyLinks, campaignLinks, DEFAULT_SCOUT_URLS, extractScouted, pageTitle } from "./extract.js";
import { DEMO_AGENCY, DEMO_HARBOR, DEMO_NIGHT_OWL, DEMO_PIXEL_RUSH, DEMO_SCOUT_PAGES, DEMO_SCOUT_START } from "./fake.js";
import {
  COMPETITION_FREE_USD,
  COMPETITION_MAX,
  DEFAULT_TYPICAL_VIEWS,
  NICHE_GAMING,
  NICHE_GTA,
  NICHE_OTHER,
  NICHE_TRENDING,
  RISK_AUDIENCE,
  RISK_LOCKED,
  RISK_NO_AI,
  type ScoreContext,
  scoreCampaign,
  SOURCE_KNOWN,
  SOURCE_STREAMS,
} from "./score.js";

const nightOwl = extractScouted(DEMO_SCOUT_PAGES[DEMO_NIGHT_OWL]!);
const harbor = extractScouted(DEMO_SCOUT_PAGES[DEMO_HARBOR]!);
const pixelRush = extractScouted(DEMO_SCOUT_PAGES[DEMO_PIXEL_RUSH]!);
const ctx: ScoreContext = { ourViews: {}, knownCreators: [], clipsPerDay: 3 };

describe("reading the fixture pages (3 campaigns, 1 agency page)", () => {
  it("finds the campaign pages a sitemap, a listing or an agency page points to", () => {
    expect(campaignLinks(DEMO_SCOUT_PAGES[DEMO_SCOUT_START]!, DEMO_SCOUT_START)).toEqual([DEMO_NIGHT_OWL, DEMO_HARBOR]);
    expect(campaignLinks(DEMO_SCOUT_PAGES[DEMO_AGENCY]!, DEMO_AGENCY)).toEqual([DEMO_NIGHT_OWL, DEMO_PIXEL_RUSH]);
    // A link without a host on somebody else's site is not a Content Rewards campaign.
    expect(campaignLinks('<a href="/c/campaigns/abc">x</a> <a href="https://www.contentrewards.com/c/campaigns/def?ref=1">y</a>', "https://agency.example/TJR")).toEqual([
      "https://contentrewards.com/c/campaigns/def",
    ]);
  });

  it("starts from the public sitemap and listing unless SCOUT_URLS names other public https pages", () => {
    expect(scoutUrls(undefined)).toEqual(DEFAULT_SCOUT_URLS);
    expect(scoutUrls("")).toEqual(DEFAULT_SCOUT_URLS);
    expect(scoutUrls("http://127.0.0.1/x, ftp://a.example")).toEqual(DEFAULT_SCOUT_URLS);
    expect(scoutUrls(" https://a.example/list , https://b.example/sitemap.xml")).toEqual(["https://a.example/list", "https://b.example/sitemap.xml"]);
  });

  it("finds the agency page a campaign links to, and nothing else", () => {
    expect(agencyLinks(DEMO_SCOUT_PAGES[DEMO_NIGHT_OWL]!, DEMO_NIGHT_OWL)).toEqual([DEMO_AGENCY]);
    expect(agencyLinks(DEMO_SCOUT_PAGES[DEMO_HARBOR]!, DEMO_HARBOR)).toEqual([]);
    const page = `<a href="https://reachclipping.example/TJR">Run by Reach</a> <a href="https://www.tiktok.com/@x">TikTok</a>
      <a href="/pricing">Pricing</a> <a href="http://127.0.0.1/admin">x</a> <a href="https://agency.example/a/b">deep</a>`;
    expect(agencyLinks(page, DEMO_HARBOR)).toEqual(["https://reachclipping.example/TJR"]);
    expect(pageTitle(DEMO_SCOUT_PAGES[DEMO_AGENCY]!)).toBe("Demo Clip Agency");
  });

  it("extracts pay, payout limits, budget, platforms, creator, rules, minimum views and audience", () => {
    expect(nightOwl).toEqual<ScoutFacts>({
      title: "Night Owl GTA VI stream clips",
      creatorName: "Night Owl",
      agency: null,
      channelUrls: ["https://www.twitch.tv/nightowl"],
      ratePer1kUsd: 3,
      payoutMinUsd: 2,
      payoutMaxUsd: 150,
      budgetUsedUsd: 1200,
      budgetTotalUsd: 10_000,
      budgetLeftUsd: 8800,
      platforms: ["tiktok", "youtube"],
      minViews: 2000,
      audience: [],
      rules: ["Caption must include #nightowl and #ad", "Clips must be 15 to 45 seconds long", "No gambling or giveaways"],
      lockedRequirements: 0,
      clippers: 40,
      expiresAt: null,
      ended: null,
    });
    expect(harbor).toMatchObject({
      creatorName: "Harbor Talk",
      ratePer1kUsd: 1.5,
      payoutMinUsd: null,
      payoutMaxUsd: 100,
      budgetUsedUsd: 4500,
      budgetTotalUsd: 5000,
      budgetLeftUsd: 500,
      platforms: ["tiktok", "instagram"],
      minViews: null,
      audience: ["Audience must be at least 50% US/UK viewers"],
      clippers: 25,
    });
    expect(harbor.rules).toContain("No AI content");
    expect(pixelRush).toMatchObject({
      creatorName: "Pixel Rush",
      channelUrls: ["https://kick.com/pixelrush"],
      ratePer1kUsd: 2,
      budgetLeftUsd: 7500,
      platforms: ["tiktok", "youtube", "instagram"],
      lockedRequirements: 2,
      clippers: 12,
    });
  });

  it("reads a page with one rate per platform, a budget that is used up, and nothing it does not say", () => {
    const f = extractScouted(`<h1>Two rates</h1><h2>TikTok</h2><p>Per 1K views: $0.50</p><p>Min payout: $2.00</p>
      <h2>Instagram</h2><p>Per 1K views: $0.80</p><p>Min payout: $5.00</p><p>Budget: $1,000 of $1,000</p><p>312 clippers joined</p>`);
    expect(f).toMatchObject({ ratePer1kUsd: 0.5, payoutMinUsd: 5, payoutMaxUsd: null, platforms: ["tiktok", "instagram"], budgetLeftUsd: 0, clippers: 312 });
    expect(f.ended).toBe("The campaign page says its budget is used up.");
    expect(extractScouted("<h1>Clip and earn</h1><p>Sign in to see this campaign.</p>")).toMatchObject({
      ratePer1kUsd: null,
      budgetTotalUsd: null,
      budgetLeftUsd: null,
      platforms: [],
      clippers: null,
      creatorName: null,
    });
  });
});

describe("scoreCampaign", () => {
  const step = (f: ScoutFacts, label: string, c = ctx) => scoreCampaign(f, c).steps.find((s) => s.label === label)!;

  it("follows the formula on Night Owl, and shows each line of the working", () => {
    // A clip is paid from 2,000 views (the minimum; the $2 least payout needs only 667).
    const tiktok = ((3 * DEFAULT_TYPICAL_VIEWS.tiktok) / 1000) * (DEFAULT_TYPICAL_VIEWS.tiktok / (DEFAULT_TYPICAL_VIEWS.tiktok + 2000));
    const youtube = ((3 * DEFAULT_TYPICAL_VIEWS.youtube) / 1000) * (DEFAULT_TYPICAL_VIEWS.youtube / (DEFAULT_TYPICAL_VIEWS.youtube + 2000));
    const expected = (tiktok + youtube) * (8800 / 10_000) * NICHE_GTA * SOURCE_KNOWN * (1 - 0 - 0);
    const s = scoreCampaign(nightOwl, ctx);

    expect(s.score).toBeCloseTo(expected, 4);
    expect(s.score).toBeCloseTo(8.0457, 4);
    expect(s.perDayUsd).toBe(24.14);
    expect(s.steps.map((x) => [x.label, x.value])).toEqual([
      ["TikTok", "$4.17"],
      ["YouTube Shorts", "$1.93"],
      ["Expected earnings per clip", "$6.10"],
      ["Budget left", "× 0.88"],
      ["Fit with our channels", "× 1.50"],
      ["Streams we can clip", "× 1.00"],
      ["Rule risk", "− 0%"],
      ["Competition", "− 0%"],
      ["Score", "$8.05"],
      ["Estimate per day", "$24.14"],
    ]);
    expect(s.steps[0]!.why).toBe(
      "$3.00 per 1,000 views × 2,500 views (a starting guess until we have 5 posts there) × 56% chance of reaching the 2,000 views it takes to be paid",
    );
    expect(step(nightOwl, "Budget left").why).toBe("$8,800.00 of $10,000.00 is still left.");
    expect(step(nightOwl, "Competition").why).toBe("40 clippers share $8,800.00: $220.00 each ($50.00 or more is no worry).");
  });

  it("takes off the rule risk and the competition on Harbor Talk", () => {
    const perClip = (1.5 * DEFAULT_TYPICAL_VIEWS.tiktok) / 1000 + (1.5 * DEFAULT_TYPICAL_VIEWS.instagram) / 1000;
    const competition = COMPETITION_MAX * (1 - 500 / 25 / COMPETITION_FREE_USD);
    const expected = perClip * (500 / 5000) * NICHE_OTHER * SOURCE_STREAMS * (1 - (RISK_NO_AI + RISK_AUDIENCE) - competition);
    const s = scoreCampaign(harbor, ctx);

    expect(s.score).toBeCloseTo(expected, 4);
    expect(step(harbor, "Rule risk")).toEqual({
      label: "Rule risk",
      value: "− 50%",
      why: "It forbids AI content, and our picks and captions are made by AI; it asks for a certain audience (“Audience must be at least 50% US/UK viewers”): check our account stats.",
    });
    expect(step(harbor, "Competition").value).toBe("− 24%");
    expect(step(harbor, "Streams we can clip").why).toBe("It talks about streams, but links no channel.");
  });

  it("ranks the three fixtures by score: Pixel Rush, Night Owl, Harbor Talk", () => {
    const expectedPixel = ((2 * (2500 + 1500 + 1200)) / 1000) * (7500 / 8000) * NICHE_GAMING * SOURCE_KNOWN * (1 - RISK_LOCKED);
    expect(scoreCampaign(pixelRush, ctx).score).toBeCloseTo(expectedPixel, 4);
    const ranked = [harbor, nightOwl, pixelRush].sort((a, b) => scoreCampaign(b, ctx).score - scoreCampaign(a, ctx).score);
    expect(ranked.map((f) => f.creatorName)).toEqual(["Pixel Rush", "Night Owl", "Harbor Talk"]);
  });

  it("uses our own posts once there are five: their middle, and the share that reached the minimum", () => {
    const own: ScoreContext = { ...ctx, ourViews: { tiktok: [500, 1000, 3000, 8000, 20_000], youtube: [100, 200] } };
    // TikTok: middle 3,000 views, 3 of 5 posts reached 2,000. YouTube has too few posts: the starting guess.
    expect(step(nightOwl, "TikTok", own).value).toBe("$5.40");
    expect(step(nightOwl, "TikTok", own).why).toContain("3,000 views (the middle of our own posts) × 60% chance");
    expect(step(nightOwl, "YouTube Shorts", own).value).toBe("$1.93");
  });

  it("caps a clip at the most the campaign pays, and counts a creator we already follow", () => {
    const capped = { ...pixelRush, payoutMaxUsd: 4, channelUrls: [] };
    expect(step(capped, "TikTok").value).toBe("$4.00");
    expect(step(capped, "TikTok").why).toContain("capped at $4.00 a clip");
    expect(step(capped, "Streams we can clip", { ...ctx, knownCreators: ["pixel rush"] }).why).toBe("Pixel Rush is already in our creators.");
  });

  it("lifts a creator who is in today's fastest GTA clips (trend radar)", () => {
    const hot: ScoreContext = { ...ctx, trending: ["Someone Else", "night owl"] };
    expect(step(nightOwl, "Fit with our channels", hot)).toEqual({
      label: "Fit with our channels",
      value: "× 1.80",
      why: "It is about GTA, which is what our pages post. Night Owl is in today's fastest GTA clips (trend radar).",
    });
    expect(scoreCampaign(nightOwl, hot).score).toBeCloseTo(scoreCampaign(nightOwl, ctx).score * NICHE_TRENDING, 3);
    expect(step(pixelRush, "Fit with our channels", hot).value).toBe("× 1.20");
  });

  it("scores nothing for a campaign that ended or does not say what it pays", () => {
    expect(scoreCampaign({ ...nightOwl, ended: "The campaign page says it has ended." }, ctx)).toEqual({
      score: 0,
      perDayUsd: 0,
      steps: [{ label: "Score", value: "$0.00", why: "The campaign page says it has ended." }],
    });
    expect(scoreCampaign({ ...nightOwl, ratePer1kUsd: null }, ctx).steps[0]!.why).toBe("The page does not say what it pays per 1,000 views.");
  });
});

describe("planAuto", () => {
  const joined = (permissionId: number, name: string, score: number, left: number | null = 5000, total: number | null = 10_000) => ({
    permissionId,
    name,
    score,
    budgetLeftUsd: left,
    budgetTotalUsd: total,
    stopped: null,
  });

  it("spreads the day's clips over the joined campaigns by score", () => {
    const plan = planAuto([joined(1, "Low", 1), joined(2, "High", 6), joined(3, "Mid", 3)], 10);
    expect(plan.map((r) => [r.name, r.slots])).toEqual([
      ["High", 6],
      ["Mid", 3],
      ["Low", 1],
    ]);
    // 7 clips over scores 6 : 3 : 1 is 4.2, 2.1 and 0.7: the largest remainder gets the spare one.
    expect(planAuto([joined(1, "Low", 1), joined(2, "High", 6), joined(3, "Mid", 3)], 7).map((r) => r.slots)).toEqual([4, 2, 1]);
    expect(plan.reduce((sum, r) => sum + r.slots, 0)).toBe(10);
  });

  it("pauses a campaign with under 10% of its budget left and gives its clips to the others", () => {
    const plan = planAuto([joined(1, "Nearly out", 9, 900, 10_000), joined(2, "Fresh", 3), joined(3, "Exactly 10%", 3, 1000, 10_000)], 6);
    expect(plan).toEqual([
      { permissionId: 2, name: "Fresh", score: 3, slots: 3, budgetUsedPct: 50, paused: null },
      { permissionId: 3, name: "Exactly 10%", score: 3, slots: 3, budgetUsedPct: 90, paused: null },
      { permissionId: 1, name: "Nearly out", score: 9, slots: 0, budgetUsedPct: 91, paused: "Under 10% of its budget is left (9%)." },
    ]);
  });

  it("pauses a campaign that ended, shares equally when no campaign has a score, and plans nothing without accounts", () => {
    const ended = { ...joined(1, "Over", 5), stopped: "It ended on 2026-11-01." };
    expect(planAuto([ended, joined(2, "Running", 0, null, null)], 3)).toEqual([
      { permissionId: 2, name: "Running", score: 0, slots: 3, budgetUsedPct: null, paused: null },
      { permissionId: 1, name: "Over", score: 5, slots: 0, budgetUsedPct: 50, paused: "It ended on 2026-11-01." },
    ]);
    expect(planAuto([joined(1, "A", 0), joined(2, "B", 0)], 3).map((r) => r.slots)).toEqual([2, 1]);
    // A campaign with no score gets nothing while another has one.
    expect(planAuto([joined(1, "A", 0), joined(2, "B", 2)], 3).map((r) => [r.name, r.slots])).toEqual([
      ["B", 3],
      ["A", 0],
    ]);
    expect(planAuto([joined(1, "A", 4)], 0)[0]!.slots).toBe(0);
    expect(planAuto([], 5)).toEqual([]);
  });
});
