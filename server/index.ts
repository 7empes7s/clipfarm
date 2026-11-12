import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { ClipsRepo } from "./clips/repo.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";
import { DEMO_JOB, demoClipsHandler } from "./dev/demo.js";
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
import { SourcesRepo } from "./sources/repo.js";
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
  },
  onFinished: (job, payload) => {
    pipelineFinished(job, payload);
    clipRenderFinished(job);
  },
});

const watchRepo = new WatchlistRepo(db, sources);
watchRepo.seedOnce(seed.creators);
const poller = new WatchlistPoller({ repo: watchRepo, sources, vods, queue, clients: config.watchClients });

// Built layout: dist/server/index.js next to dist/client/. In dev (tsx), Vite serves the client.
const here = fileURLToPath(import.meta.url);
const clientDir = here.endsWith(".js") ? join(dirname(here), "..", "client") : undefined;
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
  watchlist: { repo: watchRepo, poller },
  seedDemoClip,
  clientDir,
});

queue.start();
// Post links and views, read on a timer within the service's API limits.
const refreshTimer = setInterval(() => void publisher.refresh(), config.postingRefreshMinutes * 60_000);
refreshTimer.unref();
poller.start(config.watchPollMinutes * 60_000);
const server = app.listen(config.port, () => {
  console.log(
    `clipfarm on http://localhost:${config.port} (downloader: ${config.downloader.name}, transcriber: ${config.transcriber.name}, picker: ${config.picker.name}, posting: ${config.postingService.name})`,
  );
});

function shutdown() {
  // A running job is aborted and put back in the queue for the next start.
  queue.stop();
  clearInterval(refreshTimer);
  poller.stop();
  server.close(() => {
    void queue.idle().then(() => {
      db.close();
      process.exit(0);
    });
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
