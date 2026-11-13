import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ChatClient } from "../../pipeline/picks/llm.js";
import { campaignKey, extractCampaign, fieldsToCheck, fillWithChat, isCampaignUrl, pageLines, parseChatCampaign, parseDay } from "./extract.js";

const fixture = (name: string) => readFileSync(new URL(`../../../test/fixtures/campaigns/${name}`, import.meta.url), "utf8");
const WHOP = fixture("whop-campaign.html");
const REWARDS = fixture("contentrewards-campaign.html");

describe("extractCampaign", () => {
  it("fills every field from a campaign page that states them all", () => {
    const facts = extractCampaign(WHOP);
    expect(facts).toEqual({
      creatorName: "Rook Valley",
      channelUrls: ["https://www.twitch.tv/rookvalley", "https://www.youtube.com/@rookvalley"],
      cpmRateUsd: 3,
      minViews: 10_000,
      allowedPlatforms: ["tiktok", "youtube", "instagram"],
      expiresAt: "2026-11-30T23:59:59.000Z",
      briefRules: [
        "Caption must include #RookValley and tag @rookvalley",
        "Add the link https://rook.example/play to your caption",
        `Caption must say "Clipped from Rook Valley's stream"`,
        "Clips must be 15-45 seconds long",
        "No gambling, politics or giveaways",
        "Don't use copyrighted music",
      ].join("\n"),
      rules: {
        requiredTags: ["#RookValley", "@rookvalley"],
        requiredLinks: ["https://rook.example/play"],
        requiredText: ["Clipped from Rook Valley's stream"],
        bannedWords: ["gambling", "politics", "giveaways", "copyrighted music"],
        minSec: 15,
        maxSec: 45,
        budgetLeftUsd: 3750,
      },
      ended: null,
    });
    expect(fieldsToCheck(facts)).toEqual([]);
  });

  it("leaves what a page does not say empty and marked to check, with no guessing", () => {
    const facts = extractCampaign(REWARDS);
    expect(facts).toMatchObject({
      creatorName: "Night Owl Radio",
      channelUrls: ["https://kick.com/nightowlradio"],
      // "$1,500 per 1M views" is $1.50 per 1,000.
      cpmRateUsd: 1.5,
      minViews: null,
      allowedPlatforms: ["tiktok", "x"],
      expiresAt: null,
      rules: { requiredTags: ["#NightOwlRadio"], requiredLinks: [], requiredText: [], bannedWords: [], minSec: null, maxSec: 60, budgetLeftUsd: null },
      ended: null,
    });
    expect(fieldsToCheck(facts)).toEqual(["minViews", "budgetLeftUsd", "requiredLinks", "requiredText", "bannedWords", "expiresAt"]);
  });

  it("reads nothing from scripts, the site's own links or a page that says nothing", () => {
    expect(pageLines(WHOP).join("\n")).not.toContain("$99");
    expect(extractCampaign(WHOP).channelUrls).not.toContain("https://www.youtube.com/@whop");
    const bare = extractCampaign("<html><body><h1>Clip and earn</h1><p>Sign in to see this campaign.</p></body></html>");
    expect(fieldsToCheck(bare)).toHaveLength(12);
    expect(bare.ended).toBeNull();
  });

  it("leaves the rate empty when the page gives two different ones", () => {
    expect(extractCampaign("<p>$2 per 1,000 views on TikTok</p><p>$4 per 1,000 views on YouTube</p>").cpmRateUsd).toBeNull();
    expect(extractCampaign("<p>CPM: $2.25</p>").cpmRateUsd).toBe(2.25);
  });

  it("sees that a campaign is over or out of budget", () => {
    expect(extractCampaign(WHOP.replace("<h2>Requirements</h2>", "<p>This campaign has ended.</p>")).ended).toBe("The campaign page says it has ended.");
    expect(extractCampaign("<div>Status</div><div>Ended</div>").ended).toBe("The campaign page says it has ended.");
    expect(extractCampaign(WHOP.replace("$6,250 of $10,000 paid out", "$10,000 of $10,000 paid out"))).toMatchObject({
      rules: { budgetLeftUsd: 0 },
      ended: "The campaign page says its budget is used up.",
    });
    expect(extractCampaign("<p>Budget left: $0</p>").ended).toBe("The campaign page says its budget is used up.");
    expect(extractCampaign("<p>Clip it over and over. The campaign is live.</p>").ended).toBeNull();
  });
});

describe("parseDay", () => {
  it("reads a written-out or ISO day as the end of that day, and never a bare 11/30", () => {
    expect(parseDay("November 30, 2026")).toBe("2026-11-30T23:59:59.000Z");
    expect(parseDay("on 3rd Dec 2026 at noon")).toBe("2026-12-03T23:59:59.000Z");
    expect(parseDay("2027-01-15")).toBe("2027-01-15T23:59:59.000Z");
    expect(parseDay("11/30/2026")).toBeNull();
    expect(parseDay("February 31, 2026")).toBeNull();
  });
});

describe("campaign links", () => {
  it("takes https links on whop.com and contentrewards.com only", () => {
    expect(isCampaignUrl("https://whop.com/rook-valley-clipping")).toBe(true);
    expect(isCampaignUrl("https://www.contentrewards.com/c/night-owl")).toBe(true);
    expect(isCampaignUrl("http://whop.com/x")).toBe(false);
    expect(isCampaignUrl("https://notwhop.com/x")).toBe(false);
    expect(isCampaignUrl("https://whop.com.evil.example/x")).toBe(false);
    expect(isCampaignUrl("whop")).toBe(false);
  });

  it("knows the same campaign whatever the query, www or trailing slash", () => {
    expect(campaignKey("https://www.whop.com/rook/?ref=abc#top")).toBe(campaignKey("https://whop.com/rook"));
    expect(campaignKey("https://whop.com/rook")).not.toBe(campaignKey("https://whop.com/rook2"));
  });
});

const answer = (o: Record<string, unknown>) =>
  JSON.stringify({
    creator_name: null,
    channel_urls: [],
    usd_per_1000_views: null,
    minimum_views: null,
    budget_left_usd: null,
    platforms: [],
    required_tags: [],
    required_links: [],
    required_caption_text: [],
    banned_words: [],
    min_seconds: null,
    max_seconds: null,
    end_date: null,
    ...o,
  });

describe("a chat model's reading of the page", () => {
  const page = "Night Owl Radio pays clippers. Posts need 5,000 views. Runs through 12 December 2026. Keep it clean: nothing about betting. Budget remaining 2k.";

  it("keeps only values the page itself shows", () => {
    const said = parseChatCampaign(
      answer({
        creator_name: "Night Owl Radio",
        minimum_views: 5000,
        budget_left_usd: 2000,
        end_date: "2026-12-12",
        banned_words: ["betting", "crypto"],
        // None of these are on the page: a model that guesses fills nothing.
        usd_per_1000_views: 3,
        max_seconds: 60,
        platforms: ["tiktok"],
        required_tags: ["#ad"],
        channel_urls: ["https://kick.com/nightowlradio"],
      }),
      page,
    );
    expect(said).toEqual({
      creatorName: "Night Owl Radio",
      channelUrls: [],
      cpmRateUsd: null,
      minViews: 5000,
      allowedPlatforms: [],
      expiresAt: "2026-12-12T23:59:59.000Z",
      rules: { requiredTags: [], requiredLinks: [], requiredText: [], bannedWords: ["betting"], minSec: null, maxSec: null, budgetLeftUsd: 2000 },
    });
  });

  it("refuses an answer that is not the schema's JSON", () => {
    expect(() => parseChatCampaign("Sure! Here you go", page)).toThrow("did not answer in JSON");
    expect(() => parseChatCampaign("[]", page)).toThrow("not a campaign");
    expect(parseChatCampaign(answer({ minimum_views: "5000", banned_words: "betting", end_date: "12/12/2026" }), page)).toMatchObject({
      minViews: null,
      expiresAt: null,
      rules: { bannedWords: [] },
    });
  });

  it("fills only what the page's own labels left empty", async () => {
    const asked: string[] = [];
    const chat: ChatClient = {
      name: "fake-chat",
      complete: (req) => {
        asked.push(req.user);
        return Promise.resolve({ content: answer({ creator_name: "Somebody Else", usd_per_1000_views: 9, banned_words: ["spoilers"] }), costUsd: 0 });
      },
    };
    const raw = `${REWARDS.replace("</article>", "<p>Keep spoilers out of it. 9 clips a day at most.</p></article>")}`;
    const facts = await fillWithChat(extractCampaign(raw), raw, chat);
    expect(asked[0]).toContain("Earn $1,500 per 1M views");
    // The page's labels win; the model only adds the banned word they missed.
    expect(facts).toMatchObject({ creatorName: "Night Owl Radio", cpmRateUsd: 1.5, rules: { bannedWords: ["spoilers"], requiredTags: ["#NightOwlRadio"] } });
  });
});
