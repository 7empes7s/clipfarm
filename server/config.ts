import { join, resolve } from "node:path";
import { type AccessVerifier, cloudflareAccessVerifier } from "./access.js";
import { Engine } from "./engine/engine.js";
import { type GeminiClient, VertexGemini } from "./google/client.js";
import { FakeGemini } from "./google/fake.js";
import { GoogleAi } from "./google/service.js";
import type { AudioDownloader } from "./pipeline/ingest/downloader.js";
import { FakeDownloader } from "./pipeline/ingest/fakeDownloader.js";
import { YtDlpDownloader } from "./pipeline/ingest/ytdlp.js";
import { thresholdsFromEnv } from "./pipeline/transcript/chain.js";
import { FakeTranscriber } from "./pipeline/transcript/fake.js";
import { OpenAiTranscriber } from "./pipeline/transcript/openai.js";
import type { Transcriber } from "./pipeline/transcript/types.js";
import { FakePicker } from "./pipeline/picks/fake.js";
import { type ChatClient, chatFor, LlmPicker } from "./pipeline/picks/llm.js";
import type { Picker } from "./pipeline/picks/types.js";
import { FakeSectionDownloader, type SectionDownloader, YtDlpSectionDownloader } from "./pipeline/render/section.js";
import type { Platform, PostingAccount } from "../shared/types.js";
import { PLATFORMS } from "../shared/types.js";
import { demoEndpoints, FakePlatforms } from "./publish/direct/fake.js";
import { type Endpoints, REAL_ENDPOINTS } from "./publish/direct/platforms.js";
import { FakePostingService, NoPostingService } from "./publish/fake.js";
import { type Transport, undiciTransport } from "./isolation/net.js";
import { PostizService } from "./publish/postiz.js";
import type { PostingService } from "./publish/types.js";
import { UploadPostService } from "./publish/uploadPost.js";
import { FakeLiveCapturer, type LiveCapturer, PlatformLiveCapturer, YtDlpLiveCapturer } from "./live/capturer.js";
import { DEFAULT_LAUNCH_AT } from "./live/plan.js";
import { FakeCampaignFetcher } from "./sources/campaign/fake.js";
import { FakeProofFetcher, HttpProofFetcher, type ProofFetcher } from "./sources/proof.js";
import { FakePlatformClient } from "./sources/watchlist/platforms/fake.js";
import { KickClient } from "./sources/watchlist/platforms/kick.js";
import { TwitchClient } from "./sources/watchlist/platforms/twitch.js";
import type { PlatformClient } from "./sources/watchlist/platforms/types.js";
import { YouTubeClient } from "./sources/watchlist/platforms/youtube.js";
import { type PlatformStatsSource, YouTubeStats } from "./growth/platformStats.js";
import { openAiSetup, pickChatOptions } from "./settings/openai.js";
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
  /** Gemini on the Google Cloud credit (video-aware picks, hooks, thumbnails), behind its spend guard. Off until connected in Settings. */
  google: GoogleAi;
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
  /** Platform APIs asked about our posts directly, on top of the posting service. */
  platformStats: PlatformStatsSource[];
  /** What an hour of this server costs (USD), for a clip's compute cost. */
  computeUsdPerHour: number;
  /** Live mode: records streams while they are live, in rolling segments. */
  live: {
    capturer: LiveCapturer;
    /** A new segment starts this often, and each runs `overlapSec` longer. */
    segmentSec: number;
    overlapSec: number;
    /** Hours a segment's video is kept. */
    keepHours: number;
    /** Clips cut per segment. */
    maxPicks: number;
    /** Most streams recorded at once. */
    maxStreams: number;
    /** The launch time until the manager changes it on the Launch day card. */
    launchAt: string;
    /** The app's web address, named to the push services as the sender of notifications. */
    pushSubject: string;
  };
  /** Reads the proof pages of public clipping allowances. */
  proofFetcher: ProofFetcher;
  /** Reads Whop / Content Rewards campaign pages. */
  campaignFetcher: ProofFetcher;
  /** The cloud model that helps read a campaign page, only while "Use cloud AI for speed" is on and a key is set. */
  campaignChat: () => ChatClient | null;
  /** The app's public address: where the platforms send the browser back after "Connect channel". */
  publicUrl: string;
  /** Direct uploads: the platforms' addresses, and each isolation group's way out (its proxy, or straight). */
  direct: { endpoints: Endpoints; transport: Transport };
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
  return liveBy(
    () => names.map((n) => settings.get(n) ?? "").join("\0"),
    () => build(settings.env()),
  );
}

/** The same, for a service whose setup is more than a list of settings: built again when `key` changes. */
function liveBy<T>(key: () => string, build: () => T): () => T {
  let builtFor: string | null = null;
  let current: T;
  return () => {
    const now = key();
    if (now !== builtFor) {
      current = build();
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

const GOOGLE_SETTINGS = ["GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GOOGLE_API_KEY", "GOOGLE_SERVICE_ACCOUNT_JSON", "GOOGLE_FLASH_MODEL", "GOOGLE_IMAGE_MODEL"];
const POSTING_SETTINGS = ["POSTIZ_URL", "POSTIZ_API_KEY", "UPLOAD_POST_API_KEY", "UPLOAD_POST_USER", "UPLOAD_POST_PLATFORMS"];

/** The optional cloud transcriber ("Use cloud AI for speed"); null until an OpenAI key is set. */
function liveCloudTranscriber(settings: Settings): () => Transcriber | null {
  // The model comes from Settings and the last test: gpt-transcribe once it sends word timings, whisper-1 until then.
  const now = () => ({ apiKey: settings.env().OPENAI_API_KEY, model: openAiSetup(settings).transcribeModel });
  const cur = liveBy(
    () => JSON.stringify(now()),
    () => {
      const { apiKey, model } = now();
      return apiKey ? new OpenAiTranscriber({ apiKey, model }) : null;
    },
  );
  return () => {
    const t = cur();
    return t && { name: t.name, transcribe: (audio, opts) => guarded(settings, () => t.transcribe(audio, opts)) };
  };
}

/** A cloud picks service, built again when the key, address or chosen model changes. */
function liveCloud<T>(settings: Settings, build: (settings: Settings) => T): () => T {
  return liveBy(
    () => JSON.stringify(pickChatOptions(settings)),
    () => build(settings),
  );
}

function liveCampaignChat(settings: Settings, engine: Engine): () => ChatClient | null {
  const cur = liveCloud(settings, cloudChat);
  return () => {
    const chat = cur();
    if (!chat || !engine.settings().cloud) return null;
    return { name: chat.name, complete: (req, signal) => guarded(settings, () => chat.complete(req, signal)) };
  };
}

/** The optional cloud picker; null until a key is set. */
function liveCloudPicker(settings: Settings): () => Picker | null {
  const cur = liveCloud(settings, cloudPicker);
  return () => {
    const p = cur();
    return p && { name: p.name, pick: (input, signal) => guarded(settings, () => p.pick(input, signal)) };
  };
}

/** The cloud chat model: small writing jobs (trend tags, hook variants) and the hook writer at the end of the picks chain; null until a key is set. */
function liveCloudChat(settings: Settings): () => ChatClient | null {
  const cur = liveCloud(settings, cloudChat);
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
  const demoGemini = new FakeGemini();
  const google = new GoogleAi({
    // Demo mode never reaches Google: a stand-in makes the thumbnails.
    client: fakes ? () => demoGemini : live(settings, GOOGLE_SETTINGS, googleClient),
    creditEur: Number(env.GOOGLE_CREDIT_EUR) || undefined,
    expiresAt: /^\d{4}-\d{2}-\d{2}$/.test(env.GOOGLE_CREDIT_EXPIRES ?? "") ? env.GOOGLE_CREDIT_EXPIRES : undefined,
    eurPerUsd: Number(env.GOOGLE_EUR_PER_USD) || undefined,
    scrub: (text) => settings.scrub(text),
  });
  const engine = new Engine({
    modelsDir: join(dataDir, "models"),
    whisperBin: env.WHISPER_BIN || undefined,
    llamaServerBin: env.LLAMA_SERVER_BIN || undefined,
    cloudTranscriber: liveCloudTranscriber(settings),
    cloudPicker: liveCloudPicker(settings),
    cloudChat: liveCloudChat(settings),
    googleChat: () => google.chat(),
    pythonBin: env.PYTHON_BIN || undefined,
    thresholds: thresholdsFromEnv(env),
  });
  const fakeTranscriber = fakes || env.TRANSCRIBER === "fake";
  const fakePicker = fakes || env.PICKER === "fake";
  // Demo mode: YouTube, TikTok, Instagram and the proxy check are in-process stand-ins.
  const fakePlatforms = fakes ? new FakePlatforms() : null;
  return {
    publicUrl: env.CLIPFARM_PUBLIC_URL || "https://clip.techinsiderbytes.com",
    direct: fakePlatforms
      ? { endpoints: demoEndpoints(fakePlatforms), transport: (proxyUrl) => fakePlatforms.fetch(proxyUrl !== null) }
      : { endpoints: { ...REAL_ENDPOINTS, ipEcho: env.IP_ECHO_URL || REAL_ENDPOINTS.ipEcho }, transport: undiciTransport().fetch },
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
    google,
    fakeEngine: fakeTranscriber && fakePicker,
    transcriber: fakeTranscriber ? new FakeTranscriber() : engine.transcriber,
    picker: fakePicker ? new FakePicker() : engine.picker,
    sectionDownloader: fakeDownloads ? new FakeSectionDownloader() : new YtDlpSectionDownloader(env.YT_DLP_BIN ?? "yt-dlp"),
    mediaDir: resolve(env.MEDIA_DIR ?? "media"),
    maxPicks: Number(env.MAX_PICKS || 15),
    renderPreset: env.RENDER_PRESET || "veryfast",
    postingService: fakes ? new FakePostingService() : livePostingService(settings),
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
    // In demo mode the fake posting service stands in for the platforms' analytics too.
    platformStats: fakes ? [] : [new YouTubeStats({ apiKey: () => settings.get("YOUTUBE_API_KEY") })],
    // A Hetzner CX32 is about $8 a month: roughly a cent an hour.
    computeUsdPerHour: Number(env.COMPUTE_USD_PER_HOUR) || 0.011,
    live: {
      // Demo mode: a made-up stream of two short segments, so LIVE clips show up within seconds.
      capturer: fakeDownloads ? new FakeLiveCapturer({ maxSegments: 2 }) : new PlatformLiveCapturer(new YtDlpLiveCapturer(env.YT_DLP_BIN ?? "yt-dlp")),
      segmentSec: Math.max(1, Number(env.LIVE_SEGMENT_SEC) || (fakeDownloads ? 30 : 600)),
      // As long as the longest clip, so every moment is whole in one segment.
      overlapSec: Math.max(0, Number(env.LIVE_OVERLAP_SEC || (fakeDownloads ? 30 : 60))),
      keepHours: Math.max(0, Number(env.LIVE_KEEP_HOURS || 3)),
      maxPicks: Math.max(1, Number(env.LIVE_MAX_PICKS) || 3),
      maxStreams: Math.max(1, Number(env.LIVE_MAX_STREAMS) || 4),
      launchAt: env.LAUNCH_AT && !Number.isNaN(new Date(env.LAUNCH_AT).getTime()) ? new Date(env.LAUNCH_AT).toISOString() : DEFAULT_LAUNCH_AT,
      pushSubject: env.PUBLIC_URL || "https://clip.techinsiderbytes.com",
    },
    // A YouTube check costs 2 quota units: 15 min keeps 25+ channels well under the free 10,000 a day.
    watchPollMinutes: Math.max(5, Number(env.WATCHLIST_POLL_MINUTES) || 15),
    proofFetcher: fakes ? new FakeProofFetcher() : new HttpProofFetcher(),
    campaignFetcher: fakes ? new FakeCampaignFetcher() : new HttpProofFetcher(),
    campaignChat: fakes ? () => null : liveCampaignChat(settings, engine),
  };
}

/** Gemini on Vertex AI for these settings; null until a project and an API key or service account are set. */
function googleClient(env: NodeJS.ProcessEnv): GeminiClient | null {
  if (!env.GOOGLE_CLOUD_PROJECT || !(env.GOOGLE_API_KEY || env.GOOGLE_SERVICE_ACCOUNT_JSON)) return null;
  return new VertexGemini({
    project: env.GOOGLE_CLOUD_PROJECT,
    location: env.GOOGLE_CLOUD_LOCATION || undefined,
    apiKey: env.GOOGLE_API_KEY || undefined,
    serviceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON || undefined,
    flashModel: env.GOOGLE_FLASH_MODEL || undefined,
    imageModel: env.GOOGLE_IMAGE_MODEL || undefined,
  });
}

/** The cloud chat model for these settings (Responses API at OpenAI, Chat Completions elsewhere); null without a key. */
function cloudChat(settings: Settings): ChatClient | null {
  const opts = pickChatOptions(settings);
  return opts && chatFor(opts);
}

/** The cloud picker for these settings; null without a key. */
function cloudPicker(settings: Settings): Picker | null {
  const chat = cloudChat(settings);
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
