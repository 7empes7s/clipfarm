import { join, resolve } from "node:path";
import type { AudioDownloader } from "./pipeline/ingest/downloader.js";
import { FakeDownloader } from "./pipeline/ingest/fakeDownloader.js";
import { YtDlpDownloader } from "./pipeline/ingest/ytdlp.js";
import { FakeTranscriber } from "./pipeline/transcript/fake.js";
import { OpenAiTranscriber } from "./pipeline/transcript/openai.js";
import type { Transcriber, TranscribeOptions } from "./pipeline/transcript/types.js";

export interface Config {
  port: number;
  dbFile: string;
  downloader: AudioDownloader;
  transcriber: Transcriber;
}

/** Reads settings from env. Keys only ever come from env, never from files in the repo. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const fakes = env.CLIPFARM_FAKES === "1";
  const dataDir = resolve(env.DATA_DIR ?? "data");
  return {
    port: Number(env.PORT ?? 3000),
    dbFile: join(dataDir, "clipfarm.db"),
    downloader: fakes || env.DOWNLOADER === "fake" ? new FakeDownloader() : new YtDlpDownloader(env.YT_DLP_BIN ?? "yt-dlp"),
    transcriber: fakes || env.TRANSCRIBER === "fake" ? new FakeTranscriber() : openAiOrMissingKey(env.OPENAI_API_KEY),
  };
}

function openAiOrMissingKey(apiKey: string | undefined): Transcriber {
  if (apiKey) return new OpenAiTranscriber({ apiKey });
  // Start anyway so the gallery works; transcription jobs fail with a clear reason.
  return {
    name: "openai",
    transcribe(_audio: string, _opts: TranscribeOptions) {
      return Promise.reject(new Error("OPENAI_API_KEY is not set on the server, so audio cannot be transcribed."));
    },
  };
}
