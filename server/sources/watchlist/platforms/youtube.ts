import { fetchJson, PlatformError, type ChannelCheck, type PlatformClient, type RemoteVod } from "./types.js";

/** "PT1H2M3S" → seconds. */
export function parseIsoDuration(s: string): number | null {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(s);
  if (!m || s === "P" || s === "PT") return null;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

interface YtVideo {
  id: string;
  snippet: { title: string; publishedAt: string; liveBroadcastContent: "live" | "upcoming" | "none" };
  contentDetails?: { duration?: string };
  liveStreamingDetails?: { actualStartTime?: string; actualEndTime?: string };
}

const API = "https://www.googleapis.com/youtube/v3";

/**
 * YouTube Data API with a key from env. Uses the uploads playlist (1 quota unit) and a videos
 * lookup (1 unit) instead of search (100 units): live replays and live streams are uploads too.
 */
export class YouTubeClient implements PlatformClient {
  readonly platform = "youtube" as const;
  readonly missing: string | null;
  private doFetch: typeof fetch;
  private uploads = new Map<string, string>();

  constructor(private opts: { apiKey?: string; fetch?: typeof fetch }) {
    this.missing = opts.apiKey ? null : "Set YOUTUBE_API_KEY on the server.";
    this.doFetch = opts.fetch ?? fetch;
  }

  private get<T>(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
    const q = new URLSearchParams({ ...params, key: this.opts.apiKey ?? "" });
    return fetchJson<T>(this.doFetch, "YouTube", `${API}/${path}?${q}`, { signal });
  }

  async check(handle: string, signal?: AbortSignal): Promise<ChannelCheck> {
    let playlist = this.uploads.get(handle);
    if (!playlist) {
      const ch = await this.get<{ items?: { contentDetails: { relatedPlaylists: { uploads: string } } }[] }>(
        "channels",
        { part: "contentDetails", forHandle: `@${handle}` },
        signal,
      );
      playlist = ch.items?.[0]?.contentDetails.relatedPlaylists.uploads;
      if (!playlist) throw new PlatformError(`There is no YouTube channel called "@${handle}".`, { channelMissing: true });
      this.uploads.set(handle, playlist);
    }
    const items = await this.get<{ items?: { contentDetails: { videoId: string } }[] }>(
      "playlistItems",
      { part: "contentDetails", playlistId: playlist, maxResults: "10" },
      signal,
    );
    const ids = (items.items ?? []).map((i) => i.contentDetails.videoId);
    if (ids.length === 0) return { vods: [], live: null };
    const videos = await this.get<{ items?: YtVideo[] }>(
      "videos",
      { part: "snippet,contentDetails,liveStreamingDetails", id: ids.join(",") },
      signal,
    );
    const all = videos.items ?? [];
    const liveVideo = all.find((v) => v.snippet.liveBroadcastContent === "live");
    const vods: RemoteVod[] = all
      .filter((v) => v.snippet.liveBroadcastContent === "none")
      .map((v) => ({
        platform: "youtube" as const,
        externalId: v.id,
        url: `https://www.youtube.com/watch?v=${v.id}`,
        title: v.snippet.title,
        category: null,
        publishedAt: v.liveStreamingDetails?.actualStartTime ?? v.snippet.publishedAt,
        durationSec: v.contentDetails?.duration ? parseIsoDuration(v.contentDetails.duration) : null,
      }))
      // Shorts are not streams to clip from.
      .filter((v) => v.durationSec === null || v.durationSec >= 180)
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    return {
      vods,
      live: liveVideo
        ? {
            platform: "youtube",
            title: liveVideo.snippet.title,
            game: null,
            startedAt: liveVideo.liveStreamingDetails?.actualStartTime ?? null,
            url: `https://www.youtube.com/watch?v=${liveVideo.id}`,
          }
        : null,
    };
  }
}
