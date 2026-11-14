import { fetchJson } from "../../sources/watchlist/platforms/types.js";
import type { ChatLog, ChatMessage, ChatSource, CommunityClip } from "./types.js";

/** The id in a Twitch VOD link (twitch.tv/videos/123), or null. */
export function twitchVideoId(url: string): string | null {
  return /^https?:\/\/(?:www\.|m\.)?twitch\.tv\/(?:videos\/|[^/]+\/v(?:ideo)?\/)(\d+)/i.exec(url)?.[1] ?? null;
}

/** The public web player's client id: chat replay is read the way the Twitch site reads it (no key). */
const WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const GQL = "https://gql.twitch.tv/gql";
const COMMENTS_QUERY = `query($id: ID!, $offset: Int, $cursor: Cursor) {
  video(id: $id) { comments(contentOffsetSeconds: $offset, after: $cursor) {
    edges { cursor node { contentOffsetSeconds commenter { login } message { fragments { text emote { emoteID } } } } }
    pageInfo { hasNextPage }
  } }
}`;
/** A busy 3-hour stream is a few thousand pages; past this the rest of the chat is left out. */
const MAX_PAGES = 4000;

interface CommentsPage {
  data?: {
    video?: {
      comments?: {
        edges?: { cursor?: string; node?: { contentOffsetSeconds?: number; commenter?: { login?: string } | null; message?: { fragments?: { text?: string; emote?: { emoteID?: string } | null }[] } } }[];
        pageInfo?: { hasNextPage?: boolean };
      } | null;
    } | null;
  };
}

/** One page of chat replay → messages; emote fragments give the emote names. */
export function parseCommentsPage(page: CommentsPage): { messages: ChatMessage[]; cursor: string | null; more: boolean } {
  const comments = page.data?.video?.comments;
  const edges = comments?.edges ?? [];
  const messages: ChatMessage[] = [];
  for (const e of edges) {
    const n = e.node;
    if (typeof n?.contentOffsetSeconds !== "number") continue;
    const fragments = n.message?.fragments ?? [];
    messages.push({
      sec: n.contentOffsetSeconds,
      user: n.commenter?.login ?? "",
      text: fragments.map((f) => f.text ?? "").join("").trim(),
      emotes: fragments.filter((f) => f.emote).map((f) => (f.text ?? "").trim()).filter(Boolean),
    });
  }
  return { messages, cursor: edges.at(-1)?.cursor ?? null, more: comments?.pageInfo?.hasNextPage === true && edges.length > 0 };
}

interface HelixVideo {
  user_id: string;
  created_at: string;
  duration: string;
}
interface HelixClip {
  video_id: string;
  vod_offset: number | null;
  duration: number;
}

/** Calls Twitch Helix with the app's keys (the watchlist's client); null when no keys are set. */
export type Helix = <T>(path: string, signal?: AbortSignal) => Promise<T>;

/** Community clips of a Twitch VOD, from Helix: clips made while it streamed that point into this video. */
export async function twitchVodClips(helix: Helix, videoId: string, durationSec: number, signal?: AbortSignal): Promise<CommunityClip[]> {
  const video = (await helix<{ data: HelixVideo[] }>(`/videos?id=${videoId}`, signal)).data[0];
  if (!video) return [];
  const startedAt = new Date(video.created_at);
  const endedAt = new Date(startedAt.getTime() + (durationSec + 600) * 1000);
  const q = new URLSearchParams({ broadcaster_id: video.user_id, started_at: startedAt.toISOString(), ended_at: endedAt.toISOString(), first: "100" });
  const clips = (await helix<{ data: HelixClip[] }>(`/clips?${q}`, signal)).data;
  return clips
    .filter((c) => c.video_id === videoId && typeof c.vod_offset === "number")
    .map((c) => ({ startSec: c.vod_offset!, endSec: c.vod_offset! + c.duration }));
}

/** Twitch VOD chat replay (from the site's own chat API) plus community clips (Helix, when the Twitch key is set). */
export class TwitchChatSource implements ChatSource {
  readonly name = "twitch";
  private doFetch: typeof fetch;

  constructor(private opts: { fetch?: typeof fetch; helix?: () => Helix | null; maxPages?: number } = {}) {
    this.doFetch = opts.fetch ?? fetch;
  }

  async fetch(url: string, opts: { durationSec: number; signal?: AbortSignal }): Promise<ChatLog | null> {
    const id = twitchVideoId(url);
    if (!id) return null;
    const messages: ChatMessage[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < (this.opts.maxPages ?? MAX_PAGES); page++) {
      const body: CommentsPage = await fetchJson<CommentsPage>(this.doFetch, "Twitch chat", GQL, {
        method: "POST",
        headers: { "Client-Id": WEB_CLIENT_ID, "Content-Type": "application/json" },
        body: JSON.stringify({ query: COMMENTS_QUERY, variables: cursor ? { id, cursor } : { id, offset: 0 } }),
        signal: opts.signal,
      });
      const got = parseCommentsPage(body);
      messages.push(...got.messages);
      if (!got.more || !got.cursor || (got.messages.at(-1)?.sec ?? 0) > opts.durationSec) break;
      cursor = got.cursor;
    }
    let clips: CommunityClip[] = [];
    const helix = this.opts.helix?.();
    if (helix) {
      try {
        clips = await twitchVodClips(helix, id, opts.durationSec, opts.signal);
      } catch (err) {
        opts.signal?.throwIfAborted();
        console.warn(`[chat] Twitch clips for video ${id} could not be read: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { messages, clips };
  }
}

/** One line from Twitch's chat (IRC over a websocket): a message, a PING to answer, or nothing of use. */
export function parseIrcLine(line: string): ChatMessage | "ping" | null {
  if (line.startsWith("PING")) return "ping";
  const m = /^(?:@(\S+) )?:([^!\s]+)![^ ]* PRIVMSG #\S+ :(.*)$/.exec(line);
  if (!m) return null;
  const text = m[3]!;
  const emotes: string[] = [];
  // emotes=25:0-4,12-16/1902:6-10 → the names, cut from the text.
  const tag = /(?:^|;)emotes=([^;]*)/.exec(m[1] ?? "")?.[1] ?? "";
  for (const part of tag.split("/").filter(Boolean)) {
    const range = /:(\d+)-(\d+)/.exec(part);
    if (range) emotes.push([...text].slice(Number(range[1]), Number(range[2]) + 1).join(""));
  }
  return { sec: 0, user: m[2]!, text, emotes };
}
