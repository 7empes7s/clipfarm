import { fetchJson } from "../sources/watchlist/platforms/types.js";
import { parseIsoDuration } from "../sources/watchlist/platforms/youtube.js";

/** A public video as the radar reads it: its title, channel and numbers. Never its media. */
export interface RawTrendVideo {
  videoId: string;
  title: string;
  channel: string;
  publishedAt: string;
  durationSec: number | null;
  views: number;
}

export interface TrendFetch {
  queries: string[];
  publishedAfter: Date;
  /** Called with the quota units of each call before it is made, so a failed refresh is counted too. */
  spend: (units: number) => void;
  signal?: AbortSignal;
}

/** Where the radar reads today's short videos from. The real one is YouTube; tests and demos use a fake. */
export interface TrendSource {
  /** What to add in Settings when the key is missing; null when it can be called. */
  readonly missing: string | null;
  /** The most quota units one fetch of `queries` searches can cost. */
  maxUnits(queries: number): number;
  fetch(opts: TrendFetch): Promise<RawTrendVideo[]>;
}

const API = "https://www.googleapis.com/youtube/v3";
/** YouTube Data API quota costs: a search is 100 units, a videos lookup 1. */
const SEARCH_UNITS = 100;
const VIDEOS_UNITS = 1;
const PAGE = 50;

interface YtStats {
  id: string;
  snippet?: { title?: string; channelTitle?: string; publishedAt?: string };
  contentDetails?: { duration?: string };
  statistics?: { viewCount?: string };
}

/**
 * YouTube Data API with the key from Settings or env: one search.list per query (short videos, most
 * viewed first, published after a date), then videos.list for their view counts.
 */
export class YouTubeTrendSource implements TrendSource {
  readonly missing: string | null;
  private doFetch: typeof fetch;

  constructor(private opts: { apiKey?: string; fetch?: typeof fetch }) {
    this.missing = opts.apiKey ? null : "Add your YouTube key in Settings.";
    this.doFetch = opts.fetch ?? fetch;
  }

  maxUnits(queries: number): number {
    // Each search returns at most one page of ids, and each page of ids is one videos lookup.
    return queries * (SEARCH_UNITS + VIDEOS_UNITS);
  }

  private get<T>(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
    const q = new URLSearchParams({ ...params, key: this.opts.apiKey ?? "" });
    return fetchJson<T>(this.doFetch, "YouTube", `${API}/${path}?${q}`, { signal });
  }

  async fetch({ queries, publishedAfter, spend, signal }: TrendFetch): Promise<RawTrendVideo[]> {
    const ids = new Set<string>();
    for (const q of queries) {
      spend(SEARCH_UNITS);
      const found = await this.get<{ items?: { id?: { videoId?: string } }[] }>(
        "search",
        {
          part: "snippet",
          q,
          type: "video",
          videoDuration: "short",
          order: "viewCount",
          publishedAfter: publishedAfter.toISOString(),
          maxResults: String(PAGE),
        },
        signal,
      );
      for (const item of found.items ?? []) if (item.id?.videoId) ids.add(item.id.videoId);
    }
    const all = [...ids];
    const videos: RawTrendVideo[] = [];
    for (let i = 0; i < all.length; i += PAGE) {
      spend(VIDEOS_UNITS);
      const page = await this.get<{ items?: YtStats[] }>(
        "videos",
        { part: "snippet,contentDetails,statistics", id: all.slice(i, i + PAGE).join(","), maxResults: String(PAGE) },
        signal,
      );
      for (const v of page.items ?? []) {
        if (!v.snippet?.title || !v.snippet.publishedAt) continue;
        videos.push({
          videoId: v.id,
          title: v.snippet.title,
          channel: v.snippet.channelTitle ?? "",
          publishedAt: v.snippet.publishedAt,
          durationSec: v.contentDetails?.duration ? parseIsoDuration(v.contentDetails.duration) : null,
          views: Number(v.statistics?.viewCount) || 0,
        });
      }
    }
    return videos;
  }
}

/** Demos and e2e (CLIPFARM_FAKES=1): made-up titles and numbers, no network. */
export class FakeTrendSource implements TrendSource {
  readonly missing = null;

  constructor(private now: () => Date = () => new Date()) {}

  maxUnits(queries: number): number {
    return queries * (SEARCH_UNITS + VIDEOS_UNITS);
  }

  fetch({ queries, spend }: TrendFetch): Promise<RawTrendVideo[]> {
    spend(queries.length * SEARCH_UNITS + VIDEOS_UNITS);
    const sample: [string, string, number, number][] = [
      ["Demo Streamer LOSES IT after a 5 star police chase", "Demo Clips", 310_000, 6],
      ["Is this the craziest stunt jump in GTA VI?", "Vice Shorts", 95_000, 4],
      ["First time flying a plane in GTA 6 goes wrong", "Demo Streamer", 240_000, 20],
      ["POV: the cops find you in 10 seconds", "Vice Shorts", 60_000, 5],
      ["This GTA 6 glitch broke the whole city", "Leonida Daily", 130_000, 30],
      ["Wait for it… the funniest crash of launch day", "Leonida Daily", 44_000, 9],
    ];
    const t = this.now().getTime();
    return Promise.resolve(
      sample.map(([title, channel, views, hoursOld], i) => ({
        videoId: `demo-trend-${i + 1}`,
        title,
        channel,
        publishedAt: new Date(t - hoursOld * 3_600_000).toISOString(),
        durationSec: 20 + i * 5,
        views,
      })),
    );
  }
}
