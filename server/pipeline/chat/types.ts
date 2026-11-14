import type { WatchPlatform } from "../../../shared/types.js";

/** One chat message, `sec` seconds into the VOD (or into the live segment being recorded). */
export interface ChatMessage {
  sec: number;
  user: string;
  text: string;
  /** Emote names the platform marked in the message (custom channel emotes included). */
  emotes?: string[];
}

/** A clip viewers made on Twitch/Kick, as seconds into the VOD. */
export interface CommunityClip {
  startSec: number;
  endSec: number;
}

export interface ChatLog {
  messages: ChatMessage[];
  clips: CommunityClip[];
}

/**
 * The chat of a VOD, stored compactly: one entry per `bucketSec` (10 s) for each count.
 * `offsetSec` is when bucket 0 starts (0 for a whole VOD, other values for a slice of a live stream).
 */
export interface ChatBuckets {
  bucketSec: number;
  offsetSec: number;
  messages: number[];
  chatters: number[];
  /** Messages with a laughing or hype emote (LUL, KEKW, OMEGALUL, W, L, custom emotes). */
  emotes: number[];
  /** The emote used most in the bucket, null when none was. */
  topEmote: (string | null)[];
  /** Messages saying "clip it", "no way", "W" and the like. */
  keywords: number[];
  clips: CommunityClip[];
}

/** Reads the chat replay (and community clips) of a VOD. Real ones call Twitch/Kick; tests use the fake. */
export interface ChatSource {
  readonly name: string;
  /** Null when this link has no chat to read (an upload, YouTube, a direct file). */
  fetch(url: string, opts: { durationSec: number; signal?: AbortSignal }): Promise<ChatLog | null>;
}

/** Listens to a live stream's chat while one segment records. Resolves with what it heard when `signal` aborts. */
export interface LiveChatTap {
  readonly name: string;
  listen(target: { platform: WatchPlatform; handle: string }, signal: AbortSignal): Promise<ChatLog | null>;
}
