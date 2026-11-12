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

export interface Source {
  id: number;
  creatorName: string;
  channelUrls: string[];
  bannedContent: string;
  /** Where the creator's face cam sits in their stream, for the stacked layout; null if none. */
  faceCam: CropRect | null;
  /** Whether a frame of their stream is saved to draw the face cam on. */
  hasFrame: boolean;
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
  createdAt: string;
  updatedAt: string;
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

/** A rectangle as fractions (0..1) of the source frame, so it fits any resolution. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * How a clip is laid out on the 1080×1920 canvas: face cam over gameplay, a center crop of the
 * gameplay, or the whole frame over a blurred copy of itself.
 */
export const LAYOUTS = ["stacked", "center", "full"] as const;
export type Layout = (typeof LAYOUTS)[number];

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
  layout: Layout;
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
  createdAt: string;
}
