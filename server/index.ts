import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AccountStatsStore } from "./accounts/stats.js";
import { clientBuildProblem, createApp } from "./app.js";
import { ClipsRepo } from "./clips/repo.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";
import { DEMO_JOB, demoClipsHandler } from "./dev/demo.js";
import { DEMO_DATA_JOB, demoDataHandler } from "./dev/demoData.js";
import { demoClipSeeder } from "./dev/seed.js";
import { JobQueue } from "./jobs/queue.js";
import { PicksRepo } from "./picks/repo.js";
import { pipelineOnFinished } from "./pipeline/chain.js";
import { INGEST_JOB, ingestHandler } from "./pipeline/ingest/ingest.js";
import { PICKS_JOB, picksHandler } from "./pipeline/picks/job.js";
import { RENDER_JOB, renderHandler } from "./pipeline/render/job.js";
import { onRenderFinished, RENDER_CLIP_JOB, renderClipHandler } from "./pipeline/rerender/render.js";
import { Publisher } from "./publish/publisher.js";
import { PostsRepo } from "./publish/repo.js";
import { AllowanceChecker, FakeProofFetcher } from "./sources/proof.js";
import { SourcesRepo } from "./sources/repo.js";
import allowanceSeed from "./sources/seed/public-allowance.json" with { type: "json" };
import { parseSuggested } from "./sources/suggested.js";
import { WatchlistPoller } from "./sources/watchlist/poller.js";
import { WatchlistRepo } from "./sources/watchlist/repo.js";
import seed from "./sources/watchlist/seed.json" with { type: "json" };
import { VodsRepo } from "./vods/repo.js";

const config = loadConfig();
const db = openDb(config.dbFile);
const sources = new SourcesRepo(db);
const vods = new VodsRepo(db);
const picks = new PicksRepo(db);
const clips = new ClipsRepo(db);
const posts = new PostsRepo(db);
const publisher = new Publisher({ sources, clips, posts, service: config.postingService });
const accountStats = new AccountStatsStore(db, config.postingService, posts);
const mediaDir = config.mediaDir;
const pipelineFinished = pipelineOnFinished({ vods, picks, queue: () => queue });
const clipRenderFinished = onRenderFinished(clips);
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
      mediaDir,
      preset: config.renderPreset,
    }),
    [RENDER_CLIP_JOB]: renderClipHandler({ clips, sources, mediaDir }),
    [DEMO_JOB]: demoClipsHandler({ sources, clips, mediaDir }),
    [DEMO_DATA_JOB]: demoDataHandler({ db, sources, clips, vods, accountStats, mediaDir }),
  },
  onFinished: (job, payload) => {
    pipelineFinished(job, payload);
    clipRenderFinished(job);
  },
});

const watchRepo = new WatchlistRepo(db, sources);
watchRepo.seedOnce(seed.creators);
const suggested = parseSuggested(allowanceSeed.creators);
// With fakes on, the starter list's proof pages say what the list quotes (no network).
if (config.proofFetcher instanceof FakeProofFetcher) {
  for (const c of suggested) config.proofFetcher.set(c.proofUrl, { status: 200, text: `<p>${c.proofQuote}</p>` });
}
const allowance = new AllowanceChecker({ sources, fetcher: config.proofFetcher });
const poller = new WatchlistPoller({ repo: watchRepo, sources, vods, queue, clients: config.watchClients });

// Built layout: dist/server/index.js next to dist/client/. In dev (tsx), Vite serves the client.
const here = fileURLToPath(import.meta.url);
const clientDir = here.endsWith(".js") ? join(dirname(here), "..", "client") : undefined;
const clientProblem = clientDir ? clientBuildProblem(clientDir) : null;
if (clientProblem) console.error(`ERROR: ${clientProblem}`);
const seedDemoClip =
  process.env.CLIPFARM_FAKES === "1" ? demoClipSeeder({ sources, clips, mediaDir }) : undefined;
const app = createApp({
  sources,
  vods,
  picks,
  queue,
  clips,
  posts,
  publisher,
  accountStats,
  allowance,
  suggested,
  watchlist: { repo: watchRepo, poller },
  seedDemoClip,
  clientDir,
  requireAccess: config.requireAccess,
});

queue.start();
// Post links and views, read on a timer within the service's API limits.
// Account stats follow their own, longer interval (the guard skips them until due).
const refreshTimer = setInterval(() => {
  void publisher.refresh().then(() => accountStats.refresh());
}, config.postingRefreshMinutes * 60_000);
refreshTimer.unref();
poller.start(config.watchPollMinutes * 60_000);
// Looks every 6 hours for public allowances whose proof was last read a week or more ago.
allowance.start(6 * 3600_000);
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
  allowance.stop();
  server.close(() => {
    void queue.idle().then(() => {
      db.close();
      process.exit(0);
    });
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
