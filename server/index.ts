import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { clientBuildProblem, createApp } from "./app.js";
import { demoClipSeeder } from "./dev/seed.js";
import { ENGINE_SETUP_JOB } from "./engine/engine.js";
import { openRuntime } from "./runtime.js";
import { Campaigns } from "./sources/campaign/service.js";
import { AllowanceChecker, FakeProofFetcher } from "./sources/proof.js";
import allowanceSeed from "./sources/seed/public-allowance.json" with { type: "json" };
import { parseSuggested } from "./sources/suggested.js";
import { LiveManager } from "./live/manager.js";
import { realSystem } from "./live/system.js";
import { WatchlistPoller } from "./sources/watchlist/poller.js";
import { WatchlistRepo } from "./sources/watchlist/repo.js";
import seed from "./sources/watchlist/seed.json" with { type: "json" };

const { settings, config, db, sources, vods, picks, clips, posts, publisher, accountStats, growth, scout, queue, liveRepo, notifier } = openRuntime();
const mediaDir = config.mediaDir;

const watchRepo = new WatchlistRepo(db, sources);
watchRepo.seedOnce(seed.creators);
const suggested = parseSuggested(allowanceSeed.creators);
// With fakes on, the starter list's proof pages say what the list quotes (no network).
if (config.proofFetcher instanceof FakeProofFetcher) {
  for (const c of suggested) config.proofFetcher.set(c.proofUrl, { status: 200, text: `<p>${c.proofQuote}</p>` });
}
const allowance = new AllowanceChecker({ sources, fetcher: config.proofFetcher });
const campaigns = new Campaigns({ sources, fetcher: config.campaignFetcher, chat: config.campaignChat });
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
  allowance,
  campaigns,
  suggested,
  watchlist: { repo: watchRepo, poller },
  live: { manager: live, repo: liveRepo },
  engine: { engine: config.engine, fake: config.fakeEngine },
  settings: { store: settings, demo: config.fakes },
  growth,
  scout,
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
const refreshTimer = setInterval(() => {
  void publisher
    .refresh()
    .then(() => growth.collectPlatformStats())
    .then(() => accountStats.refresh());
}, config.postingRefreshMinutes * 60_000);
refreshTimer.unref();
// Test campaigns: schedule what is due in the next half hour, then the 09:00 digest. No AI, no ffmpeg.
const growthRound = () => {
  void growth
    .tick()
    .then(() => growth.sendDigest())
    .catch((err: unknown) => console.error(`[growth] ${(err as Error).message}`));
};
const growthTimer = setInterval(growthRound, 10 * 60_000);
growthTimer.unref();
growthRound();
poller.start(config.watchPollMinutes * 60_000);
void live.start();
// Looks every 6 hours for public allowances whose proof was last read a week or more ago.
allowance.start(6 * 3600_000);
// Looks every hour for running campaigns whose page was last read a day or more ago.
campaigns.start(3600_000);
// Looks every hour whether the daily campaign scout is due. Public pages only, one every five seconds.
scout.start(3600_000);
const server = app.listen({ port: config.port, host: config.host }, () => {
  console.log(
    `clipfarm on http://${config.host ?? "localhost"}:${config.port} (access gate: ${config.requireAccess ? "on" : "off"}, downloader: ${config.downloader.name}, transcriber: ${config.transcriber.name}, picker: ${config.picker.name}, posting: ${config.postingService.name})`,
  );
});

function shutdown() {
  // A running job is aborted and put back in the queue for the next start.
  queue.stop();
  clearInterval(refreshTimer);
  clearInterval(growthTimer);
  poller.stop();
  live.stop();
  allowance.stop();
  campaigns.stop();
  scout.stop();
  server.close(() => {
    void Promise.all([queue.idle(), live.settled()]).then(() => {
      db.close();
      process.exit(0);
    });
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
