import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Word } from "../../../shared/types.js";
import { extractAudio } from "../../media/ffmpeg.js";
import { type ChunkWords, mergeChunkWords, planChunks } from "./chunking.js";
import type { TranscribeOptions, Transcriber, Transcript } from "./types.js";

/** OpenAI's upload limit is 25 MB; stay under it with some room. */
export const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;
const OVERLAP_SEC = 10;
/** whisper-1 list price, USD per minute of audio. */
export const WHISPER_USD_PER_MIN = 0.006;

interface VerboseJson {
  text?: string;
  duration?: number;
  words?: { word: string; start: number; end: number }[];
}

export interface OpenAiTranscriberOptions {
  apiKey: string;
  baseUrl?: string;
  /** Injected in tests so no real API is called. */
  fetchImpl?: typeof fetch;
  /** Overridable in tests to force chunking on small files. */
  maxUploadBytes?: number;
}

/** Whisper API (`whisper-1`) with word-level timestamps; audio over 25 MB is split with overlap. */
export class OpenAiTranscriber implements Transcriber {
  readonly name = "openai";
  private readonly fetchImpl: typeof fetch;
  private readonly maxUploadBytes: number;

  constructor(private opts: OpenAiTranscriberOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxUploadBytes = opts.maxUploadBytes ?? MAX_UPLOAD_BYTES;
  }

  async transcribe(audioPath: string, opts: TranscribeOptions): Promise<Transcript> {
    const { size } = await stat(audioPath);
    if (size <= this.maxUploadBytes) {
      const words = await this.request(audioPath, opts.signal);
      opts.onProgress?.(1);
      return { words, costUsd: cost(opts.durationSec) };
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
      results.push({ ...chunk, words: await this.request(file, opts.signal) });
      opts.onProgress?.((chunk.index + 1) / plan.length);
    }
    const billedSec = plan.reduce((sum, c) => sum + c.durationSec, 0);
    return { words: mergeChunkWords(results), costUsd: cost(billedSec) };
  }

  private async request(file: string, signal?: AbortSignal): Promise<Word[]> {
    const form = new FormData();
    form.append("file", new Blob([await readFile(file)]), basename(file));
    form.append("model", "whisper-1");
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    const res = await this.fetchImpl(`${this.opts.baseUrl ?? "https://api.openai.com/v1"}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
      body: form,
      signal,
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new Error(`OpenAI transcription failed (${res.status}): ${detail}`);
    }
    const body = (await res.json()) as VerboseJson;
    return (body.words ?? []).map((w) => ({ word: w.word.trim(), startSec: w.start, endSec: w.end }));
  }
}

function cost(seconds: number): number {
  return Math.round((seconds / 60) * WHISPER_USD_PER_MIN * 10000) / 10000;
}
