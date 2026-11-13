import { type CampaignProgress, type Digest, NOT_AVAILABLE } from "../../shared/growth.js";

/** The hour the daily digest goes out, on the phone's clock. */
export const DIGEST_HOUR = 9;

export interface DigestInput {
  /** Views gained yesterday over every post, and the post that gained most; null without readings. */
  yesterday: { views: number; best: { title: string; views: number } | null } | null;
  campaigns: { name: string; progress: CampaignProgress }[];
  /** The newest open recommendation. */
  recommendation: string | null;
}

/** The daily digest in a few plain lines: yesterday's views, the best clip, each running campaign and one tip. */
export function buildDigest({ yesterday, campaigns, recommendation }: DigestInput): Digest {
  const lines = [yesterday ? `Yesterday: ${yesterday.views.toLocaleString("en")} views` : `Yesterday's views: ${NOT_AVAILABLE}`];
  if (yesterday?.best) lines.push(`Best clip: "${yesterday.best.title}" (+${yesterday.best.views.toLocaleString("en")} views)`);
  for (const c of campaigns.slice(0, 3)) lines.push(`${c.name}: day ${c.progress.day} of ${c.progress.days}, ${c.progress.posts} of ${c.progress.planned} posts`);
  if (campaigns.length === 0) lines.push("No campaign is running.");
  if (recommendation) lines.push(`Tip: ${recommendation}`);
  return { title: "clipfarm: yesterday", lines };
}

export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The date and hour on a clock in `tz`; an unknown zone counts as UTC. */
export function localDayHour(now: Date, tz: string): { day: string; hour: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
    const get = (type: string) => parts.find((p) => p.type === type)!.value;
    return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
  } catch {
    return { day: now.toISOString().slice(0, 10), hour: now.getUTCHours() };
  }
}

/** Due once a day from 09:00 on the manager's clock; after noon a missed one is skipped, not sent late. */
export function digestDue(now: Date, tz: string, lastDigestDay: string | null): string | null {
  const { day, hour } = localDayHour(now, tz);
  return hour >= DIGEST_HOUR && hour < 12 && lastDigestDay !== day ? day : null;
}
