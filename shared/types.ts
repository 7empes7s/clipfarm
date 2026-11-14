// Types and constants shared by the server and the gallery client.
import type { CampaignSummary, Recommendation } from "./growth.js";
import type { AiGate, BrandTemplate, ClipLook, TimeRange } from "./studio.js";

/**
 * "experiment": a test of what the platforms do to clips posted without the creator's permission.
 * It needs no proof, and its clips go to burner accounts only: never to a main account, an export or Whop.
 */
export const PERMISSION_KINDS = ["whop-campaign", "direct-permission", "own-content", "public-allowance", "experiment"] as const;
export type PermissionKind = (typeof PERMISSION_KINDS)[number];

export const PLATFORMS = ["tiktok", "youtube", "instagram", "x", "facebook", "threads", "linkedin", "bluesky"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABELS: Record<Platform, string> = {
  tiktok: "TikTok",
  youtube: "YouTube Shorts",
  instagram: "Instagram Reels",
  x: "X",
  facebook: "Facebook Reels",
  threads: "Threads",
  linkedin: "LinkedIn",
  bluesky: "Bluesky",
};

export const PERMISSION_KIND_LABELS: Record<PermissionKind, string> = {
  "whop-campaign": "Whop campaign",
  "direct-permission": "Direct permission",
  "own-content": "Our own content",
  "public-allowance": "Creator publicly allows clipping",
  experiment: "Experiment (burner only)",
};

/** A public allowance is checked again this often, and ends this long after its last good check. */
export const ALLOWANCE_RECHECK_DAYS = 7;
export const ALLOWANCE_VALID_DAYS = 90;

/** Days an experiment record runs when no end date is given. */
export const EXPERIMENT_DAYS = 30;

/** What Whop keeps of every campaign payout, and how long a payout takes to settle once a clip is approved. */
export const WHOP_FEE = 0.1;
export const WHOP_HOLD_DAYS = 10;

/** A campaign's rules, as they are checked before a clip posts under it. */
export interface CampaignRules {
  /** Hashtags and @mentions the caption must carry. */
  requiredTags: string[];
  requiredLinks: string[];
  /** Words the caption must say. */
  requiredText: string[];
  /** Words and topics that must not be said in the clip or its title. */
  bannedWords: string[];
  /** Shortest and longest clip the campaign takes, in seconds. */
  minSec: number | null;
  maxSec: number | null;
  /** What was left of the budget when the page was last read. */
  budgetLeftUsd: number | null;
  /** The clip has to be submitted by hand within 30 minutes of posting (Whop and Content Rewards: yes unless the page says otherwise). */
  manualSubmit: boolean;
  /** The campaign bans AI-made content (AI hooks, titles, thumbnails, voices): clipfarm's AI features (and the Studio's) stay off for it. */
  aiBanned?: boolean;
}

export const NO_CAMPAIGN_RULES: CampaignRules = {
  requiredTags: [],
  requiredLinks: [],
  requiredText: [],
  bannedWords: [],
  minSec: null,
  maxSec: null,
  budgetLeftUsd: null,
  manualSubmit: true,
};

/** The fields of a campaign that a page can fill. */
export const CAMPAIGN_FIELDS = [
  "creatorName",
  "channelUrls",
  "cpmRateUsd",
  "minViews",
  "budgetLeftUsd",
  "allowedPlatforms",
  "requiredTags",
  "requiredLinks",
  "requiredText",
  "bannedWords",
  "clipLength",
  "expiresAt",
] as const;
export type CampaignField = (typeof CAMPAIGN_FIELDS)[number];

/** What was read from a campaign page: the form's starting values. Nothing here is saved yet. */
export interface CampaignDraft {
  campaignUrl: string;
  creatorName: string | null;
  channelUrls: string[];
  cpmRateUsd: number | null;
  minViews: number | null;
  allowedPlatforms: Platform[];
  /** ISO timestamp of the end of the campaign's last day. */
  expiresAt: string | null;
  /** The page's do and don't lines, for the picker. */
  briefRules: string;
  rules: CampaignRules;
  /** Fields the page did not give: left empty and marked "check this", never guessed. */
  check: CampaignField[];
  /** Set when the page says the campaign is over or out of budget: why, in plain words. */
  ended: string | null;
  /** The creator already in Sources this campaign would be saved to. */
  existingSource: string | null;
}

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
  /** "public-allowance" only: where the creator says clipping is allowed, their words, and when we last saw them there. */
  proofUrl: string | null;
  proofQuote: string | null;
  proofCheckedAt: string | null;
  /** Set when a check found the proof gone: why, in plain words. The record is on hold until it is checked again. */
  reviewReason: string | null;
  /** A campaign's rules; null for records without any. */
  rules: CampaignRules | null;
  /** When the campaign page was last read by the daily check. */
  campaignCheckedAt: string | null;
  /** "own-content" only: who owns the videos, and when the manager confirmed it. Without the date nothing posts. */
  ownerName?: string | null;
  attestedAt?: string | null;
  /** The workspace of its source (1, "Me", when left out). */
  workspaceId?: number;
  createdAt: string;
}

export type PermissionState = "active" | "needs-review" | "expired" | "none";

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
  /** The workspace (me, or a client) it belongs to. */
  workspaceId: number;
  /** clipfarm's AI features (AI hooks, titles, thumbnails) may be used on it: off when a campaign in force bans AI. */
  aiAllowed: boolean;
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
  proofUrl?: string | null;
  proofQuote?: string | null;
  /** ISO date or timestamp of the day the proof was read. */
  proofCheckedAt?: string | null;
  rules?: CampaignRules | null;
  /** "own-content": who owns the videos, and when "I own these videos" was ticked (null: not yet, so nothing posts). */
  ownerName?: string | null;
  attestedAt?: string | null;
  /** From the form: "I own these videos" is ticked (the server dates it). */
  attested?: boolean;
}

export interface NewSourceInput {
  creatorName: string;
  channelUrls: string[];
  bannedContent?: string;
  permission: NewPermissionInput;
}

/** A creator from the starter list who publicly allows clipping, shown with the proof before adding. */
export interface SuggestedCreator {
  name: string;
  channels: WatchChannel[];
  language: string;
  proofUrl: string;
  proofQuote: string;
  /** YYYY-MM-DD: the day the proof was read. */
  checkedOn: string;
  /** Their conditions (credit, platforms…), in plain words. */
  rules: string;
  allowedPlatforms: Platform[];
  /** Who they are and what kind of page the proof is. */
  note: string;
  /** Already in Sources with this kind of permission. */
  added: boolean;
}

/** What "Look for a clipping allowance" found on a creator's pages. */
export interface AllowanceFind {
  found: { proofUrl: string; proofQuote: string; checkedAt: string } | null;
  /** What was looked at and what came of it, in plain words. */
  note: string;
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
  /** Higher runs first. 0 for stream/VOD work; live segments and their clips jump ahead. */
  priority: number;
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

/** The finishing touches a render adds. Each is on by default and can be turned off per clip in Edit. */
export const CLIP_EFFECTS = ["hookCard", "zoom", "loudness", "loopEnding", "progressBar"] as const;
export type ClipEffect = (typeof CLIP_EFFECTS)[number];
export type ClipEffects = Record<ClipEffect, boolean>;

export const DEFAULT_EFFECTS: ClipEffects = { hookCard: true, zoom: true, loudness: true, loopEnding: true, progressBar: true };

export const CLIP_EFFECT_LABELS: Record<ClipEffect, string> = {
  hookCard: "Hook card (first 1.5 s)",
  zoom: "Punch-in zooms",
  loudness: "Even loudness",
  loopEnding: "Loop ending",
  progressBar: "Progress bar",
};

export type QualityCode = "black" | "frozen" | "silence" | "captions" | "duration" | "size" | "loudness";

/** One thing the automatic check found wrong with a render, in plain words. */
export interface QualityIssue {
  code: QualityCode;
  reason: string;
}

/** The change the Fix button makes before it remakes the clip. Times are master seconds. */
export interface ClipFix {
  label: string;
  startSec?: number;
  endSec?: number;
  effects?: Partial<ClipEffects>;
}

/** The result of the check that runs after each render; no issues means the clip passed. */
export interface ClipQuality {
  issues: QualityIssue[];
  fix: ClipFix | null;
}

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
  /** Studio edit list: ranges (master seconds) cut out of [startSec, endSec]. The master is never changed. */
  cuts: TimeRange[];
  /** Caption style, crop, watermark and outro (Studio). */
  look: ClipLook;
  effects: ClipEffects;
  /** Null until a render has been checked (clips made before the check, demo clips). */
  quality: ClipQuality | null;
  postCount: number;
  /** The creator has only an experiment record in force: the clip goes to burner accounts only. */
  experiment: boolean;
  /** Made by the daily proof or the launch drill: tagged "Proof" in the Inbox, reviewed and posted like any clip. */
  proof: boolean;
  /** Where the gallery plays and downloads the MP4. */
  videoUrl: string;
  /** The source section, for trimming and the face cam frame. */
  masterUrl: string;
  /** Set when the clip was cut while the stream was still live. */
  live: ClipLive | null;
  createdAt: string;
}

export interface ClipLive {
  /** Where the clip starts, in seconds from the start of the stream. */
  streamSec: number;
  /** When the moment happened (its last second), by the server's clock. */
  momentAt: string;
  /** Seconds from the moment to the clip landing in the Inbox. */
  latencySec: number;
}

/** One export of a clip, kept so it can be brought back. Version 0 is the clip as it first came. */
export interface ClipVersion {
  id: number;
  clipId: number;
  n: number;
  label: string;
  durationSec: number;
  /** Plays this version. */
  videoUrl: string;
  /** The one the clip uses now. */
  current: boolean;
  createdAt: string;
}

/** What the Studio exports: the window, the edit list, the look and the words on screen. */
export interface StudioEditInput {
  title: string;
  hook: string;
  layout: ClipLayout;
  startSec: number;
  endSec: number;
  cuts: TimeRange[];
  effects: ClipEffects;
  look: ClipLook;
}

/** One part of "Why this clip": 0..100, or null when it was not measured for this clip. */
export interface ScorePart {
  key: "hook" | "payoff" | "energy" | "chat" | "length";
  label: string;
  value: number | null;
  note: string;
}

/** Everything the Studio screen needs for one clip. */
export interface StudioInfo {
  clip: Clip;
  source: Source;
  breakdown: ScorePart[];
  ai: AiGate;
  templates: BrandTemplate[];
  versions: ClipVersion[];
  /** The posting accounts a template can be applied by. */
  accounts: { id: string; name: string; platform: Platform }[];
}

export interface ClipEditInput {
  title: string;
  hook: string;
  captionText: string;
  layout: ClipLayout;
  startSec: number;
  endSec: number;
  effects: ClipEffects;
}

/** "direct": uploaded by clipfarm itself through the platform's API, with the account's group's app and proxy. */
export const POSTING_SERVICES = ["postiz", "upload-post", "fake", "none", "direct"] as const;
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
  /** The isolation group it belongs to: its developer apps and its way out to the internet. */
  groupId: number;
  /** Connected in clipfarm (Settings, Accounts) and uploaded to directly, not through the posting service. */
  direct: boolean;
  /** The workspace whose clips it posts (1, "Me", when left out). */
  workspaceId?: number;
}

/** The two groups every install starts with. */
export const MAIN_GROUP_ID = 1;
export const BURNERS_GROUP_ID = 2;

/** Platforms clipfarm can upload to by itself, with a group's own developer app. */
export const DIRECT_PLATFORMS = ["youtube", "tiktok", "instagram"] as const;
export type DirectPlatform = (typeof DIRECT_PLATFORMS)[number];

/** What each platform calls the two halves of an app's keys. */
export const APP_KEY_LABELS: Record<DirectPlatform, { app: string; id: string; secret: string }> = {
  youtube: { app: "YouTube (Google Cloud project)", id: "OAuth client ID", secret: "Client secret" },
  tiktok: { app: "TikTok app", id: "Client key", secret: "Client secret" },
  instagram: { app: "Instagram (Meta app)", id: "App ID", secret: "App secret" },
};

/** YouTube gives each Cloud project this many units a day; one upload costs 1,600. The day ends at midnight Pacific time. */
export const YOUTUBE_DAILY_UNITS = 10_000;
export const YOUTUBE_UPLOAD_UNITS = 1_600;

/** One platform's developer app in a group. The keys are never sent: only whether they are set. */
export interface GroupApp {
  platform: DirectPlatform;
  set: boolean;
  /** The last 4 characters of the app's ID, to tell apps apart. */
  idEnding: string | null;
  /** The address to paste as the app's redirect URI. */
  redirectUri: string;
}

/** The last test of a group's proxy. Addresses are masked to their network (203.0.113.x). */
export interface ProxyCheck {
  ok: boolean;
  message: string;
  exitIp: string | null;
  country: string | null;
  at: string;
}

export interface GroupAccount {
  id: string;
  name: string;
  platform: Platform;
  direct: boolean;
  /** A direct account whose sign-in ran out: connect it again. */
  disabled: boolean;
}

/** Accounts that share developer apps and a way out to the internet, kept apart from every other group. */
export interface IsolationGroup {
  id: number;
  name: string;
  /** Main groups hold main accounts (proxy optional); burner groups hold burners (proxy required). */
  kind: AccountRole;
  /** Main and Burners: always there. */
  builtIn: boolean;
  apps: GroupApp[];
  /** The proxy's host and port; its user name and password are never sent. */
  proxy: { set: boolean; address: string | null; signIn: boolean; check: ProxyCheck | null };
  /** Why this group's accounts cannot post right now, in plain words. */
  blocked: string | null;
  /** YouTube units this group's app used today; `fullUntil` is the reset when another upload no longer fits. */
  youtubeQuota: { used: number; limit: number; fullUntil: string | null };
  accounts: GroupAccount[];
}

export interface IsolationInfo {
  groups: IsolationGroup[];
  /** How the last "Connect channel" ended. */
  lastConnect: { ok: boolean; message: string; at: string } | null;
  /** Demo mode: the platforms and the proxy check are stand-ins. */
  demo: boolean;
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
  /** Where the creator publicly allows clipping, when the post went out under such a record. */
  proofUrl: string | null;
  views: number | null;
  viewsUpdatedAt: string | null;
  viewsSource: "service" | "manual" | null;
  whopSubmittedAt: string | null;
  /** Tapped by hand once Whop approved the submission, and once it paid. */
  whopApprovedAt: string | null;
  whopPaidAt: string | null;
  /** Tapped by hand when the campaign turned the submission down, with its reason. */
  whopRejectedAt: string | null;
  whopRejectReason: string | null;
  /** When an approved submission's payout should settle: approval plus Whop's hold. */
  whopPayoutAt: string | null;
  /** Posted under an experiment record (always on a burner account). */
  experiment: boolean;
  /** When each claim, removal or strike was recorded; null when there is none. */
  flags: Record<PostFlag, string | null>;
  /** The isolation group the post went out through, and the address it left from (masked to its network). */
  groupName: string | null;
  exitIp: string | null;
  /** Something to know about a waiting post, e.g. that it waits for YouTube's quota. */
  note: string | null;
  /** Views × the campaign's pay per 1,000 (less Whop's 10% fee on a Whop campaign), or 0 under its minimum views or after a missed submit window. */
  estimatedEarningsUsd: number;
  /** A campaign post that has to be submitted by hand within 30 minutes of going live; null for every other post. */
  submit: PostSubmit | null;
  /** What a post with a missed submit window would have earned; 0 for every other post. */
  lostEarningsUsd: number;
}

export interface PostSubmit {
  /** When the post went live; null while it waits for its time. */
  liveAt: string | null;
  /** The end of the submit window; null while it waits. */
  dueBy: string | null;
  /** Set when the window passed without a submit. */
  missedAt: string | null;
}

export const WHOP_STEPS = ["submitted", "approved", "paid"] as const;
export type WhopStep = (typeof WHOP_STEPS)[number];

export interface ExportPack {
  clipId: number;
  videoUrl: string;
  fileName: string;
  platform: Platform;
  caption: string;
  /** The permission the clip goes out under, with the proof for a public allowance. */
  permission: { kind: PermissionKind; campaignUrl: string | null; proofUrl: string | null; proofQuote: string | null };
}

/** One post a dry run says would go out: every check passed, nothing was sent or stored. */
export interface PlannedPost {
  accountId: string;
  accountName: string;
  platform: Platform;
  permissionId: number;
  caption: string;
  scheduledAt: string;
  /** Why it would wait past the wanted time (a platform's limit, the submit hours), in plain words. */
  note?: string | null;
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
  /** Campaign posts that were not submitted within 30 minutes, and what they would have earned. */
  missedWindows: number;
  lostEarningsUsd: number;
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
  /** Which engine handled the transcript and the picks, with the time per step; empty before they ran. */
  engines: string[];
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

/** What the box's auto-deploy last did (ops/clipfarm/autodeploy.sh writes it: names and states, never a key). */
export interface LiveVersion {
  /** The commit that was tried. */
  sha: string;
  at: string;
  /** "rolled back": it did not start, the version before it is live again. "failed": it could not be built. */
  result: "live" | "rolled back" | "failed";
  /** Why, in plain words; empty when it went live. */
  reason: string;
  keys: { name: string; state: "Working" | "Failed" | "Not set" }[];
  /** clipfarm:check: the service, its port, Caddy and the public address. */
  check: { ok: boolean; problems: string[] };
  postiz: { state: "healthy" | "not healthy" | "not installed"; detail: string };
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
  /** Test campaigns that are running or paused, and changes waiting for a yes or no: the same data as the Campaigns tab. */
  growth: { campaigns: CampaignSummary[]; recommendations: Recommendation[] };
}

export const WATCH_PLATFORMS = ["twitch", "kick", "youtube"] as const;
export type WatchPlatform = (typeof WATCH_PLATFORMS)[number];

export const WATCH_PLATFORM_LABELS: Record<WatchPlatform, string> = {
  twitch: "Twitch",
  kick: "Kick",
  youtube: "YouTube",
};

/** How clippers get a creator's permission. "none" means we know of no program yet. */
export const CLIP_PROGRAMS = ["whop", "own", "kick", "public", "none"] as const;
export type ClipProgram = (typeof CLIP_PROGRAMS)[number];

export const CLIP_PROGRAM_LABELS: Record<ClipProgram, string> = {
  whop: "Whop Content Rewards",
  own: "Their own program",
  kick: "Kick clipping program",
  public: "Says clipping is allowed",
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
  /** The workspace it belongs to (1, "Me", when left out). */
  workspaceId?: number;
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

export const INTEGRATION_IDS = ["openai", "google", "twitch", "youtube", "postiz", "upload-post", "stripe", "client-signin"] as const;
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
  /** What is used while nothing is set (the default model or address); null when there is none. */
  fallback: string | null;
  /** The choices for a dropdown (model names from the service, the recommended one first); null for a free text field. */
  options: string[] | null;
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
  id: "keys" | "accounts" | "isolation" | "permission" | "clip" | "post";
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

/** A clip should be in the Inbox this soon after its moment happened on a live stream. */
export const LIVE_TARGET_LATENCY_SEC = 15 * 60;

/** One watched creator on the Launch day card. */
export interface LiveCreatorStatus {
  creatorId: number;
  name: string;
  /** The per-creator switch. */
  on: boolean;
  permissionState: PermissionState;
  live: LiveNow | null;
  recording: boolean;
  /** Why it is not being recorded, in plain words; null while it is. */
  reason: string | null;
  /** Segments recorded, segments skipped because the server fell behind, and LIVE clips made, this stream. */
  segments: number;
  skipped: number;
  clips: number;
}

export interface LiveInfo {
  /** When GTA VI launches: before it, GTA VI streams are never recorded (early copies count as leaks). */
  launchAt: string;
  beforeLaunch: boolean;
  /** Live mode is on right now. */
  armed: boolean;
  /** Where things stand, in one plain line. */
  statusLine: string;
  /** Creators with a permission record, plus anyone being recorded. */
  creators: LiveCreatorStatus[];
  /** Watched creators left out of `creators` because they have no permission record. */
  needPermission: number;
  /** Why no new recording can start (disk or memory), or null. */
  guard: string | null;
  push: {
    /** The key the browser subscribes with; null when notifications cannot be sent (demo mode). */
    publicKey: string | null;
    /** Phones and browsers that get notifications. */
    subscribers: number;
  };
}

/** How clipfarm transcribes and picks: on this server by default, cloud AI only as a speed-up. */
export interface EngineSettings {
  /** "Use cloud AI for speed": OpenAI transcribes and picks instead of the local engine. */
  cloud: boolean;
  /** The local speech model, e.g. "base.en". */
  sttModel: string;
  /** Let the local writer (a small model on this server) write hooks and titles. */
  writer: boolean;
  /** The speech-to-text steps in the order they are tried, each on or off. Cloud on means "fall back to cloud". */
  stt: { id: string; on: boolean }[];
}

/** One step of the speech-to-text chain, as the Dashboard shows it. */
export interface EngineStepStatus {
  id: string;
  /** e.g. "Moonshine". */
  label: string;
  /** What the step is for, in a few words. */
  note: string;
  on: boolean;
  /** "missing": not downloaded; "blocked": cannot run right now (no key, no memory, no program). */
  state: "ready" | "missing" | "blocked";
  /** Why it is blocked, in plain words. */
  problem: string | null;
  /** What its Download button would fetch, in bytes; 0 when nothing. */
  downloadBytes: number;
  /** Seconds of audio it gets through per second on this server, measured on real jobs; null before the first one. */
  speed: number | null;
}

/** How much of one job a step handled. */
export interface EngineUse {
  step: string;
  label: string;
  /** Speech-to-text: segments and seconds of audio. Picks: clips. */
  count: number;
  audioSec: number;
  ms: number;
  /** The most memory the step held, in MB; null when it could not be read. */
  peakMb: number | null;
  /** e.g. "Spanish segment". */
  note: string;
}

/** Which engine handled what in one job, and how long each step took. */
export interface EngineReport {
  kind: "stt" | "picks";
  /** The language heard in the first 30 s of speech, e.g. "es"; null when it could not be told. */
  language: string | null;
  uses: EngineUse[];
  /** Each time a step was passed over or its answer thrown away: which step, and why. */
  fallbacks: { step: string; reason: string; count: number }[];
  /** e.g. "Moonshine 92%, Whisper small 8% (Spanish segment)". */
  summary: string;
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
  /** The speech-to-text chain in the order it is tried. */
  steps: EngineStepStatus[];
  /** The last 7 days: how many jobs ran and how often each step and each fallback was used. */
  week: { jobs: number; lines: string[] };
  sttModels: EngineModelChoice[];
  /** Whether an OpenAI key is on the server, so "Use cloud AI for speed" can be switched on. */
  cloudAvailable: boolean;
}
