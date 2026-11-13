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
