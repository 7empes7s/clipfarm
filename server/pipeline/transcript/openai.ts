import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Word } from "../../../shared/types.js";
import { extractAudio } from "../../tools/ffmpeg.js";
import { type ChunkWords, mergeChunkWords, planChunks } from "./chunking.js";
import type { TranscribeOptions, Transcriber, Transcript } from "./types.js";

/** OpenAI's upload limit is 25 MB; stay under it with some room. */
export const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;
const OVERLAP_SEC = 10;
/** List price, USD per minute of audio. */
export const WHISPER_USD_PER_MIN = 0.006;
/** The transcription model OpenAI recommends; used once it returns word timings. */
export const DEFAULT_TRANSCRIBE_MODEL = "gpt-transcribe";
/** The model that returns word timings today. OpenAI shuts it down on 2027-02-26. */
export const WORD_TIMING_MODEL = "whisper-1";
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

interface VerboseJson {
  text?: string;
  duration?: number;
  words?: { word: string; start: number; end: number }[];
}

export interface OpenAiTranscriberOptions {
  apiKey: string;
  baseUrl?: string;
  /** The model to ask first. One that sends no word timings is swapped for `whisper-1`. */
  model?: string;
  /** Injected in tests so no real API is called. */
  fetchImpl?: typeof fetch;
  /** Overridable in tests to force chunking on small files. */
  maxUploadBytes?: number;
}

/** The transcription API refused a call. `body` is its answer as sent. */
export class TranscriptionFailedError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`OpenAI transcription failed (${status}): ${body.slice(0, 300)}`);
  }
}

/**
 * OpenAI speech-to-text with word-level timestamps (captions need them); audio over 25 MB is split
 * with overlap. A model that cannot give word timings is dropped for `whisper-1` on its first answer.
 */
export class OpenAiTranscriber implements Transcriber {
  readonly name = "openai";
  private readonly fetchImpl: typeof fetch;
  private readonly maxUploadBytes: number;
  private model: string;

  constructor(private opts: OpenAiTranscriberOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxUploadBytes = opts.maxUploadBytes ?? MAX_UPLOAD_BYTES;
    this.model = opts.model ?? DEFAULT_TRANSCRIBE_MODEL;
  }

  async transcribe(audioPath: string, opts: TranscribeOptions): Promise<Transcript> {
    const { size } = await stat(audioPath);
    if (size <= this.maxUploadBytes) {
      const words = await this.requestFile(audioPath, opts.signal);
      opts.onProgress?.(1);
      return { words, costUsd: cost(opts.durationSec), model: this.model };
    }

    if (!(opts.durationSec > 0)) throw new Error("Could not read the length of the audio, so it cannot be split.");
    // Size the chunks from the file's bitrate so each one fits the upload limit.
    const bytesPerSec = size / opts.durationSec;
    const maxChunkSec = Math.max(OVERLAP_SEC * 3, Math.floor((this.maxUploadBytes * 0.9) / bytesPerSec));
    const plan = planChunks(opts.durationSec, maxChunkSec, OVERLAP_SEC);
    const results: ChunkWords[] = [];
    for (const chunk of plan) {
      const file = join(opts.tmpDir, `chunk-${chunk.index}.mp3`);
      await extractAudio(audioPath, file, { startSec: chunk.startSec, durationSec: chunk.durationSec, signal: opts.signal });
      results.push({ ...chunk, words: await this.requestFile(file, opts.signal) });
      opts.onProgress?.((chunk.index + 1) / plan.length);
    }
    const billedSec = plan.reduce((sum, c) => sum + c.durationSec, 0);
    return { words: mergeChunkWords(results), costUsd: cost(billedSec), model: this.model };
  }

  /** Transcribes audio held in memory (the Settings test's 2-second sample) and says which model answered. */
  async sample(audio: Uint8Array<ArrayBuffer>, fileName: string, signal?: AbortSignal): Promise<{ words: Word[]; model: string }> {
    const words = await this.request(audio, fileName, signal);
    return { words, model: this.model };
  }

  private async requestFile(file: string, signal?: AbortSignal): Promise<Word[]> {
    return this.request(new Uint8Array(await readFile(file)), basename(file), signal);
  }

  private async request(audio: Uint8Array<ArrayBuffer>, fileName: string, signal?: AbortSignal): Promise<Word[]> {
    const asked = this.model;
    try {
      const words = await this.ask(asked, audio, fileName, signal);
      if (words) return words;
    } catch (err) {
      // 400 or 404: the model does not take a word-timings request (or is not there). Anything else is a real failure.
      const unsupported = err instanceof TranscriptionFailedError && (err.status === 400 || err.status === 404);
      if (asked === WORD_TIMING_MODEL || !unsupported) throw err;
    }
    if (asked === WORD_TIMING_MODEL) return [];
    // No word timings from this model: whisper-1 for this file and the rest of the job.
    this.model = WORD_TIMING_MODEL;
    return (await this.ask(WORD_TIMING_MODEL, audio, fileName, signal)) ?? [];
  }

  /** One upload. Null when the answer has no word timings at all. */
  private async ask(model: string, audio: Uint8Array<ArrayBuffer>, fileName: string, signal?: AbortSignal): Promise<Word[] | null> {
    const form = new FormData();
    form.append("file", new Blob([audio]), fileName);
    form.append("model", model);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    const res = await this.fetchImpl(`${this.opts.baseUrl ?? OPENAI_BASE_URL}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
      body: form,
      signal,
    });
    if (!res.ok) throw new TranscriptionFailedError(res.status, await res.text());
    const body = (await res.json()) as VerboseJson;
    if (!Array.isArray(body.words)) return null;
    return body.words.map((w) => ({ word: w.word.trim(), startSec: w.start, endSec: w.end }));
  }
}

function cost(seconds: number): number {
  return Math.round((seconds / 60) * WHISPER_USD_PER_MIN * 10000) / 10000;
}
