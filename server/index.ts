import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AccountStatsStore } from "./accounts/stats.js";
import { clientBuildProblem, createApp } from "./app.js";
import { ClipsRepo } from "./clips/repo.js";
import { loadConfig, openSettings } from "./config.js";
import { openDb } from "./db/index.js";
import { ENGINE_SETUP_JOB } from "./engine/engine.js";
import { engineSetupHandler } from "./engine/setup.js";
import { DEMO_JOB, demoClipsHandler } from "./dev/demo.js";
import { DEMO_DATA_JOB, demoDataHandler } from "./dev/demoData.js";
import { demoClipSeeder } from "./dev/seed.js";
import { JobQueue } from "./jobs/queue.js";
import { liveCutter, liveOnFinished, LIVE_SEGMENT_JOB, liveSegmentHandler } from "./live/job.js";
import { LiveManager } from "./live/manager.js";
import { FakeNotifier, WebPushNotifier } from "./live/notify.js";
import { LiveRepo } from "./live/repo.js";
import { realSystem } from "./live/system.js";
import { PicksRepo } from "./picks/repo.js";
import { pipelineOnFinished } from "./pipeline/chain.js";
import { INGEST_JOB, ingestHandler } from "./pipeline/ingest/ingest.js";
import { PICKS_JOB, picksHandler } from "./pipeline/picks/job.js";
import { RENDER_JOB, renderHandler } from "./pipeline/render/job.js";
import { onRenderFinished, RENDER_CLIP_JOB, renderClipHandler } from "./pipeline/rerender/render.js";
import { Publisher } from "./publish/publisher.js";
import { PostsRepo } from "./publish/repo.js";
import { SourcesRepo } from "./sources/repo.js";
import { WatchlistPoller } from "./sources/watchlist/poller.js";
import { WatchlistRepo } from "./sources/watchlist/repo.js";
import seed from "./sources/watchlist/seed.json" with { type: "json" };
import { VodsRepo } from "./vods/repo.js";

const settings = openSettings();
const config = loadConfig(process.env, settings);
const db = openDb(config.dbFile);
config.engine.bind(db);
const sources = new SourcesRepo(db);
const vods = new VodsRepo(db);
const picks = new PicksRepo(db);
const clips = new ClipsRepo(db);
const posts = new PostsRepo(db);
const publisher = new Publisher({ sources, clips, posts, service: config.postingService, vodTitle: (id) => vods.get(id).title });
const accountStats = new AccountStatsStore(db, config.postingService, posts, { accounts: publisher.accounts });
const mediaDir = config.mediaDir;
const pipelineFinished = pipelineOnFinished({ vods, picks, queue: () => queue });
const clipRenderFinished = onRenderFinished(clips);
const liveRepo = new LiveRepo(db, config.live.launchAt);
// Demo mode never reaches a push service.
const notifier = config.fakes ? new FakeNotifier() : new WebPushNotifier(liveRepo, config.live.pushSubject);
const liveFinished = liveOnFinished({ repo: liveRepo, picks, sources, notifier });
const queue: JobQueue = new JobQueue(db, {
  handlers: {
    [INGEST_JOB]: ingestHandler({ sources, vods, downloader: config.downloader, transcriber: config.transcriber }),
    [PICKS_JOB]: picksHandler({ sources, vods, picks, picker: config.picker, maxPicks: config.maxPicks }),
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
    [ENGINE_SETUP_JOB]: engineSetupHandler(config.engine),
    [DEMO_JOB]: demoClipsHandler({ sources, clips, mediaDir }),
    [DEMO_DATA_JOB]: demoDataHandler({ db, sources, clips, vods, accountStats, mediaDir }),
  },
  onFinished: (job, payload) => {
    pipelineFinished(job, payload);
    clipRenderFinished(job);
    liveFinished(job, payload);
  },
});

const watchRepo = new WatchlistRepo(db, sources);
watchRepo.seedOnce(seed.creators);
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
const lookLive = () => void live.sync().catch((err: unknown) => console.error("Live mode check failed:", err));
const poller = new WatchlistPoller({ repo: watchRepo, sources, vods, queue, clients: config.watchClients, onPolled: lookLive });
// A key saved in Settings is tried at once, not after the next wait.
settings.onChange(() => {
  poller.retryNow();
  // The posting service may have just changed: read its accounts now, not at the next restart.
  publisher.syncAccounts().catch(() => undefined);
});

// Built layout: dist/server/index.js next to dist/client/. In dev (tsx), Vite serves the client.
const here = fileURLToPath(import.meta.url);
const clientDir = here.endsWith(".js") ? join(dirname(here), "..", "client") : undefined;
const clientProblem = clientDir ? clientBuildProblem(clientDir) : null;
if (clientProblem) console.error(`ERROR: ${clientProblem}`);
const seedDemoClip =
  config.fakes ? demoClipSeeder({ sources, clips, mediaDir }) : undefined;
const app = createApp({
  sources,
  vods,
  picks,
  queue,
  clips,
  posts,
  publisher,
  accountStats,
  watchlist: { repo: watchRepo, poller },
  live: { manager: live, repo: liveRepo },
  engine: { engine: config.engine, fake: config.fakeEngine },
  settings: { store: settings, demo: config.fakes },
  seedDemoClip,
  clientDir,
  requireAccess: config.requireAccess,
});

queue.start();
// Zero-touch: when the local engine is the one in use and something is missing, fetch it now.
if (!config.fakeEngine && !config.engine.settings().cloud && config.engine.missing().length > 0) {
  const waiting = queue.list(200).some((j) => j.type === ENGINE_SETUP_JOB && (j.status === "queued" || j.status === "running"));
  if (!waiting) queue.enqueue(ENGINE_SETUP_JOB, {});
}
// Post links and views, read on a timer within the service's API limits.
// Account stats follow their own, longer interval (the guard skips them until due).
const refreshTimer = setInterval(() => {
  void publisher.refresh().then(() => accountStats.refresh());
}, config.postingRefreshMinutes * 60_000);
refreshTimer.unref();
poller.start(config.watchPollMinutes * 60_000);
void live.start();
const server = app.listen({ port: config.port, host: config.host }, () => {
  console.log(
    `clipfarm on http://${config.host ?? "localhost"}:${config.port} (access gate: ${config.requireAccess ? "on" : "off"}, downloader: ${config.downloader.name}, transcriber: ${config.transcriber.name}, picker: ${config.picker.name}, posting: ${config.postingService.name})`,
  );
});

function shutdown() {
  // A running job is aborted and put back in the queue for the next start.
  queue.stop();
  clearInterval(refreshTimer);
  poller.stop();
  live.stop();
  server.close(() => {
    void Promise.all([queue.idle(), live.settled()]).then(() => {
      db.close();
      process.exit(0);
    });
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
