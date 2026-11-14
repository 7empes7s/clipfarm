import { describe, expect, it } from "vitest";
import { NO_CAMPAIGN_RULES } from "../../shared/types.js";
import { composeCaption, defaultVersion, parseVersion, versionProblems, type VersionContext } from "./versions.js";

const ctx = (over: Partial<VersionContext> = {}): VersionContext => ({
  title: "TJR calls the top on live stream and the chat goes wild",
  creatorName: "TJR",
  channelUrl: "https://twitch.tv/tjr",
  briefRules: "Tag #TJR in every caption.",
  rules: { ...NO_CAMPAIGN_RULES, requiredTags: ["#tjrclips"] },
  platform: "tiktok",
  ...over,
});

describe("per-platform versions", () => {
  it("starts from the clip and the campaign: title, credit, and the required tags as hashtags", () => {
    const v = defaultVersion(ctx());
    expect(v.title).toBe("TJR calls the top on live stream and the chat goes wild");
    expect(v.hashtags).toEqual(["#TJR", "#tjrclips"]);
    expect(v.caption).toContain("Credit: TJR https://twitch.tv/tjr");
    expect(v.caption).not.toContain("#TJR");
    expect(composeCaption(v)).toBe(`${v.caption}\n\n#TJR #tjrclips`);
    expect(versionProblems(v, ctx())).toEqual([]);
  });

  it("fits each platform's caption limit: on Bluesky (300) only the title is shortened", () => {
    const long = ctx({ platform: "bluesky", title: "x".repeat(400) });
    const v = defaultVersion(long);
    expect(composeCaption(v).length).toBeLessThanOrEqual(300);
    expect(composeCaption(v)).toContain("#TJR #tjrclips");
    expect(composeCaption(v)).toContain("Credit: TJR");
    expect(versionProblems(v, long)).toEqual([]);
    // YouTube's title stops at 100.
    expect(defaultVersion(ctx({ platform: "youtube", title: "y".repeat(150) })).title.length).toBeLessThanOrEqual(100);
  });

  it("says what is wrong: a long title or caption, a missing required tag, too many hashtags, no credit", () => {
    const c = ctx({ platform: "x" });
    const v = defaultVersion(c);
    expect(versionProblems({ ...v, title: "t".repeat(101) }, c)).toContain("The title is 101 characters; X takes 100.");
    expect(versionProblems({ ...v, caption: "c".repeat(300) }, c)[0]).toMatch(/^The caption is \d+ characters with hashtags; X takes 280\.$/);
    expect(versionProblems({ ...v, hashtags: ["#tjrclips"] }, c)).toContain("The campaign requires #TJR.");
    expect(versionProblems({ ...v, hashtags: ["#TJR", "#tjrclips", "#gta6"] }, c)).toContain("X takes 2 hashtags at most without looking spammy; this has 3.");
    expect(versionProblems({ ...v, caption: "Just a title" }, c)).toContain("The caption must credit TJR.");
    expect(versionProblems({ ...v, hashtags: ["#TJR", "tjrclips"] }, c)).toContain("“tjrclips” is not a hashtag: start it with # and use letters, numbers or _.");
  });

  it("required campaign tags may go over the safe count (Threads takes 1)", () => {
    const c = ctx({ platform: "threads" });
    const v = defaultVersion(c);
    expect(v.hashtags).toEqual(["#TJR", "#tjrclips"]);
    expect(versionProblems(v, c)).toEqual([]);
    expect(versionProblems({ ...v, hashtags: [...v.hashtags, "#gta6"] }, c)).toContain("Threads takes 2 hashtags at most without looking spammy; this has 3.");
  });

  it("a tag written in the caption counts as present", () => {
    const c = ctx();
    const v = defaultVersion(c);
    expect(versionProblems({ ...v, caption: `${v.caption} #TJR`, hashtags: ["#tjrclips"] }, c)).toEqual([]);
  });

  it("parses what the sheet sends, splitting hashtags on spaces and commas", () => {
    expect(parseVersion({ title: " Hi ", caption: "Body", hashtags: "#a, #b  #a", coverId: 3 })).toEqual({ title: "Hi", caption: "Body", hashtags: ["#a", "#b"], coverId: 3 });
    expect(parseVersion({ title: "Hi", caption: "Body", hashtags: ["#a"], coverId: null }).coverId).toBeNull();
    expect(() => parseVersion({ title: 5 })).toThrow(/title/);
  });
});
