import { describe, expect, it } from "vitest";
import type { Permission } from "../../shared/types.js";
import { PermissionError } from "../sources/permission.js";
import { buildCaption, CAPTION_LIMITS } from "./caption.js";
import { estimateEarnings } from "./earnings.js";
import { assertCanPost } from "./gate.js";
import { nextFreeSlot } from "./spacing.js";

const NOW = new Date("2026-11-19T12:00:00Z");

function perm(overrides: Partial<Permission> = {}): Permission {
  return {
    id: 7,
    sourceId: 1,
    kind: "whop-campaign",
    campaignUrl: "https://whop.com/x",
    briefRules: "",
    note: "",
    cpmRateUsd: 1.5,
    minViews: 3000,
    allowedPlatforms: ["tiktok", "youtube"],
    expiresAt: null,
    proofUrl: null,
    proofQuote: null,
    proofCheckedAt: null,
    reviewReason: null,
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

describe("assertCanPost (permission and brief gate)", () => {
  it("refuses a source with no permission record", () => {
    expect(() => assertCanPost({ clipStatus: "approved", creatorName: "Ana", permissions: [], targets: [{ platform: "tiktok", role: "main" }], now: NOW })).toThrow(
      new PermissionError("Ana has no permission record. Add their campaign or written permission first."),
    );
  });

  it("refuses when the permission expired", () => {
    const permissions = [perm({ expiresAt: "2026-11-18T00:00:00.000Z" })];
    expect(() => assertCanPost({ clipStatus: "approved", creatorName: "Ana", permissions, targets: [{ platform: "tiktok", role: "main" }], now: NOW })).toThrow(
      "expired on 2026-11-18",
    );
  });

  it("refuses a platform the brief does not allow, even if others are allowed", () => {
    expect(() =>
      assertCanPost({ clipStatus: "approved", creatorName: "Ana", permissions: [perm()], targets: [{ platform: "tiktok", role: "main" }, { platform: "instagram", role: "main" }], now: NOW }),
    ).toThrow("does not allow posting to Instagram Reels");
  });

  it("refuses a clip that is not approved", () => {
    expect(() => assertCanPost({ clipStatus: "pending", creatorName: "Ana", permissions: [perm()], targets: [{ platform: "tiktok", role: "main" }], now: NOW })).toThrow(
      "Approve the clip before posting it.",
    );
  });

  it("returns the permission that covers each platform", () => {
    const yt = perm({ id: 9, allowedPlatforms: ["youtube"] });
    const tt = perm({ id: 8, allowedPlatforms: ["tiktok"] });
    const covering = assertCanPost({
      clipStatus: "approved",
      creatorName: "Ana",
      permissions: [tt, yt],
      targets: [{ platform: "youtube", role: "main" }, { platform: "tiktok", role: "main" }],
      now: NOW,
    });
    expect(covering.map((p) => p.id)).toEqual([9, 8]);
  });
});

describe("nextFreeSlot (spacing per account)", () => {
  const rules = { maxPerDay: 3, minGapMinutes: 90 };
  const at = (hhmm: string, day = "2026-11-19") => new Date(`${day}T${hhmm}:00.000Z`);

  it("keeps the wanted time when the account is free", () => {
    expect(nextFreeSlot([], NOW, rules)).toEqual(NOW);
    expect(nextFreeSlot([at("09:00")], NOW, rules)).toEqual(NOW);
  });

  it("moves the post to keep the gap after an earlier post", () => {
    expect(nextFreeSlot([at("11:30")], NOW, rules)).toEqual(at("13:00"));
  });

  it("moves the post past a later post that is too close", () => {
    expect(nextFreeSlot([at("12:30")], NOW, rules)).toEqual(at("14:00"));
  });

  it("chains through several posts", () => {
    expect(nextFreeSlot([at("11:00"), at("12:30")], NOW, { ...rules, maxPerDay: 5 })).toEqual(at("14:00"));
  });

  it("moves to the next day when the day is full", () => {
    const taken = [at("01:00"), at("05:00"), at("08:00")];
    expect(nextFreeSlot(taken, NOW, rules)).toEqual(at("00:00", "2026-11-20"));
  });

  it("respects the gap across midnight", () => {
    const taken = [at("01:00"), at("05:00"), at("23:30")];
    expect(nextFreeSlot(taken, NOW, rules)).toEqual(at("01:00", "2026-11-20"));
  });
});

describe("nextFreeSlot (the same clip on our other accounts)", () => {
  const rules = { maxPerDay: 3, minGapMinutes: 90 };
  const at = (hhmm: string) => new Date(`2026-11-19T${hhmm}:00.000Z`);

  it("keeps the spacing from the same clip on another account, before or after", () => {
    expect(nextFreeSlot([], NOW, rules, [NOW])).toEqual(at("13:30"));
    expect(nextFreeSlot([], NOW, rules, [at("12:30")])).toEqual(at("14:00"));
    expect(nextFreeSlot([], NOW, rules, [at("09:00")])).toEqual(NOW);
  });

  it("fits around both its own posts and the clip's other accounts", () => {
    expect(nextFreeSlot([at("13:00")], NOW, rules, [NOW])).toEqual(at("14:30"));
  });

  it("never shares the exact time, even with no spacing set", () => {
    expect(nextFreeSlot([], NOW, { maxPerDay: 3, minGapMinutes: 0 }, [NOW])).toEqual(at("12:01"));
  });
});

describe("buildCaption", () => {
  const base = {
    title: "He actually landed the jump",
    creatorName: "Big Streamer",
    channelUrl: "https://www.twitch.tv/bigstreamer",
    briefRules: "Clips 20-60 s. Must tag #ad and #BigStreamerClips, link https://whop.com/big in the caption.",
  };

  it("adds the credit, the brief's required links and hashtags", () => {
    expect(buildCaption({ ...base, platform: "tiktok" })).toBe(
      [
        "He actually landed the jump",
        "",
        "Credit: Big Streamer https://www.twitch.tv/bigstreamer",
        "https://whop.com/big",
        "#ad #BigStreamerClips",
      ].join("\n"),
    );
  });

  it("does not repeat a link that is the channel link, and strips trailing punctuation", () => {
    const caption = buildCaption({ ...base, briefRules: "Link https://www.twitch.tv/bigstreamer.", platform: "youtube" });
    expect(caption).toBe("He actually landed the jump\n\nCredit: Big Streamer https://www.twitch.tv/bigstreamer");
  });

  it("shortens the title, never the required parts, to fit X", () => {
    const caption = buildCaption({ ...base, title: "word ".repeat(80).trim(), platform: "x" });
    expect(caption.length).toBeLessThanOrEqual(CAPTION_LIMITS.x);
    expect(caption).toContain("#ad #BigStreamerClips");
    expect(caption).toContain("https://whop.com/big");
    expect(caption.split("\n")[0]!.endsWith("…")).toBe(true);
  });

  it("works with no channel link and no brief", () => {
    expect(buildCaption({ title: "Clip", creatorName: "Ana", channelUrl: null, briefRules: "", platform: "instagram" })).toBe(
      "Clip\n\nCredit: Ana",
    );
  });
});

describe("estimateEarnings", () => {
  it("pays nothing under the campaign's minimum views", () => {
    expect(estimateEarnings(2999, 1.5, 3000)).toBe(0);
  });

  it("pays views × rate per 1,000 once the minimum is reached", () => {
    expect(estimateEarnings(3000, 1.5, 3000)).toBe(4.5);
    expect(estimateEarnings(24000, 1.5, 3000)).toBe(36);
  });

  it("treats a missing minimum as none and a missing rate as unpaid", () => {
    expect(estimateEarnings(500, 2, null)).toBe(1);
    expect(estimateEarnings(500000, null, 0)).toBe(0);
    expect(estimateEarnings(null, 2, null)).toBe(0);
  });
});
