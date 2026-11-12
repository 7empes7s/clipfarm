import { join } from "node:path";
import type { Job } from "../../../shared/types.js";
import type { JobHandler } from "../../jobs/queue.js";
import { extractAudio, probeDuration } from "../../tools/ffmpeg.js";
import type { SourcesRepo } from "../../sources/repo.js";
import type { VodsRepo } from "../../vods/repo.js";
import { measureLoudness } from "../picks/signals.js";
import type { Transcriber } from "../transcript/types.js";
import type { AudioDownloader } from "./downloader.js";

export const INGEST_JOB = "ingest";

export interface IngestDeps {
  sources: SourcesRepo;
  vods: VodsRepo;
  downloader: AudioDownloader;
  transcriber: Transcriber;
}

/**
 * link → audio → word-timed transcript. Only the audio is downloaded; it lives in the job's temp
 * folder and is deleted with it once the words are stored.
 */
export function ingestHandler(deps: IngestDeps): JobHandler {
  return async ({ payload, tmpDir, signal, progress }) => {
    const { vodId } = payload as { vodId: number };
    const vod = deps.vods.get(vodId);
    // Checked again here, not only when the link was added: the permission may have expired since.
    deps.sources.assertCanUse(vod.sourceId);

    deps.vods.setStatus(vodId, "downloading");
    progress(0.05, "Downloading audio");
    const downloaded = await deps.downloader.downloadAudio(vod.url, tmpDir, signal);

    progress(0.3, "Preparing audio");
    const audio = join(tmpDir, "speech.mp3");
    await extractAudio(downloaded.file, audio, { signal });
    const durationSec = await probeDuration(audio, signal);
    deps.vods.saveMeta(vodId, { ...downloaded.meta, durationSec: downloaded.meta.durationSec ?? durationSec });
    // Loudness spikes help find highlights later; measure them now, while the audio is here.
    progress(0.35, "Measuring loudness");
    deps.vods.saveLoudness(vodId, await measureLoudness(audio, signal));

    deps.vods.setStatus(vodId, "transcribing");
    progress(0.4, "Transcribing");
    const transcript = await deps.transcriber.transcribe(audio, {
      durationSec,
      tmpDir,
      signal,
      onProgress: (f) => progress(0.4 + f * 0.55, "Transcribing"),
    });
    deps.vods.saveTranscript(vodId, transcript.words, deps.transcriber.name, transcript.costUsd);
  };
}

/** Marks the video failed when its ingest job ends without success. */
export function onIngestFinished(vods: VodsRepo) {
  return (job: Job): void => {
    if (job.type === INGEST_JOB && job.vodId !== null && job.status !== "done") {
      vods.setStatus(job.vodId, "failed");
    }
  };
}
