import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { clientBuildProblem, createApp } from "./app.js";
import { demoClipSeeder } from "./dev/seed.js";
import { ENGINE_SETUP_JOB } from "./engine/engine.js";
import { openRuntime } from "./runtime.js";
import { WatchlistPoller } from "./sources/watchlist/poller.js";
import seed from "./sources/watchlist/seed.json" with { type: "json" };

const { settings, config, db, sources, vods, picks, clips, posts, publisher, accountStats, queue, watchRepo, radar, hookLab } =
  openRuntime();
const mediaDir = config.mediaDir;

watchRepo.seedOnce(seed.creators);
const poller = new WatchlistPoller({ repo: watchRepo, sources, vods, queue, clients: config.watchClients });
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
  engine: { engine: config.engine, fake: config.fakeEngine },
  settings: { store: settings, demo: config.fakes },
  trends: radar,
  hookLab,
  seedDemoClip,
  clientDir,
  access: config.access ?? undefined,
});

queue.start();
// Zero-touch: when the local engine is the one in use and something is missing, fetch it now.
if (!config.fakeEngine && !config.engine.settings().cloud && config.engine.missing().length > 0) {
  const waiting = queue.list(200).some((j) => j.type === ENGINE_SETUP_JOB && (j.status === "queued" || j.status === "running"));
  if (!waiting) queue.enqueue(ENGINE_SETUP_JOB, {});
}
// Post links and views, read on a timer within the service's API limits.
// Account stats follow their own, longer interval (the guard skips them until due).
// The same timer runs the daily trend refresh (when due) and one pass of the hook lab (when on).
const background = () => {
  void radar.refreshIfDue();
  void hookLab.tick().catch((err: Error) => console.error(`[hook lab] ${err.message}`));
};
const refreshTimer = setInterval(() => {
  void publisher.refresh().then(() => accountStats.refresh());
  background();
}, config.postingRefreshMinutes * 60_000);
refreshTimer.unref();
poller.start(config.watchPollMinutes * 60_000);
background();
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
  server.close(() => {
    void queue.idle().then(() => {
      db.close();
      process.exit(0);
    });
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
