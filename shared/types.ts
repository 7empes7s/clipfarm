// Types and constants shared by the server and the gallery client.

export const PERMISSION_KINDS = ["whop-campaign", "direct-permission", "own-content"] as const;
export type PermissionKind = (typeof PERMISSION_KINDS)[number];

export const PLATFORMS = ["tiktok", "youtube", "instagram", "x"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABELS: Record<Platform, string> = {
  tiktok: "TikTok",
  youtube: "YouTube Shorts",
  instagram: "Instagram Reels",
  x: "X",
};

export const PERMISSION_KIND_LABELS: Record<PermissionKind, string> = {
  "whop-campaign": "Whop campaign",
  "direct-permission": "Direct permission",
  "own-content": "Our own content",
};

export interface Permission {
  id: number;
  sourceId: number;
  kind: PermissionKind;
  campaignUrl: string | null;
  briefRules: string;
  cpmRateUsd: number | null;
  minViews: number | null;
  allowedPlatforms: Platform[];
  /** ISO timestamp; null means it does not expire. */
  expiresAt: string | null;
  createdAt: string;
}

export type PermissionState = "active" | "expired" | "none";

/** Where the face cam sits in the stream's frame, as fractions (0..1) of its width and height. */
export interface FaceCam {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Source {
  id: number;
  creatorName: string;
  channelUrls: string[];
  bannedContent: string;
  /** Set once per creator in Sources; the stacked layout puts this region on top. */
  faceCam: FaceCam | null;
  createdAt: string;
  permissions: Permission[];
  /** Whether the source has a permission record that is in force right now. */
  permissionState: PermissionState;
}

export interface NewSourceInput {
  creatorName: string;
  channelUrls: string[];
  bannedContent?: string;
  permission: {
    kind: PermissionKind;
    campaignUrl?: string | null;
    briefRules?: string;
    cpmRateUsd?: number | null;
    minViews?: number | null;
    allowedPlatforms: Platform[];
    expiresAt?: string | null;
  };
}

export const JOB_STATUSES = ["queued", "running", "done", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface Job {
  id: number;
  type: string;
  status: JobStatus;
  /** 0..1 */
  progress: number;
  message: string;
  error: string | null;
  attempts: number;
  maxAttempts: number;
  vodId: number | null;
  clipId: number | null;
  createdAt: string;
  updatedAt: string;
  /** When the current (or last) try started and when the job ended for good; null until then. */
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Chapter {
  title: string;
  startSec: number;
  endSec: number;
}

export type VodStatus = "queued" | "downloading" | "transcribing" | "ready" | "failed";

export interface Vod {
  id: number;
  sourceId: number;
  url: string;
  status: VodStatus;
  title: string | null;
  durationSec: number | null;
  chapters: Chapter[];
  transcriber: string | null;
  transcriptCostUsd: number | null;
  wordCount: number;
  createdAt: string;
}

export interface Word {
  word: string;
  startSec: number;
  endSec: number;
}

export interface VodDetail extends Vod {
  words: Word[];
}

/** Why the picker may refuse a moment. Any of these drops the pick before it can render. */
export interface PickFlags {
  spoiler: boolean;
  cutscene: boolean;
  ending: boolean;
  leak: boolean;
  breaksBrief: boolean;
}

export type PickStatus = "picked" | "dropped" | "rendering" | "rendered" | "failed";

export interface StepTime {
  step: string;
  ms: number;
}

/** A highlight chosen from a VOD's transcript, and (once rendered) its vertical clip. */
export interface Pick {
  id: number;
  vodId: number;
  sourceId: number;
  rank: number;
  startSec: number;
  endSec: number;
  title: string;
  hook: string;
  score: number;
  /** Why it was chosen. */
  reason: string;
  flags: PickFlags;
  /** Set when the pick was left out (spoiler, brief ban, bad length…); it never renders. */
  dropReason: string | null;
  layout: ClipLayout;
  status: PickStatus;
  error: string | null;
  /** Share of the transcript and picking cost, in USD. */
  costUsd: number;
  /** Time per step of the run (picks share, download, render). */
  steps: StepTime[];
  sizeBytes: number | null;
  durationSec: number | null;
  videoUrl: string | null;
  thumbUrl: string | null;
  /** The clip waiting for review and posting, once rendered. */
  clipId: number | null;
  createdAt: string;
}


/** "rendering": an edit was saved and the new version is being made; it returns to "pending". */
export type ClipStatus = "pending" | "approved" | "rejected" | "rendering";

export const CLIP_LAYOUTS = ["stacked", "center", "full"] as const;
export type ClipLayout = (typeof CLIP_LAYOUTS)[number];

export const CLIP_LAYOUT_LABELS: Record<ClipLayout, string> = {
  stacked: "Face cam on top",
  center: "Center crop",
  full: "Full frame",
};

export const REJECT_REASONS = ["boring", "spoiler", "bad-crop", "bad-captions", "other"] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export const REJECT_REASON_LABELS: Record<RejectReason, string> = {
  boring: "Boring",
  spoiler: "Spoiler",
  "bad-crop": "Bad crop",
  "bad-captions": "Bad captions",
  other: "Other",
};

/** Shortest and longest clip an edit may produce, in seconds. */
export const CLIP_MIN_SEC = 3;
export const CLIP_MAX_SEC = 60;

export interface Clip {
  id: number;
  sourceId: number;
  vodId: number | null;
  title: string;
  /** The text on screen for the first seconds. */
  hook: string;
  /** Why the picker chose it. */
  reason: string;
  /** 0..100 from the picker; null when unknown. */
  score: number | null;
  durationSec: number;
  status: ClipStatus;
  rejectReason: RejectReason | null;
  layout: ClipLayout;
  /** Cut points inside the longer source section ("master") the clip was rendered from. */
  startSec: number;
  endSec: number;
  masterDurationSec: number;
  /** Caption words, timed in master seconds. */
  captionWords: Word[];
  postCount: number;
  /** Where the gallery plays and downloads the MP4. */
  videoUrl: string;
  /** The source section, for trimming and the face cam frame. */
  masterUrl: string;
  createdAt: string;
}

export interface ClipEditInput {
  title: string;
  hook: string;
  captionText: string;
  layout: ClipLayout;
  startSec: number;
  endSec: number;
}

export const POSTING_SERVICES = ["postiz", "upload-post", "fake", "none"] as const;
export type PostingServiceName = (typeof POSTING_SERVICES)[number];

/** A social account connected in the posting service (Postiz "integration", Upload-Post profile platform). */
export interface PostingAccount {
  id: string;
  platform: Platform;
  name: string;
  disabled: boolean;
}

export interface PostingRules {
  /** Most posts per account per (UTC) day. */
  maxPerDay: number;
  /** Least time between two posts on the same account. */
  minGapMinutes: number;
}

export interface PostingInfo {
  service: PostingServiceName;
  label: string;
  accounts: PostingAccount[];
  /** Why accounts could not be loaded, in plain words. */
  accountsError: string | null;
  /** Posts per platform per day the service allows (Upload-Post); empty when it has no caps. */
  dailyCaps: Partial<Record<Platform, number>>;
  /** Posts sent today per platform through the service. */
  usedToday: Partial<Record<Platform, number>>;
  rules: PostingRules;
  /** Platform limits worth knowing, in plain words. */
  notes: string[];
}

export type PostStatus = "scheduled" | "posted" | "failed";

export interface Post {
  id: number;
  clipId: number;
  clipTitle: string;
  sourceId: number;
  creatorName: string;
  platform: Platform;
  accountId: string;
  accountName: string;
  service: PostingServiceName;
  status: PostStatus;
  url: string | null;
  error: string | null;
  caption: string;
  scheduledAt: string;
  postedAt: string | null;
  permissionId: number;
  campaignUrl: string | null;
  views: number | null;
  viewsUpdatedAt: string | null;
  viewsSource: "service" | "manual" | null;
  whopSubmittedAt: string | null;
  /** Views × the campaign's pay per 1,000, or 0 under its minimum views. */
  estimatedEarningsUsd: number;
}

export interface ExportPack {
  clipId: number;
  videoUrl: string;
  fileName: string;
  platform: Platform;
  caption: string;
}

/** One post a dry run says would go out: every check passed, nothing was sent or stored. */
export interface PlannedPost {
  accountId: string;
  accountName: string;
  platform: Platform;
  permissionId: number;
  caption: string;
  scheduledAt: string;
}

export interface StatsRow {
  key: string;
  label: string;
  posts: number;
  views: number;
  estimatedEarningsUsd: number;
}

export interface Stats {
  posts: number;
  views: number;
  estimatedEarningsUsd: number;
  approvedClips: number;
  /** Spend so far (transcription) divided by approved clips; null before the first approval. */
  costPerApprovedClipUsd: number | null;
  byCampaign: StatsRow[];
  byPlatform: StatsRow[];
}

/** One value per day (YYYY-MM-DD, UTC). */
export interface DailyPoint {
  date: string;
  value: number;
}

export interface Growth {
  /** Last value minus first value of the range. */
  change: number;
  /** Change as a share of the first value; null when it started at 0. */
  pct: number | null;
}

/** Where a number on a card came from: the posting service, typed in by hand, or nowhere yet. */
export type StatSource = "service" | "manual" | "none";

/** One connected account on the dashboard: stats from the posting service, posts from our records. */
export interface AccountCard {
  accountId: string;
  platform: Platform;
  name: string;
  followers: number | null;
  followersSeries: DailyPoint[];
  followersGrowth: Growth | null;
  followersSource: StatSource;
  viewsPerDay: DailyPoint[];
  viewsSource: StatSource;
  posts: number;
  avgViewsPerPost: number | null;
  topClips: { clipId: number; title: string; views: number; url: string | null }[];
  postsLast7Days: number;
  /** Posts the spacing rules plan for 7 days (posts per day × 7). */
  plannedLast7Days: number;
  updatedAt: string | null;
  /** Made by "Load demo data", not a real account. */
  demo: boolean;
}

export interface AccountsInfo {
  service: PostingServiceName;
  label: string;
  cards: AccountCard[];
  /** The last error from the posting service, in plain words. */
  error: string | null;
  /** Hours between reads of account stats (kept inside the service's API limits). */
  refreshHours: number;
}

export type StageName = "transcript" | "picks" | "render";
export type StageState = "waiting" | "running" | "done" | "failed";

export interface VodProgress {
  vodId: number;
  title: string;
  creatorName: string;
  durationSec: number | null;
  stages: { stage: StageName; state: StageState; seconds: number | null; progress: number }[];
  clips: number;
  approved: number;
  /** Approved share of the clips made (0..1); null with no clips. */
  approvedShare: number | null;
  createdAt: string;
}

export interface RunningJob {
  jobId: number;
  label: string;
  progress: number;
  message: string;
  /** Seconds left, guessed from progress so far; null while too early to tell. */
  etaSec: number | null;
}

export interface Goal {
  id: string;
  objective: "O1" | "O2";
  label: string;
  /** What it is now, in plain words ("8 clips per hour of stream"). */
  now: string;
  target: string;
  /** 0..1 towards the target; null without data yet. */
  value: number | null;
}

export interface EarningsRow {
  key: string;
  campaign: string;
  platform: Platform;
  posts: number;
  views: number;
  minViews: number | null;
  /** Posts at or over the campaign's minimum views. */
  overMinimum: number;
  estimatedUsd: number;
  weekUsd: number;
  /** Posts marked "sent to Whop". */
  submitted: number;
}

export interface DashboardToday {
  waiting: number;
  approved: number;
  postedToday: number;
  viewsToday: number;
  /** "accounts": today's views from the posting service; "posts": views of posts made today. */
  viewsTodayFrom: "accounts" | "posts";
  earningsWeekUsd: number;
  costWeekUsd: number;
  costPerApprovedClipUsd: number | null;
}

export interface Dashboard {
  /** No clips, VODs or posts yet: the app offers "Load demo data". */
  empty: boolean;
  demoLoaded: boolean;
  today: DashboardToday;
  running: RunningJob[];
  vods: VodProgress[];
  goals: Goal[];
  earnings: { rows: EarningsRow[]; weekUsd: number; totalUsd: number };
}

export const WATCH_PLATFORMS = ["twitch", "kick", "youtube"] as const;
export type WatchPlatform = (typeof WATCH_PLATFORMS)[number];

export const WATCH_PLATFORM_LABELS: Record<WatchPlatform, string> = {
  twitch: "Twitch",
  kick: "Kick",
  youtube: "YouTube",
};

/** How clippers get a creator's permission. "none" means we know of no program yet. */
export const CLIP_PROGRAMS = ["whop", "own", "kick", "none"] as const;
export type ClipProgram = (typeof CLIP_PROGRAMS)[number];

export const CLIP_PROGRAM_LABELS: Record<ClipProgram, string> = {
  whop: "Whop Content Rewards",
  own: "Their own program",
  kick: "Kick clipping program",
  none: "No program known",
};

/** A creator's handle on one platform (Twitch login, Kick slug, YouTube @handle without the @). */
export interface WatchChannel {
  platform: WatchPlatform;
  handle: string;
}

export interface LiveNow {
  platform: WatchPlatform;
  title: string;
  /** The category or game shown on the stream, when the platform says. */
  game: string | null;
  startedAt: string | null;
  url: string;
}

export type DetectedVodStatus = "queued" | "skipped";

export interface DetectedVod {
  id: number;
  platform: WatchPlatform;
  url: string;
  title: string;
  category: string | null;
  publishedAt: string;
  status: DetectedVodStatus;
  /** Why it was not queued, in plain words. */
  skipReason: string | null;
  vodId: number | null;
}

export interface WatchedCreator {
  id: number;
  name: string;
  channels: WatchChannel[];
  /** Language code, like "en", "ar", "es". */
  language: string;
  /** Games whose VODs are picked up, matched in the VOD title or category ("GTA VI" first). */
  games: string[];
  program: ClipProgram;
  programUrl: string | null;
  /** Why they are on the list: rank, source and date. */
  note: string;
  /** The campaign (permission records) for this creator: set by hand, else found by the same name. */
  sourceId: number | null;
  permissionState: PermissionState;
  autoIngest: boolean;
  live: LiveNow | null;
  lastVod: DetectedVod | null;
}

export interface WatchedCreatorInput {
  name: string;
  channels: WatchChannel[];
  language: string;
  games: string[];
  program: ClipProgram;
  programUrl: string | null;
  note: string;
  sourceId: number | null;
}

export interface WatchPlatformStatus {
  platform: WatchPlatform;
  /** False when the keys it needs are not set on the server. */
  configured: boolean;
  /** What to set, or why it is waiting, in plain words; null when all is well. */
  note: string | null;
  /** Set while the platform is backed off after errors. */
  nextTryAt: string | null;
}

export interface Watchlist {
  creators: WatchedCreator[];
  platforms: WatchPlatformStatus[];
  lastPollAt: string | null;
}
