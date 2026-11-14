import type { ChatBuckets, ChatLog } from "./types.js";

export const BUCKET_SEC = 10;

/** Laughing and hype emotes (and their plain-text forms) that show a reaction. Lower case. */
const REACTION_EMOTES = new Set([
  "lul", "kekw", "omegalul", "lmao", "lol", "pogchamp", "pog", "poggers", "pogu", "monkas", "kappa",
  "w", "l", "ww", "www", "ll", "lll", "😂", "🤣", "💀", "😭", "ez", "sadge", "pepelaugh", "icant", "aware",
]);

/** Short phrases chat types when something just happened. Lower case, matched as whole words. */
const KEYWORDS = ["clip it", "clip that", "clipped", "no way", "noway", "w", "l", "insane", "holy", "wtf", "omg", "lmao", "bro"];
const KEYWORD_RE = new RegExp(`(^|[^a-z0-9])(${KEYWORDS.map((k) => k.replace(/ /g, "\\s+")).join("|")})($|[^a-z0-9])`, "i");

/** The emotes in a message: what the platform marked, plus known reaction emotes typed as words. */
export function messageEmotes(text: string, marked: string[] = []): string[] {
  const typed = text.split(/\s+/).filter((t) => REACTION_EMOTES.has(t.toLowerCase()));
  return [...marked, ...typed];
}

export function hasKeyword(text: string): boolean {
  return KEYWORD_RE.test(text);
}

/** Groups a chat log into 10 s buckets: messages, unique chatters, emote bursts and keywords. */
export function bucketChat(log: ChatLog, durationSec: number, bucketSec = BUCKET_SEC): ChatBuckets {
  const lastSec = Math.max(durationSec, ...log.messages.map((m) => m.sec), 0);
  const n = Math.max(1, Math.ceil(lastSec / bucketSec));
  const messages = new Array<number>(n).fill(0);
  const emotes = new Array<number>(n).fill(0);
  const keywords = new Array<number>(n).fill(0);
  const users = Array.from({ length: n }, () => new Set<string>());
  const emoteCounts = Array.from({ length: n }, () => new Map<string, number>());
  for (const m of log.messages) {
    if (!(m.sec >= 0)) continue;
    const i = Math.min(n - 1, Math.floor(m.sec / bucketSec));
    messages[i]!++;
    users[i]!.add(m.user.toLowerCase());
    const found = messageEmotes(m.text, m.emotes);
    if (found.length > 0) emotes[i]!++;
    // One vote per message per emote, so a spammed "KEKW KEKW KEKW" counts once.
    for (const e of new Set(found)) emoteCounts[i]!.set(e, (emoteCounts[i]!.get(e) ?? 0) + 1);
    if (hasKeyword(m.text)) keywords[i]!++;
  }
  return {
    bucketSec,
    offsetSec: 0,
    messages,
    chatters: users.map((u) => u.size),
    emotes,
    topEmote: emoteCounts.map((c) => [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null),
    keywords,
    clips: log.clips.filter((c) => c.endSec > c.startSec).sort((a, b) => a.startSec - b.startSec),
  };
}

/**
 * A live stream's chat grows a segment at a time. `add` is bucketed on the stream's clock; its
 * buckets from `fromSec` on replace what was there, so overlapping segments never count twice.
 */
export function mergeBuckets(base: ChatBuckets | null, add: ChatBuckets, fromSec: number): ChatBuckets {
  if (!base || base.bucketSec !== add.bucketSec) return add;
  const first = Math.ceil(fromSec / add.bucketSec);
  const n = Math.max(base.messages.length, add.messages.length);
  const pick = <T>(a: T[], b: T[], empty: T): T[] =>
    Array.from({ length: n }, (_, i) => (i >= first && i < b.length ? b[i]! : (a[i] ?? empty)));
  const clips = [...base.clips];
  for (const c of add.clips) if (!clips.some((k) => k.startSec === c.startSec && k.endSec === c.endSec)) clips.push(c);
  return {
    bucketSec: add.bucketSec,
    offsetSec: 0,
    messages: pick(base.messages, add.messages, 0),
    chatters: pick(base.chatters, add.chatters, 0),
    emotes: pick(base.emotes, add.emotes, 0),
    topEmote: pick(base.topEmote, add.topEmote, null),
    keywords: pick(base.keywords, add.keywords, 0),
    clips: clips.sort((a, b) => a.startSec - b.startSec),
  };
}

/** The part of the chat from `fromSec` to `toSec`, on a clock that starts at `fromSec` (as the live picker sees it). */
export function sliceBuckets(b: ChatBuckets | null, fromSec: number, toSec: number): ChatBuckets | null {
  if (!b) return null;
  const first = Math.max(0, Math.floor((fromSec - b.offsetSec) / b.bucketSec));
  const last = Math.ceil((toSec - b.offsetSec) / b.bucketSec);
  if (last <= first) return null;
  return {
    bucketSec: b.bucketSec,
    offsetSec: b.offsetSec + first * b.bucketSec - fromSec,
    messages: b.messages.slice(first, last),
    chatters: b.chatters.slice(first, last),
    emotes: b.emotes.slice(first, last),
    topEmote: b.topEmote.slice(first, last),
    keywords: b.keywords.slice(first, last),
    clips: b.clips
      .filter((c) => c.endSec > fromSec && c.startSec < toSec)
      .map((c) => ({ startSec: c.startSec - fromSec, endSec: c.endSec - fromSec })),
  };
}
