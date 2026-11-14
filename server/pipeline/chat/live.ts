import type { WatchPlatform } from "../../../shared/types.js";
import { fetchJson } from "../../sources/watchlist/platforms/types.js";
import { parseKickEvent } from "./kick.js";
import { parseIrcLine } from "./twitch.js";
import type { ChatLog, ChatMessage, ChatSource, LiveChatTap } from "./types.js";

/** The bits of a websocket the taps use (Node 22's global WebSocket; a fake in tests). */
export interface WsLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
}
export type WsFactory = (url: string) => WsLike;

const nodeWs: WsFactory = (url) => new WebSocket(url) as unknown as WsLike;

/**
 * Listens on a chat websocket until `signal` aborts, timing each message from when listening began.
 * Never throws: a dropped connection keeps what was heard, one that never opened gives null.
 */
function listenWs(
  ws: WsLike,
  handlers: { open(send: (s: string) => void): void; parse(raw: string): (ChatMessage | "ping" | null)[]; pong(send: (s: string) => void): void },
  signal: AbortSignal,
  now: () => number,
): Promise<ChatLog | null> {
  const started = now();
  const messages: ChatMessage[] = [];
  let opened = false;
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        ws.close();
      } catch {
        // Already closed.
      }
      resolve(opened ? { messages, clips: [] } : null);
    };
    const send = (s: string) => ws.send(s);
    ws.onopen = () => {
      opened = true;
      handlers.open(send);
    };
    ws.onmessage = (ev) => {
      for (const got of handlers.parse(String(ev.data))) {
        if (got === "ping") handlers.pong(send);
        else if (got) messages.push({ ...got, sec: (now() - started) / 1000 });
      }
    };
    ws.onerror = finish;
    ws.onclose = finish;
    if (signal.aborted) finish();
    else signal.addEventListener("abort", finish, { once: true });
  });
}

/** Twitch live chat, read anonymously over its IRC websocket (no key). */
export class TwitchChatTap implements LiveChatTap {
  readonly name = "twitch";
  constructor(private opts: { ws?: WsFactory; now?: () => number } = {}) {}

  async listen(target: { platform: WatchPlatform; handle: string }, signal: AbortSignal): Promise<ChatLog | null> {
    if (target.platform !== "twitch" || !target.handle) return null;
    const login = target.handle.toLowerCase();
    return listenWs(
      (this.opts.ws ?? nodeWs)("wss://irc-ws.chat.twitch.tv:443"),
      {
        open: (send) => {
          send("CAP REQ :twitch.tv/tags");
          send("PASS SCHMOOPIIE");
          send(`NICK justinfan${10000 + Math.floor(Math.random() * 80000)}`);
          send(`JOIN #${login}`);
        },
        parse: (raw) => raw.split("\r\n").filter(Boolean).map(parseIrcLine),
        pong: (send) => send("PONG :tmi.twitch.tv"),
      },
      signal,
      this.opts.now ?? Date.now,
    );
  }
}

const KICK_PUSHER = "wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false";

/** Kick live chat over its public Pusher websocket; the chatroom id comes from the channel's page data. */
export class KickChatTap implements LiveChatTap {
  readonly name = "kick";
  private doFetch: typeof fetch;
  constructor(private opts: { ws?: WsFactory; fetch?: typeof fetch; now?: () => number } = {}) {
    this.doFetch = opts.fetch ?? fetch;
  }

  async listen(target: { platform: WatchPlatform; handle: string }, signal: AbortSignal): Promise<ChatLog | null> {
    if (target.platform !== "kick" || !target.handle) return null;
    const channel = await fetchJson<{ chatroom?: { id?: number } }>(
      this.doFetch,
      "Kick",
      `https://kick.com/api/v2/channels/${encodeURIComponent(target.handle.toLowerCase())}`,
      { headers: { Accept: "application/json" }, signal },
    );
    const room = channel.chatroom?.id;
    if (!room) return null;
    return listenWs(
      (this.opts.ws ?? nodeWs)(KICK_PUSHER),
      {
        open: (send) => send(JSON.stringify({ event: "pusher:subscribe", data: { auth: "", channel: `chatrooms.${room}.v2` } })),
        parse: (raw) => [parseKickEvent(raw)],
        pong: (send) => send(JSON.stringify({ event: "pusher:pong", data: {} })),
      },
      signal,
      this.opts.now ?? Date.now,
    );
  }
}

/** Tries each source in turn; the first that knows the link answers. */
export function chatSources(sources: ChatSource[]): ChatSource {
  return {
    name: sources.map((s) => s.name).join("+"),
    async fetch(url, opts) {
      for (const s of sources) {
        const log = await s.fetch(url, opts);
        if (log) return log;
      }
      return null;
    },
  };
}

/** The tap for the stream's platform. A failure gives no chat, never a failed recording. */
export function chatTaps(taps: LiveChatTap[]): LiveChatTap {
  return {
    name: taps.map((t) => t.name).join("+"),
    async listen(target, signal) {
      const tap = taps.find((t) => t.name === target.platform);
      if (!tap) return null;
      try {
        return await tap.listen(target, signal);
      } catch (err) {
        console.warn(`[chat] ${target.platform} live chat for ${target.handle} could not be read: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    },
  };
}
