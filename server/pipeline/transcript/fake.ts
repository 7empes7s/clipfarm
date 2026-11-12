import type { Word } from "../../../shared/types.js";
import type { TranscribeOptions, Transcriber, Transcript } from "./types.js";

const SCRIPT = "no way he actually did that chat look at this clip it right now.".split(" ");

/** A deterministic transcriber for tests and demos: one word every half second, no API calls. */
export class FakeTranscriber implements Transcriber {
  readonly name = "fake";

  async transcribe(_audioPath: string, opts: TranscribeOptions): Promise<Transcript> {
    const words: Word[] = [];
    for (let t = 0, i = 0; t + 0.4 <= opts.durationSec; t += 0.5, i++) {
      words.push({ word: SCRIPT[i % SCRIPT.length]!, startSec: round(t), endSec: round(t + 0.4) });
    }
    opts.onProgress?.(1);
    return { words, costUsd: 0 };
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000;
