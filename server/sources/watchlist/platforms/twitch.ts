import { fetchJson, PlatformError, type ChannelCheck, type PlatformClient, type RemoteVod } from "./types.js";

/** "3h8m33s" → seconds. */
export function parseTwitchDuration(s: string): number | null {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s);
  if (!m || !s) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

interface HelixVideo {
  id: string;
  stream_id: string | null;
  title: string;
  created_at: string;
  url: string;
  duration: string;
}

interface HelixStream {
  id: string;
  user_login: string;
  game_name: string;
  title: string;
  started_at: string;
  type: string;
}

export interface TwitchOptions {
  clientId?: string;
  clientSecret?: string;
  fetch?: typeof fetch;
}

const HELIX = "https://api.twitch.tv/helix";

/**
 * Twitch Helix with an app access token (client credentials, from env). Past broadcasts come from
 * GET /videos?type=archive, live streams from GET /streams. Videos carry no category, so the game
 * seen on the live stream is remembered by stream id and given to its VOD.
 */
export class TwitchClient implements PlatformClient {
  readonly platform = "twitch" as const;
  readonly missing: string | null;
  private doFetch: typeof fetch;
  private token: { value: string; expiresAt: number } | null = null;
  private userIds = new Map<string, string>();
  private streamGames = new Map<string, string>();

  constructor(private opts: TwitchOptions) {
    this.missing = opts.clientId && opts.clientSecret ? null : "Add your Twitch key in Settings.";
    this.doFetch = opts.fetch ?? fetch;
  }

  private async accessToken(signal?: AbortSignal): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const q = new URLSearchParams({
      client_id: this.opts.clientId ?? "",
      client_secret: this.opts.clientSecret ?? "",
      grant_type: "client_credentials",
    });
    const res = await fetchJson<{ access_token: string; expires_in: number }>(
      this.doFetch,
      "Twitch",
      `https://id.twitch.tv/oauth2/token?${q}`,
      { method: "POST", signal },
    );
    this.token = { value: res.access_token, expiresAt: Date.now() + res.expires_in * 1000 };
    return res.access_token;
  }

  /** A Helix call with the app token (also used for a VOD's community clips). */
  async helix<T>(path: string, signal?: AbortSignal): Promise<T> {
    const token = await this.accessToken(signal);
    try {
      return await fetchJson<T>(this.doFetch, "Twitch", `${HELIX}${path}`, {
        headers: { "Client-Id": this.opts.clientId ?? "", Authorization: `Bearer ${token}` },
        signal,
      });
    } catch (err) {
      // An expired or revoked token: get a fresh one on the next try.
      if (err instanceof PlatformError && /refused/.test(err.message)) this.token = null;
      throw err;
    }
  }

  async check(handle: string, signal?: AbortSignal): Promise<ChannelCheck> {
    const login = handle.toLowerCase();
    const streams = await this.helix<{ data: HelixStream[] }>(`/streams?user_login=${encodeURIComponent(login)}`, signal);
    const stream = streams.data.find((s) => s.type === "live") ?? null;
    if (stream?.game_name) {
      this.streamGames.set(stream.id, stream.game_name);
      if (this.streamGames.size > 500) this.streamGames.delete(this.streamGames.keys().next().value!);
    }

    let userId = this.userIds.get(login);
    if (!userId) {
      const users = await this.helix<{ data: { id: string; login: string }[] }>(`/users?login=${encodeURIComponent(login)}`, signal);
      userId = users.data[0]?.id;
      if (!userId) throw new PlatformError(`There is no Twitch channel called "${handle}".`, { channelMissing: true });
      this.userIds.set(login, userId);
    }
    const videos = await this.helix<{ data: HelixVideo[] }>(`/videos?user_id=${userId}&type=archive&first=5`, signal);
    const vods: RemoteVod[] = videos.data
      // The archive of the stream that is still live is not finished yet.
      .filter((v) => !stream || v.stream_id !== stream.id)
      .map((v) => ({
        platform: "twitch",
        externalId: v.id,
        url: v.url,
        title: v.title,
        category: (v.stream_id && this.streamGames.get(v.stream_id)) || null,
        publishedAt: v.created_at,
        durationSec: parseTwitchDuration(v.duration),
      }));
    return {
      vods,
      live: stream
        ? { platform: "twitch", title: stream.title, game: stream.game_name || null, startedAt: stream.started_at, url: `https://www.twitch.tv/${login}` }
        : null,
    };
  }
}
