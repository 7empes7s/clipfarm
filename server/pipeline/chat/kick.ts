import { fetchJson } from "../../sources/watchlist/platforms/types.js";
import type { ChatLog, ChatMessage, ChatSource, CommunityClip } from "./types.js";

/** The video uuid in a Kick VOD link (kick.com/{slug}/videos/{uuid} or kick.com/video/{uuid}), or null. */
export function kickVideoId(url: string): string | null {
  return /^https?:\/\/(?:www\.)?kick\.com\/(?:[^/]+\/videos|video)\/([0-9a-f-]{36})/i.exec(url)?.[1] ?? null;
}

/** Kick's dates come as "2026-11-10 18:02:11" (UTC) or ISO. */
export function kickTime(s: string): number {
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}Z`).getTime();
}

/** "[emote:37226:KEKW] lol" → the text with emote names, and the emotes. */
export function kickContent(content: string): { text: string; emotes: string[] } {
  const emotes: string[] = [];
  const text = content.replace(/\[emote:\d+:([^\]]+)\]/g, (_, name: string) => {
    emotes.push(name);
    return name;
  });
  return { text: text.trim(), emotes };
}

interface KickVideo {
  livestream?: { id?: number; channel_id?: number; start_time?: string; duration?: number; channel?: { slug?: string } | null } | null;
}
interface KickMessage {
  id?: string;
  created_at?: string;
  content?: string;
  sender?: { username?: string } | null;
}
interface KickClip {
  livestream_id?: string | number | null;
  created_at?: string;
  /** Seconds. */
  duration?: number;
}

const HEADERS = { Accept: "application/json" };
/** Each call gives a few seconds of chat; a 3-hour stream is a few thousand calls. Past this the rest is left out. */
const MAX_CALLS = 4000;
const STEP_MS = 5000;

/**
 * Kick VOD chat from its public chat history (/api/v2/channels/{id}/messages?start_time=…, walked
 * forward through the stream) and community clips from the channel's clip list. No key.
 */
export class KickChatSource implements ChatSource {
  readonly name = "kick";
  private doFetch: typeof fetch;

  constructor(private opts: { fetch?: typeof fetch; maxCalls?: number } = {}) {
    this.doFetch = opts.fetch ?? fetch;
  }

  async fetch(url: string, opts: { durationSec: number; signal?: AbortSignal }): Promise<ChatLog | null> {
    const uuid = kickVideoId(url);
    if (!uuid) return null;
    const { signal } = opts;
    const video = await fetchJson<KickVideo>(this.doFetch, "Kick", `https://kick.com/api/v1/video/${uuid}`, { headers: HEADERS, signal });
    const ls = video.livestream;
    if (!ls?.channel_id || !ls.start_time) return null;
    const start = kickTime(ls.start_time);
    const end = start + (ls.duration ? ls.duration : opts.durationSec * 1000);

    const messages: ChatMessage[] = [];
    const seen = new Set<string>();
    let t = start;
    for (let call = 0; call < (this.opts.maxCalls ?? MAX_CALLS) && t < end; call++) {
      const q = new URLSearchParams({ start_time: new Date(t).toISOString() });
      const page = await fetchJson<{ data?: { messages?: KickMessage[] } }>(
        this.doFetch,
        "Kick chat",
        `https://kick.com/api/v2/channels/${ls.channel_id}/messages?${q}`,
        { headers: HEADERS, signal },
      );
      let last = t;
      for (const m of page.data?.messages ?? []) {
        const at = m.created_at ? kickTime(m.created_at) : NaN;
        if (!Number.isFinite(at) || at < start || at > end) continue;
        const key = m.id ?? `${at}:${m.sender?.username}:${m.content}`;
        if (seen.has(key)) continue;
        seen.add(key);
        last = Math.max(last, at);
        messages.push({ sec: (at - start) / 1000, user: m.sender?.username ?? "", ...kickContent(m.content ?? "") });
      }
      t = last > t ? last + 1 : t + STEP_MS;
    }

    let clips: CommunityClip[] = [];
    const slug = ls.channel?.slug ?? /kick\.com\/([^/]+)\/videos\//i.exec(url)?.[1];
    if (slug && slug !== "video") {
      try {
        const res = await fetchJson<{ clips?: KickClip[] }>(this.doFetch, "Kick", `https://kick.com/api/v2/channels/${encodeURIComponent(slug)}/clips?sort=date&time=all`, { headers: HEADERS, signal });
        clips = kickVodClips(res.clips ?? [], ls.id ?? null, start);
      } catch (err) {
        signal?.throwIfAborted();
        console.warn(`[chat] Kick clips for ${slug} could not be read: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { messages: messages.sort((a, b) => a.sec - b.sec), clips };
  }
}

/** Clips of this broadcast, as seconds into the VOD: a clip is made at its end, so it covers the `duration` before. */
export function kickVodClips(clips: KickClip[], livestreamId: number | null, startMs: number): CommunityClip[] {
  return clips
    .filter((c) => livestreamId !== null && String(c.livestream_id) === String(livestreamId) && c.created_at && c.duration)
    .map((c) => {
      const endSec = (kickTime(c.created_at!) - startMs) / 1000;
      return { startSec: Math.max(0, endSec - c.duration!), endSec };
    })
    .filter((c) => c.endSec > 0);
}

/** One event from Kick's live chat (a Pusher websocket): a message, a ping to answer, or nothing of use. */
export function parseKickEvent(raw: string): ChatMessage | "ping" | null {
  let ev: { event?: string; data?: unknown };
  try {
    ev = JSON.parse(raw) as typeof ev;
  } catch {
    return null;
  }
  if (ev.event === "pusher:ping") return "ping";
  if (ev.event !== "App\\Events\\ChatMessageEvent" || typeof ev.data !== "string") return null;
  try {
    const m = JSON.parse(ev.data) as KickMessage;
    return { sec: 0, user: m.sender?.username ?? "", ...kickContent(m.content ?? "") };
  } catch {
    return null;
  }
}
