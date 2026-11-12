import type { NewSourceInput } from "../shared/types.js";

export function campaignInput(overrides: Partial<NewSourceInput["permission"]> = {}): NewSourceInput {
  return {
    creatorName: "Test Streamer",
    channelUrls: ["https://www.twitch.tv/teststreamer"],
    bannedContent: "No story spoilers",
    permission: {
      kind: "whop-campaign",
      campaignUrl: "https://whop.com/test/campaign",
      briefRules: "Clips 20-60 s, credit the streamer.",
      cpmRateUsd: 1.5,
      minViews: 3000,
      allowedPlatforms: ["tiktok", "youtube"],
      expiresAt: null,
      ...overrides,
    },
  };
}

/** A creator who says in public that clipping is allowed, with the proof (read on 2026-11-10). */
export function allowanceInput(overrides: Partial<NewSourceInput["permission"]> = {}): NewSourceInput {
  return {
    creatorName: "Open Streamer",
    channelUrls: ["https://kick.com/openstreamer"],
    permission: {
      kind: "public-allowance",
      allowedPlatforms: ["tiktok", "youtube"],
      briefRules: "Credit the channel.",
      proofUrl: "https://openstreamer.example/clips",
      proofQuote: "You can clip my streams and post them anywhere",
      proofCheckedAt: "2026-11-10",
      ...overrides,
    },
  };
}
