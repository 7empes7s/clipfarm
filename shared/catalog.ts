// The campaign catalog: every clipping program that pays for clips, and the streamers who allow paid clipping.
import type { Platform } from "./types.js";

export const PROGRAM_IDS = ["content-rewards", "vyro", "clipping-net", "discord-payroll"] as const;
export type ProgramId = (typeof PROGRAM_IDS)[number];

export const PROGRAM_NAMES: Record<ProgramId, string> = {
  "content-rewards": "Content Rewards",
  vyro: "Vyro",
  "clipping-net": "Clipping.net",
  "discord-payroll": "Discord payroll",
};

/** How a campaign of the program gets into clipfarm. */
export type ProgramImport = "scout" | "paste-link" | "paste-text";

/** One clipping program, as far as public pages say. What they do not say stays null. */
export interface Program {
  id: ProgramId;
  name: string;
  /** Where to find its campaigns. */
  url: string;
  /** Sites its campaign links are on (a campaign link pasted from one of them is read as this program's). */
  hosts: string[];
  /** Pay per 1,000 views: the lowest and highest reported. */
  ratePer1kMinUsd: number | null;
  ratePer1kMaxUsd: number | null;
  /** The most one post can earn. */
  capPerPostUsd: number | null;
  /** Views a post needs before it pays. */
  minViews: number | null;
  platforms: Platform[];
  /** Days a post keeps earning after it goes up, then days before the money can be taken out. */
  earningWindowDays: number | null;
  holdDays: number | null;
  /** "scout": read by itself every day. "paste-link": paste a campaign link. "paste-text": paste the brief (no public page). */
  import: ProgramImport;
  /** False while the terms come from reports, not from the program itself. */
  termsConfirmed: boolean;
  /** Where the numbers above come from, and the day they were read. */
  factsUrl: string;
  checkedOn: string;
  /** What to know, in plain words. */
  note: string;
}

/** A program with what one of our clips should earn on it (rate × our typical views, capped). */
export interface ProgramListing extends Program {
  perClipUsd: number;
  /** How the estimate was made, in plain words. */
  estimateWhy: string;
}

/**
 * "program": the creator publicly pays for or allows clipping, with proof.
 * "no-program": none was found: their clips never go to main accounts.
 * "gone": the proof was not found on the last re-check: treated as no program until it is back.
 */
export const STREAMER_STATUSES = ["program", "no-program", "gone"] as const;
export type StreamerStatus = (typeof STREAMER_STATUSES)[number];

export interface StreamerEntry {
  name: string;
  status: StreamerStatus;
  /** The program or campaign they run ("Reach weekly campaign"); null without one. */
  program: string | null;
  /** The page that shows it, and words on it the re-check looks for. */
  proofUrl: string | null;
  proofQuote: string | null;
  /** Last time it was checked, and when it is checked again. */
  checkedAt: string;
  nextCheckAt: string;
  /** What the last check found, in plain words. */
  lastResult: string;
  note: string;
}

export interface CatalogInfo {
  programs: ProgramListing[];
  streamers: StreamerEntry[];
}

/** A streamer is checked again this often. */
export const STREAMER_RECHECK_DAYS = 7;
