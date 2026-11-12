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
import type { Platform, PostingAccount } from "../shared/types.js";
import { PLATFORMS } from "../shared/types.js";
import { FakePostingService, NoPostingService } from "./publish/fake.js";
import { PostizService } from "./publish/postiz.js";
import type { PostingService } from "./publish/types.js";
import { UploadPostService } from "./publish/uploadPost.js";
import { FakePlatformClient } from "./sources/watchlist/platforms/fake.js";
import { KickClient } from "./sources/watchlist/platforms/kick.js";
import { TwitchClient } from "./sources/watchlist/platforms/twitch.js";
import type { PlatformClient } from "./sources/watchlist/platforms/types.js";
import { YouTubeClient } from "./sources/watchlist/platforms/youtube.js";
import { Settings } from "./settings/store.js";

export interface Config {
  port: number;
  /** Address to listen on; unset means every interface (dev). The live box uses 127.0.0.1. */
  host: string | undefined;
  /** Refuse requests without Cloudflare Access's header (the live box has no other login). */
  requireAccess: boolean;
  dbFile: string;
  downloader: AudioDownloader;
  transcriber: Transcriber;
  picker: Picker;
  sectionDownloader: SectionDownloader;
  /** Where final clips (and creator frames) are kept. */
  mediaDir: string;
  maxPicks: number;
  renderPreset: string;
  postingService: PostingService;
  /** How often post links and views are read from the posting service. */
  postingRefreshMinutes: number;
  /** Twitch, Kick and YouTube, for the watchlist's live and new-VOD checks. */
  watchClients: PlatformClient[];
  /** How often the watchlist is checked. */
  watchPollMinutes: number;
  /** Keys pasted in Settings, on top of the env. */
  settings: Settings;
  /** Demo mode: every outside service is a stand-in. */
  fakes: boolean;
}

/** Keys saved from the Settings screen live next to the database: DATA_DIR/secrets.json, mode 600. */
export function openSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  return new Settings(join(resolve(env.DATA_DIR ?? "data"), "secrets.json"), env);
}

/**
 * Builds a service from the settings it needs, and builds it again when one of those changes:
 * a key saved in Settings is in use on the next call, with no restart.
 */
function live<T>(settings: Settings, names: string[], build: (env: NodeJS.ProcessEnv) => T): () => T {
  let builtFor: string | null = null;
  let current: T;
  return () => {
    const now = names.map((n) => settings.get(n) ?? "").join("\0");
    if (now !== builtFor) {
      current = build(settings.env());
      builtFor = now;
    }
    return current;
  };
}

/** Runs a call to an outside service; a key that slipped into its error message is taken out. */
async function guarded<T>(settings: Settings, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof Error) {
      err.message = settings.scrub(err.message);
      // The stack repeats the message, and is what a log line prints.
      if (err.stack) err.stack = settings.scrub(err.stack);
    }
    throw err;
  }
}

const LLM_SETTINGS = ["LLM_API_KEY", "OPENAI_API_KEY", "LLM_BASE_URL", "LLM_MODEL"];
const POSTING_SETTINGS = ["POSTIZ_URL", "POSTIZ_API_KEY", "UPLOAD_POST_API_KEY", "UPLOAD_POST_USER", "UPLOAD_POST_PLATFORMS"];

function liveTranscriber(settings: Settings): Transcriber {
  const cur = live(settings, ["OPENAI_API_KEY"], (env) => openAiOrMissingKey(env.OPENAI_API_KEY));
  return { name: "openai", transcribe: (audio, opts) => guarded(settings, () => cur().transcribe(audio, opts)) };
}

function livePicker(settings: Settings): Picker {
  const cur = live(settings, LLM_SETTINGS, llmPickerOrMissingKey);
  return {
    get name() {
      return cur().name;
    },
    pick: (input, signal) => guarded(settings, () => cur().pick(input, signal)),
  };
}

function livePostingService(settings: Settings): PostingService {
  const cur = live(settings, POSTING_SETTINGS, postingService);
  return {
    get name() {
      return cur().name;
    },
    get label() {
      return cur().label;
    },
    get dailyCaps() {
      return cur().dailyCaps;
    },
    get maxStatsAccountsPerRead() {
      return cur().maxStatsAccountsPerRead;
    },
    get accountStats() {
      const service = cur();
      return service.accountStats && ((accounts: PostingAccount[], days: number) => guarded(settings, () => service.accountStats!(accounts, days)));
    },
    listAccounts: () => guarded(settings, () => cur().listAccounts()),
    publish: (video, items) => guarded(settings, () => cur().publish(video, items)),
    refresh: (posts) => guarded(settings, () => cur().refresh(posts)),
  };
}

function liveWatchClient(settings: Settings, names: string[], build: (now: { env: NodeJS.ProcessEnv }) => PlatformClient): PlatformClient {
  const cur = live(settings, names, (env) => build({ env }));
  return {
    platform: cur().platform,
    get missing() {
      return cur().missing;
    },
    check: (handle, signal) => guarded(settings, () => cur().check(handle, signal)),
  };
}

/**
 * Reads settings from env, with the keys saved in Settings on top (`settings`; left out, only the
 * env counts). Keys never come from files in the repo.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, settings: Settings = new Settings(null, env)): Config {
  const fakes = env.CLIPFARM_FAKES === "1";
  const dataDir = resolve(env.DATA_DIR ?? "data");
  const fakeDownloads = fakes || env.DOWNLOADER === "fake";
  return {
    settings,
    fakes,
    port: Number(env.PORT ?? 3000),
    host: env.HOST || undefined,
    requireAccess: env.CLIPFARM_REQUIRE_ACCESS === "1",
    dbFile: join(dataDir, "clipfarm.db"),
    downloader: fakeDownloads
      ? new FakeDownloader(Number(env.FAKE_VOD_SEC || 10))
      : new YtDlpDownloader(env.YT_DLP_BIN ?? "yt-dlp"),
    transcriber: fakes || env.TRANSCRIBER === "fake" ? new FakeTranscriber() : liveTranscriber(settings),
    picker: fakes || env.PICKER === "fake" ? new FakePicker() : livePicker(settings),
    sectionDownloader: fakeDownloads ? new FakeSectionDownloader() : new YtDlpSectionDownloader(env.YT_DLP_BIN ?? "yt-dlp"),
    mediaDir: resolve(env.MEDIA_DIR ?? "media"),
    maxPicks: Number(env.MAX_PICKS || 15),
    renderPreset: env.RENDER_PRESET || "veryfast",
    postingService: fakes ? new FakePostingService() : livePostingService(settings),
    postingRefreshMinutes: Math.max(5, Number(env.POSTING_REFRESH_MINUTES) || 60),
    watchClients: fakes
      ? [new FakePlatformClient("twitch"), new FakePlatformClient("kick"), new FakePlatformClient("youtube")]
      : [
          liveWatchClient(
            settings,
            ["TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET"],
            (now) => new TwitchClient({ clientId: now.env.TWITCH_CLIENT_ID, clientSecret: now.env.TWITCH_CLIENT_SECRET }),
          ),
          new KickClient(),
          liveWatchClient(settings, ["YOUTUBE_API_KEY"], (now) => new YouTubeClient({ apiKey: now.env.YOUTUBE_API_KEY })),
        ],
    // A YouTube check costs 2 quota units: 15 min keeps 25+ channels well under the free 10,000 a day.
    watchPollMinutes: Math.max(5, Number(env.WATCHLIST_POLL_MINUTES) || 15),
  };
}

function llmPickerOrMissingKey(env: NodeJS.ProcessEnv): Picker {
  const apiKey = env.LLM_API_KEY || env.OPENAI_API_KEY;
  if (!apiKey) {
    // No signals-only fallback: only the model can flag spoilers and leaks, so picking stops instead.
    return {
      name: "llm",
      pick: () => Promise.reject(new Error("Add your OpenAI key in Settings, so highlights can be picked.")),
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

/** Postiz or Upload-Post from the settings (POSTING_SERVICE picks when both are set); export only without keys. */
function postingService(env: NodeJS.ProcessEnv): PostingService {
  const postiz = env.POSTIZ_URL && env.POSTIZ_API_KEY ? { url: env.POSTIZ_URL, apiKey: env.POSTIZ_API_KEY } : null;
  const uploadPost =
    env.UPLOAD_POST_API_KEY && env.UPLOAD_POST_USER
      ? {
          apiKey: env.UPLOAD_POST_API_KEY,
          user: env.UPLOAD_POST_USER,
          platforms: [...new Set((env.UPLOAD_POST_PLATFORMS ?? "tiktok,youtube,instagram").split(",").map((x) => x.trim()))].filter(
            (p): p is Platform => PLATFORMS.includes(p as Platform),
          ),
        }
      : null;
  // || not ??: an env file's empty "POSTING_SERVICE=" line means unset.
  const choice = env.POSTING_SERVICE || (postiz ? "postiz" : uploadPost ? "upload-post" : "none");
  if (choice === "fake") return new FakePostingService();
  if (choice === "postiz" && postiz) return new PostizService(postiz);
  if (choice === "upload-post" && uploadPost) return new UploadPostService(uploadPost);
  return new NoPostingService();
}

function openAiOrMissingKey(apiKey: string | undefined): Transcriber {
  if (apiKey) return new OpenAiTranscriber({ apiKey });
  // Start anyway so the gallery works; transcription jobs fail with a clear reason.
  return {
    name: "openai",
    transcribe(_audio: string, _opts: TranscribeOptions) {
      return Promise.reject(new Error("Add your OpenAI key in Settings, so audio can be transcribed."));
    },
  };
}
