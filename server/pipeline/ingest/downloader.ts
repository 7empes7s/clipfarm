import type { Chapter } from "../../../shared/types.js";

export interface VodMeta {
  title: string | null;
  durationSec: number | null;
  chapters: Chapter[];
}

export interface DownloadedAudio {
  /** The downloaded media file (audio only for real downloads). */
  file: string;
  meta: VodMeta;
}

/** Fetches only the audio of a stream/VOD plus its metadata. The video is fetched later, per clip. */
export interface AudioDownloader {
  readonly name: string;
  downloadAudio(url: string, dir: string, signal?: AbortSignal): Promise<DownloadedAudio>;
}
