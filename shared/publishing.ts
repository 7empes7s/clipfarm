// Cross-platform publishing: each platform's limits, best times, the calendar, per-platform versions
// and autopilot rules. Shared by the server (which enforces them) and the gallery (which shows them).
import type { Platform, Post } from "./types.js";
import { localParts, zonedTime } from "./submitWindow.js";

/** A limit the platform's API puts on top of each account's own posts-per-day. */
export type PlatformLimit =
  /** At most `max` uploads per developer app (API project) per day in `timeZone`. */
  | { kind: "app-day"; max: number; timeZone: string; text: string; source: string }
  /** At most `max` posts per account in any `hours` hours. */
  | { kind: "account-rolling"; max: number; hours: number; text: string; source: string }
  /** At most `max` different accounts posting per developer app per day in `timeZone`. */
  | { kind: "app-accounts-day"; max: number; timeZone: string; text: string; source: string };

export interface PlatformRule {
  /** Longest title (YouTube's video title; elsewhere it is the caption's first line). */
  titleMax: number;
  /** Longest caption, hashtags included. */
  captionMax: number;
  /** Hashtags that are safe to use; more look spammy or are ignored. Required campaign tags may go over it. */
  hashtagsMax: number;
  /** The API's own limit, or null when only each account's daily cap applies. */
  limit: PlatformLimit | null;
}

const YT_QUOTA = "https://developers.google.com/youtube/v3/determine_quota_cost";
const IG_LIMIT = "https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/content-publishing";
const TT_LIMIT = "https://developers.tiktok.com/doc/content-posting-api-reference-direct-post";
const FB_LIMIT = "https://developers.facebook.com/docs/video-api/guides/reels-publishing";
const THREADS_LIMIT = "https://developers.facebook.com/docs/threads/overview";

export const PLATFORM_RULES: Record<Platform, PlatformRule> = {
  youtube: {
    titleMax: 100,
    captionMax: 5000,
    hashtagsMax: 3,
    limit: {
      kind: "app-day",
      max: 6,
      timeZone: "America/Los_Angeles",
      text: "YouTube gives each API project 10,000 units a day and an upload costs 1,600: about 6 uploads a day (Pacific time).",
      source: YT_QUOTA,
    },
  },
  tiktok: {
    titleMax: 100,
    captionMax: 2200,
    hashtagsMax: 5,
    limit: {
      kind: "app-accounts-day",
      max: 5,
      timeZone: "UTC",
      text: "Until TikTok audits the posting app, it posts privately and for at most 5 accounts a day.",
      source: TT_LIMIT,
    },
  },
  instagram: {
    titleMax: 100,
    captionMax: 2200,
    hashtagsMax: 5,
    limit: { kind: "account-rolling", max: 50, hours: 24, text: "Instagram allows 50 posts per account in any 24 hours.", source: IG_LIMIT },
  },
  facebook: {
    titleMax: 100,
    captionMax: 2200,
    hashtagsMax: 3,
    limit: { kind: "account-rolling", max: 30, hours: 24, text: "Facebook allows 30 Reels per Page in any 24 hours through the API.", source: FB_LIMIT },
  },
  threads: {
    titleMax: 100,
    captionMax: 500,
    hashtagsMax: 1,
    limit: { kind: "account-rolling", max: 250, hours: 24, text: "Threads allows 250 posts per account in any 24 hours.", source: THREADS_LIMIT },
  },
  x: { titleMax: 100, captionMax: 280, hashtagsMax: 2, limit: null },
  linkedin: { titleMax: 100, captionMax: 3000, hashtagsMax: 3, limit: null },
  bluesky: { titleMax: 100, captionMax: 300, hashtagsMax: 3, limit: null },
};

/** The limit in force: TikTok's only applies until its app passes the audit. */
export function limitFor(platform: Platform, tiktokAudited: boolean): PlatformLimit | null {
  if (platform === "tiktok" && tiktokAudited) return null;
  return PLATFORM_RULES[platform].limit;
}

/** Hours (on the manager's clock) that do well for short videos, used until our own posts say otherwise. */
export const DEFAULT_BEST_HOURS: Record<Platform, number[]> = {
  youtube: [12, 15, 19],
  tiktok: [9, 12, 19],
  instagram: [11, 13, 19],
  facebook: [9, 13, 16],
  threads: [8, 12, 18],
  x: [9, 12, 17],
  linkedin: [8, 12, 17],
  bluesky: [9, 13, 20],
};

/** Posts with views a platform needs before its best hours are learned from them. */
export const LEARN_AFTER_POSTS = 10;

export interface BestTimes {
  platform: Platform;
  /** Hours of the day (0-23) on the manager's clock, earliest first. */
  hours: number[];
  /** True when the hours come from our own posts' views. */
  learned: boolean;
  /** How many of our posts they are based on (0 for the defaults). */
  basedOn: number;
}

/**
 * The best hours for a platform: the 3 hours whose posts drew the most views on average once there
 * are LEARN_AFTER_POSTS posts with views (an hour needs 2 posts to count), topped up with the
 * defaults when fewer hours qualify. Before that, the defaults.
 */
export function bestTimes(platform: Platform, posts: { platform: Platform; at: string; views: number | null }[], timeZone: string): BestTimes {
  const seen = posts.filter((p) => p.platform === platform && p.views !== null);
  const defaults = DEFAULT_BEST_HOURS[platform];
  if (seen.length < LEARN_AFTER_POSTS) return { platform, hours: defaults, learned: false, basedOn: 0 };
  const byHour = new Map<number, number[]>();
  for (const p of seen) {
    const hour = Math.floor(localParts(new Date(p.at).getTime(), timeZone).min / 60);
    byHour.set(hour, [...(byHour.get(hour) ?? []), p.views!]);
  }
  const ranked = [...byHour.entries()]
    .filter(([, v]) => v.length >= 2)
    .map(([hour, v]) => ({ hour, avg: v.reduce((a, b) => a + b, 0) / v.length }))
    .sort((a, b) => b.avg - a.avg || a.hour - b.hour)
    .map((r) => r.hour);
  const hours = [...new Set([...ranked.slice(0, 3), ...defaults])].slice(0, 3).sort((a, b) => a - b);
  return { platform, hours, learned: ranked.length > 0, basedOn: seen.length };
}

/** The earliest moment at or after `t` that falls in one of the hours (on the zone's clock). */
export function nextBestTime(t: Date, hours: number[], timeZone: string): Date {
  if (hours.length === 0) return t;
  const ms = t.getTime();
  const { y, m, d, min } = localParts(ms, timeZone);
  if (hours.includes(Math.floor(min / 60))) return t;
  const sorted = [...hours].sort((a, b) => a - b);
  for (let k = 0; k < 3; k++) {
    for (const h of sorted) {
      const at = zonedTime(y, m, d + k, h * 60, timeZone);
      if (at > ms) return new Date(at);
    }
  }
  return t;
}

/** What a slot on the calendar shows: "posting" is a post whose time came and that the platform has not confirmed. */
export type SlotStatus = "scheduled" | "posting" | "posted" | "failed";

export const SLOT_STATUS_LABELS: Record<SlotStatus, string> = { scheduled: "Scheduled", posting: "Posting", posted: "Posted", failed: "Failed" };

export function slotStatus(post: Pick<Post, "status" | "scheduledAt">, now: Date): SlotStatus {
  if (post.status !== "scheduled") return post.status;
  return new Date(post.scheduledAt).getTime() <= now.getTime() ? "posting" : "scheduled";
}

export interface CalendarItem {
  post: Post;
  status: SlotStatus;
  /** Can be dragged to another time: it waits in clipfarm and its time has not come. */
  movable: boolean;
  /** Failed and not tried again yet. */
  retryable: boolean;
}

export interface CalendarInfo {
  items: CalendarItem[];
  /** The manager's time zone (from the submit hours): days and best hours are on this clock. */
  timeZone: string;
  best: BestTimes[];
  /** Each platform's API limit in force, in plain words, with its source. */
  limits: { platform: Platform; text: string; source: string }[];
  tiktokAudited: boolean;
}

/** One clip's title, caption, hashtags and cover on one platform. */
export interface PostVersion {
  platform: Platform;
  title: string;
  /** Everything but the hashtags: the title line, the credit, required links and text. */
  caption: string;
  /** Each with its #; required campaign tags are in here. */
  hashtags: string[];
  /** A cover picked from the clip's thumbnails; null uses the platform's own frame. */
  coverId: number | null;
  /** False: the version made from the clip and its campaign, not saved by hand yet. */
  saved: boolean;
  /** What is wrong with it, in plain words; it cannot be saved or posted until this is empty. */
  problems: string[];
}

export interface ClipVersions {
  clipId: number;
  versions: PostVersion[];
  /** Covers to pick from (the clip's thumbnails). */
  covers: { id: number; label: string; url: string }[];
  /** Hashtags the campaign requires on every platform. */
  requiredTags: string[];
}

/** "When a clip from <source/campaign> scores ≥ X and passes the quality check → post to <accounts> → submit." */
export interface AutopilotRule {
  id: number;
  name: string;
  enabled: boolean;
  /** Only clips of this source; null: any source. */
  sourceId: number | null;
  /** Only clips under this campaign (permission record), which also gets the submit; null: any. */
  permissionId: number | null;
  /** 0..100: the picker's score the clip needs. */
  minScore: number;
  /** The clip must have passed the automatic quality check. */
  needsQuality: boolean;
  accountIds: string[];
  /** Posts to main accounts without the manager's approve tap (burners never need one). */
  auto: boolean;
  /** Posts only to burner accounts; experiment clips are always burner-only. */
  burnerOnly: boolean;
  /** Posts this rule makes a day (UTC). */
  dailyCap: number;
  /** Shows what it would have done instead of posting. */
  dryRun: boolean;
}

export type AutopilotAction = "post" | "wait-approval" | "skip";

export interface AutopilotStep {
  ruleId: number;
  ruleName: string;
  clipId: number;
  clipTitle: string;
  accountId: string | null;
  accountName: string | null;
  action: AutopilotAction;
  /** When it posts (or would post). */
  at: string | null;
  /** Why, in plain words. */
  reason: string;
  dryRun: boolean;
  createdAt: string;
}

export interface AutopilotInfo {
  rules: AutopilotRule[];
  /** The latest steps the rules took (or would have taken in dry run), newest first. */
  recent: AutopilotStep[];
}
