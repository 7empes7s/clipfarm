import type { JobStatus, PermissionState, Platform } from "./types.js";

/** How one thing on the Operations page stands: fine, worth a look, broken, or not set up. */
export type OpsLevel = "ok" | "warn" | "down" | "off";

const ORDER: OpsLevel[] = ["off", "ok", "warn", "down"];

/** The worst of the levels ("off" counts as fine: a thing that is not set up is not broken). */
export function worstLevel(levels: OpsLevel[]): OpsLevel {
  return levels.reduce<OpsLevel>((worst, l) => (ORDER.indexOf(l) > ORDER.indexOf(worst) ? l : worst), "ok");
}

export interface OpsCheck {
  id: string;
  label: string;
  level: OpsLevel;
  /** In plain words: "Up", "12 GB free (40%)", "OpenAI says: invalid key". */
  detail: string;
}

export interface OpsDeploy {
  /** The commit the auto-deploy last tried; null when there is no deploy record (not the box). */
  sha: string | null;
  at: string | null;
  result: "live" | "rolled back" | "failed" | null;
  reason: string;
  lastRollback: { sha: string; at: string; reason: string } | null;
}

export interface OpsStatus {
  /** The worst level below: red when anything is down. */
  level: OpsLevel;
  deploy: OpsDeploy;
  services: OpsCheck[];
  /** Disk and memory headroom, as clipfarm sees them. */
  resources: OpsCheck[];
  /** Provider keys (from their last test) and YouTube quota per app. */
  keys: OpsCheck[];
  /** Today's live proof. */
  proof: OpsCheck;
  checkedAt: string;
}

export interface OpsJob {
  id: number;
  type: string;
  /** The pipeline step in plain words: "Transcript", "Picks", "Cutting a clip". */
  step: string;
  status: JobStatus;
  progress: number;
  message: string;
  error: string | null;
  /** What it works on: the video's or clip's title, when it has one. */
  what: string | null;
  createdAt: string;
  startedAt: string | null;
  priority: number;
  canRetry: boolean;
  canCancel: boolean;
  canMoveTop: boolean;
}

export interface OpsPost {
  id: number;
  clipId: number;
  clipTitle: string;
  platform: Platform;
  accountId: string;
  accountName: string;
  status: "scheduled" | "failed";
  scheduledAt: string;
  error: string | null;
  note: string | null;
  /** Still waits in clipfarm, so it can be moved or skipped here (not yet handed to the posting service). */
  movable: boolean;
}

export interface OpsAccountPosts {
  platform: Platform;
  accountId: string;
  accountName: string;
  scheduled: OpsPost[];
  failed: OpsPost[];
}

export interface OpsSubmit {
  postId: number;
  clipTitle: string;
  platform: Platform;
  accountName: string;
  url: string | null;
  dueBy: string | null;
}

export interface OpsCampaign {
  permissionId: number;
  creatorName: string;
  campaignUrl: string | null;
  /** Minutes after a post goes live within which it must be submitted. */
  windowMin: number;
  /** Live posts whose window is still open: Submit now. */
  open: OpsSubmit[];
  missed: number;
  lostUsd: number;
  payout: { submitted: number; approved: number; paid: number; rejected: number; estimatedUsd: number };
}

export interface OpsSource {
  id: number;
  name: string;
  channels: string[];
  live: boolean;
  lastVodTitle: string | null;
  lastVodAt: string | null;
  permissionState: PermissionState;
  autoIngest: boolean;
  paused: boolean;
}

export interface OpsActivity {
  id: number;
  at: string;
  who: string;
  action: string;
  target: string;
  detail: string;
}

export interface OpsInfo {
  status: OpsStatus;
  worker: { paused: boolean; since: string | null; seenAt: string | null };
  /** Running and waiting jobs in the order they run, then recent failures. */
  jobs: OpsJob[];
  publishing: { paused: boolean; since: string | null; accounts: OpsAccountPosts[] };
  campaigns: OpsCampaign[];
  sources: OpsSource[];
  activity: OpsActivity[];
}
