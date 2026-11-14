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
import { BusinessRepo } from "./business/repo.js";
import { BusinessService } from "./business/service.js";
import { GrowthLab } from "./growth/lab.js";
import { GrowthRepo } from "./growth/repo.js";
import { HOOK_VARIANTS_JOB, HookLab } from "./hooklab/lab.js";
import { hookVariantsHandler, onHookVariantsFinished } from "./hooklab/render.js";
import { type JobHandler, JobQueue } from "./jobs/queue.js";
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
import { AutopilotRepo } from "./publish/autopilotRepo.js";
import { Autopilot } from "./publish/autopilotService.js";
import { Publisher } from "./publish/publisher.js";
import { VersionsRepo } from "./publish/versionsRepo.js";
import { PostsRepo } from "./publish/repo.js";
import { PoliteFetcher } from "./scout/polite.js";
import { ScoutRepo } from "./scout/repo.js";
import { Scout } from "./scout/service.js";
import { RegistryRepo, StreamerRegistry } from "./catalog/registry.js";
import { INTEGRATIONS, isConfigured } from "./settings/integrations.js";
import { testIntegration } from "./settings/keyTests.js";
import type { Settings } from "./settings/store.js";
import { SourcesRepo } from "./sources/repo.js";
import { OpsState } from "./ops/state.js";
import { TrendRadar } from "./trends/radar.js";
import { VodsRepo } from "./vods/repo.js";
import { WatchlistRepo } from "./sources/watchlist/repo.js";
import { join } from "node:path";
import { CreatorSectionDownloader, UploadAudioDownloader } from "./creator/media.js";
import { isAudioUrl } from "./creator/links.js";
import { OutputsRepo } from "./creator/outputs.js";
import { isOwnContent } from "./creator/service.js";
import { uploadIdOf, UploadsRepo } from "./creator/uploads.js";
import { FORMATS_JOB, formatsHandler } from "./pipeline/formats/job.js";
import { WorkspacesRepo } from "./workspaces/repo.js";
import { ClientService } from "./service/service.js";
import { FakeStripe, HttpStripe, type StripeApi } from "./service/stripe.js";

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
  autopilot: Autopilot;
  isolation: Isolation;
  direct: DirectPoster;
  accountStats: AccountStatsStore;
  growth: GrowthLab;
  business: BusinessService;
  scout: Scout;
  /** The streamer registry: who pays for or allows clipping, re-checked weekly. */
  registry: StreamerRegistry;
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
  workspaces: WorkspacesRepo;
  uploads: UploadsRepo;
  outputs: OutputsRepo;
  /** Clipping as a service: clients, plans, billing. */
  clientService: ClientService;
  stripe: StripeApi;
  /** Operations' switches (worker and publishing paused) and its Activity list. */
  opsState: OpsState;
}

/**
 * The database, the keys and the job queue with every pipeline step, built from the environment.
 * The server and the ops CLI both start from this, so a job means the same thing in either.
 */
export function openRuntime(env: NodeJS.ProcessEnv = process.env, opts: { pollMs?: number } = {}): Runtime {
  const settings = openSettings(env);
  const config = loadConfig(env, settings);
  const db = openDb(config.dbFile);
  const opsState = new OpsState(db);
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
    holdLater: true,
    versions: new VersionsRepo(db),
    covers: (clipId) => thumbs.listForClip(clipId).map((t) => ({ id: t.id, label: t.label, url: `/api/thumbnails/${t.id}/cover` })),
    vodTitle: (id) => vods.get(id).title,
    campaignLimit: (permission, clipId) => scout.postBlock(permission, clipId),
    aiMade: (clipId) => (thumbs.listForClip(clipId).some((t) => t.chosen && t.ai) ? ["the chosen thumbnail"] : []),
  });
  const direct = new DirectPoster({
    isolation,
    accounts: publisher.accounts,
    posts,
    clips,
    sources,
    settings,
    endpoints: config.direct.endpoints,
    assignWorkspace: (accountId, workspaceId) => workspaces.assignAccount(accountId, workspaceId),
  });
  publisher.useDirect(direct);
  const autopilot = new Autopilot({ repo: new AutopilotRepo(db), publisher, clips, sources, paused: () => opsState.isOn("publishing_paused") });
  const accountStats = new AccountStatsStore(db, config.postingService, posts, { accounts: publisher.accounts });
  const mediaDir = config.mediaDir;
  const workspaces = new WorkspacesRepo(db);
  const uploads = new UploadsRepo(db, join(mediaDir, "uploads"));
  const outputs = new OutputsRepo(db);
  // Demo mode and tests never reach Stripe.
  const stripe: StripeApi = config.fakes ? new FakeStripe() : new HttpStripe(() => settings.get("STRIPE_SECRET_KEY"));
  const clientService = new ClientService({ db, workspaces, sources, vods, clips, stripe });
  const brandOf = (sourceId: number) => workspaces.get(sources.get(sourceId).workspaceId).brand;
  // Uploaded files are read where they lie; sound-only sections become waveform videos (audiograms).
  const downloader = new UploadAudioDownloader(config.downloader, uploads);
  const sectionDownloader = new CreatorSectionDownloader(config.sectionDownloader, uploads, (url) => {
    const vod = vods.list().find((v) => v.url === url);
    return vod ? brandOf(vod.sourceId).color : workspaces.get(1).brand.color;
  });
  const audioOnly = (url: string) => {
    const id = uploadIdOf(url);
    return isAudioUrl(id === null ? url : uploads.get(id).fileName);
  };
  const watchRepo = new WatchlistRepo(db, sources);
  const radar = new TrendRadar({ db, source: config.trendSource, chat: config.aiChat, watchlist: () => watchRepo.list() });
  const pipelineFinished = pipelineOnFinished({
    vods,
    picks,
    queue: () => queue,
    creatorMode: (vodId) => isOwnContent(sources.get(vods.get(vodId).sourceId), new Date()),
  });
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
    digestLines: () => business.digestLines(),
  });
  const business: BusinessService = new BusinessService({
    repo: new BusinessRepo(db),
    clips,
    posts,
    sources,
    // The queue is made further down (its jobs need the growth lab).
    jobs: () => queue.list(500),
    publisher,
    isolation,
    growth,
    eurPerUsd: config.google.eurPerUsd,
    computeUsdPerHour: config.computeUsdPerHour,
    demo: config.fakes,
    workspaceNames: () => new Map(workspaces.list().map((w) => [w.id, w.name])),
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
  const registry = new StreamerRegistry({
    repo: new RegistryRepo(db),
    sources,
    fetcher: new PoliteFetcher(config.proofFetcher, { gapMs: config.scout.gapMs }),
    campaignsFor: (name) => {
      const n = name.trim().toLowerCase();
      return scout.repo
        .list()
        .filter((r) => !r.facts.ended && r.facts.creatorName?.trim().toLowerCase() === n)
        .map((r) => r.url);
    },
  });
  const liveFinished = liveOnFinished({ repo: liveRepo, picks, sources, notifier });
  const queue: JobQueue = new JobQueue(db, {
    handlers: {
      [INGEST_JOB]: clientGate(clientService, ingestHandler({ sources, vods, downloader, transcriber: config.transcriber, chat: config.chatSource })),
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
        downloader: sectionDownloader,
        liveCut: liveCutter(liveRepo, config.renderPreset),
        mediaDir,
        preset: config.renderPreset,
        accuracy: { transcriber: config.accurateTranscriber, chat: config.aiChat },
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
      [FORMATS_JOB]: formatsHandler({ sources, vods, picks, outputs, downloader: sectionDownloader, audioOnly, brand: brandOf, mediaDir, preset: config.renderPreset }),
      [THUMBS_JOB]: thumbsHandler({ clips, thumbs, google: config.google, mediaDir, aiAllowed: (id) => sources.get(id).aiAllowed }),
      [HOOK_VARIANTS_JOB]: hookVariantsHandler({ lab: hookLab, clips, sources, mediaDir }),
      [ENGINE_SETUP_JOB]: engineSetupHandler(config.engine),
      [DEMO_JOB]: demoClipsHandler({ sources, clips, mediaDir }),
      [DEMO_DATA_JOB]: demoDataHandler({ db, sources, clips, vods, accountStats, mediaDir, onSeeded: () => growth.proposeChanges() }),
    },
    onFinished: (job, payload) => {
      pipelineFinished(job, payload);
      clipRenderFinished(job);
      // A client who switched on auto-approve gets new clips approved as soon as they are cut.
      if (job.type === RENDER_JOB && job.status === "done") clientService.autoApprove();
      hookVariantsFinished(job, payload);
      liveFinished(job, payload);
    },
    pollMs: opts.pollMs,
    paused: () => opsState.isOn("worker_paused"),
  });
  const live = new LiveManager({
    repo: liveRepo,
    watchlist: watchRepo,
    sources,
    vods,
    queue,
    capturer: config.live.capturer,
    chatTap: config.live.chatTap,
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
    autopilot,
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
    business,
    scout,
    registry,
    queue,
    watchRepo,
    radar,
    hookLab,
    liveRepo,
    notifier,
    thumbs,
    live,
    proof,
    workspaces,
    uploads,
    outputs,
    clientService,
    stripe,
    opsState,
  };
}

/** A client's video starts only while the plan has minutes and clips left; otherwise the job fails and says why. */
function clientGate(service: ClientService, handler: JobHandler): JobHandler {
  return async (ctx) => {
    if (ctx.job.vodId !== null) service.assertVodAllowed(ctx.job.vodId);
    await handler(ctx);
  };
}
