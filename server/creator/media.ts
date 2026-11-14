import { join } from "node:path";
import type { AudioDownloader, DownloadedAudio } from "../pipeline/ingest/downloader.js";
import type { Section, SectionDownloader } from "../pipeline/render/section.js";
import { run } from "../tools/exec.js";
import { probeVideo } from "../tools/ffmpeg.js";
import { uploadIdOf, type UploadsRepo } from "./uploads.js";

const QUIET = ["-hide_banner", "-loglevel", "error", "-y"];

/** True when the file has a sound track but no picture (a podcast episode). */
export async function isAudioOnly(file: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await probeVideo(file, signal);
    return false;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("No video track")) return true;
    throw err;
  }
}

/** The ffmpeg arguments that cut a section out of a local file, starting exactly at its start. */
export function cutSectionArgs(input: string, section: Section, output: string, audioOnly: boolean): string[] {
  const args = [...QUIET, "-ss", section.startSec.toFixed(3), "-i", input, "-t", (section.endSec - section.startSec).toFixed(3)];
  if (audioOnly) args.push("-vn", "-c:a", "aac", "-b:a", "160k");
  else args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k");
  return [...args, output];
}

/**
 * The ffmpeg arguments that turn sound into a vertical waveform video (dark background, the
 * waveform in the brand colour), so the usual 9:16 render can caption it like any clip.
 */
export function waveformArgs(input: string, output: string, color = "#ffd84d", size = { w: 1080, h: 1920 }): string[] {
  const waveH = Math.round(size.h * 0.3);
  return [
    ...QUIET,
    "-i", input,
    "-filter_complex",
    `color=c=0x111318:s=${size.w}x${size.h}:r=30[bg];` +
      `[0:a]showwaves=s=${size.w}x${waveH}:mode=cline:rate=30:colors=${color.replace("#", "0x")},format=yuva420p[w];` +
      `[bg][w]overlay=0:${Math.round((size.h - waveH) / 2)}:shortest=1,format=yuv420p[v]`,
    "-map", "[v]", "-map", "0:a",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-b:a", "160k", "-shortest",
    output,
  ];
}

/** Ingest: an uploaded file is read where it lies; anything else goes to the real (or fake) downloader. */
export class UploadAudioDownloader implements AudioDownloader {
  get name(): string {
    return this.inner.name;
  }

  constructor(
    private inner: AudioDownloader,
    private uploads: UploadsRepo,
  ) {}

  async downloadAudio(url: string, dir: string, signal?: AbortSignal): Promise<DownloadedAudio> {
    const id = uploadIdOf(url);
    if (id === null) return this.inner.downloadAudio(url, dir, signal);
    const { path, fileName } = this.uploads.file(id);
    return { file: path, meta: { title: fileName.replace(/\.[^.]+$/, ""), durationSec: null, chapters: [] } };
  }
}

/**
 * Clip sections: cut from an uploaded file, or downloaded. A section with sound and no picture (a
 * podcast) becomes a waveform video, so it renders, captions and posts like any clip: an audiogram.
 */
export class CreatorSectionDownloader implements SectionDownloader {
  get name(): string {
    return this.inner.name;
  }

  constructor(
    private inner: SectionDownloader,
    private uploads: UploadsRepo,
    private brandColor: (url: string) => string = () => "#ffd84d",
  ) {}

  async downloadSection(url: string, section: Section, dir: string, signal?: AbortSignal): Promise<string> {
    const id = uploadIdOf(url);
    let file: string;
    if (id === null) {
      file = await this.inner.downloadSection(url, section, dir, signal);
    } else {
      const { path } = this.uploads.file(id);
      const audioOnly = await isAudioOnly(path, signal);
      file = join(dir, audioOnly ? "section.m4a" : "section.mp4");
      await run("ffmpeg", cutSectionArgs(path, section, file, audioOnly), { signal });
    }
    if (!(await isAudioOnly(file, signal))) return file;
    const video = join(dir, "section-waveform.mp4");
    await run("ffmpeg", waveformArgs(file, video, this.brandColor(url)), { signal });
    return video;
  }
}
