/** The daily live proof and the launch drill: what the Proof card on the Dashboard shows. */

export type ProofKind = "vod" | "drill";
/** "campaign": the campaign channel's latest video. "gta": a GTA V / GTA RP video of a creator who publicly allows clipping. */
export type ProofTarget = "campaign" | "gta" | "drill";
export type ProofStatus = "waiting" | "running" | "passed" | "failed" | "skipped";
/** Who asked: the daily timer, the Dashboard button, or IT with clipfarm-ops. */
export type ProofAskedBy = "timer" | "app" | "ops";

/** What went wrong, in plain words. Each one is pushed to the manager's phone once. */
export interface ProofProblem {
  kind: "failed" | "slow" | "few";
  text: string;
}

export interface ProofMetrics {
  /** Length of the video, in seconds; null until it is known. */
  vodSec: number | null;
  /** Minutes from the start of the run to the first clip, and to the last. */
  firstClipMin: number | null;
  allClipsMin: number | null;
  clips: number;
  /** Clips the quality check looked at, and how many it passed. */
  qualityChecked: number;
  qualityPassed: number;
  /** "Local", "Cloud", "Local and cloud" or "Stand-in (demo)", with the steps that did the work. */
  engine: string;
  costUsd: number;
  /** The most memory the whole server had in use during the run, in MB. */
  ramPeakMb: number | null;
  /** Drill: seconds from the moment to its LIVE clip in the Inbox (the first clip, and the slowest). */
  firstLatencySec: number | null;
  worstLatencySec: number | null;
  /** Drill: segments recorded, and how many were dropped (skipped to keep up, or failed). */
  segments: number;
  dropped: number;
}

/** One number against its target. */
export interface ProofCheck {
  label: string;
  value: string;
  target: string;
  /** Null when there is no target to meet (cost, memory) or nothing to judge yet. */
  ok: boolean | null;
}

export interface ProofRun {
  id: number;
  kind: ProofKind;
  target: ProofTarget;
  askedBy: ProofAskedBy;
  status: ProofStatus;
  /** Whose video or stream, and its title. */
  label: string;
  url: string | null;
  vodId: number | null;
  /** What it is doing now, or why it was skipped. */
  step: string;
  problems: ProofProblem[];
  metrics: ProofMetrics;
  checks: ProofCheck[];
  /** The run's clips, best first. They wait in the Inbox like any other clip. */
  clipIds: number[];
  /** The manager's swipes on those clips. */
  approved: number;
  rejected: number;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** One day of the 7-day trend (the server's own days). */
export interface ProofDay {
  /** YYYY-MM-DD. */
  day: string;
  status: "passed" | "failed" | "none";
  clips: number;
  clipsPerHour: number | null;
  minPerHour: number | null;
  approved: number;
  rejected: number;
}

export interface LaunchReadiness {
  ready: boolean;
  /** Why not, in plain words; empty when ready. */
  reasons: string[];
}

export interface ProofInfo {
  /** A proof or a drill is waiting or running. */
  busy: boolean;
  /** The runs of the newest proof. */
  runs: ProofRun[];
  days: ProofDay[];
  /** The newest launch drill. */
  drill: ProofRun | null;
  launch: LaunchReadiness;
  /** When the daily proof runs next; null when the timer is off. */
  nextAt: string | null;
}

/** O1: a 1-hour video gives 10 or more clips in under 30 minutes. */
export const PROOF_CLIPS_PER_HOUR = 10;
export const PROOF_MIN_PER_HOUR = 30;
