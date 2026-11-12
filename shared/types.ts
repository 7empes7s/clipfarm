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
