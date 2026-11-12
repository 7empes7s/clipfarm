import { join } from "node:path";
import { generateSample } from "../../tools/ffmpeg.js";
import type { AudioDownloader, DownloadedAudio } from "./downloader.js";

/** Stands in for yt-dlp in tests and demos: no network, it generates a short sample clip instead. */
export class FakeDownloader implements AudioDownloader {
  readonly name = "fake";

  constructor(private durationSec = 10) {}

  async downloadAudio(_url: string, dir: string, signal?: AbortSignal): Promise<DownloadedAudio> {
    const file = join(dir, "source.mp4");
    await generateSample(file, this.durationSec, signal);
    const half = this.durationSec / 2;
    return {
      file,
      meta: {
        title: "Sample stream (test clip)",
        durationSec: this.durationSec,
        chapters: [
          { title: "Just chatting", startSec: 0, endSec: half },
          { title: "Gameplay", startSec: half, endSec: this.durationSec },
        ],
      },
    };
  }
}
