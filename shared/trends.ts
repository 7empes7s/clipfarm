// The trend radar (what GTA clips win today) and the hook lab (A/B tests of hooks on burner
// accounts): the fixed tag lists and the shapes the Dashboard reads.

/** What happens in a clip. Fixed: a tag from the AI that is not in here is thrown away. */
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

/** How a title or hook is built. Fixed, like the moment types. */
export const HOOK_PATTERNS = ["name-reaction", "first-time", "question", "pov", "wait-for-it", "number", "quote", "other"] as const;
export type HookPattern = (typeof HOOK_PATTERNS)[number];

export const HOOK_PATTERN_LABELS: Record<HookPattern, string> = {
  "name-reaction": "Streamer name + big reaction",
  "first-time": "First time…",
  question: "A question",
  pov: "POV",
  "wait-for-it": "Wait for it",
  number: "A number or record",
  quote: "A quote",
  other: "Other",
};

/** One short video the radar found. Titles and links only: no media is ever downloaded. */
export interface TrendVideo {
  videoId: string;
  title: string;
  channel: string;
  url: string;
  durationSec: number | null;
  views: number;
  publishedAt: string;
  viewsPerHour: number;
  /** The streamer on our watchlist it is from or about; null when none. */
  streamer: string | null;
  momentType: MomentType;
  hookPattern: HookPattern;
}

export interface TrendExample {
  title: string;
  url: string;
  channel: string;
  viewsPerHour: number;
}

export interface TrendGroup<T extends string> {
  tag: T;
  label: string;
  videos: number;
  /** Views per hour of its videos, added up. */
  viewsPerHour: number;
  examples: TrendExample[];
}

export interface TrendStreamer {
  name: string;
  onWatchlist: boolean;
  videos: number;
  viewsPerHour: number;
}

/** An approved clip of ours that fits what is winning today and has not been posted. */
export interface TrendClipTip {
  clipId: number;
  title: string;
  creatorName: string;
  why: string;
}

export interface TrendReport {
  /** A YouTube key is set (Settings or the server's env). */
  configured: boolean;
  /** What to do when it cannot run, in plain words. */
  note: string | null;
  refreshedAt: string | null;
  /** Why the last refresh failed; null when it worked. */
  error: string | null;
  /** Who tagged the videos: the AI model, or plain keywords when there is no AI key. */
  tagger: "ai" | "keywords" | null;
  quota: { usedToday: number; dailyBudget: number; refreshCost: number };
  /** Points a pick gets for the top moment type of today (0 switches the boost off). */
  boostWeight: number;
  videos: number;
  momentTypes: TrendGroup<MomentType>[];
  hookPatterns: TrendGroup<HookPattern>[];
  streamers: TrendStreamer[];
  clipsToPost: TrendClipTip[];
}

export const TREND_WEIGHT_MAX = 20;

export interface HookLabSettings {
  /** Off by default. On: approved clips are tested on burner accounts and the winner goes to main. */
  on: boolean;
  /** Hours the variants run before they are compared. */
  hours: number;
}

export const HOOK_LAB_HOURS = { min: 1, max: 72, default: 6 } as const;

/** "rendering": the variants are being made. "running": they are out on burners. "stopped": it could not go on. */
export type HookTestStatus = "rendering" | "running" | "done" | "stopped";

export interface HookVariant {
  id: number;
  label: string;
  hook: string;
  title: string;
  pattern: HookPattern;
  /** The burner account it is tested on. */
  accountName: string;
  postId: number | null;
  views: number | null;
  viewsPerHour: number | null;
  winner: boolean;
}

export interface HookTest {
  id: number;
  clipId: number;
  clipTitle: string;
  status: HookTestStatus;
  /** What happened, in plain words (who won, or why it stopped). */
  note: string | null;
  createdAt: string;
  /** When the variants are compared; null until they are all sent. */
  endsAt: string | null;
  variants: HookVariant[];
  /** Posts of the winner on main accounts. */
  mainPosts: number;
}

export interface HookScore {
  pattern: HookPattern;
  label: string;
  tests: number;
  wins: number;
  avgViewsPerHour: number;
}

export interface HookLabInfo {
  settings: HookLabSettings;
  /** Why nothing can be tested right now; null when it can. */
  note: string | null;
  tests: HookTest[];
  scoreboard: HookScore[];
}
