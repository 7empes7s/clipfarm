import type { Platform } from "../../shared/types.js";
import { limitFor, nextBestTime, type PlatformLimit } from "../../shared/publishing.js";
import { localParts, zonedTime } from "../../shared/submitWindow.js";

const HOUR = 3600_000;

/** A post that went out or is due: it counts against its account's and its app's limits. */
export interface Booking {
  accountId: string;
  platform: Platform;
  /** The developer app it goes through: "group:<id>" for our own uploads, "service:<name>" for Postiz and the like. */
  app: string;
  at: Date;
}

export interface SlotRequest {
  accountId: string;
  accountName: string;
  platform: Platform;
  app: string;
  wanted: Date;
  /** Every other post that went out or is due (not this one). */
  bookings: Booking[];
  /** The account's own spacing (posts a day, minutes apart, submit hours): the earliest time at or after `from`. */
  pace: (from: Date) => Date;
  /** Why the spacing moved it, in plain words, e.g. "GTA VI Moments posts 3 a day, 90 min apart". */
  paceText: string;
  /** Only inside these hours (autopilot's "next best slot"); left out: any time. */
  best?: { hours: number[]; timeZone: string } | null;
  tiktokAudited?: boolean;
  /** The platform's limit is kept elsewhere (a direct YouTube upload counts its group's real units). */
  ignoreLimit?: boolean;
}

export interface PlannedSlot {
  at: Date;
  /** Why it is later than wanted, in plain words; empty when it goes at the wanted time. */
  reasons: string[];
}

function dayKey(t: number, timeZone: string): string {
  const { y, m, d } = localParts(t, timeZone);
  return `${y}-${m}-${d}`;
}

function nextMidnight(t: number, timeZone: string): number {
  const { y, m, d } = localParts(t, timeZone);
  return zonedTime(y, m, d + 1, 0, timeZone);
}

/** True when no post in `times` has more than `max` posts in the `hours` hours up to and including it. */
function rollingOk(times: number[], max: number, hours: number): boolean {
  const sorted = [...times].sort((a, b) => a - b);
  let start = 0;
  for (let i = 0; i < sorted.length; i++) {
    while (sorted[start]! <= sorted[i]! - hours * HOUR) start++;
    if (i - start + 1 > max) return false;
  }
  return true;
}

/** Why the platform's API limit keeps a post off time `t`, and the earliest time worth trying next; null when it fits. */
export function limitBlock(req: SlotRequest, t: number, limit: PlatformLimit | null): { until: number; reason: string } | null {
  if (!limit) return null;
  const same = req.bookings.filter((b) => b.platform === req.platform);
  switch (limit.kind) {
    case "app-day": {
      const day = dayKey(t, limit.timeZone);
      const n = same.filter((b) => b.app === req.app && dayKey(b.at.getTime(), limit.timeZone) === day).length;
      return n >= limit.max ? { until: nextMidnight(t, limit.timeZone), reason: `${limit.text} ${n} are already booked that day.` } : null;
    }
    case "app-accounts-day": {
      const day = dayKey(t, limit.timeZone);
      const accounts = new Set(same.filter((b) => b.app === req.app && dayKey(b.at.getTime(), limit.timeZone) === day).map((b) => b.accountId));
      if (accounts.has(req.accountId) || accounts.size < limit.max) return null;
      return { until: nextMidnight(t, limit.timeZone), reason: `${limit.text} ${accounts.size} accounts already post that day.` };
    }
    case "account-rolling": {
      const mine = same.filter((b) => b.accountId === req.accountId).map((b) => b.at.getTime());
      if (rollingOk([...mine, t], limit.max, limit.hours)) return null;
      const window = limit.hours * HOUR;
      // Full in the hours before t: wait until the oldest of those is old enough. Else a later run
      // of posts would go over, so try just after the next of them.
      const before = mine.filter((x) => x > t - window && x <= t).sort((a, b) => a - b);
      const until = before.length >= limit.max ? before[0]! + window : Math.min(...mine.filter((x) => x > t)) + 1;
      return { until, reason: limit.text };
    }
  }
}

/**
 * The slot planner: the earliest time at or after `wanted` that keeps the account's own spacing,
 * the platform's API limit (YouTube per project per day, Instagram per account per 24 hours,
 * TikTok's unaudited 5 accounts a day…) and, when asked, a best hour. It never overbooks: a post
 * that does not fit rolls to the next time that does, with each reason in plain words.
 */
export function planSlot(req: SlotRequest): PlannedSlot {
  const limit = req.ignoreLimit ? null : limitFor(req.platform, req.tiktokAudited ?? false);
  const reasons: string[] = [];
  const because = (r: string) => {
    const text = /[.!?]$/.test(r) ? r : `${r}.`;
    if (!reasons.includes(text)) reasons.push(text);
  };
  let t = req.wanted.getTime();
  // Each pass moves t forward past one conflict; a year of passes means something is wrong.
  for (let pass = 0; pass < 5000; pass++) {
    if (req.best) {
      const snapped = nextBestTime(new Date(t), req.best.hours, req.best.timeZone).getTime();
      if (snapped !== t) {
        t = snapped;
        continue;
      }
    }
    const paced = req.pace(new Date(t)).getTime();
    if (paced !== t) {
      because(req.paceText);
      t = paced;
      continue;
    }
    const block = limitBlock(req, t, limit);
    if (block) {
      because(block.reason);
      t = Math.max(block.until, t + 1);
      continue;
    }
    return { at: new Date(t), reasons };
  }
  throw new Error(`No free slot found for ${req.accountName}.`);
}
