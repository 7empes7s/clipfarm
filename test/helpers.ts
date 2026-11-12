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
