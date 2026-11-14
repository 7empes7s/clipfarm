import type { RawPick } from "../picks/types.js";
import type { ChatBuckets } from "./types.js";

/** Chat reacts after the moment: the clip window opens this long before the spike. */
export const CHAT_LEAD_SEC = 30;
/** The rolling baseline: the 5 minutes of chat before each bucket. */
const BASELINE_BUCKETS = 30;
/** Fewer earlier buckets than this (the start of a stream) and the baseline is the stream's first minutes instead. */
const MIN_HISTORY = 6;
/** How far above the baseline (z-score) a bucket must be to count as a spike, and the fewest messages it needs. */
export const SPIKE_Z = 3;
const MIN_MESSAGES = 5;
/** A bucket where this share of messages has an emote is an emote burst. */
const BURST_SHARE = 0.3;
/** How much the chat signal weighs in a pick's score: up to this share of 100 points is added. */
export const CHAT_WEIGHT = 0.4;
/** candidateWindows opens a window 8 s before its peak, so the chat signal peaks 8 s after the window start. */
const PEAK_AFTER_START_SEC = 8;
const PEAK_HALF_WIDTH_SEC = 15;

export interface Baseline {
  mean: number;
  sd: number;
}

/** Each bucket's baseline: mean and spread of the messages in the buckets before it. */
export function rollingBaselines(counts: number[], window = BASELINE_BUCKETS): Baseline[] {
  return counts.map((_, i) => {
    let from = Math.max(0, i - window);
    let to = i;
    if (to - from < MIN_HISTORY) {
      from = 0;
      to = Math.min(counts.length, window + 1);
    }
    const prior = counts.slice(from, to).filter((_, k) => from + k !== i);
    if (prior.length === 0) return { mean: 0, sd: 1 };
    const mean = prior.reduce((a, b) => a + b, 0) / prior.length;
    const sd = Math.sqrt(prior.reduce((a, b) => a + (b - mean) ** 2, 0) / prior.length);
    // A quiet, steady chat has a tiny spread; chat counts are Poisson-like, so the spread is at least √mean.
    return { mean, sd: Math.max(sd, Math.sqrt(mean), 1) };
  });
}

export function zScores(counts: number[], window = BASELINE_BUCKETS): number[] {
  const base = rollingBaselines(counts, window);
  return counts.map((c, i) => (c - base[i]!.mean) / base[i]!.sd);
}

/** A moment the audience reacted to. Times are seconds on the chat's clock. */
export interface ChatSpike {
  /** The clip window: from CHAT_LEAD_SEC before the spike to its end. */
  startSec: number;
  endSec: number;
  /** When the busiest bucket starts. */
  atSec: number;
  z: number;
  /** Messages in the busiest bucket over the usual. */
  ratio: number;
  /** The emote of a burst, when chat spammed one. */
  emote: string | null;
  keywords: number;
  /** Community clips made in the window. */
  clips: number;
}

/** The clip window for a spike in bucket `first` (through bucket `last`). */
export function spikeWindow(b: Pick<ChatBuckets, "bucketSec" | "offsetSec">, first: number, last = first): { startSec: number; endSec: number } {
  const start = b.offsetSec + first * b.bucketSec;
  return { startSec: Math.max(0, start - CHAT_LEAD_SEC), endSec: b.offsetSec + (last + 1) * b.bucketSec };
}

const overlaps = (a: { startSec: number; endSec: number }, b: { startSec: number; endSec: number }) =>
  a.startSec < b.endSec && b.startSec < a.endSec;

/**
 * Chat spikes: buckets far above the stream's rolling baseline (z-score), next ones merged. Community
 * clips count inside a spike's window; clips made where chat stayed calm are moments of their own.
 */
export function detectSpikes(b: ChatBuckets | null): ChatSpike[] {
  if (!b) return [];
  const base = rollingBaselines(b.messages);
  const z = b.messages.map((c, i) => (c - base[i]!.mean) / base[i]!.sd);
  const hot = b.messages.map((c, i) => c >= MIN_MESSAGES && z[i]! >= SPIKE_Z);
  const spikes: ChatSpike[] = [];
  for (let i = 0; i < hot.length; i++) {
    if (!hot[i]) continue;
    let last = i;
    while (hot[last + 1]) last++;
    let peak = i;
    for (let k = i; k <= last; k++) if (z[k]! > z[peak]!) peak = k;
    let emote: string | null = null;
    let keywords = 0;
    for (let k = i; k <= last; k++) {
      keywords += b.keywords[k] ?? 0;
      if (!emote && b.topEmote[k] && (b.emotes[k] ?? 0) >= b.messages[k]! * BURST_SHARE) emote = b.topEmote[k]!;
    }
    const win = spikeWindow(b, i, last);
    spikes.push({
      ...win,
      atSec: b.offsetSec + peak * b.bucketSec,
      z: Math.round(z[peak]! * 10) / 10,
      ratio: Math.round(b.messages[peak]! / Math.max(1, base[peak]!.mean)),
      emote,
      keywords,
      clips: b.clips.filter((c) => overlaps(c, win)).length,
    });
    i = last;
  }
  // Community clips away from any chat spike: overlapping clips are one moment.
  const lone = b.clips.filter((c) => !spikes.some((s) => overlaps(c, s)));
  for (const c of lone) {
    const prev = spikes.at(-1);
    if (prev && prev.z === 0 && overlaps(prev, c)) {
      prev.endSec = Math.max(prev.endSec, c.endSec);
      prev.clips++;
    } else spikes.push({ startSec: c.startSec, endSec: c.endSec, atSec: c.startSec, z: 0, ratio: 1, emote: null, keywords: 0, clips: 1 });
  }
  return spikes.sort((a, b) => a.startSec - b.startSec);
}

/** How strongly chat points at a moment, 0-100: how far above normal, an emote burst, community clips. */
export function chatScore(s: ChatSpike): number {
  return Math.max(0, Math.min(100, Math.round(10 * s.z + (s.emote ? 10 : 0) + 25 * s.clips)));
}

/** In plain words, for the "Why this one" card: "chat 6× normal, KEKW burst, 2 community clips". */
export function describeSpike(s: ChatSpike): string {
  const parts: string[] = [];
  if (s.z > 0) parts.push(s.ratio >= 2 ? `chat ${s.ratio}× normal` : "chat spike");
  if (s.emote) parts.push(`${s.emote} burst`);
  if (s.clips > 0) parts.push(`${s.clips} community clip${s.clips === 1 ? "" : "s"}`);
  return parts.join(", ");
}

/**
 * The chat signal per second, for the plain-signal ranking: each spike rises to its strength
 * (0-3, like the other signals) where a candidate window opening at the spike's window start peaks.
 */
export function chatPerSecond(b: ChatBuckets | null, durationSec: number): number[] | null {
  if (!b) return null;
  const out = new Array<number>(Math.max(0, Math.ceil(durationSec))).fill(0);
  for (const s of detectSpikes(b)) {
    const strength = (3 * chatScore(s)) / 100;
    const center = s.startSec + PEAK_AFTER_START_SEC;
    const from = Math.max(0, Math.floor(center - PEAK_HALF_WIDTH_SEC));
    const to = Math.min(out.length - 1, Math.ceil(center + PEAK_HALF_WIDTH_SEC));
    for (let t = from; t <= to; t++) {
      out[t] = Math.max(out[t]!, strength * Math.max(0, 1 - Math.abs(t - center) / PEAK_HALF_WIDTH_SEC));
    }
  }
  return out;
}

/**
 * The chat signal joins whatever scored the picks (signals, the LLM, Gemini's look) as a weighted
 * feature: a pick on a chat spike gains up to CHAT_WEIGHT × 100 points, and its reason says why.
 * Without chat (uploads, YouTube) the picks come back as they were.
 */
export function applyChatBoost(picks: RawPick[], chat: ChatBuckets | null, weight = CHAT_WEIGHT): RawPick[] {
  const spikes = detectSpikes(chat);
  if (spikes.length === 0) return picks;
  return picks.map((p) => {
    const best = spikes.filter((s) => overlaps(s, p)).sort((a, b) => chatScore(b) - chatScore(a))[0];
    if (!best) return p;
    const points = Math.round(weight * chatScore(best));
    const why = describeSpike(best);
    return {
      ...p,
      score: Math.min(100, p.score + points),
      reason: `${p.reason} ${why.charAt(0).toUpperCase()}${why.slice(1)}.`.trim(),
    };
  });
}
