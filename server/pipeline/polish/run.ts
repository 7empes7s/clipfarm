import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClipEffects, Word } from "../../../shared/types.js";
import { run } from "../../tools/exec.js";
import { type LoudnessMeasure, loudnormFilter, meanDiff, parseLoudnorm, planPolish, type PolishPlan } from "./plan.js";

/** First loudnorm pass over the cut: what the audio measures before it is normalized. */
export async function measureLoudness(input: string, offsetSec: number, durationSec: number, signal?: AbortSignal): Promise<LoudnessMeasure | null> {
  const { stderr } = await run(
    "ffmpeg",
    [
      "-hide_banner", "-nostats", "-ss", offsetSec.toFixed(3), "-t", durationSec.toFixed(3), "-i", input,
      "-vn", "-af", `${loudnormFilter(null)}:print_format=json`, "-f", "null", "-",
    ],
    { signal },
  );
  return parseLoudnorm(stderr);
}

async function greyFrame(input: string, atSec: number, out: string, signal?: AbortSignal): Promise<Buffer> {
  await run(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", "-ss", atSec.toFixed(3), "-i", input, "-frames:v", "1", "-vf", "scale=32:32,format=gray", "-f", "rawvideo", out],
    { signal },
  );
  return readFile(out);
}

/**
 * Measures what the plan needs (loudness for the second pass, how different the first and last
 * frames are), one ffmpeg call after another, and returns the plan. Skips what is turned off.
 */
export async function preparePolish(o: {
  input: string;
  /** The cut, in seconds of the input file. */
  offsetSec: number;
  durationSec: number;
  effects: ClipEffects;
  hook: string;
  /** Caption words in clip seconds. */
  words: Word[];
  peakSec: number | null;
  hasAudio: boolean;
  /** The job's temp folder (removed by the queue). */
  tmpDir: string;
  signal?: AbortSignal;
}): Promise<PolishPlan> {
  const loudness = o.effects.loudness && o.hasAudio ? await measureLoudness(o.input, o.offsetSec, o.durationSec, o.signal) : null;
  let loopDiff = 0;
  if (o.effects.loopEnding) {
    const first = await greyFrame(o.input, o.offsetSec, join(o.tmpDir, "first.gray"), o.signal);
    const last = await greyFrame(o.input, o.offsetSec + Math.max(0, o.durationSec - 0.1), join(o.tmpDir, "last.gray"), o.signal);
    loopDiff = meanDiff(first, last);
  }
  return planPolish({ ...o, loopDiff, loudness });
}
