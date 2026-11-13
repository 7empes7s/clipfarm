import type { PermissionState, WatchPlatform } from "../../../shared/types.js";
import { WATCH_PLATFORM_LABELS } from "../../../shared/types.js";

/** Other ways titles and categories name a game. Keys are lower case. */
const ALIASES: Record<string, string[]> = {
  "gta vi": ["gta vi", "gta 6", "gta6", "gtavi", "grand theft auto vi", "grand theft auto 6"],
};

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `text` names the game as whole words ("GTA VI" never matches "GTA V" or "GTA VII"). */
export function mentionsGame(text: string, game: string): boolean {
  const hay = ` ${normalize(text)} `;
  const names = ALIASES[normalize(game)] ?? [normalize(game)];
  return names.some((n) => n && new RegExp(` ${escapeRe(normalize(n))} `).test(hay));
}

export type VodMatch = { matched: true; game: string } | { matched: false };

/** Whether a VOD is one of the creator's games, by its category first, then its title. */
export function matchVod(vod: { title: string; category: string | null }, games: string[]): VodMatch {
  for (const game of games) {
    if ((vod.category && mentionsGame(vod.category, game)) || mentionsGame(vod.title, game)) return { matched: true, game };
  }
  return { matched: false };
}

/** Leaked footage is never clipped (charter: no leaks). */
export function mentionsLeak(title: string): boolean {
  return /\bleak(s|ed|ing)?\b/i.test(title);
}

export interface BroadcastTimes {
  platform: WatchPlatform;
  publishedAt: string;
  durationSec: number | null;
}

/** Two VODs on different platforms that started within 20 minutes and last about as long are one simulcast. */
export function sameBroadcast(a: BroadcastTimes, b: BroadcastTimes): boolean {
  if (a.platform === b.platform) return false;
  const startGap = Math.abs(new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime());
  if (startGap > 20 * 60_000) return false;
  if (a.durationSec === null || b.durationSec === null) return true;
  const longer = Math.max(a.durationSec, b.durationSec);
  return Math.abs(a.durationSec - b.durationSec) <= Math.max(600, longer * 0.1);
}

export const NEEDS_PERMISSION = "Needs permission: join their program";

export interface IngestCheck {
  permission: PermissionState;
  autoIngest: boolean;
  title: string;
  match: VodMatch;
  /** Older than the look-back window. */
  tooOld: boolean;
  /** The platform this broadcast was already queued from, if any. */
  duplicateOf: WatchPlatform | null;
}

export type IngestDecision = { queue: true } | { queue: false; reason: string };

/**
 * Whether a newly seen VOD is queued for ingest. The permission gate comes first:
 * a creator without an active record is watched, never ingested.
 */
export function decideIngest(c: IngestCheck): IngestDecision {
  if (c.permission === "needs-review") return { queue: false, reason: "Clipping allowance needs review: check it again in Sources" };
  if (c.permission !== "active") {
    return { queue: false, reason: c.permission === "expired" ? "Permission expired: renew it in their program" : NEEDS_PERMISSION };
  }
  if (mentionsLeak(c.title)) return { queue: false, reason: "The title mentions a leak" };
  if (!c.match.matched) return { queue: false, reason: "Not one of their games" };
  if (c.tooOld) return { queue: false, reason: "Too old" };
  if (c.duplicateOf) return { queue: false, reason: `Same stream already queued from ${WATCH_PLATFORM_LABELS[c.duplicateOf]}` };
  if (!c.autoIngest) return { queue: false, reason: "Auto-ingest is off" };
  return { queue: true };
}
