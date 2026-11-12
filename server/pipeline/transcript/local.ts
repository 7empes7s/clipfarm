import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import type { Word } from "../../../shared/types.js";
import { assertMemoryFor, type MemoryReading } from "../../engine/memory.js";
import { runTracked } from "../../engine/proc.js";
import type { TranscribeOptions, Transcript } from "./types.js";

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
export function whisperArgs(setup: WhisperSetup, audio: string, outBase: string, threads: number): string[] {
  return [
    "-m", setup.model,
    "-f", audio,
    "--vad", "-vm", setup.vadModel,
    "-l", setup.modelId.endsWith(".en") ? "en" : "auto",
    "-ml", "1", "-sow",
    "-bs", "1", "-bo", "1",
    "-t", String(threads),
    "-ojf", "-of", outBase,
    "-np", "-pp",
  ];
}

interface WhisperJson {
  transcription?: { offsets?: { from?: number; to?: number }; text?: string }[];
}

/**
 * Turns whisper.cpp's JSON (one segment per word) into words with times in seconds.
 * - Sound notes like "[BLANK_AUDIO]" or "(laughs)" are not words and are left out.
 * - A piece without letters or digits (a stray dash or quote) joins the word before it.
 * - With VAD, the first word after a skipped silence can come out starting before the silence;
 *   a word longer than a word can be is pulled up to just before its end.
 */
export function parseWhisperJson(json: string): Word[] {
  let body: WhisperJson;
  try {
    body = JSON.parse(json) as WhisperJson;
  } catch {
    throw new Error("The speech-to-text program did not write a readable transcript.");
  }
  const words: Word[] = [];
  let noteEnd: string | null = null;
  for (const seg of body.transcription ?? []) {
    const text = (seg.text ?? "").trim();
    const from = seg.offsets?.from;
    const to = seg.offsets?.to;
    if (!text || typeof from !== "number" || typeof to !== "number") continue;
    if (noteEnd) {
      if (text.endsWith(noteEnd)) noteEnd = null;
      continue;
    }
    const open = /^[[(]/.exec(text)?.[0];
    if (open) {
      const close = open === "[" ? "]" : ")";
      if (!text.endsWith(close)) noteEnd = close;
      continue;
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
  }
  return words;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export interface LocalTranscript extends Transcript {
  peakRssMb: number | null;
}

/**
 * Speech-to-text on this server with whisper.cpp: no outside service, no cost per minute.
 * Refuses to start when the box is short on memory (the guard), and runs as one child process
 * that gives its memory back when it ends.
 */
export async function transcribeLocally(
  setup: WhisperSetup,
  audioPath: string,
  opts: TranscribeOptions,
  memory: MemoryReading,
): Promise<LocalTranscript> {
  assertMemoryFor(`the speech model (${setup.modelId})`, setup.needMb, memory);
  const outBase = join(opts.tmpDir, "transcript");
  const started = Date.now();
  const { peakRssMb } = await runTracked(
    setup.bin,
    whisperArgs(setup, audioPath, outBase, Math.min(4, availableParallelism())),
    {
      signal: opts.signal,
      onStderrLine: (line) => {
        const m = /progress\s*=\s*(\d+)%/.exec(line);
        if (m) opts.onProgress?.(Math.min(1, Number(m[1]) / 100));
      },
    },
  );
  const words = parseWhisperJson(await readFile(`${outBase}.json`, "utf8"));
  opts.onProgress?.(1);
  console.log(
    `[transcribe] local ${setup.modelId}: ${Math.round(opts.durationSec)} s of audio in ${Math.round((Date.now() - started) / 1000)} s, ${words.length} words, peak memory ${peakRssMb ?? "?"} MB`,
  );
  return { words, costUsd: 0, peakRssMb };
}
