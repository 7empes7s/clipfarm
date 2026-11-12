import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";
import { JobQueue } from "./jobs/queue.js";
import { PicksRepo } from "./picks/repo.js";
import { pipelineOnFinished } from "./pipeline/chain.js";
import { INGEST_JOB, ingestHandler } from "./pipeline/ingest/ingest.js";
import { PICKS_JOB, picksHandler } from "./pipeline/picks/job.js";
import { RENDER_JOB, renderHandler } from "./pipeline/render/job.js";
import { SourcesRepo } from "./sources/repo.js";
import { VodsRepo } from "./vods/repo.js";

const config = loadConfig();
const db = openDb(config.dbFile);
const sources = new SourcesRepo(db);
const vods = new VodsRepo(db);
const picks = new PicksRepo(db);
const queue: JobQueue = new JobQueue(db, {
  handlers: {
    [INGEST_JOB]: ingestHandler({ sources, vods, downloader: config.downloader, transcriber: config.transcriber }),
    [PICKS_JOB]: picksHandler({ sources, vods, picks, picker: config.picker, maxPicks: config.maxPicks }),
    [RENDER_JOB]: renderHandler({
      sources,
      vods,
      picks,
      downloader: config.sectionDownloader,
      mediaDir: config.mediaDir,
      preset: config.renderPreset,
    }),
  },
  onFinished: pipelineOnFinished({ vods, picks, queue: () => queue }),
});

// Built layout: dist/server/index.js next to dist/client/. In dev (tsx), Vite serves the client.
const here = fileURLToPath(import.meta.url);
const clientDir = here.endsWith(".js") ? join(dirname(here), "..", "client") : undefined;
const app = createApp({ sources, vods, picks, queue, clientDir });

queue.start();
const server = app.listen(config.port, () => {
  console.log(
    `clipfarm on http://localhost:${config.port} (downloader: ${config.downloader.name}, transcriber: ${config.transcriber.name}, picker: ${config.picker.name})`,
  );
});

function shutdown() {
  // A running job is aborted and put back in the queue for the next start.
  queue.stop();
  server.close(() => {
    void queue.idle().then(() => {
      db.close();
      process.exit(0);
    });
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
