import type { EngineReport, EngineUse, Word } from "../../../shared/types.js";

/**
 * The speech-to-text fallback chain: the audio is cut into segments at pauses, and each segment
 * goes to the first step that can take it. A step that fails, runs out of memory, takes too long
 * or comes back with a poor answer hands that one segment to the next step; the rest of the
 * stream is not transcribed again. The words keep the times of the step that produced them.
 */

/** When an answer counts as poor, and how the audio is cut. Every number here is covered by a test. */
export interface ChainThresholds {
  /** Segments aim for this length and are cut at a pause between min and max. */
  segmentSec: number;
  minSegmentSec: number;
  maxSegmentSec: number;
  /** A pause must last this long to cut at it. */
  minPauseSec: number;
  /** Whisper: the average log-probability of the words; below this the answer is a guess. */
  minAvgLogProb: number;
  /** The share of audio the step heard as speech but gave no words for; above this it missed the speech. */
  maxNoSpeechRatio: number;
  /** Answers covering less than this are too short to judge. */
  minJudgedSec: number;
  /** Moonshine: the average confidence of its words; below this the answer is a guess. */
  minWordConfidence: number;
  /** The same word this many times in a row is a stuck model, not speech ("go, go, go, go" is). */
  maxRepeatRun: number;
  /** The same three words in a row this many times in one segment is a model going in circles. */
  maxPhraseRepeat: number;
  /** With at least `minJudgedWords` words: one word making up more than this share is garbled output. */
  maxRepeatShare: number;
  minJudgedWords: number;
  /** A step may take this many times the segment's length, and at least `minTimeoutSec`. */
  timeoutFactor: number;
  minTimeoutSec: number;
}

export const DEFAULT_THRESHOLDS: ChainThresholds = {
  segmentSec: 60,
  minSegmentSec: 30,
  maxSegmentSec: 90,
  minPauseSec: 0.3,
  minAvgLogProb: -1,
  maxNoSpeechRatio: 0.6,
  minJudgedSec: 5,
  minWordConfidence: 0.5,
  maxRepeatRun: 8,
  maxPhraseRepeat: 5,
  maxRepeatShare: 0.5,
  minJudgedWords: 12,
  timeoutFactor: 4,
  minTimeoutSec: 120,
};

/** Thresholds from the environment (`STT_MIN_AVG_LOGPROB` and so on) on top of the defaults. */
export function thresholdsFromEnv(env: NodeJS.ProcessEnv): ChainThresholds {
  const names: Record<keyof ChainThresholds, string> = {
    segmentSec: "STT_SEGMENT_SEC",
    minSegmentSec: "STT_MIN_SEGMENT_SEC",
    maxSegmentSec: "STT_MAX_SEGMENT_SEC",
    minPauseSec: "STT_MIN_PAUSE_SEC",
    minAvgLogProb: "STT_MIN_AVG_LOGPROB",
    maxNoSpeechRatio: "STT_MAX_NO_SPEECH_RATIO",
    minJudgedSec: "STT_MIN_JUDGED_SEC",
    minWordConfidence: "STT_MIN_WORD_CONFIDENCE",
    maxRepeatRun: "STT_MAX_REPEAT_RUN",
    maxPhraseRepeat: "STT_MAX_PHRASE_REPEAT",
    maxRepeatShare: "STT_MAX_REPEAT_SHARE",
    minJudgedWords: "STT_MIN_JUDGED_WORDS",
    timeoutFactor: "STT_TIMEOUT_FACTOR",
    minTimeoutSec: "STT_MIN_TIMEOUT_SEC",
  };
  const out = { ...DEFAULT_THRESHOLDS };
  for (const key of Object.keys(names) as (keyof ChainThresholds)[]) {
    const raw = env[names[key]];
    const n = raw === undefined || raw === "" ? Number.NaN : Number(raw);
    if (Number.isFinite(n)) out[key] = n;
  }
  return out;
}

export interface Segment {
  index: number;
  startSec: number;
  durationSec: number;
}

export interface Pause {
  startSec: number;
  endSec: number;
}

/**
 * Cuts the audio into segments of about `segmentSec`, each cut in the middle of the pause nearest
 * to that length (so no word is cut in two); without a pause in reach the cut is at `segmentSec`.
 */
export function planSegments(totalSec: number, pauses: Pause[], t: ChainThresholds = DEFAULT_THRESHOLDS): Segment[] {
  if (!(totalSec > 0)) return [];
  const cuts = pauses.filter((p) => p.endSec - p.startSec >= t.minPauseSec).map((p) => (p.startSec + p.endSec) / 2);
  const out: Segment[] = [];
  let start = 0;
  while (totalSec - start > t.maxSegmentSec) {
    const target = start + t.segmentSec;
    const inReach = cuts.filter((c) => c >= start + t.minSegmentSec && c <= start + t.maxSegmentSec);
    const cut = inReach.length > 0 ? inReach.reduce((best, c) => (Math.abs(c - target) < Math.abs(best - target) ? c : best)) : target;
    out.push({ index: out.length, startSec: round(start), durationSec: round(cut - start) });
    start = cut;
  }
  out.push({ index: out.length, startSec: round(start), durationSec: round(totalSec - start) });
  return out;
}

/** Parses ffmpeg's `silencedetect` log into pauses. A pause still open at the end runs to `totalSec`. */
export function parsePauses(log: string, totalSec: number): Pause[] {
  const out: Pause[] = [];
  let open: number | null = null;
  for (const m of log.matchAll(/silence_(start|end):\s*(-?[\d.]+)/g)) {
    const at = Math.max(0, Number(m[2]));
    if (m[1] === "start") open = at;
    else if (open !== null) {
      out.push({ startSec: open, endSec: at });
      open = null;
    }
  }
  if (open !== null && totalSec > open) out.push({ startSec: open, endSec: totalSec });
  return out;
}

/** What one step heard in one segment. Times are seconds from the start of the segment. */
export interface StepResult {
  words: Word[];
  /** Whisper: the average log-probability of the word tokens. */
  avgLogProb?: number | null;
  /** Moonshine: the average confidence of the words, 0..1. */
  confidence?: number | null;
  /** Seconds the step took for speech, and how many of them it gave no words for. */
  heardSec?: number;
  silentSec?: number;
  /** The language the step heard, when it says. */
  language?: string | null;
  peakRssMb?: number | null;
  costUsd?: number;
}

/** The longest run of one word said again and again, the largest share one word has, and how often the most repeated three-word phrase came. */
export function repeats(words: Word[]): { run: number; share: number; phrase: number } {
  const norm = words.map((w) => w.word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""));
  let run = 0;
  let cur = 0;
  const counts = new Map<string, number>();
  norm.forEach((w, i) => {
    cur = i > 0 && w === norm[i - 1] ? cur + 1 : 1;
    run = Math.max(run, cur);
    counts.set(w, (counts.get(w) ?? 0) + 1);
  });
  const phrases = new Map<string, number>();
  for (let i = 0; i + 3 <= norm.length; i++) {
    // One word over and over is the run above, not a phrase.
    if (norm[i] === norm[i + 1] && norm[i] === norm[i + 2]) continue;
    const key = norm.slice(i, i + 3).join(" ");
    phrases.set(key, (phrases.get(key) ?? 0) + 1);
  }
  return { run, share: norm.length > 0 ? Math.max(...counts.values()) / norm.length : 0, phrase: Math.max(0, ...phrases.values()) };
}

/** Why an answer is too poor to keep, in plain words; null when it is fine. */
export function lowConfidence(r: StepResult, t: ChainThresholds = DEFAULT_THRESHOLDS): string | null {
  const { run, share, phrase } = repeats(r.words);
  if (run >= t.maxRepeatRun) return `the same word came out ${run} times in a row`;
  if (phrase >= t.maxPhraseRepeat) return `the same phrase came out ${phrase} times`;
  if (r.words.length >= t.minJudgedWords && share > t.maxRepeatShare) return "the words came out garbled (one word over and over)";
  if (r.words.some((w) => /�/.test(w.word))) return "the words came out garbled";
  const heard = r.heardSec ?? 0;
  if (heard >= t.minJudgedSec && (r.silentSec ?? 0) / heard > t.maxNoSpeechRatio) {
    return `no words for ${Math.round(((r.silentSec ?? 0) / heard) * 100)}% of the speech`;
  }
  if (r.words.length === 0) return null;
  if (typeof r.avgLogProb === "number" && r.avgLogProb < t.minAvgLogProb) {
    return `low confidence (average log-probability ${r.avgLogProb.toFixed(2)}, below ${t.minAvgLogProb})`;
  }
  if (typeof r.confidence === "number" && r.confidence < t.minWordConfidence) {
    return `low confidence (${Math.round(r.confidence * 100)}%, below ${Math.round(t.minWordConfidence * 100)}%)`;
  }
  return null;
}

export interface StepRunOptions {
  /** The language to transcribe in, e.g. "en"; null lets the step find it. */
  language: string | null;
  durationSec: number;
  /** A folder the step may write into. */
  tmpDir: string;
  signal?: AbortSignal;
}

/** One engine in the chain. Tests use fakes; the real ones run Moonshine, whisper.cpp or the cloud. */
export interface SttStep {
  id: string;
  /** Plain name, e.g. "Whisper small". */
  label: string;
  /** "en": English only, skipped for any other language. */
  languages: "en" | "any";
  /** A paid outside service: only reached when every local step failed, and its answer is kept as it is. */
  cloud?: boolean;
  /** Why the step cannot run right now (not downloaded, no memory), or null when it can. */
  unavailable(): string | null;
  run(audioPath: string, opts: StepRunOptions): Promise<StepResult>;
}

export interface ChainDeps {
  steps: SttStep[];
  thresholds?: ChainThresholds;
  /** Writes the segment's audio (16 kHz mono WAV) and returns its path. */
  cut(segment: Segment): Promise<string>;
  /** Called when a segment is finished with, to delete its audio. */
  done?(path: string): Promise<void>;
  tmpDir: string;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

export interface ChainResult {
  words: Word[];
  costUsd: number;
  report: EngineReport;
}

/** Every step failed for a segment. The message lists what each step said, plainly. */
export class ChainFailedError extends Error {}

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English", es: "Spanish", pt: "Portuguese", fr: "French", de: "German", it: "Italian", nl: "Dutch", ru: "Russian",
  uk: "Ukrainian", pl: "Polish", tr: "Turkish", ar: "Arabic", hi: "Hindi", ja: "Japanese", ko: "Korean", zh: "Chinese",
  vi: "Vietnamese", id: "Indonesian", tl: "Tagalog", sv: "Swedish",
};
export const languageName = (code: string): string => LANGUAGE_NAMES[code] ?? code;

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Words of all segments in stream order, with stream times; a word never starts before the one before it. */
export function stitch(parts: { segment: Segment; words: Word[] }[]): Word[] {
  const out: Word[] = [];
  let floor = 0;
  for (const part of [...parts].sort((a, b) => a.segment.startSec - b.segment.startSec)) {
    const end = part.segment.startSec + part.segment.durationSec;
    for (const w of part.words) {
      // Kept inside its own segment, so a step's small timing slip cannot reorder two segments.
      const startSec = Math.min(Math.max(w.startSec + part.segment.startSec, floor, part.segment.startSec), end);
      const endSec = Math.min(Math.max(w.endSec + part.segment.startSec, startSec), Math.max(end, startSec));
      out.push({ word: w.word, startSec: round(startSec), endSec: round(endSec) });
      floor = startSec;
    }
  }
  return out;
}

/** Whole percentages that add up to 100, with nothing that did some work shown as 0%. */
export function shares(amounts: number[]): number[] {
  const total = amounts.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return amounts.map(() => 0);
  const out = amounts.map((a) => (a > 0 ? Math.max(1, Math.round((a / total) * 100)) : 0));
  // The largest share takes the slack of the rounding.
  out[out.indexOf(Math.max(...out))]! += 100 - out.reduce((a, b) => a + b, 0);
  return out;
}

/** "Moonshine 92%, Whisper small 8% (Spanish segment)": each step's share of the audio it handled. */
export function summarize(uses: EngineUse[]): string {
  const pct = shares(uses.map((u) => u.audioSec));
  return uses.filter((_, i) => pct[i]! > 0).map((u) => `${u.label} ${pct[uses.indexOf(u)]}%${u.note ? ` (${u.note})` : ""}`).join(", ");
}

interface Tally {
  use: EngineUse;
  languages: Map<string, number>;
}

/**
 * Runs the chain over the segments, one at a time. `language` is the stream's language (null when
 * unknown: treated as English). A step is skipped when it is English-only and the stream is not,
 * or when it cannot run right now. A segment whose every local answer was poor keeps the answer
 * of the last step that tried; a segment every step failed on fails the job, with each step's reason.
 */
export async function runChain(segments: Segment[], language: string | null, deps: ChainDeps): Promise<ChainResult> {
  const t = deps.thresholds ?? DEFAULT_THRESHOLDS;
  const tallies = new Map<string, Tally>();
  const fallbacks = new Map<string, { step: string; reason: string; count: number }>();
  const passedOver = (step: SttStep, reason: string) => {
    const key = `${step.id}\n${reason}`;
    const f = fallbacks.get(key) ?? { step: step.id, reason, count: 0 };
    f.count += 1;
    fallbacks.set(key, f);
  };
  const tally = (step: SttStep) => {
    let x = tallies.get(step.id);
    if (!x) {
      x = { use: { step: step.id, label: step.label, count: 0, audioSec: 0, ms: 0, peakMb: null, note: "" }, languages: new Map() };
      tallies.set(step.id, x);
    }
    return x;
  };
  const parts: { segment: Segment; words: Word[] }[] = [];
  let costUsd = 0;
  const total = segments.reduce((sum, s) => sum + s.durationSec, 0);
  let doneSec = 0;

  for (const segment of segments) {
    deps.signal?.throwIfAborted();
    const audio = await deps.cut(segment);
    try {
      const said: string[] = [];
      let kept: { step: SttStep; result: StepResult } | null = null;
      let poor: { step: SttStep; result: StepResult } | null = null;
      // After a poor answer the next step listens for the language itself: the segment may be in another one.
      let retryLanguage = language;
      for (const step of deps.steps) {
        if (step.languages === "en" && (language ?? "en") !== "en") {
          passedOver(step, `the stream is in ${languageName(language!)}, and ${step.label} only knows English`);
          continue;
        }
        // Paid for: not worth it when a local step did answer, however poorly.
        if (step.cloud && poor) continue;
        const cannot = step.unavailable();
        if (cannot) {
          said.push(`${step.label}: ${cannot}`);
          passedOver(step, cannot);
          continue;
        }
        const started = Date.now();
        const timeoutMs = Math.max(t.minTimeoutSec, segment.durationSec * t.timeoutFactor) * 1000;
        const timeout = AbortSignal.timeout(timeoutMs);
        let result: StepResult;
        try {
          result = await step.run(audio, {
            language: retryLanguage,
            durationSec: segment.durationSec,
            tmpDir: deps.tmpDir,
            signal: deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout,
          });
        } catch (err) {
          // Cancelled by the user: stop, do not try the next step.
          deps.signal?.throwIfAborted();
          const why = timeout.aborted ? `took longer than ${Math.round(timeoutMs / 1000)} s` : err instanceof Error ? err.message : String(err);
          tally(step).use.ms += Date.now() - started;
          said.push(`${step.label}: ${why}`);
          passedOver(step, timeout.aborted ? "timed out" : why);
          continue;
        }
        const x = tally(step);
        x.use.ms += Date.now() - started;
        if (typeof result.peakRssMb === "number") x.use.peakMb = Math.max(x.use.peakMb ?? 0, result.peakRssMb);
        costUsd += result.costUsd ?? 0;
        const why = step.cloud ? null : lowConfidence(result, t);
        if (why) {
          said.push(`${step.label}: ${why}`);
          passedOver(step, why);
          poor = { step, result };
          retryLanguage = null;
          continue;
        }
        kept = { step, result };
        break;
      }
      kept ??= poor;
      if (!kept) {
        throw new ChainFailedError(
          `Speech-to-text failed for the part at ${clock(segment.startSec)}: no step could transcribe it. ${said.join(" ")}`.trim() +
            (deps.steps.some((s) => s.cloud) ? "" : ' Cloud AI is off; switch on "Fall back to cloud AI" on the Dashboard to let it take over when this happens.'),
        );
      }
      const x = tally(kept.step);
      x.use.count += 1;
      x.use.audioSec = round(x.use.audioSec + segment.durationSec);
      // Said next to the step in the summary: "Whisper small 8% (Spanish segment)".
      const heard = kept.result.language ?? language;
      if (heard && heard !== "en") x.languages.set(heard, (x.languages.get(heard) ?? 0) + 1);
      parts.push({ segment, words: kept.result.words });
    } finally {
      await deps.done?.(audio);
    }
    doneSec += segment.durationSec;
    deps.onProgress?.(total > 0 ? Math.min(1, doneSec / total) : 1);
  }

  const uses = [...tallies.values()]
    .filter((x) => x.use.count > 0 || x.use.ms > 0)
    .map((x) => {
      const notes = [...x.languages].map(([code, n]) => `${languageName(code)} segment${n === 1 ? "" : "s"}`);
      return { ...x.use, note: notes.join(", ") };
    });
  const handled = uses.filter((u) => u.count > 0);
  return {
    words: stitch(parts),
    costUsd: Math.round(costUsd * 10000) / 10000,
    report: { kind: "stt", language, uses, fallbacks: [...fallbacks.values()], summary: summarize(handled) },
  };
}

const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
