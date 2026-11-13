// Types and constants shared by the server and the gallery client.

/**
 * "experiment": a test of what the platforms do to clips posted without the creator's permission.
 * It needs no proof, and its clips go to burner accounts only: never to a main account, an export or Whop.
 */
export const PERMISSION_KINDS = ["whop-campaign", "direct-permission", "own-content", "experiment"] as const;
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
  experiment: "Experiment (burner only)",
};

/** Days an experiment record runs when no end date is given. */
export const EXPERIMENT_DAYS = 30;

export interface Permission {
  id: number;
  sourceId: number;
  kind: PermissionKind;
  campaignUrl: string | null;
  briefRules: string;
  /** What an experiment is testing; empty for the other kinds. */
  note: string;
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

export interface NewPermissionInput {
  kind: PermissionKind;
  campaignUrl?: string | null;
  briefRules?: string;
  /** Needed for an experiment: what is being tested. */
  note?: string;
  cpmRateUsd?: number | null;
  minViews?: number | null;
  allowedPlatforms: Platform[];
  expiresAt?: string | null;
}

export interface NewSourceInput {
  creatorName: string;
  channelUrls: string[];
  bannedContent?: string;
  permission: NewPermissionInput;
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
  /** The creator has only an experiment record in force: the clip goes to burner accounts only. */
  experiment: boolean;
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
  /** The @handle and picture, when the service has them. */
  handle?: string | null;
  avatarUrl?: string | null;
}

/** "burner" marks a throwaway channel for tests (what a claim or strike really does). */
export const ACCOUNT_ROLES = ["main", "burner"] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

export const ACCOUNT_ROLE_LABELS: Record<AccountRole, string> = { main: "Main", burner: "Burner" };

/** How the platform treats the account; set by hand, since the posting services do not say. */
export const ACCOUNT_HEALTHS = ["healthy", "limited", "banned"] as const;
export type AccountHealth = (typeof ACCOUNT_HEALTHS)[number];

export const ACCOUNT_HEALTH_LABELS: Record<AccountHealth, string> = { healthy: "Healthy", limited: "Limited", banned: "Banned" };

/** What we decide about one of our posting accounts. */
export interface ChannelSettings {
  role: AccountRole;
  /** What the channel is about, e.g. "GTA VI moments"; empty takes any clip. */
  niche: string;
  /** Posts a day and minutes between posts; null follows the shared spacing. */
  maxPerDay: number | null;
  minGapMinutes: number | null;
  /** Off stops new posts to the account. */
  enabled: boolean;
  health: AccountHealth;
  /** Routing: the permission kinds whose clips this account posts. Every kind to start with. */
  takes: PermissionKind[];
  /** Whop campaigns (permission ids) pinned here: on this platform they post only from this account. */
  pinnedCampaignIds: number[];
}

/** A connected account plus our settings for it. */
export interface ChannelAccount extends PostingAccount, ChannelSettings {
  handle: string | null;
  avatarUrl: string | null;
  /** The pace in force: its own numbers, else the shared spacing. */
  pace: PostingRules;
  /** Why the account was switched off by itself (a strike); cleared when it is switched on again. */
  pausedReason: string | null;
}

/** One account in the picker for a clip. */
export interface AccountChoice {
  account: ChannelAccount;
  canPost: boolean;
  /** Ticked to start with: a main account whose niche fits the clip (a burner, for an experiment clip). */
  suggested: boolean;
  /** Why it cannot be picked, or a warning, in plain words. */
  note: string | null;
}

/** An account that was picked but left out, and why. */
export interface SkippedAccount {
  accountId: string;
  accountName: string;
  reason: string;
}

export interface PostOutcome {
  posts: Post[];
  skipped: SkippedAccount[];
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
  accounts: ChannelAccount[];
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

/** What a platform did to a post: a copyright claim, a removal, a strike on the account. */
export const POST_FLAGS = ["claim", "removal", "strike"] as const;
export type PostFlag = (typeof POST_FLAGS)[number];

export const POST_FLAG_LABELS: Record<PostFlag, string> = { claim: "Claim", removal: "Removed", strike: "Strike" };

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
  /** Posted under an experiment record (always on a burner account). */
  experiment: boolean;
  /** When each claim, removal or strike was recorded; null when there is none. */
  flags: Record<PostFlag, string | null>;
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
  /** Our settings for it; null for demo accounts and ones the service no longer lists. */
  account: ChannelAccount | null;
  estimatedEarningsUsd: number;
  /** Claims or strikes, when the posting service reports them. */
  claims: number | null;
  updatedAt: string | null;
  /** Made by "Load demo data", not a real account. */
  demo: boolean;
}

export interface AccountsInfo {
  service: PostingServiceName;
  label: string;
  cards: AccountCard[];
  /** The shared spacing, used by accounts without their own pace. */
  rules: PostingRules;
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

export interface DashboardTrends {
  /** Views per day: from the accounts when the posting service has them, else of the posts sent that day. */
  views: DailyPoint[];
  /** New clips per day. */
  clips: DailyPoint[];
  /** Estimated pay of the posts sent each day. */
  earnings: DailyPoint[];
}

/** Experiment posts added up for one burner account or one creator. */
export interface ExperimentRow {
  key: string;
  label: string;
  posts: number;
  views: number;
  claims: number;
  removals: number;
  strikes: number;
  /** Seconds from a post going out to its claim, for the earliest claim; null without a claim. */
  firstClaimSec: number | null;
  /** Accounts only: why it is paused, or null while it is on. */
  pausedReason: string | null;
}

/** What the platforms did to the experiment posts. */
export interface ExperimentReport {
  total: ExperimentRow;
  byAccount: ExperimentRow[];
  byCreator: ExperimentRow[];
}

export interface Dashboard {
  /** No clips, VODs or posts yet: the app offers "Load demo data". */
  empty: boolean;
  demoLoaded: boolean;
  today: DashboardToday;
  /** The last 7 days, oldest first, for the sparklines under the big numbers. */
  trends: DashboardTrends;
  running: RunningJob[];
  vods: VodProgress[];
  goals: Goal[];
  earnings: { rows: EarningsRow[]; weekUsd: number; totalUsd: number };
  experiment: ExperimentReport;
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
  /** False when the keys it needs are not set (in Settings or the server's env). */
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

export const INTEGRATION_IDS = ["openai", "twitch", "youtube", "postiz", "upload-post"] as const;
export type IntegrationId = (typeof INTEGRATION_IDS)[number];

/** The last Test of an integration's keys. The message is plain and never holds a key. */
export interface KeyTestResult {
  ok: boolean;
  message: string;
  at: string;
}

/** One value of an integration, as the Settings screen may see it: a key's value is never sent. */
export interface SettingField {
  /** The setting's name, the same as the server's env variable. */
  name: string;
  label: string;
  /** A key: only "set" and its last characters are shown. False for addresses and names. */
  secret: boolean;
  required: boolean;
  set: boolean;
  /** Where the value in use comes from: saved in Settings, or the server's env file. */
  source: "settings" | "env" | null;
  /** The last 4 characters of a key, to tell keys apart; null when it is too short to show any. */
  ending: string | null;
  /** The value itself, only for fields that are not keys. */
  value: string | null;
  savedAt: string | null;
  placeholder: string;
}

export interface IntegrationStatus {
  id: IntegrationId;
  label: string;
  /** What clipfarm uses it for. */
  purpose: string;
  fields: SettingField[];
  /** Every required value is set (in Settings or the server's env). */
  configured: boolean;
  test: KeyTestResult | null;
  /** Something to know about this row right now, in plain words. */
  note: string | null;
}

export interface SettingsInfo {
  integrations: IntegrationStatus[];
  /** Demo mode (CLIPFARM_FAKES=1): keys are saved, but every outside service is a stand-in. */
  demo: boolean;
}

export interface SetupItem {
  id: "keys" | "accounts" | "permission" | "clip" | "post";
  label: string;
  done: boolean;
  /** One plain line on what to do (or what is done). */
  line: string;
  /** Where the button goes, and what it says. */
  href: string;
  action: string;
}

export interface SetupChecklist {
  items: SetupItem[];
  done: boolean;
}

/** How clipfarm transcribes and picks: on this server by default, cloud AI only as a speed-up. */
export interface EngineSettings {
  /** "Use cloud AI for speed": OpenAI transcribes and picks instead of the local engine. */
  cloud: boolean;
  /** The local speech model, e.g. "base.en". */
  sttModel: string;
  /** Let the local writer (a small model on this server) write hooks and titles. */
  writer: boolean;
}

export interface EngineDownload {
  id: string;
  label: string;
  bytes: number;
}

export interface EngineModelChoice {
  id: string;
  label: string;
  note: string;
  bytes: number;
  needMb: number;
  present: boolean;
}

export interface EngineStatus {
  /** "test" when the server runs on fakes (demos and tests). */
  mode: "local" | "cloud" | "test";
  ready: boolean;
  /** e.g. "Local engine: ready". */
  headline: string;
  /** Exactly what is missing or short, in plain words; empty when ready. */
  problems: string[];
  /** What "Set up the local engine" would download now. */
  downloads: EngineDownload[];
  /** The download job, while it waits, runs or after it failed. */
  setupJob: { id: number; status: JobStatus; progress: number; message: string; error: string | null } | null;
  memory: { availableMb: number; needMb: number; ok: boolean };
  /** Why the hook writer would be refused right now (memory), so hooks would come from the transcript; null when it can run or is off. */
  writerNote: string | null;
  settings: EngineSettings;
  sttModels: EngineModelChoice[];
  /** Whether an OpenAI key is on the server, so "Use cloud AI for speed" can be switched on. */
  cloudAvailable: boolean;
}
