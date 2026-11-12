import { run } from "./exec.js";

const QUIET = ["-hide_banner", "-loglevel", "error", "-y"];

/** Media duration in seconds, from ffprobe. */
export async function probeDuration(file: string, signal?: AbortSignal): Promise<number> {
  const { stdout } = await run(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file],
    { signal },
  );
  const d = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(d)) throw new Error(`Could not read the length of ${file}`);
  return d;
}

/** Width and height of the first video stream, from ffprobe. */
export async function probeVideoSize(file: string, signal?: AbortSignal): Promise<{ width: number; height: number }> {
  const { stdout } = await run(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file],
    { signal },
  );
  const [width, height] = stdout.trim().split(",").map(Number);
  if (!width || !height) throw new Error(`Could not read the picture size of ${file}`);
  return { width, height };
}

/**
 * Extracts (a slice of) the audio track as small mono MP3 (16 kHz, 48 kbps: ~21 MB per hour),
 * which is all speech-to-text needs.
 */
export async function extractAudio(
  input: string,
  output: string,
  opts: { startSec?: number; durationSec?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const args = [...QUIET];
  if (opts.startSec !== undefined) args.push("-ss", String(opts.startSec));
  args.push("-i", input);
  if (opts.durationSec !== undefined) args.push("-t", String(opts.durationSec));
  args.push("-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "48k", output);
  await run("ffmpeg", args, { signal: opts.signal });
}

/** Generates a sample clip (ffmpeg test pattern + sine tone). Used by tests and the fake downloader. */
export async function generateSample(
  output: string,
  durationSec = 10,
  signal?: AbortSignal,
  size = "640x360",
  pattern: "testsrc" | "testsrc2" | "smptehdbars" = "testsrc",
): Promise<void> {
  await run(
    "ffmpeg",
    [
      ...QUIET,
      "-f", "lavfi", "-i", `${pattern}=duration=${durationSec}:size=${size}:rate=30`,
      "-f", "lavfi", "-i", `sine=frequency=440:duration=${durationSec}`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", output,
    ],
    { signal },
  );
}
