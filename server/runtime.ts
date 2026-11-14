import { AccountStatsStore } from "./accounts/stats.js";
import { templateForAccount } from "../shared/studio.js";
import { TemplatesRepo } from "./studio/templates.js";
import { ClipsRepo } from "./clips/repo.js";
import { type Config, loadConfig, openSettings } from "./config.js";
import { type Db, openDb } from "./db/index.js";
import { DEMO_JOB, demoClipsHandler } from "./dev/demo.js";
import { DEMO_DATA_JOB, demoDataHandler } from "./dev/demoData.js";
import { ENGINE_SETUP_JOB } from "./engine/engine.js";
import { engineSetupHandler } from "./engine/setup.js";
import { proxyMaker, videoReranker } from "./google/rerank.js";
import { THUMBS_JOB, thumbsHandler, ThumbsRepo } from "./google/thumbs.js";
import { Isolation } from "./isolation/isolation.js";
import { GrowthLab } from "./growth/lab.js";
import { GrowthRepo } from "./growth/repo.js";
import { HOOK_VARIANTS_JOB, HookLab } from "./hooklab/lab.js";
import { hookVariantsHandler, onHookVariantsFinished } from "./hooklab/render.js";
import { JobQueue } from "./jobs/queue.js";
import { liveCutter, liveOnFinished, LIVE_SEGMENT_JOB, liveSegmentHandler } from "./live/job.js";
import { LiveManager } from "./live/manager.js";
import { FakeNotifier, type Notifier, WebPushNotifier } from "./live/notify.js";
import { LiveRepo } from "./live/repo.js";
import { realSystem } from "./live/system.js";
import { ProofRepo } from "./liveproof/repo.js";
import { ProofRunner } from "./liveproof/service.js";
import { PicksRepo } from "./picks/repo.js";
import { pipelineOnFinished } from "./pipeline/chain.js";
import { INGEST_JOB, ingestHandler } from "./pipeline/ingest/ingest.js";
import { PICKS_JOB, picksHandler } from "./pipeline/picks/job.js";
import { RENDER_JOB, renderHandler } from "./pipeline/render/job.js";
import { onRenderFinished, RENDER_CLIP_JOB, renderClipHandler } from "./pipeline/rerender/render.js";
import { DirectPoster } from "./publish/direct/direct.js";
import { Publisher } from "./publish/publisher.js";
import { PostsRepo } from "./publish/repo.js";
import { PoliteFetcher } from "./scout/polite.js";
import { ScoutRepo } from "./scout/repo.js";
import { Scout } from "./scout/service.js";
import { INTEGRATIONS, isConfigured } from "./settings/integrations.js";
import { testIntegration } from "./settings/keyTests.js";
import type { Settings } from "./settings/store.js";
import { SourcesRepo } from "./sources/repo.js";
import { TrendRadar } from "./trends/radar.js";
import { VodsRepo } from "./vods/repo.js";
import { WatchlistRepo } from "./sources/watchlist/repo.js";

export interface Runtime {
  settings: Settings;
  config: Config;
  db: Db;
  /** Studio brand templates (their hashtags go into captions by account). */
  templates: TemplatesRepo;
  sources: SourcesRepo;
  vods: VodsRepo;
  picks: PicksRepo;
  clips: ClipsRepo;
  posts: PostsRepo;
  publisher: Publisher;
  isolation: Isolation;
  direct: DirectPoster;
  accountStats: AccountStatsStore;
  growth: GrowthLab;
  scout: Scout;
  queue: JobQueue;
  watchRepo: WatchlistRepo;
  radar: TrendRadar;
  hookLab: HookLab;
  liveRepo: LiveRepo;
  notifier: Notifier;
  thumbs: ThumbsRepo;
  /** Live mode. The server starts it; clipfarm-ops only uses it for a launch drill. */
  live: LiveManager;
  proof: ProofRunner;
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
  posts.submitDefaults = config.submitHours;
  const thumbs = new ThumbsRepo(db);
  const isolation = new Isolation({ db, settings, transport: config.direct.transport, ipEchoUrl: config.direct.endpoints.ipEcho, publicUrl: config.publicUrl });
  const templates = new TemplatesRepo(db);
  const publisher = new Publisher({
    sources,
    clips,
    posts,
    brandTags: (accountId) => templateForAccount(templates.list(), accountId)?.hashtags ?? [],
    service: config.postingService,
    isolation,
    submitWindow: true,
    vodTitle: (id) => vods.get(id).title,
    campaignLimit: (permission, clipId) => scout.postBlock(permission, clipId),
  });
  const direct = new DirectPoster({ isolation, accounts: publisher.accounts, posts, clips, sources, settings, endpoints: config.direct.endpoints });
  publisher.useDirect(direct);
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
  const scout: Scout = new Scout({
    repo: new ScoutRepo(db),
    sources,
    posts,
    accounts: () => publisher.accounts.list(),
    fetcher: new PoliteFetcher(config.scout.fetcher, { gapMs: config.scout.gapMs }),
    startUrls: config.scout.startUrls,
    notifier,
    watched: () => watchRepo.list().map((c) => c.name),
    // Only while the radar's reading is fresh (boost() is null otherwise).
    trending: () => (radar.boost() ? radar.videos().map((v) => v.streamer ?? v.channel) : []),
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
  const live = new LiveManager({
    repo: liveRepo,
    watchlist: watchRepo,
    sources,
    vods,
    queue,
    capturer: config.live.capturer,
    system: realSystem,
    notifier,
    mediaDir,
    segmentSec: config.live.segmentSec,
    overlapSec: config.live.overlapSec,
    keepHours: config.live.keepHours,
    maxStreams: config.live.maxStreams,
  });
  const proof = new ProofRunner({
    db,
    repo: new ProofRepo(db),
    sources,
    vods,
    picks,
    clips,
    queue,
    watchlist: watchRepo,
    live,
    liveRepo,
    clients: config.watchClients,
    notifier,
    testKeys: async () => {
      const checks = [];
      for (const def of INTEGRATIONS.filter((d) => isConfigured(settings, d.id))) {
        const result = await testIntegration(def.id, settings, config.fakes);
        // A service's refusal can repeat the key: it is taken out before anything is stored.
        checks.push({ label: def.label, ok: result.ok, message: settings.scrub(result.message) });
      }
      return checks;
    },
    engineReports: (vodId) => config.engine.reportsFor(vodId),
    campaignChannel: config.proof.campaignChannel,
    maxPicks: config.maxPicks,
    capPicks: config.proof.maxPicks,
    maxVodHours: config.proof.maxVodHours,
    dailyHour: config.proof.dailyHour,
    computeUsdPerHour: config.computeUsdPerHour,
    demo: config.fakes,
    pollMs: opts.pollMs,
  });
  return {
    settings,
    config,
    db,
    templates,
    sources,
    vods,
    picks,
    clips,
    posts,
    publisher,
    isolation,
    direct,
    accountStats,
    growth,
    scout,
    queue,
    watchRepo,
    radar,
    hookLab,
    liveRepo,
    notifier,
    thumbs,
    live,
    proof,
  };
}
