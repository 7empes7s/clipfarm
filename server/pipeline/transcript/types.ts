import type { EngineReport, Word } from "../../../shared/types.js";

export interface TranscribeOptions {
  /** Length of the audio file in seconds. */
  durationSec: number;
  /** A temp folder the transcriber may write chunks into (the job cleans it up). */
  tmpDir: string;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
  /** The video this transcript is for, so the engine can note which step did what; `add` on a live stream, where each segment adds to the last. */
  run?: { vodId: number; add?: boolean };
}

export interface Transcript {
  /** Words with times in seconds from the start of the audio, in order. */
  words: Word[];
  costUsd: number;
  /** Which engine handled what, with the time each step took. */
  report?: EngineReport;
}

/** Speech-to-text with word-level timestamps. Real adapters call paid APIs; tests use the fake. */
export interface Transcriber {
  readonly name: string;
  transcribe(audioPath: string, opts: TranscribeOptions): Promise<Transcript>;
}
