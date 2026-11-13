import { join, resolve } from "node:path";
import { type AccessVerifier, cloudflareAccessVerifier } from "./access.js";
import { Engine } from "./engine/engine.js";
import type { AudioDownloader } from "./pipeline/ingest/downloader.js";
import { FakeDownloader } from "./pipeline/ingest/fakeDownloader.js";
import { YtDlpDownloader } from "./pipeline/ingest/ytdlp.js";
import { FakeTranscriber } from "./pipeline/transcript/fake.js";
import { OpenAiTranscriber } from "./pipeline/transcript/openai.js";
import type { Transcriber } from "./pipeline/transcript/types.js";
import { FakePicker } from "./pipeline/picks/fake.js";
import { type ChatClient, LlmPicker, OpenAiCompatibleChat } from "./pipeline/picks/llm.js";
import type { Picker } from "./pipeline/picks/types.js";
import { FakeSectionDownloader, type SectionDownloader, YtDlpSectionDownloader } from "./pipeline/render/section.js";
import type { Platform, PostingAccount } from "../shared/types.js";
import { PLATFORMS } from "../shared/types.js";
import { FakePostingService, NoPostingService } from "./publish/fake.js";
import { PostizService } from "./publish/postiz.js";
import type { PostingService } from "./publish/types.js";
import { UploadPostService } from "./publish/uploadPost.js";
import { FakeProofFetcher, HttpProofFetcher, type ProofFetcher } from "./sources/proof.js";
import { FakePlatformClient } from "./sources/watchlist/platforms/fake.js";
import { KickClient } from "./sources/watchlist/platforms/kick.js";
import { TwitchClient } from "./sources/watchlist/platforms/twitch.js";
import type { PlatformClient } from "./sources/watchlist/platforms/types.js";
import { YouTubeClient } from "./sources/watchlist/platforms/youtube.js";
import { Settings } from "./settings/store.js";
import { FakeTrendSource, type TrendSource, YouTubeTrendSource } from "./trends/youtube.js";

export interface Config {
  port: number;
  /** Address to listen on; unset means every interface (dev). The live box uses 127.0.0.1. */
  host: string | undefined;
  /** Refuse requests without a token signed by Cloudflare Access (the live box has no other login). */
  requireAccess: boolean;
  /** Checks those tokens; null when the gate is off. */
  access: AccessVerifier | null;
  dbFile: string;
  downloader: AudioDownloader;
  /** clipfarm's own engine: local speech-to-text and picks by default, cloud AI as an option. */
  engine: Engine;
  /** True when transcription and picks are test doubles (demos, e2e), so the engine is not used. */
  fakeEngine: boolean;
  /** The engine's transcriber and picker, or the fakes. */
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
  /** Where the trend radar reads today's short videos (YouTube, with the key in use right now). */
  trendSource: () => TrendSource;
  /** The cloud AI model that tags trends and writes hook variants; null without a key (and in demo mode). */
  aiChat: () => ChatClient | null;
  /** Reads the proof pages of public clipping allowances. */
  proofFetcher: ProofFetcher;
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

/** The optional cloud transcriber ("Use cloud AI for speed"); null until an OpenAI key is set. */
function liveCloudTranscriber(settings: Settings): () => Transcriber | null {
  const cur = live(settings, ["OPENAI_API_KEY"], (env) => (env.OPENAI_API_KEY ? new OpenAiTranscriber({ apiKey: env.OPENAI_API_KEY }) : null));
  return () => {
    const t = cur();
    return t && { name: t.name, transcribe: (audio, opts) => guarded(settings, () => t.transcribe(audio, opts)) };
  };
}

/** The optional cloud picker; null until a key is set. */
function liveCloudPicker(settings: Settings): () => Picker | null {
  const cur = live(settings, LLM_SETTINGS, cloudPicker);
  return () => {
    const p = cur();
    return p && { name: p.name, pick: (input, signal) => guarded(settings, () => p.pick(input, signal)) };
  };
}

/** The cloud chat model for small writing jobs (trend tags, hook variants); null until a key is set. */
function liveCloudChat(settings: Settings): () => ChatClient | null {
  const cur = live(settings, LLM_SETTINGS, cloudChat);
  return () => {
    const c = cur();
    return c && { name: c.name, complete: (req, signal) => guarded(settings, () => c.complete(req, signal)) };
  };
}

function liveTrendSource(settings: Settings): () => TrendSource {
  const cur = live(settings, ["YOUTUBE_API_KEY"], (env) => new YouTubeTrendSource({ apiKey: env.YOUTUBE_API_KEY }));
  return () => {
    const s = cur();
    return { missing: s.missing, maxUnits: (queries) => s.maxUnits(queries), fetch: (opts) => guarded(settings, () => s.fetch(opts)) };
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
  const requireAccess = env.CLIPFARM_REQUIRE_ACCESS === "1";
  const engine = new Engine({
    modelsDir: join(dataDir, "models"),
    whisperBin: env.WHISPER_BIN || undefined,
    llamaServerBin: env.LLAMA_SERVER_BIN || undefined,
    cloudTranscriber: liveCloudTranscriber(settings),
    cloudPicker: liveCloudPicker(settings),
  });
  const fakeTranscriber = fakes || env.TRANSCRIBER === "fake";
  const fakePicker = fakes || env.PICKER === "fake";
  return {
    settings,
    fakes,
    port: Number(env.PORT ?? 3000),
    host: env.HOST || undefined,
    requireAccess,
    access: requireAccess
      ? cloudflareAccessVerifier({
          teamDomain: env.CF_ACCESS_TEAM_DOMAIN || undefined,
          aud: env.CF_ACCESS_AUD || undefined,
          // The live site, so a box whose env file predates these settings still checks sign-ins.
          publicUrl: env.CLIPFARM_PUBLIC_URL || "https://clip.techinsiderbytes.com",
        })
      : null,
    dbFile: join(dataDir, "clipfarm.db"),
    downloader: fakeDownloads
      ? new FakeDownloader(Number(env.FAKE_VOD_SEC || 10))
      : new YtDlpDownloader(env.YT_DLP_BIN ?? "yt-dlp"),
    engine,
    fakeEngine: fakeTranscriber && fakePicker,
    transcriber: fakeTranscriber ? new FakeTranscriber() : engine.transcriber,
    picker: fakePicker ? new FakePicker() : engine.picker,
    sectionDownloader: fakeDownloads ? new FakeSectionDownloader() : new YtDlpSectionDownloader(env.YT_DLP_BIN ?? "yt-dlp"),
    mediaDir: resolve(env.MEDIA_DIR ?? "media"),
    maxPicks: Number(env.MAX_PICKS || 15),
    renderPreset: env.RENDER_PRESET || "veryfast",
    postingService: fakes ? demoPostingService() : livePostingService(settings),
    trendSource: fakes ? () => new FakeTrendSource() : liveTrendSource(settings),
    aiChat: fakes ? () => null : liveCloudChat(settings),
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
    proofFetcher: fakes ? new FakeProofFetcher() : new HttpProofFetcher(),
  };
}

/** Demo mode's posting service: scheduled posts go out when their time comes, as a real service's would. */
function demoPostingService(): FakePostingService {
  const service = new FakePostingService();
  service.publishesOnTime = true;
  return service;
}

/** The cloud chat model for these settings; null without a key. */
function cloudChat(env: NodeJS.ProcessEnv): ChatClient | null {
  const apiKey = env.LLM_API_KEY || env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return new OpenAiCompatibleChat({
    apiKey,
    baseUrl: env.LLM_BASE_URL || "https://api.openai.com/v1",
    model: env.LLM_MODEL || "gpt-4o-mini",
    usdPerMTokIn: Number(env.LLM_USD_PER_MTOK_IN ?? 0),
    usdPerMTokOut: Number(env.LLM_USD_PER_MTOK_OUT ?? 0),
  });
}

/** The cloud picker for these settings; null without a key. */
function cloudPicker(env: NodeJS.ProcessEnv): Picker | null {
  const chat = cloudChat(env);
  return chat && new LlmPicker(chat);
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
