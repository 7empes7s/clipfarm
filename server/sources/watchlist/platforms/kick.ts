import { fetchJson, type ChannelCheck, type PlatformClient } from "./types.js";

interface KickCategory {
  name: string;
}

interface KickVideo {
  id: number;
  created_at: string;
  session_title: string | null;
  /** Milliseconds. */
  duration: number | null;
  is_live: boolean;
  categories?: KickCategory[];
  video?: { uuid: string } | null;
}

interface KickChannel {
  slug: string;
  livestream: {
    is_live: boolean;
    session_title: string | null;
    created_at: string | null;
    categories?: KickCategory[];
  } | null;
}

/** Kick's dates come as "2026-11-10 18:02:11" (UTC) or ISO. */
function kickDate(s: string): string {
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}Z`;
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? s : t.toISOString();
}

/**
 * Kick's public channel endpoints (no key): /api/v2/channels/{slug} for the live stream and
 * /api/v2/channels/{slug}/videos for past broadcasts. The official api.kick.com has no VOD list yet.
 */
export class KickClient implements PlatformClient {
  readonly platform = "kick" as const;
  readonly missing = null;
  private doFetch: typeof fetch;

  constructor(opts: { fetch?: typeof fetch } = {}) {
    this.doFetch = opts.fetch ?? fetch;
  }

  async check(handle: string, signal?: AbortSignal): Promise<ChannelCheck> {
    const slug = handle.toLowerCase();
    const headers = { Accept: "application/json" };
    const channel = await fetchJson<KickChannel>(this.doFetch, "Kick", `https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, { headers, signal });
    const videos = await fetchJson<KickVideo[]>(this.doFetch, "Kick", `https://kick.com/api/v2/channels/${encodeURIComponent(slug)}/videos`, { headers, signal });
    const ls = channel.livestream?.is_live ? channel.livestream : null;
    return {
      vods: videos
        .filter((v) => !v.is_live && v.video?.uuid)
        .map((v) => ({
          platform: "kick" as const,
          externalId: v.video!.uuid,
          url: `https://kick.com/${slug}/videos/${v.video!.uuid}`,
          title: v.session_title ?? "",
          category: v.categories?.[0]?.name ?? null,
          publishedAt: kickDate(v.created_at),
          durationSec: v.duration ? Math.round(v.duration / 1000) : null,
        }))
        .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)),
      live: ls
        ? {
            platform: "kick",
            title: ls.session_title ?? "",
            game: ls.categories?.[0]?.name ?? null,
            startedAt: ls.created_at ? kickDate(ls.created_at) : null,
            url: `https://kick.com/${slug}`,
          }
        : null,
    };
  }
}
