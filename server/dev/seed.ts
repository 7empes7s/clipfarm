import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ClipsRepo } from "../clips/repo.js";
import type { SourcesRepo } from "../sources/repo.js";
import { generateSample } from "../tools/ffmpeg.js";

/**
 * Demo and e2e only (CLIPFARM_FAKES=1): a campaign plus a pending 9:16 clip made from a generated
 * test pattern, so posting can be tried before the picks-and-render step exists.
 */
export function demoClipSeeder({ sources, clips, mediaDir }: { sources: SourcesRepo; clips: ClipsRepo; mediaDir: string }) {
  return async () => {
    mkdirSync(mediaDir, { recursive: true });
    const source = sources.create({
      creatorName: "Demo Streamer",
      channelUrls: ["https://www.twitch.tv/demostreamer"],
      bannedContent: "No story spoilers",
      permission: {
        kind: "whop-campaign",
        campaignUrl: "https://whop.com/demo/gta-clips",
        briefRules: "Clips 20-60 s. Tag #ad and #DemoClips.",
        cpmRateUsd: 1.5,
        minViews: 3000,
        allowedPlatforms: ["youtube", "tiktok", "instagram"],
        expiresAt: null,
      },
    });
    const filePath = join(mediaDir, `demo-clip-${source.id}.mp4`);
    await generateSample(filePath, 3, undefined, "1080x1920");
    return clips.create({ sourceId: source.id, vodId: null, title: "He actually landed the jump", filePath, durationSec: 3 });
  };
}
