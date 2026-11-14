import type { WatchPlatform } from "../../../shared/types.js";
import type { ChatLog, ChatSource, CommunityClip, LiveChatTap } from "./types.js";

const CALM = ["hi chat", "what game is this", "gg", "this music is nice", "first time here", "where is he going", "lets go"];

/**
 * A made-up chat for tests and demo mode: a few calm messages every 10 s, and at each `atSec` a
 * burst of `messages` from different viewers (with an emote or a line, when given). Deterministic.
 */
export function seededChat(
  durationSec: number,
  spikes: { atSec: number; messages: number; emote?: string; text?: string }[],
  opts: { perBucket?: number; clips?: CommunityClip[] } = {},
): ChatLog {
  const perBucket = opts.perBucket ?? 3;
  const messages: ChatLog["messages"] = [];
  let n = 0;
  for (let t = 0; t < durationSec; t += 10) {
    // 2, 3 or 4 calm messages, so the baseline has some spread.
    const count = Math.max(0, perBucket + ((t / 10) % 3) - 1);
    for (let k = 0; k < count; k++) messages.push({ sec: t + (k * 10) / Math.max(1, count), user: `viewer${n % 40}`, text: CALM[n++ % CALM.length]! });
  }
  for (const s of spikes) {
    for (let k = 0; k < s.messages; k++) {
      const text = s.text ?? (s.emote ? `${s.emote} ${s.emote}` : "no way");
      messages.push({ sec: s.atSec + (k * 9.9) / s.messages, user: `fan${k}`, text, ...(s.emote ? { emotes: [s.emote] } : {}) });
    }
  }
  return { messages: messages.sort((a, b) => a.sec - b.sec), clips: opts.clips ?? [] };
}

const hasChat = (url: string) => /^https?:\/\/(www\.|m\.)?(twitch\.tv|kick\.com)\//i.test(url);

/** Stands in for Twitch/Kick chat: a set log per link, or (demo mode) one spike 60% into any Twitch/Kick VOD. */
export class FakeChatSource implements ChatSource {
  readonly name = "fake";
  readonly calls: string[] = [];

  constructor(private logs?: Record<string, ChatLog | null>) {}

  async fetch(url: string, opts: { durationSec: number }): Promise<ChatLog | null> {
    this.calls.push(url);
    if (this.logs) return this.logs[url] ?? null;
    if (!hasChat(url)) return null;
    return seededChat(opts.durationSec, [{ atSec: Math.floor(opts.durationSec * 0.6), messages: 40, emote: "KEKW" }]);
  }
}

/** Stands in for a live chat connection: hands back `log` when the segment ends. */
export class FakeChatTap implements LiveChatTap {
  readonly name = "fake";
  readonly listened: { platform: WatchPlatform; handle: string }[] = [];

  constructor(private log: ChatLog | null = null) {}

  listen(target: { platform: WatchPlatform; handle: string }, signal: AbortSignal): Promise<ChatLog | null> {
    this.listened.push(target);
    return new Promise((resolve) => {
      if (signal.aborted) resolve(this.log);
      else signal.addEventListener("abort", () => resolve(this.log), { once: true });
    });
  }
}
