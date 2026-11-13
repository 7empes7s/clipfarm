// Gemini on the Google Cloud credit: what it sees in a clip, what it has cost, and the thumbnails it makes.

/** What happens in a clip. Fixed: an answer from the AI with anything else is thrown away. */
export const MOMENT_TYPES = [
  "police-chase",
  "crash",
  "first-reaction",
  "funny-fail",
  "glitch",
  "stunt",
  "heist",
  "shootout",
  "rage",
  "npc-moment",
  "other",
] as const;
export type MomentType = (typeof MOMENT_TYPES)[number];

export const MOMENT_TYPE_LABELS: Record<MomentType, string> = {
  "police-chase": "Police chase",
  crash: "Crash",
  "first-reaction": "First reaction",
  "funny-fail": "Funny fail",
  glitch: "Glitch or bug",
  stunt: "Stunt",
  heist: "Heist or mission",
  shootout: "Shootout",
  rage: "Rage",
  "npc-moment": "Funny character moment",
  other: "Other",
};

/** The switches and limits on the Dashboard's Google card. */
export interface GoogleSettings {
  /** Gemini watches the best picks and its score is blended into theirs. */
  rerank: boolean;
  /** Approved clips get thumbnail options. */
  thumbnails: boolean;
  /** How much the video counts in a pick's score, 0-100 (percent). */
  weight: number;
  /** How many of the best picks are watched per video. */
  topN: number;
  /** Estimated spend a day after which Google is not called until tomorrow. */
  dailyCapEur: number;
}

export interface GoogleStatus {
  /** A Google connection is set in Settings (or demo mode stands in for it). */
  configured: boolean;
  settings: GoogleSettings;
  creditEur: number;
  /** The last day of the credit, YYYY-MM-DD. */
  expiresAt: string;
  /** Estimated from each call's token counts and list prices. */
  spentEur: number;
  todayEur: number;
  calls: number;
  /** Why Google is not being called right now (cap, 90% of the credit, credit ended), or null. */
  blocked: string | null;
}

/** One thumbnail option of a clip, at both sizes. */
export interface ClipThumb {
  id: number;
  clipId: number;
  /** "Option A", or "Frame from the clip" when Google could not be used. */
  label: string;
  /** Made by Gemini (false: a plain frame of the clip). */
  ai: boolean;
  chosen: boolean;
  /** 1080×1920, for Shorts, TikTok and Reels covers. */
  coverUrl: string;
  /** 1280×720, YouTube's thumbnail size. */
  wideUrl: string;
}

export interface ClipThumbs {
  thumbs: ClipThumb[];
  /** Options are being made right now. */
  making: boolean;
  /** Google is connected, so "Make thumbnails" gives AI options (else a plain frame). */
  ai: boolean;
}
