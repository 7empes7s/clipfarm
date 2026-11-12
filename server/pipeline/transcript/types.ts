import type { Word } from "../../../shared/types.js";

export interface TranscribeOptions {
  /** Length of the audio file in seconds. */
  durationSec: number;
  /** A temp folder the transcriber may write chunks into (the job cleans it up). */
  tmpDir: string;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

export interface Transcript {
  /** Words with times in seconds from the start of the audio, in order. */
  words: Word[];
  costUsd: number;
}

/** Speech-to-text with word-level timestamps. Real adapters call paid APIs; tests use the fake. */
export interface Transcriber {
  readonly name: string;
  transcribe(audioPath: string, opts: TranscribeOptions): Promise<Transcript>;
}
