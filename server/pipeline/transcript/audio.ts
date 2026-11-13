import { execFile } from "node:child_process";
import { type Pause, parsePauses, type Segment } from "./chain.js";
import { run } from "../../tools/exec.js";

const QUIET = ["-hide_banner", "-nostdin", "-y"];
/** Quieter than this is a pause (and is not speech). */
const PAUSE_DB = -35;

/** The pauses in an audio file, from ffmpeg's silencedetect. */
export function findPauses(audio: string, totalSec: number, minPauseSec: number, signal?: AbortSignal): Promise<Pause[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      [...QUIET, "-i", audio, "-vn", "-af", `silencedetect=noise=${PAUSE_DB}dB:d=${minPauseSec}`, "-f", "null", "-"],
      { signal, maxBuffer: 64 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) reject(new Error("ffmpeg could not read the audio to find its pauses.", { cause: err }));
        else resolve(parsePauses(String(stderr), totalSec));
      },
    );
  });
}

/** Writes one segment of the audio as 16 kHz mono 16-bit WAV, the format every local engine reads. */
export async function cutSegment(audio: string, segment: Pick<Segment, "startSec" | "durationSec">, out: string, signal?: AbortSignal): Promise<string> {
  await run(
    "ffmpeg",
    [...QUIET, "-loglevel", "error", "-ss", String(segment.startSec), "-i", audio, "-t", String(segment.durationSec), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out],
    { signal },
  );
  return out;
}

/** The first `seconds` of speech in the audio (the pauses taken out), for telling the language. */
export async function firstSpeech(audio: string, out: string, seconds: number, signal?: AbortSignal): Promise<string> {
  await run(
    "ffmpeg",
    [
      ...QUIET, "-loglevel", "error", "-i", audio, "-vn",
      "-af", `silenceremove=start_periods=1:start_threshold=${PAUSE_DB}dB:stop_periods=-1:stop_duration=0.5:stop_threshold=${PAUSE_DB}dB`,
      "-t", String(seconds), "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out,
    ],
    { signal },
  );
  return out;
}
