import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Chapter } from "../../../shared/types.js";
import { run } from "../../tools/exec.js";
import type { AudioDownloader, DownloadedAudio, VodMeta } from "./downloader.js";

/** yt-dlp arguments for an audio-only download (~60 MB per hour) plus an info JSON with metadata. */
export function ytDlpAudioArgs(url: string, dir: string): string[] {
  return [
    "-f", "bestaudio/best",
    "--no-playlist",
    "--no-progress",
    "--write-info-json",
    "-o", join(dir, "source.%(ext)s"),
    "--", url,
  ];
}

interface InfoJson {
  title?: string;
  duration?: number;
  chapters?: { title?: string; start_time?: number; end_time?: number }[] | null;
}

export function parseInfoJson(info: InfoJson): VodMeta {
  const chapters: Chapter[] = (info.chapters ?? [])
    .filter((c) => typeof c.start_time === "number" && typeof c.end_time === "number")
    .map((c) => ({ title: c.title ?? "", startSec: c.start_time!, endSec: c.end_time! }));
  return {
    title: typeof info.title === "string" ? info.title : null,
    durationSec: typeof info.duration === "number" ? info.duration : null,
    chapters,
  };
}

/** Real downloader: Twitch, Kick, YouTube, direct files and Drive links all go through yt-dlp. */
export class YtDlpDownloader implements AudioDownloader {
  readonly name = "yt-dlp";

  constructor(private bin = "yt-dlp") {}

  async downloadAudio(url: string, dir: string, signal?: AbortSignal): Promise<DownloadedAudio> {
    await run(this.bin, ytDlpAudioArgs(url, dir), { signal });
    const files = await readdir(dir);
    const media = files.find((f) => f.startsWith("source.") && !f.endsWith(".json") && !f.endsWith(".part"));
    if (!media) throw new Error("yt-dlp finished but no audio file was saved.");
    const infoFile = files.find((f) => f.endsWith(".info.json"));
    const meta = infoFile
      ? parseInfoJson(JSON.parse(await readFile(join(dir, infoFile), "utf8")) as InfoJson)
      : { title: null, durationSec: null, chapters: [] };
    return { file: join(dir, media), meta };
  }
}
