import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { run } from "../../tools/exec.js";
import { generateSample } from "../../tools/ffmpeg.js";

/** Seconds of video fetched before and after a pick, so the cut never lands outside the download. */
export const SECTION_PAD_SEC = 3;

export interface Section {
  startSec: number;
  endSec: number;
}

/** The part of the VOD to download for a pick: the pick plus padding, kept inside the VOD. */
export function sectionFor(startSec: number, endSec: number, vodDurationSec: number | null, pad = SECTION_PAD_SEC): Section {
  const end = endSec + pad;
  return {
    startSec: Math.max(0, Math.floor((startSec - pad) * 10) / 10),
    endSec: Math.ceil((vodDurationSec !== null ? Math.min(vodDurationSec, end) : end) * 10) / 10,
  };
}

/** Fetches only a section of a VOD's video. The file starts at `section.startSec`. */
export interface SectionDownloader {
  readonly name: string;
  downloadSection(url: string, section: Section, dir: string, signal?: AbortSignal): Promise<string>;
}

/** yt-dlp arguments for one section at up to 1080p30 (60 fps and 4K would only cost time and disk). */
export function ytDlpSectionArgs(url: string, section: Section, dir: string): string[] {
  return [
    "-f", "bv*[height<=1080][fps<=30]+ba/bv*[height<=1080]+ba/b[height<=1080]/b",
    "--download-sections", `*${section.startSec}-${section.endSec}`,
    "--merge-output-format", "mp4",
    "--no-playlist",
    "--no-progress",
    "-o", join(dir, "section.%(ext)s"),
    "--", url,
  ];
}

export class YtDlpSectionDownloader implements SectionDownloader {
  readonly name = "yt-dlp";

  constructor(private bin = "yt-dlp") {}

  async downloadSection(url: string, section: Section, dir: string, signal?: AbortSignal): Promise<string> {
    await run(this.bin, ytDlpSectionArgs(url, section, dir), { signal });
    const media = (await readdir(dir)).find((f) => f.startsWith("section.") && !f.endsWith(".part"));
    if (!media) throw new Error("yt-dlp finished but no video section was saved.");
    return join(dir, media);
  }
}

/** Stands in for yt-dlp in tests and demos: no network, it generates a 16:9 test clip of the section's length. */
export class FakeSectionDownloader implements SectionDownloader {
  readonly name = "fake";
  readonly calls: Section[] = [];

  async downloadSection(_url: string, section: Section, dir: string, signal?: AbortSignal): Promise<string> {
    this.calls.push(section);
    const file = join(dir, "section.mp4");
    await generateSample(file, section.endSec - section.startSec, signal, "1280x720");
    return file;
  }
}
