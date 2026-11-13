import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import type { Word } from "../../../shared/types.js";
import { assertMemoryFor, type MemoryReading } from "../../engine/memory.js";
import { runTracked } from "../../engine/proc.js";

/** What whisper.cpp needs to run: its program, the speech model and the speech finder (VAD) model. */
export interface WhisperSetup {
  bin: string;
  model: string;
  vadModel: string;
  /** e.g. "base.en". */
  modelId: string;
  /** Memory the model needs while it runs, in MB. */
  needMb: number;
}

/** A spoken word cannot plausibly last longer than this (seconds). */
const MAX_WORD_SEC = 1.5;

/**
 * whisper-cli arguments: Silero VAD first so only speech is transcribed, one word per segment
 * (`-ml 1 -sow`) for word times, full JSON out, greedy decoding (about twice as fast as the
 * default beam search, same words on clear speech).
 */
export function whisperArgs(setup: WhisperSetup, audio: string, outBase: string, threads: number, language?: string | null): string[] {
  return [
    "-m", setup.model,
    "-f", audio,
    "--vad", "-vm", setup.vadModel,
    "-l", setup.modelId.endsWith(".en") ? "en" : language || "auto",
    "-ml", "1", "-sow",
    "-bs", "1", "-bo", "1",
    "-t", String(threads),
    "-ojf", "-of", outBase,
    "-np", "-pp",
  ];
}

interface WhisperJson {
  result?: { language?: string };
  transcription?: { offsets?: { from?: number; to?: number }; text?: string; tokens?: { text?: string; p?: number }[] }[];
}

/** What whisper.cpp heard, with what the fallback chain needs to judge it. */
export interface WhisperReading {
  words: Word[];
  /** The average log-probability of the word tokens; null without words. */
  avgLogProb: number | null;
  /** Seconds whisper took for speech, and how many of them it only had a sound note for ("[BLANK_AUDIO]"). */
  heardSec: number;
  silentSec: number;
  language: string | null;
}

/** A sound note cannot stand for more than this (seconds): its times can span a skipped silence. */
const MAX_NOTE_SEC = 30;

/**
 * Turns whisper.cpp's JSON (one segment per word) into words with times in seconds.
 * - Sound notes like "[BLANK_AUDIO]" or "(laughs)" are not words and are left out.
 * - A piece without letters or digits (a stray dash or quote) joins the word before it.
 * - With VAD, the first word after a skipped silence can come out starting before the silence;
 *   a word longer than a word can be is pulled up to just before its end.
 */
export function parseWhisperJson(json: string): Word[] {
  return readWhisperJson(json).words;
}

/** The words (see parseWhisperJson) with whisper's own confidence and how much speech it had no words for. */
export function readWhisperJson(json: string): WhisperReading {
  let body: WhisperJson;
  try {
    body = JSON.parse(json) as WhisperJson;
  } catch {
    throw new Error("The speech-to-text program did not write a readable transcript.");
  }
  const words: Word[] = [];
  let noteEnd: string | null = null;
  let logProbs = 0;
  let tokens = 0;
  let spokenSec = 0;
  let silentSec = 0;
  for (const seg of body.transcription ?? []) {
    const text = (seg.text ?? "").trim();
    const from = seg.offsets?.from;
    const to = seg.offsets?.to;
    if (!text || typeof from !== "number" || typeof to !== "number") continue;
    const noteSec = Math.min(MAX_NOTE_SEC, Math.max(0, to - from) / 1000);
    if (noteEnd) {
      if (text.endsWith(noteEnd)) noteEnd = null;
      silentSec += noteSec;
      continue;
    }
    const open = /^[[(]/.exec(text)?.[0];
    if (open) {
      const close = open === "[" ? "]" : ")";
      if (!text.endsWith(close)) noteEnd = close;
      silentSec += noteSec;
      continue;
    }
    for (const t of seg.tokens ?? []) {
      // "[_BEG_]" and the like are whisper's own marks, not words.
      if (typeof t.p !== "number" || !(t.p > 0) || (t.text ?? "").startsWith("[_")) continue;
      logProbs += Math.log(t.p);
      tokens += 1;
    }
    const endSec = Math.max(to, from + 20) / 1000;
    if (!/[\p{L}\p{N}]/u.test(text)) {
      const prev = words.at(-1);
      if (prev) prev.word += text;
      continue;
    }
    let startSec = from / 1000;
    if (endSec - startSec > MAX_WORD_SEC) startSec = endSec - Math.min(MAX_WORD_SEC, 0.2 + 0.07 * text.length);
    words.push({ word: text, startSec: round(startSec), endSec: round(endSec) });
    spokenSec += endSec - startSec;
  }
  return {
    words,
    avgLogProb: tokens > 0 ? logProbs / tokens : null,
    heardSec: round(spokenSec + silentSec),
    silentSec: round(silentSec),
    language: body.result?.language || null,
  };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export interface WhisperRun extends WhisperReading {
  peakRssMb: number | null;
}

/**
 * One whisper.cpp run over an audio file, in the given language (null: whisper finds it). Refuses
 * to start when the box is short on memory (the guard); the child process gives its memory back
 * when it ends.
 */
export async function runWhisper(
  setup: WhisperSetup,
  audioPath: string,
  opts: { outBase: string; language?: string | null; signal?: AbortSignal; onProgress?: (fraction: number) => void },
  memory: MemoryReading,
): Promise<WhisperRun> {
  assertMemoryFor(`the speech model (${setup.modelId})`, setup.needMb, memory);
  const { peakRssMb } = await runTracked(
    setup.bin,
    whisperArgs(setup, audioPath, opts.outBase, Math.min(4, availableParallelism()), opts.language),
    {
      signal: opts.signal,
      onStderrLine: (line) => {
        const m = /progress\s*=\s*(\d+)%/.exec(line);
        if (m) opts.onProgress?.(Math.min(1, Number(m[1]) / 100));
      },
    },
  );
  return { ...readWhisperJson(await readFile(`${opts.outBase}.json`, "utf8")), peakRssMb };
}

/** The language whisper.cpp hears in an audio file (a multilingual model), e.g. "es"; null when it does not say. */
export async function detectLanguage(setup: WhisperSetup, audioPath: string, memory: MemoryReading, signal?: AbortSignal): Promise<string | null> {
  assertMemoryFor(`the speech model (${setup.modelId})`, setup.needMb, memory);
  let found: string | null = null;
  await runTracked(setup.bin, ["-m", setup.model, "-f", audioPath, "-dl", "-t", String(Math.min(4, availableParallelism()))], {
    signal,
    onStderrLine: (line) => {
      const m = /auto-detected language:\s*([a-z]{2,3})\b/.exec(line);
      if (m) found = m[1]!;
    },
  });
  return found;
}
