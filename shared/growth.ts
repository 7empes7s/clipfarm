// The growth lab: test campaigns, per-post time series and their reports. Shared by server and client.
import type { DailyPoint, Platform } from "./types.js";

/** What a test campaign changes between its variants. */
export const TEST_VARIABLES = ["length", "hook", "time", "niche"] as const;
export type TestVariable = (typeof TEST_VARIABLES)[number];

export const TEST_VARIABLE_LABELS: Record<TestVariable, string> = {
  length: "Clip length",
  hook: "Hook wording",
  time: "Posting time",
  niche: "Niche",
};

/**
 * One arm of a test. Only the fields of the campaign's variable count: a length range, words (in
 * the hook, or about the niche), or posting times ("HH:MM", UTC).
 */
export interface Variant {
  key: string;
  label: string;
  minSec: number | null;
  maxSec: number | null;
  words: string[];
  times: string[];
}

export const SUCCESS_METRICS = ["vph24", "vph72", "views7d"] as const;
export type SuccessMetric = (typeof SUCCESS_METRICS)[number];

export const SUCCESS_METRIC_LABELS: Record<SuccessMetric, string> = {
  vph24: "Views per hour at 24 h",
  vph72: "Views per hour at 72 h",
  views7d: "Views at 7 days",
};

export const CAMPAIGN_STATUSES = ["draft", "running", "paused", "finished"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = {
  draft: "Draft",
  running: "Running",
  paused: "Paused",
  finished: "Finished",
};

export const ASSIGNMENTS = ["alternate", "random"] as const;
export type Assignment = (typeof ASSIGNMENTS)[number];

export interface GrowthCampaignInput {
  name: string;
  /** What we expect to learn, e.g. "Police chases at 20-30 s beat first reactions on TikTok". */
  hypothesis: string;
  /** Creators whose approved clips may be used; empty takes any creator. */
  sourceIds: number[];
  accountIds: string[];
  /** Posts per account per day. */
  postsPerDay: number;
  /** Times of day ("HH:MM", UTC) for the day's posts; empty uses the default post times. */
  times: string[];
  durationDays: number;
  variable: TestVariable;
  variants: Variant[];
  assignment: Assignment;
  metric: SuccessMetric;
}

export interface GrowthCampaign extends GrowthCampaignInput {
  id: number;
  status: CampaignStatus;
  /** Why it paused by itself (a strike), in plain words. */
  pausedReason: string | null;
  /** The scheduler's last remark: why a slot stayed empty. */
  note: string | null;
  startedAt: string | null;
  endsAt: string | null;
  createdAt: string;
}

/** The ages at which a post's numbers are kept. */
export const STAT_OFFSETS = [
  { key: "1h", hours: 1 },
  { key: "6h", hours: 6 },
  { key: "24h", hours: 24 },
  { key: "72h", hours: 72 },
  { key: "7d", hours: 168 },
] as const;
export type StatOffset = (typeof STAT_OFFSETS)[number]["key"];

/** What a platform said about a post. null: it did not say, shown as "not available". */
export interface PostMetrics {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  reach: number | null;
  /** Average share of the clip watched, 0..100. */
  avgWatchPct: number | null;
  followsGained: number | null;
  revenueUsd: number | null;
}

export const METRIC_KEYS = ["views", "likes", "comments", "shares", "saves", "reach", "avgWatchPct", "followsGained", "revenueUsd"] as const;

export const NO_METRICS: PostMetrics = {
  views: null,
  likes: null,
  comments: null,
  shares: null,
  saves: null,
  reach: null,
  avgWatchPct: null,
  followsGained: null,
  revenueUsd: null,
};

/** A reading kept for one age of a post. */
export interface StatPoint extends PostMetrics {
  offset: StatOffset;
  /** How old the post really was at the reading. */
  ageHours: number;
  at: string;
}

/** The numbers on a report's tiles. null is "not available": never shown as 0. */
export interface Kpis {
  /** Posts that went out. */
  posts: number;
  /** Posts still waiting for their time. */
  scheduled: number;
  totalViews: number | null;
  /** Median of the campaign's success metric over the posts old enough to have it. */
  medianMetric: number | null;
  /** Posts old enough to have the success metric. */
  measured: number;
  avgWatchPct: number | null;
  followsGained: number | null;
  earningsUsd: number;
  costUsd: number | null;
  costPer1kViewsUsd: number | null;
}

export interface VariantRow extends Kpis {
  key: string;
  label: string;
}

export interface ReportPost {
  postId: number;
  clipTitle: string;
  accountName: string;
  platform: Platform;
  url: string | null;
  variantLabel: string;
  views: number | null;
  metric: number | null;
}

export interface ComparisonSide {
  label: string;
  n: number;
  median: number | null;
}

/** The statistical read of two groups of posts, in plain words. */
export interface Comparison {
  winner: ComparisonSide;
  loser: ComparisonSide;
  significant: boolean;
  /** Winner's median over the loser's. */
  ratio: number | null;
  pValue: number | null;
  /** 95 % range of the ratio (bootstrap). */
  ratioRange: [number, number] | null;
  /** A rough count of further posts before the difference could be called; null when no difference shows. */
  morePostsNeeded: number | null;
  text: string;
}

/** The defaults a recommendation can change. */
export interface GrowthDefaults {
  /** Preferred clip length: picks inside it are ranked higher. */
  clipMinSec: number | null;
  clipMaxSec: number | null;
  /** Times of day ("HH:MM", UTC) new campaigns post at. */
  postTimes: string[];
  /** Words that rank a pick higher when its title or hook has them. */
  boostWords: string[];
}

export type RecommendationStatus = "open" | "applied" | "dismissed";

export interface Recommendation {
  id: number;
  campaignId: number;
  campaignName: string;
  /** "Make 20-30 s the default clip length". */
  text: string;
  /** The read behind it. */
  detail: string;
  change: Partial<GrowthDefaults>;
  status: RecommendationStatus;
  createdAt: string;
}

export interface CampaignProgress {
  /** Day of the run, 1-based; 0 before it starts. */
  day: number;
  days: number;
  posts: number;
  planned: number;
}

export interface ChartSeries {
  key: string;
  label: string;
  points: DailyPoint[];
}

export interface CampaignReport {
  campaign: GrowthCampaign;
  metricLabel: string;
  platforms: Platform[];
  progress: CampaignProgress;
  kpis: Kpis;
  variants: VariantRow[];
  /** Total views so far, day by day, one line per variant. */
  chart: ChartSeries[];
  comparisons: Comparison[];
  top: ReportPost[];
  bottom: ReportPost[];
  recommendation: Recommendation | null;
}

export interface CampaignSummary {
  campaign: GrowthCampaign;
  progress: CampaignProgress;
  totalViews: number | null;
  /** The headline read, when there is one. */
  read: string | null;
}

export interface Digest {
  title: string;
  lines: string[];
}

export interface GrowthInfo {
  campaigns: CampaignSummary[];
  recommendations: Recommendation[];
  defaults: GrowthDefaults;
  digest: Digest;
  /** The key a browser turns notifications on with; null when none can be sent (demo mode). */
  pushKey: string | null;
  /** The time zone whose 09:00 the digest goes out at; null until the app has said where the phone is. */
  digestZone: string | null;
}

export interface CampaignComparison {
  metricLabel: string;
  rows: { id: number; name: string; kpis: Kpis }[];
  comparisons: Comparison[];
}

/** Shown wherever a platform gave no number. */
export const NOT_AVAILABLE = "not available";
