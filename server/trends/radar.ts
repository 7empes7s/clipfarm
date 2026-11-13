import type { Clip, Source, WatchChannel } from "../../shared/types.js";
import {
  HOOK_PATTERN_LABELS,
  type HookPattern,
  MOMENT_TYPE_LABELS,
  type MomentType,
  TREND_WEIGHT_MAX,
  type TrendClipTip,
  type TrendGroup,
  type TrendReport,
  type TrendStreamer,
  type TrendVideo,
} from "../../shared/trends.js";
import type { Db } from "../db/index.js";
import { ValidationError } from "../errors.js";
import type { ChatClient } from "../pipeline/picks/llm.js";
import type { TrendBoost } from "./boost.js";
import { keywordHook, keywordMoment, parseTags, type Tags, TAGS_SCHEMA, TAGS_SYSTEM } from "./tags.js";
import type { TrendSource } from "./youtube.js";

/** YouTube quota units the radar may spend a day (the free quota is 10,000; the watchlist uses some too). */
export const DAILY_QUOTA = 1500;
export const TREND_QUERIES = ["GTA VI", "GTA 6"];
/** How far back the radar looks, and how long its picture of "today" is trusted. */
export const TREND_WINDOW_HOURS = 48;
const TOP_VIDEOS = 50;
/** Shorts run up to 3 minutes; YouTube's "short" search filter lets up to 4 through. */
const MAX_SHORT_SEC = 180;
const DEFAULT_WEIGHT = 5;
const HOUR = 3_600_000;

interface State {
  refreshedAt: string | null;
  attemptedAt: string | null;
  error: string | null;
  tagger: "ai" | "keywords" | null;
  quotaDay: string;
  quotaUsed: number;
  weight: number;
}

interface Row {
  video_id: string;
  title: string;
  channel: string;
  duration_sec: number | null;
  views: number;
  published_at: string;
  views_per_hour: number;
  streamer: string | null;
  moment_type: MomentType;
  hook_pattern: HookPattern;
}

export interface WatchedName {
  name: string;
  channels: WatchChannel[];
}

export interface TrendRadarDeps {
  db: Db;
  /** Read on every refresh, so a key saved in Settings is in use at once. */
  source: () => TrendSource;
  /** The AI model that tags titles; null (or left out) tags by keywords. */
  chat?: () => ChatClient | null;
  watchlist?: () => WatchedName[];
  now?: () => Date;
}

const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const num = (n: number) => n.toLocaleString("en-US");
/** YouTube's quota day starts at midnight Pacific time. */
const pacificDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(d);

/** The watchlist streamer a video is from (its channel) or about (named in its title). */
function streamerOf(title: string, channel: string, watched: WatchedName[]): string | null {
  const c = plain(channel);
  const t = plain(title);
  const hit = watched.find((w) => {
    const name = plain(w.name);
    return name.length > 0 && (c === name || w.channels.some((ch) => plain(ch.handle) === c) || (name.length >= 4 && t.includes(name)));
  });
  return hit?.name ?? null;
}

function groups<T extends string>(videos: TrendVideo[], tagOf: (v: TrendVideo) => T, labels: Record<T, string>): TrendGroup<T>[] {
  const out = new Map<T, TrendGroup<T>>();
  // Videos come best first, so each group's examples are its fastest.
  for (const v of videos) {
    const tag = tagOf(v);
    if (tag === "other") continue;
    const g = out.get(tag) ?? { tag, label: labels[tag], videos: 0, viewsPerHour: 0, examples: [] };
    g.videos++;
    g.viewsPerHour += v.viewsPerHour;
    if (g.examples.length < 3) g.examples.push({ title: v.title, url: v.url, channel: v.channel, viewsPerHour: v.viewsPerHour });
    out.set(tag, g);
  }
  return [...out.values()].sort((a, b) => b.viewsPerHour - a.viewsPerHour);
}

/**
 * Learns what GTA clips win today from public YouTube data: the fastest short videos of the last
 * 48 h, tagged by moment type and hook pattern. It keeps titles, channels and numbers only.
 */
export class TrendRadar {
  private now: () => Date;

  constructor(private deps: TrendRadarDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private state(): State {
    const row = this.deps.db.prepare("SELECT value FROM settings WHERE key = 'trends'").get() as { value: string } | undefined;
    const saved = row ? (JSON.parse(row.value) as Partial<State>) : {};
    const state: State = { refreshedAt: null, attemptedAt: null, error: null, tagger: null, quotaDay: "", quotaUsed: 0, weight: DEFAULT_WEIGHT, ...saved };
    const today = pacificDay(this.now());
    return state.quotaDay === today ? state : { ...state, quotaDay: today, quotaUsed: 0 };
  }

  private save(change: Partial<State>): void {
    this.deps.db
      .prepare("INSERT INTO settings (key, value) VALUES ('trends', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify({ ...this.state(), ...change }));
  }

  private refreshCost(): number {
    return this.deps.source().maxUnits(TREND_QUERIES.length);
  }

  quota(): TrendReport["quota"] {
    return { usedToday: this.state().quotaUsed, dailyBudget: DAILY_QUOTA, refreshCost: this.refreshCost() };
  }

  weight(): number {
    return this.state().weight;
  }

  setWeight(raw: unknown): number {
    const weight = Number(raw);
    if (raw === null || raw === "" || !Number.isInteger(weight) || weight < 0 || weight > TREND_WEIGHT_MAX) {
      throw new ValidationError(`The boost must be a whole number from 0 to ${TREND_WEIGHT_MAX}.`);
    }
    this.save({ weight });
    return weight;
  }

  /** Time for the daily refresh: a key is set, the last try is a day old (3 h after a failure) and the budget allows it. */
  due(): boolean {
    const s = this.state();
    if (this.deps.source().missing || s.quotaUsed + this.refreshCost() > DAILY_QUOTA) return false;
    if (!s.attemptedAt) return true;
    return this.now().getTime() - new Date(s.attemptedAt).getTime() >= (s.error ? 3 : 24) * HOUR;
  }

  /** The timer's refresh: a failure is kept to show on the Dashboard, never thrown. */
  async refreshIfDue(): Promise<void> {
    if (this.due()) await this.refresh().catch(() => undefined);
  }

  /** Reads today's videos, ranks them by views per hour, tags the top 50 and stores them. */
  async refresh(signal?: AbortSignal): Promise<void> {
    const source = this.deps.source();
    if (source.missing) throw new ValidationError(source.missing);
    const used = this.state().quotaUsed;
    if (used + this.refreshCost() > DAILY_QUOTA) {
      throw new ValidationError(
        `Today's YouTube budget for the trend radar is used up (${num(used)} of ${num(DAILY_QUOTA)} units). It starts again at midnight Pacific time.`,
      );
    }
    const now = this.now();
    this.save({ attemptedAt: now.toISOString() });
    let ranked: TrendVideo[];
    try {
      const raw = await source.fetch({
        queries: TREND_QUERIES,
        publishedAfter: new Date(now.getTime() - TREND_WINDOW_HOURS * HOUR),
        spend: (units) => this.save({ quotaUsed: this.state().quotaUsed + units }),
        signal,
      });
      const watched = this.deps.watchlist?.() ?? [];
      ranked = raw
        .filter((v) => v.durationSec === null || v.durationSec <= MAX_SHORT_SEC)
        .map((v) => {
          // Under an hour old counts as one hour, so a video with a handful of views is not "fastest".
          const hours = Math.max(1, (now.getTime() - new Date(v.publishedAt).getTime()) / HOUR);
          return {
            ...v,
            url: `https://www.youtube.com/shorts/${v.videoId}`,
            viewsPerHour: Math.round(v.views / hours),
            streamer: streamerOf(v.title, v.channel, watched),
            momentType: "other" as MomentType,
            hookPattern: "other" as HookPattern,
          };
        })
        .sort((a, b) => b.viewsPerHour - a.viewsPerHour)
        .slice(0, TOP_VIDEOS);
    } catch (err) {
      this.save({ error: (err as Error).message });
      throw err;
    }
    const { tags, tagger } = await this.tag(ranked.map((v) => v.title), signal);
    const db = this.deps.db;
    const insert = db.prepare(
      `INSERT INTO trend_videos (video_id, title, channel, duration_sec, views, published_at, views_per_hour, streamer, moment_type, hook_pattern)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.transaction(() => {
      db.prepare("DELETE FROM trend_videos").run();
      ranked.forEach((v, i) =>
        insert.run(v.videoId, v.title, v.channel, v.durationSec, v.views, v.publishedAt, v.viewsPerHour, v.streamer, tags[i]!.momentType, tags[i]!.hookPattern),
      );
    })();
    this.save({ refreshedAt: now.toISOString(), error: null, tagger });
  }

  private async tag(titles: string[], signal?: AbortSignal): Promise<{ tags: Tags[]; tagger: "ai" | "keywords" }> {
    const chat = titles.length > 0 ? this.deps.chat?.() : null;
    if (chat) {
      try {
        const user = titles.map((t, i) => `${i}. ${t}`).join("\n");
        const res = await chat.complete({ system: TAGS_SYSTEM, user, schemaName: "trend_tags", schema: TAGS_SCHEMA }, signal);
        return { tags: parseTags(res.content, titles), tagger: "ai" };
      } catch {
        // The model is down or over its limit: keywords still give a usable picture.
      }
    }
    return { tags: titles.map((t) => ({ momentType: keywordMoment(t), hookPattern: keywordHook(t) })), tagger: "keywords" };
  }

  /** The stored videos, fastest first. */
  videos(): TrendVideo[] {
    const rows = this.deps.db.prepare("SELECT * FROM trend_videos ORDER BY views_per_hour DESC, video_id").all() as Row[];
    return rows.map((r) => ({
      videoId: r.video_id,
      title: r.title,
      channel: r.channel,
      url: `https://www.youtube.com/shorts/${r.video_id}`,
      durationSec: r.duration_sec,
      views: r.views,
      publishedAt: r.published_at,
      viewsPerHour: r.views_per_hour,
      streamer: r.streamer,
      momentType: r.moment_type,
      hookPattern: r.hook_pattern,
    }));
  }

  /** "What's working today", plus our approved clips that fit it and have not been posted. */
  report(input: { clips: Clip[]; sources: Source[] }): TrendReport {
    const state = this.state();
    const videos = this.videos();
    const momentTypes = groups(videos, (v) => v.momentType, MOMENT_TYPE_LABELS);
    const byName = new Map<string, TrendStreamer>();
    for (const v of videos) {
      const name = v.streamer ?? v.channel;
      const s = byName.get(name) ?? { name, onWatchlist: v.streamer !== null, videos: 0, viewsPerHour: 0 };
      s.videos++;
      s.viewsPerHour += v.viewsPerHour;
      byName.set(name, s);
    }
    const streamers = [...byName.values()].sort((a, b) => b.viewsPerHour - a.viewsPerHour).slice(0, 8);
    const hot = momentTypes.slice(0, 3);
    const clipsToPost: TrendClipTip[] = [];
    for (const clip of input.clips) {
      if (clip.status !== "approved" || clip.postCount > 0) continue;
      const creatorName = input.sources.find((s) => s.id === clip.sourceId)?.creatorName ?? "";
      const rising = streamers.find((s) => plain(s.name) === plain(creatorName));
      const type = keywordMoment(`${clip.title} ${clip.hook} ${clip.reason}`);
      const moment = hot.find((g) => g.tag === type);
      if (!rising && !moment) continue;
      const why = rising ? `${rising.name} is rising today` : `${moment!.label} is winning today`;
      clipsToPost.push({ clipId: clip.id, title: clip.title, creatorName, why });
    }
    const missing = this.deps.source().missing;
    return {
      configured: !missing,
      note: missing,
      refreshedAt: state.refreshedAt,
      error: state.error,
      tagger: state.tagger,
      quota: this.quota(),
      boostWeight: state.weight,
      videos: videos.length,
      momentTypes,
      hookPatterns: groups(videos, (v) => v.hookPattern, HOOK_PATTERN_LABELS),
      streamers,
      clipsToPost: clipsToPost.slice(0, 10),
    };
  }

  /** What the picker gets: today's top moment types and title patterns. Null without fresh data. */
  boost(): TrendBoost | null {
    const { refreshedAt, weight } = this.state();
    if (!refreshedAt || this.now().getTime() - new Date(refreshedAt).getTime() > TREND_WINDOW_HOURS * HOUR) return null;
    const videos = this.videos();
    const types = groups(videos, (v) => v.momentType, MOMENT_TYPE_LABELS).slice(0, 3);
    const patterns = groups(videos, (v) => v.hookPattern, HOOK_PATTERN_LABELS).slice(0, 3);
    if (types.length === 0 && patterns.length === 0) return null;
    const top = types[0]?.viewsPerHour || 1;
    return {
      weight,
      momentTypes: types.map((g) => ({ type: g.tag, share: Math.round((g.viewsPerHour / top) * 100) / 100 })),
      hookPatterns: patterns.map((g) => ({ pattern: g.tag, example: g.examples[0]!.title })),
    };
  }
}
