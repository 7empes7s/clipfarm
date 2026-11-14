import type { PostMetrics } from "../../shared/growth.js";
import type { Platform } from "../../shared/types.js";

/**
 * A platform's own API, asked about our posts directly (on top of what the posting service passes
 * on). Whatever it does not give stays out of the answer and is shown as "not available".
 */
export interface PlatformStatsSource {
  readonly platform: Platform;
  /** False until its key is set; then it is skipped without a call. */
  ready(): boolean;
  stats(posts: { id: number; url: string }[]): Promise<Map<number, Partial<PostMetrics>>>;
}

/** The video id in a YouTube link (shorts, watch or youtu.be). */
export function youtubeVideoId(url: string): string | null {
  const m = /(?:youtube\.com\/(?:shorts\/|watch\?(?:.*&)?v=|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{6,20})/.exec(url);
  return m ? m[1]! : null;
}

/**
 * YouTube Data API with the key from Settings: views, likes and comments of any public video,
 * 50 videos per call (1 quota unit). Watch time, subscribers gained and revenue need the channel
 * owner's sign-in (YouTube Analytics), which the posting service holds, not clipfarm.
 */
export class YouTubeStats implements PlatformStatsSource {
  readonly platform = "youtube" as const;

  constructor(private opts: { apiKey: () => string | undefined; fetch?: typeof fetch }) {}

  ready(): boolean {
    return !!this.opts.apiKey();
  }

  async stats(posts: { id: number; url: string }[]): Promise<Map<number, Partial<PostMetrics>>> {
    const out = new Map<number, Partial<PostMetrics>>();
    const byVideo = new Map<string, number>();
    for (const p of posts) {
      const id = youtubeVideoId(p.url);
      if (id) byVideo.set(id, p.id);
    }
    const ids = [...byVideo.keys()];
    for (let i = 0; i < ids.length; i += 50) {
      const q = new URLSearchParams({ part: "statistics", id: ids.slice(i, i + 50).join(","), key: this.opts.apiKey() ?? "" });
      const res = await (this.opts.fetch ?? fetch)(`https://www.googleapis.com/youtube/v3/videos?${q}`, { signal: AbortSignal.timeout(30_000) });
      // The address holds the key, so an error names only the status.
      if (!res.ok) throw new Error(`YouTube answered ${res.status} when asked for video stats.`);
      const body = (await res.json()) as { items?: { id: string; statistics?: Record<string, string | undefined> }[] };
      for (const item of body.items ?? []) {
        const postId = byVideo.get(item.id);
        if (postId === undefined) continue;
        const metrics: Partial<PostMetrics> = {};
        const num = (v: string | undefined) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined);
        const [views, likes, comments] = [num(item.statistics?.viewCount), num(item.statistics?.likeCount), num(item.statistics?.commentCount)];
        if (views !== undefined) metrics.views = views;
        if (likes !== undefined) metrics.likes = likes;
        if (comments !== undefined) metrics.comments = comments;
        out.set(postId, metrics);
      }
    }
    return out;
  }
}

/**
 * What each platform's official stats API can give about one of our posts, and how many stats calls
 * clipfarm allows itself a day (well under each API's own limit, so posting never runs short).
 * Anything not listed is "not available" for that platform, never a made-up number.
 */
export const STATS_CAPABILITIES: Record<Platform, { metrics: (keyof PostMetrics)[]; batch: number; callsPerDay: number; api: string }> = {
  youtube: { metrics: ["views", "likes", "comments"], batch: 50, callsPerDay: 500, api: "YouTube Data API (watch time and followers need YouTube Analytics)" },
  tiktok: { metrics: ["views", "likes", "comments", "shares"], batch: 20, callsPerDay: 200, api: "TikTok Display API" },
  instagram: { metrics: ["views", "likes", "comments", "shares", "saves", "reach"], batch: 1, callsPerDay: 150, api: "Instagram Insights" },
  x: { metrics: ["views", "likes", "comments", "shares"], batch: 100, callsPerDay: 100, api: "X API public metrics" },
};

/** Calls one ask about `posts` posts costs. */
export function statsCalls(platform: Platform, posts: number): number {
  return Math.ceil(posts / STATS_CAPABILITIES[platform].batch);
}

/**
 * A platform's stats API in tests and demo mode: steady made-up numbers for exactly the metrics that
 * platform's real API gives, and nothing else.
 */
export class FakePlatformStats implements PlatformStatsSource {
  calls = 0;
  fail: string | null = null;

  constructor(
    readonly platform: Platform,
    private opts: { ready?: boolean; viewsOf?: (postId: number) => number } = {},
  ) {}

  ready(): boolean {
    return this.opts.ready ?? true;
  }

  async stats(posts: { id: number; url: string }[]): Promise<Map<number, Partial<PostMetrics>>> {
    this.calls += statsCalls(this.platform, posts.length);
    if (this.fail) throw new Error(this.fail);
    const out = new Map<number, Partial<PostMetrics>>();
    for (const p of posts) {
      const views = this.opts.viewsOf?.(p.id) ?? 1000 * p.id;
      const all: PostMetrics = {
        views,
        likes: Math.round(views * 0.05),
        comments: Math.round(views * 0.005),
        shares: Math.round(views * 0.01),
        saves: Math.round(views * 0.008),
        reach: Math.round(views * 0.9),
        avgWatchPct: 55,
        followsGained: Math.round(views * 0.002),
        revenueUsd: null,
      };
      const metrics: Partial<PostMetrics> = {};
      for (const key of STATS_CAPABILITIES[this.platform].metrics) (metrics as Record<string, number | null>)[key] = all[key];
      out.set(p.id, metrics);
    }
    return out;
  }
}
