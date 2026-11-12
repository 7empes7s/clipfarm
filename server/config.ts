import { join, resolve } from "node:path";
import type { AudioDownloader } from "./pipeline/ingest/downloader.js";
import { FakeDownloader } from "./pipeline/ingest/fakeDownloader.js";
import { YtDlpDownloader } from "./pipeline/ingest/ytdlp.js";
import { FakeTranscriber } from "./pipeline/transcript/fake.js";
import { OpenAiTranscriber } from "./pipeline/transcript/openai.js";
import type { Transcriber, TranscribeOptions } from "./pipeline/transcript/types.js";
import type { Platform } from "../shared/types.js";
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

export interface Config {
  port: number;
  dbFile: string;
  downloader: AudioDownloader;
  transcriber: Transcriber;
  postingService: PostingService;
  /** How often post links and views are read from the posting service. */
  postingRefreshMinutes: number;
  /** Twitch, Kick and YouTube, for the watchlist's live and new-VOD checks. */
  watchClients: PlatformClient[];
  /** How often the watchlist is checked. */
  watchPollMinutes: number;
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
    postingService: fakes ? new FakePostingService() : postingService(env),
    postingRefreshMinutes: Math.max(5, Number(env.POSTING_REFRESH_MINUTES) || 60),
    watchClients: fakes
      ? [new FakePlatformClient("twitch"), new FakePlatformClient("kick"), new FakePlatformClient("youtube")]
      : [
          new TwitchClient({ clientId: env.TWITCH_CLIENT_ID, clientSecret: env.TWITCH_CLIENT_SECRET }),
          new KickClient(),
          new YouTubeClient({ apiKey: env.YOUTUBE_API_KEY }),
        ],
    // A YouTube check costs 2 quota units: 15 min keeps 25+ channels well under the free 10,000 a day.
    watchPollMinutes: Math.max(5, Number(env.WATCHLIST_POLL_MINUTES) || 15),
  };
}

/** Postiz or Upload-Post from env (POSTING_SERVICE picks when both are set); export only without keys. */
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
  const choice = env.POSTING_SERVICE ?? (postiz ? "postiz" : uploadPost ? "upload-post" : "none");
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
      return Promise.reject(new Error("OPENAI_API_KEY is not set on the server, so audio cannot be transcribed."));
    },
  };
}
