import { join, resolve } from "node:path";
import type { AudioDownloader } from "./pipeline/ingest/downloader.js";
import { FakeDownloader } from "./pipeline/ingest/fakeDownloader.js";
import { YtDlpDownloader } from "./pipeline/ingest/ytdlp.js";
import { FakeTranscriber } from "./pipeline/transcript/fake.js";
import { OpenAiTranscriber } from "./pipeline/transcript/openai.js";
import type { Transcriber, TranscribeOptions } from "./pipeline/transcript/types.js";
import { FakePicker } from "./pipeline/picks/fake.js";
import { LlmPicker, OpenAiCompatibleChat } from "./pipeline/picks/llm.js";
import type { Picker } from "./pipeline/picks/types.js";
import { FakeSectionDownloader, type SectionDownloader, YtDlpSectionDownloader } from "./pipeline/render/section.js";

export interface Config {
  port: number;
  dbFile: string;
  downloader: AudioDownloader;
  transcriber: Transcriber;
  picker: Picker;
  sectionDownloader: SectionDownloader;
  /** Where final clips (and creator frames) are kept. */
  mediaDir: string;
  maxPicks: number;
  renderPreset: string;
}

/** Reads settings from env. Keys only ever come from env, never from files in the repo. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const fakes = env.CLIPFARM_FAKES === "1";
  const dataDir = resolve(env.DATA_DIR ?? "data");
  const fakeDownloads = fakes || env.DOWNLOADER === "fake";
  return {
    port: Number(env.PORT ?? 3000),
    dbFile: join(dataDir, "clipfarm.db"),
    downloader: fakeDownloads
      ? new FakeDownloader(Number(env.FAKE_VOD_SEC || 10))
      : new YtDlpDownloader(env.YT_DLP_BIN ?? "yt-dlp"),
    transcriber: fakes || env.TRANSCRIBER === "fake" ? new FakeTranscriber() : openAiOrMissingKey(env.OPENAI_API_KEY),
    picker: fakes || env.PICKER === "fake" ? new FakePicker() : llmPickerOrMissingKey(env),
    sectionDownloader: fakeDownloads ? new FakeSectionDownloader() : new YtDlpSectionDownloader(env.YT_DLP_BIN ?? "yt-dlp"),
    mediaDir: resolve(env.MEDIA_DIR ?? "media"),
    maxPicks: Number(env.MAX_PICKS || 15),
    renderPreset: env.RENDER_PRESET || "veryfast",
  };
}

function llmPickerOrMissingKey(env: NodeJS.ProcessEnv): Picker {
  const apiKey = env.LLM_API_KEY || env.OPENAI_API_KEY;
  if (!apiKey) {
    // No signals-only fallback: only the model can flag spoilers and leaks, so picking stops instead.
    return {
      name: "llm",
      pick: () => Promise.reject(new Error("LLM_API_KEY is not set on the server, so highlights cannot be picked.")),
    };
  }
  return new LlmPicker(
    new OpenAiCompatibleChat({
      apiKey,
      baseUrl: env.LLM_BASE_URL || "https://api.openai.com/v1",
      model: env.LLM_MODEL || "gpt-4o-mini",
      usdPerMTokIn: Number(env.LLM_USD_PER_MTOK_IN ?? 0),
      usdPerMTokOut: Number(env.LLM_USD_PER_MTOK_OUT ?? 0),
    }),
  );
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
