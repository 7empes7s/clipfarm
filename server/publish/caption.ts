import type { Platform } from "../../shared/types.js";

/** Longest caption each platform takes (YouTube's description, TikTok/Instagram captions, an X post). */
export const CAPTION_LIMITS: Record<Platform, number> = {
  tiktok: 2200,
  youtube: 5000,
  instagram: 2200,
  x: 280,
};

export interface CaptionInput {
  title: string;
  creatorName: string;
  channelUrl: string | null;
  /** The campaign brief: any hashtags and links in it are required in the caption. */
  briefRules: string;
  platform: Platform;
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/** Hashtags and links the brief asks for, in the order they appear. */
export function briefRequirements(briefRules: string): { links: string[]; hashtags: string[] } {
  const links = unique((briefRules.match(/https?:\/\/[^\s)]+/g) ?? []).map((l) => l.replace(/[.,;:!?]+$/, "")));
  const hashtags = unique(briefRules.match(/(?<![\w/])#[\p{L}\p{N}_]+/gu) ?? []);
  return { links, hashtags };
}

/**
 * Title, then credit to the creator, then the brief's required links and hashtags. When the
 * platform's limit is tight (X), only the title is shortened; required parts always stay.
 */
export function buildCaption({ title, creatorName, channelUrl, briefRules, platform }: CaptionInput): string {
  const { links, hashtags } = briefRequirements(briefRules);
  const required = [
    channelUrl ? `Credit: ${creatorName} ${channelUrl}` : `Credit: ${creatorName}`,
    ...links.filter((l) => l !== channelUrl),
    ...(hashtags.length ? [hashtags.join(" ")] : []),
  ].join("\n");
  const room = CAPTION_LIMITS[platform] - required.length - 2;
  const head = title.trim();
  const shortTitle = head.length <= room ? head : `${head.slice(0, Math.max(0, room - 1)).trimEnd()}…`;
  return `${shortTitle}\n\n${required}`;
}
