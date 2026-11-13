import { AccountStatsStore } from "./accounts/stats.js";
import { ClipsRepo } from "./clips/repo.js";
import { type Config, loadConfig, openSettings } from "./config.js";
import { type Db, openDb } from "./db/index.js";
import { DEMO_JOB, demoClipsHandler } from "./dev/demo.js";
import { DEMO_DATA_JOB, demoDataHandler } from "./dev/demoData.js";
import { ENGINE_SETUP_JOB } from "./engine/engine.js";
import { engineSetupHandler } from "./engine/setup.js";
import { proxyMaker, videoReranker } from "./google/rerank.js";
import { THUMBS_JOB, thumbsHandler, ThumbsRepo } from "./google/thumbs.js";
import { GrowthLab } from "./growth/lab.js";
import { GrowthRepo } from "./growth/repo.js";
import { HOOK_VARIANTS_JOB, HookLab } from "./hooklab/lab.js";
import { hookVariantsHandler, onHookVariantsFinished } from "./hooklab/render.js";
import { JobQueue } from "./jobs/queue.js";
import { liveCutter, liveOnFinished, LIVE_SEGMENT_JOB, liveSegmentHandler } from "./live/job.js";
import { FakeNotifier, type Notifier, WebPushNotifier } from "./live/notify.js";
import { LiveRepo } from "./live/repo.js";
import { PicksRepo } from "./picks/repo.js";
import { pipelineOnFinished } from "./pipeline/chain.js";
import { INGEST_JOB, ingestHandler } from "./pipeline/ingest/ingest.js";
import { PICKS_JOB, picksHandler } from "./pipeline/picks/job.js";
import { RENDER_JOB, renderHandler } from "./pipeline/render/job.js";
import { onRenderFinished, RENDER_CLIP_JOB, renderClipHandler } from "./pipeline/rerender/render.js";
import { Publisher } from "./publish/publisher.js";
import { PostsRepo } from "./publish/repo.js";
import type { Settings } from "./settings/store.js";
import { SourcesRepo } from "./sources/repo.js";
import { TrendRadar } from "./trends/radar.js";
import { VodsRepo } from "./vods/repo.js";
import { WatchlistRepo } from "./sources/watchlist/repo.js";

export interface Runtime {
  settings: Settings;
  config: Config;
  db: Db;
  sources: SourcesRepo;
  vods: VodsRepo;
  picks: PicksRepo;
  clips: ClipsRepo;
  posts: PostsRepo;
  publisher: Publisher;
  accountStats: AccountStatsStore;
  growth: GrowthLab;
  queue: JobQueue;
  watchRepo: WatchlistRepo;
  radar: TrendRadar;
  hookLab: HookLab;
  liveRepo: LiveRepo;
  notifier: Notifier;
  thumbs: ThumbsRepo;
}

/**
 * The database, the keys and the job queue with every pipeline step, built from the environment.
 * The server and the ops CLI both start from this, so a job means the same thing in either.
 */
export function openRuntime(env: NodeJS.ProcessEnv = process.env, opts: { pollMs?: number } = {}): Runtime {
  const settings = openSettings(env);
  const config = loadConfig(env, settings);
  const db = openDb(config.dbFile);
  config.engine.bind(db);
  config.google.bind(db);
  const sources = new SourcesRepo(db);
  const vods = new VodsRepo(db);
  const picks = new PicksRepo(db);
  const clips = new ClipsRepo(db);
  const posts = new PostsRepo(db);
  const thumbs = new ThumbsRepo(db);
  const publisher = new Publisher({ sources, clips, posts, service: config.postingService, vodTitle: (id) => vods.get(id).title });
  const accountStats = new AccountStatsStore(db, config.postingService, posts, { accounts: publisher.accounts });
  const mediaDir = config.mediaDir;
  const watchRepo = new WatchlistRepo(db, sources);
  const radar = new TrendRadar({ db, source: config.trendSource, chat: config.aiChat, watchlist: () => watchRepo.list() });
  const pipelineFinished = pipelineOnFinished({ vods, picks, queue: () => queue });
  const clipRenderFinished = onRenderFinished(clips);
  const hookLab = new HookLab({
    db,
    clips,
    sources,
    posts,
    publisher,
    enqueueRender: (testId, clipId) => queue.enqueue(HOOK_VARIANTS_JOB, { testId }, { clipId, maxAttempts: 2 }),
    chat: config.aiChat,
    trending: () => radar.boost()?.hookPatterns.map((h) => h.pattern) ?? [],
  });
  const hookVariantsFinished = onHookVariantsFinished(hookLab);
  const liveRepo = new LiveRepo(db, config.live.launchAt);
  // Demo mode never reaches a push service.
  const notifier = config.fakes ? new FakeNotifier() : new WebPushNotifier(liveRepo, config.live.pushSubject);
  const growthRepo = new GrowthRepo(db);
  const growth = new GrowthLab({
    repo: growthRepo,
    posts,
    clips,
    sources,
    publisher,
    vodTitle: (id) => vods.get(id).title,
    platformStats: config.platformStats,
    notifier,
    computeUsdPerHour: config.computeUsdPerHour,
  });
  const liveFinished = liveOnFinished({ repo: liveRepo, picks, sources, notifier });
  const queue: JobQueue = new JobQueue(db, {
    handlers: {
      [INGEST_JOB]: ingestHandler({ sources, vods, downloader: config.downloader, transcriber: config.transcriber }),
      [PICKS_JOB]: picksHandler({
        sources,
        vods,
        picks,
        picker: config.picker,
        maxPicks: config.maxPicks,
        // Not in demo mode: the stand-in has nothing to see, and a proxy per pick would only slow the demo.
        rerank: config.fakes ? undefined : videoReranker({ google: config.google, proxy: proxyMaker(config.sectionDownloader) }),
        preferences: () => growthRepo.defaults(),
        trends: () => radar.boost(),
      }),
      [RENDER_JOB]: renderHandler({
        sources,
        vods,
        picks,
        clips,
        downloader: config.sectionDownloader,
        liveCut: liveCutter(liveRepo, config.renderPreset),
        mediaDir,
        preset: config.renderPreset,
      }),
      [LIVE_SEGMENT_JOB]: liveSegmentHandler({
        repo: liveRepo,
        sources,
        vods,
        picks,
        transcriber: config.transcriber,
        picker: config.picker,
        queue: () => queue,
        maxPicks: config.live.maxPicks,
        contextSec: config.live.segmentSec * 2,
      }),
      [RENDER_CLIP_JOB]: renderClipHandler({ clips, sources, mediaDir }),
      [THUMBS_JOB]: thumbsHandler({ clips, thumbs, google: config.google, mediaDir }),
      [HOOK_VARIANTS_JOB]: hookVariantsHandler({ lab: hookLab, clips, sources, mediaDir }),
      [ENGINE_SETUP_JOB]: engineSetupHandler(config.engine),
      [DEMO_JOB]: demoClipsHandler({ sources, clips, mediaDir }),
      [DEMO_DATA_JOB]: demoDataHandler({ db, sources, clips, vods, accountStats, mediaDir, onSeeded: () => growth.proposeChanges() }),
    },
    onFinished: (job, payload) => {
      pipelineFinished(job, payload);
      clipRenderFinished(job);
      hookVariantsFinished(job, payload);
      liveFinished(job, payload);
    },
    pollMs: opts.pollMs,
  });
  return {
    settings,
    config,
    db,
    sources,
    vods,
    picks,
    clips,
    posts,
    publisher,
    accountStats,
    growth,
    queue,
    watchRepo,
    radar,
    hookLab,
    liveRepo,
    notifier,
    thumbs,
  };
}
