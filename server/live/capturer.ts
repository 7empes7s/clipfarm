import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { WatchPlatform } from "../../shared/types.js";
import { generateSample } from "../tools/ffmpeg.js";

export interface LiveTarget {
  platform: WatchPlatform;
  handle: string;
  /** The channel's page. */
  url: string;
}

export interface RecordOptions {
  durationSec: number;
  dir: string;
  /** File name without its extension. */
  name: string;
  signal?: AbortSignal;
}

/**
 * Records the next `durationSec` seconds of a live stream, as the platform sends it (no
 * re-encoding, so it is light). Resolves with the file; when the stream ends early the file is
 * just shorter. Real ones use yt-dlp and ffmpeg; tests and demo mode use the fake.
 */
export interface LiveCapturer {
  readonly name: string;
  record(target: LiveTarget, opts: RecordOptions): Promise<string>;
}

/**
 * Runs a recorder in its own process group, so stopping it also stops the ffmpeg that yt-dlp
 * starts. Rejects with the tail of stderr.
 */
function runGroup(bin: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { detached: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    const stop = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    };
    if (signal?.aborted) stop();
    signal?.addEventListener("abort", stop, { once: true });
    child.on("error", (err) => {
      signal?.removeEventListener("abort", stop);
      reject((err as NodeJS.ErrnoException).code === "ENOENT" ? new Error(`${bin} is not installed on this server.`) : err);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", stop);
      if (code === 0) resolve();
      else if (signal?.aborted) reject(new Error("Stopped."));
      else reject(new Error(`${bin} failed${stderr.trim() ? `: ${stderr.trim().split("\n").slice(-3).join(" ")}` : ""}`));
    });
  });
}

async function savedFile(dir: string, name: string, what: string): Promise<string> {
  const file = (await readdir(dir)).find((f) => f.startsWith(`${name}.`) && !f.endsWith(".part") && !f.endsWith(".ytdl"));
  if (!file) throw new Error(`${what} finished but no video was saved.`);
  return join(dir, file);
}

/** ffmpeg arguments to copy `durationSec` seconds of an HLS stream into an MPEG-TS file. */
export function ffmpegHlsArgs(hlsUrl: string, durationSec: number, output: string): string[] {
  return ["-hide_banner", "-loglevel", "error", "-y", "-i", hlsUrl, "-t", String(durationSec), "-c", "copy", "-f", "mpegts", output];
}

/** Records an HLS playlist with ffmpeg. */
export async function recordHls(hlsUrl: string, opts: RecordOptions): Promise<string> {
  const output = join(opts.dir, `${opts.name}.ts`);
  try {
    await runGroup("ffmpeg", ffmpegHlsArgs(hlsUrl, opts.durationSec, output), opts.signal);
  } catch (err) {
    // The playlist address carries a viewer token: keep it out of the job list and the log.
    if (err instanceof Error) {
      err.message = err.message.split(hlsUrl).join("the stream");
      if (err.stack) err.stack = err.stack.split(hlsUrl).join("the stream");
    }
    throw err;
  }
  return output;
}

/**
 * yt-dlp arguments to record a live stream from now (not `--live-from-start`, which is
 * experimental) for `durationSec` seconds, at up to 1080p30, through its ffmpeg downloader.
 */
export function ytDlpLiveArgs(url: string, durationSec: number, dir: string, name: string): string[] {
  return [
    "-f", "b[height<=1080][fps<=30]/b[height<=1080]/b",
    "--no-live-from-start",
    "--no-playlist",
    "--no-progress",
    "--no-part",
    "--hls-use-mpegts",
    "--downloader", "ffmpeg",
    "--downloader-args", `ffmpeg:-t ${durationSec}`,
    "-o", join(dir, `${name}.%(ext)s`),
    "--", url,
  ];
}

/** Twitch and YouTube (and Kick when its API says no): yt-dlp finds the stream and ffmpeg copies it. */
export class YtDlpLiveCapturer implements LiveCapturer {
  readonly name = "yt-dlp";

  constructor(private bin = "yt-dlp") {}

  async record(target: LiveTarget, opts: RecordOptions): Promise<string> {
    await runGroup(this.bin, ytDlpLiveArgs(target.url, opts.durationSec, opts.dir, opts.name), opts.signal);
    return savedFile(opts.dir, opts.name, "yt-dlp");
  }
}

/** The HLS address of a Kick channel's live stream, from its public channel endpoint; null when it has none. */
export async function kickPlaybackUrl(slug: string, doFetch: typeof fetch = fetch, signal?: AbortSignal): Promise<string | null> {
  const res = await doFetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug.toLowerCase())}`, {
    headers: { Accept: "application/json" },
    signal: signal ?? AbortSignal.timeout(20_000),
  });
  if (!res.ok) return null;
  const url = ((await res.json()) as { playback_url?: unknown }).playback_url;
  return typeof url === "string" && url.startsWith("https://") ? url : null;
}

/**
 * The real recorder: Kick through its HLS address with ffmpeg; Twitch and YouTube, and Kick when
 * the address cannot be read, through yt-dlp.
 */
export class PlatformLiveCapturer implements LiveCapturer {
  readonly name = "yt-dlp+ffmpeg";

  constructor(
    private ytDlp: LiveCapturer = new YtDlpLiveCapturer(),
    private opts: { fetch?: typeof fetch; recordHls?: typeof recordHls } = {},
  ) {}

  async record(target: LiveTarget, opts: RecordOptions): Promise<string> {
    if (target.platform === "kick") {
      const hls = await kickPlaybackUrl(target.handle, this.opts.fetch, opts.signal).catch(() => null);
      if (hls) return (this.opts.recordHls ?? recordHls)(hls, opts);
    }
    return this.ytDlp.record(target, opts);
  }
}

/**
 * Stands in for a live stream in tests and demo mode: no network, each segment is a generated test
 * clip, made at once. The "stream" ends after `maxSegments` per channel.
 */
export class FakeLiveCapturer implements LiveCapturer {
  readonly name = "fake";
  readonly calls: { target: LiveTarget; durationSec: number }[] = [];
  private made = new Map<string, number>();

  constructor(private opts: { maxSegments?: number; size?: string; lastSegmentSec?: number } = {}) {}

  async record(target: LiveTarget, opts: RecordOptions): Promise<string> {
    const made = this.made.get(target.url) ?? 0;
    const max = this.opts.maxSegments ?? Number.POSITIVE_INFINITY;
    if (made >= max) throw new Error("The stream has ended.");
    this.made.set(target.url, made + 1);
    this.calls.push({ target, durationSec: opts.durationSec });
    const file = join(opts.dir, `${opts.name}.mp4`);
    // The last segment of a stream is cut short, as a real one would be when the stream ends.
    const length = made + 1 === max && this.opts.lastSegmentSec ? this.opts.lastSegmentSec : opts.durationSec;
    await generateSample(file, length, opts.signal, this.opts.size ?? "640x360");
    return file;
  }
}
