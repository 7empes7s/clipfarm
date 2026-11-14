import type { Word } from "../../../shared/types.js";
import { run } from "../../tools/exec.js";
import { chatPerSecond } from "../chat/spikes.js";
import type { ChatBuckets } from "../chat/types.js";
import { type Sentence, snapWindow, type TimeRange } from "./sentences.js";

/** Words that usually mean something just happened: laughing, shouting, disbelief, hype. */
const HYPE_WORDS = new Set([
  "lol", "lmao", "haha", "hahaha", "ha", "omg", "wtf", "what", "no", "noo", "nooo", "yes", "yo", "bro",
  "dude", "holy", "insane", "crazy", "clip", "wow", "oh", "god", "dead", "run", "go", "stop", "why",
]);

export interface Signals {
  /** Loudest momentary loudness (LUFS) per second of the VOD, from the audio downloaded at ingest. */
  loudness: number[];
  /** The chat replay in 10 s buckets, when the platform gives one (Twitch, Kick); null for uploads and YouTube. */
  chat: ChatBuckets | null;
}

/** Parses ffmpeg `ebur128` log lines into the loudest momentary value per second. */
export function parseEbur128(log: string): number[] {
  const perSec: number[] = [];
  for (const m of log.matchAll(/t:\s*([\d.]+)\s.*?M:\s*(-?[\d.]+)/g)) {
    const sec = Math.floor(Number(m[1]) - 1e-6);
    const lufs = Number(m[2]);
    if (sec < 0 || !Number.isFinite(lufs)) continue;
    while (perSec.length <= sec) perSec.push(-120);
    perSec[sec] = Math.max(perSec[sec]!, lufs);
  }
  return perSec.map((v) => Math.round(v * 10) / 10);
}

/** Runs the EBU R128 meter over an audio file (cheap: no API, a few seconds per hour of audio). */
export async function measureLoudness(audio: string, signal?: AbortSignal): Promise<number[]> {
  const { stderr } = await run(
    "ffmpeg",
    ["-hide_banner", "-nostats", "-loglevel", "info", "-i", audio, "-af", "ebur128", "-f", "null", "-"],
    { signal },
  );
  return parseEbur128(stderr);
}

function zScores(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  return values.map((v) => (sd > 0 ? Math.max(-3, Math.min(3, (v - mean) / sd)) : 0));
}

function smooth(values: number[], radius: number): number[] {
  return values.map((_, i) => {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j++) {
      sum += values[j]!;
      count++;
    }
    return sum / count;
  });
}

export function isHypeWord(word: string): boolean {
  return HYPE_WORDS.has(word.toLowerCase().replace(/[^a-z]/g, ""));
}

/**
 * An excitement score per second of the VOD, from plain signals: loudness spikes, fast speech,
 * laughing/shouting words and (when there is a chat replay) chat spikes.
 */
export function secondScores(durationSec: number, words: Word[], signals: Signals): number[] {
  const n = Math.max(0, Math.ceil(durationSec));
  const loud = Array.from({ length: n }, (_, i) => {
    const v = signals.loudness[i];
    return v === undefined || v < -70 ? -70 : v;
  });
  const rate = new Array<number>(n).fill(0);
  const hype = new Array<number>(n).fill(0);
  for (const w of words) {
    const s = Math.floor(w.startSec);
    if (s < 0 || s >= n) continue;
    rate[s]!++;
    if (isHypeWord(w.word)) hype[s]! += 1;
  }
  // Already 0-3 where chat spiked, placed so a window opens ~30 s before the spike.
  const chat = chatPerSecond(signals.chat, n);

  const loudZ = zScores(loud);
  const rateZ = zScores(smooth(rate, 2));
  const hypeS = smooth(hype, 2);
  return smooth(
    loudZ.map((l, i) => l + 0.5 * rateZ[i]! + hypeS[i]! + (chat ? chat[i]! : 0)),
    1,
  );
}

export interface Candidate extends TimeRange {
  /** The second the excitement peaks. */
  peakSec: number;
  signal: number;
}

/**
 * Picks the most exciting moments (peaks at least `minGapSec` apart) and turns each into a
 * sentence-aligned window that opens shortly before the peak, so the clip starts on the reaction.
 */
export function candidateWindows(
  scores: number[],
  sentences: Sentence[],
  opts: { count: number; leadSec?: number; tailSec?: number; minGapSec?: number },
): Candidate[] {
  const lead = opts.leadSec ?? 8;
  const tail = opts.tailSec ?? 22;
  const minGap = opts.minGapSec ?? 45;
  const order = scores.map((_, i) => i).sort((a, b) => scores[b]! - scores[a]! || a - b);
  const out: Candidate[] = [];
  for (const peak of order) {
    if (out.length >= opts.count) break;
    if (out.some((c) => Math.abs(c.peakSec - peak) < minGap)) continue;
    const win = snapWindow(sentences, { startSec: peak - lead, endSec: peak + tail });
    if (!win) continue;
    if (out.some((c) => win.startSec < c.endSec && c.startSec < win.endSec)) continue;
    out.push({ ...win, peakSec: peak, signal: Math.round(scores[peak]! * 100) / 100 });
  }
  return out;
}
