// The campaign scout: what it reads from public campaign pages, how it scores them, and auto mode's plan.
import type { Platform } from "./types.js";

/** What a public campaign page says. What it does not say stays null or empty, never guessed. */
export interface ScoutFacts {
  title: string;
  creatorName: string | null;
  /** The agency page this campaign was found on, when it was. */
  agency: string | null;
  /** The creator's Twitch, Kick or YouTube channels linked on the page. */
  channelUrls: string[];
  /** Pay per 1,000 views; the lowest when the page gives one per platform. */
  ratePer1kUsd: number | null;
  /** The least a clip must earn to be paid, and the most one clip can earn. */
  payoutMinUsd: number | null;
  payoutMaxUsd: number | null;
  budgetUsedUsd: number | null;
  budgetTotalUsd: number | null;
  budgetLeftUsd: number | null;
  platforms: Platform[];
  minViews: number | null;
  /** Lines about who must be watching ("Audience at least 50% US/UK"). */
  audience: string[];
  /** The page's do and don't lines. */
  rules: string[];
  /** Requirements the page shows only after joining. */
  lockedRequirements: number;
  /** How many clippers have joined. */
  clippers: number | null;
  /** ISO timestamp of the end of the campaign's last day. */
  expiresAt: string | null;
  /** Set when the page says the campaign is over or out of budget: why, in plain words. */
  ended: string | null;
}

/** One line of the score's working: a factor, its number and why. */
export interface ScoreStep {
  label: string;
  /** "$4.50", "× 0.80", "− 30%". */
  value: string;
  why: string;
}

export interface ScoutScore {
  /** Expected dollars per clip after every factor and penalty: what campaigns are ranked by. */
  score: number;
  /** The score times the clips we post a day. */
  perDayUsd: number;
  steps: ScoreStep[];
}

/** "new": suggested. "opened": Join was tapped, waiting for "Joined?". "hidden": not interested. */
export const SCOUT_STATUSES = ["new", "opened", "hidden"] as const;
export type ScoutStatus = (typeof SCOUT_STATUSES)[number];

export interface ScoutedCampaign {
  id: number;
  url: string;
  facts: ScoutFacts;
  score: ScoutScore;
  status: ScoutStatus;
  firstSeenAt: string;
  readAt: string;
}

/** One joined campaign in auto mode's plan for a day. */
export interface AutoPlanRow {
  permissionId: number;
  name: string;
  score: number;
  /** Clips this campaign gets a day. */
  slots: number;
  /** Share of the budget already paid out, 0..100; null when the page does not show it. */
  budgetUsedPct: number | null;
  /** Why it gets no clips (budget nearly out, ended), in plain words. */
  paused: string | null;
}

export interface ScoutInfo {
  /** The top campaigns we have not joined or hidden, best first. */
  suggestions: ScoutedCampaign[];
  /** Campaigns read so far. */
  found: number;
  running: boolean;
  lastRunAt: string | null;
  /** Why the last run read nothing, in plain words. */
  lastError: string | null;
  auto: {
    on: boolean;
    /** Clips a day the posting accounts that take campaign clips can carry. */
    slots: number;
    plan: AutoPlanRow[];
  };
}

/** A joined campaign with less than this share of its budget left gets no more clips in auto mode. */
export const AUTO_PAUSE_BUDGET_LEFT = 0.1;
/** The share of a joined campaign's budget used at which the manager is told. */
export const BUDGET_NOTICE_USED = 0.85;
/** How many campaigns "Campaigns for you" shows. */
export const SUGGESTION_COUNT = 5;
