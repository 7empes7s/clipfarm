import { run } from "../../tools/exec.js";
import { type LayoutPlan, OUT_FPS, videoFilter } from "./layout.js";

/** Loudness target for short-form platforms. */
export const TARGET_LUFS = -14;

export interface RenderOptions {
  /** The downloaded section. */
  input: string;
  /** Where the clip starts and how long it runs, in seconds of the input file. */
  offsetSec: number;
  durationSec: number;
  plan: LayoutPlan;
  /** ASS file name relative to `cwd` (keeps ffmpeg filter escaping out of it), or null for no captions. */
  assFile: string | null;
  cwd: string;
  output: string;
  /** x264 preset: "veryfast" for real clips, "ultrafast" in tests. */
  preset?: string;
  signal?: AbortSignal;
}

/** ffmpeg arguments for one clip: H.264 + AAC MP4, 1080×1920, 30 fps, -14 LUFS. */
export function renderArgs(o: RenderOptions): string[] {
  const audio = `[0:a]loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=11,aresample=48000[a]`;
  return [
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", o.offsetSec.toFixed(3), "-t", o.durationSec.toFixed(3), "-i", o.input,
    "-filter_complex", `${videoFilter(o.plan, o.assFile)};${audio}`,
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", o.preset ?? "veryfast", "-crf", "21", "-r", String(OUT_FPS),
    "-c:a", "aac", "-b:a", "160k", "-ac", "2",
    "-t", o.durationSec.toFixed(3),
    "-movflags", "+faststart",
    o.output,
  ];
}

export async function renderClip(o: RenderOptions): Promise<void> {
  await run("ffmpeg", renderArgs(o), { signal: o.signal, cwd: o.cwd });
}

/** Saves one frame of a video as a JPG, optionally scaled to a width. */
export async function grabFrame(
  input: string,
  atSec: number,
  output: string,
  opts: { width?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-ss", atSec.toFixed(3), "-i", input, "-frames:v", "1"];
  if (opts.width) args.push("-vf", `scale=${opts.width}:-2`);
  args.push("-q:v", "3", output);
  await run("ffmpeg", args, { signal: opts.signal });
}
