import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { clientBuildProblem, createApp } from "./app.js";
import { demoClipSeeder } from "./dev/seed.js";
import { ENGINE_SETUP_JOB } from "./engine/engine.js";
import { SubmitWatch } from "./publish/submitWatch.js";
import { openRuntime } from "./runtime.js";
import { fakeFeedFetcher, httpFeedFetcher } from "./creator/links.js";
import { Creator } from "./creator/service.js";
import { Campaigns } from "./sources/campaign/service.js";
import { AllowanceChecker, FakeProofFetcher } from "./sources/proof.js";
import allowanceSeed from "./sources/seed/public-allowance.json" with { type: "json" };
import { parseSuggested } from "./sources/suggested.js";
import { WatchlistPoller } from "./sources/watchlist/poller.js";
import seed from "./sources/watchlist/seed.json" with { type: "json" };
import streamerSeed from "./catalog/seed/streamers.json" with { type: "json" };
import { parseSeedStreamers, RegistryRepo } from "./catalog/registry.js";

const {
  settings,
  config,
  db,
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
  autopilot,
  workspaces,
  uploads,
  outputs,
} = openRuntime();
const mediaDir = config.mediaDir;

watchRepo.seedOnce(seed.creators);
const suggested = parseSuggested(allowanceSeed.creators);
// With fakes on, the starter list's proof pages say what the list quotes (no network).
if (config.proofFetcher instanceof FakeProofFetcher) {
  for (const c of suggested) config.proofFetcher.set(c.proofUrl, { status: 200, text: `<p>${c.proofQuote}</p>` });
}
const streamers = parseSeedStreamers(streamerSeed.streamers);
new RegistryRepo(db).seed(streamers);
// With fakes on, the registry's proof pages answer with what the list quotes (no network).
if (config.proofFetcher instanceof FakeProofFetcher) {
  for (const s of streamers) if (s.proofUrl) config.proofFetcher.set(s.proofUrl, { status: 200, text: `<p>${s.proofQuote ?? s.program ?? s.name}</p>` });
}
const allowance = new AllowanceChecker({ sources, fetcher: config.proofFetcher });
const campaigns = new Campaigns({ sources, fetcher: config.campaignFetcher, chat: config.campaignChat });
const lookLive = () => void live.sync().catch((err: unknown) => console.error("Live mode check failed:", err));
let creator: Creator | null = null;
const onPolled = () => {
  lookLive();
  // Podcast feeds of your own shows are read with every watchlist check.
  void creator?.checkFeeds().catch((err: unknown) => console.error("Feed check failed:", err));
};
const poller = new WatchlistPoller({ repo: watchRepo, sources, vods, queue, clients: config.watchClients, onPolled });
creator = new Creator({
  sources,
  vods,
  queue,
  uploads,
  readFeed: config.fakes ? fakeFeedFetcher : httpFeedFetcher,
  watchlist: watchRepo,
  pollCreator: (id) => void poller.pollCreator(id).catch((err: unknown) => console.error("Watchlist check failed:", err)),
});
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
if (!config.supportEmail) {
  console.error("ERROR: SUPPORT_EMAIL is not set (or is not an email address): /home, /privacy and /terms answer 503 until it is.");
}
const seedDemoClip =
  config.fakes ? demoClipSeeder({ sources, clips, mediaDir }) : undefined;
const app = createApp({
  sources,
  autopilot,
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
  proof,
  engine: { engine: config.engine, fake: config.fakeEngine },
  google: { ai: config.google, thumbs, auto: !config.fakes },
  settings: { store: settings, demo: config.fakes },
  isolation: { isolation, direct, demo: config.fakes },
  trends: radar,
  hookLab,
  growth,
  scout,
  registry,
  seedDemoClip,
  clientDir,
  deployStatusFile: join(dirname(config.dbFile), "deploy-status.json"),
  supportEmail: config.supportEmail,
  access: config.access ?? undefined,
  workspaces,
  creator: { service: creator, uploads, outputs },
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
  void publisher
    .refresh()
    .then(() => growth.collectPlatformStats())
    .then(() => accountStats.refresh());
  background();
}, config.postingRefreshMinutes * 60_000);
refreshTimer.unref();
// Posts clipfarm uploads itself go out when they are due; every proxy is tested again once a day.
// The same round runs the submit window: held campaign posts go out, "submit within 30 min" is pushed
// when a post is live and again at 20 minutes, and the window is marked missed at 30.
const submitWatch = new SubmitWatch({ posts, publisher, notifier, sendDirect: () => direct.runDue() });
const directTimer = setInterval(() => void submitWatch.tick().catch((err: unknown) => console.error(`[submit window] ${(err as Error).message}`)), 60_000);
directTimer.unref();
// Autopilot rules that are on: matching clips go to their accounts at the next best slot (or, in dry run, are only noted).
const autopilotTimer = setInterval(() => void autopilot.tick().catch((err: unknown) => console.error(`[autopilot] ${(err as Error).message}`)), 5 * 60_000);
autopilotTimer.unref();
const proxyTimer = setInterval(() => void isolation.recheckStale(), 3600_000);
proxyTimer.unref();
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
background();
void live.start();
// The daily proof (06:00 on the server's clock) and any proof or drill asked for in the app or by clipfarm-ops.
proof.start();
// Looks every 6 hours for public allowances whose proof was last read a week or more ago.
allowance.start(6 * 3600_000);
// Looks every hour for running campaigns whose page was last read a day or more ago.
campaigns.start(3600_000);
// Looks every hour whether the daily campaign scout is due. Public pages only, one every five seconds.
scout.start(3600_000);
// The streamer registry: each entry is checked again every 7 days; the timer only looks for due ones.
registry.start(6 * 3600_000);
const server = app.listen({ port: config.port, host: config.host }, () => {
  console.log(
    `clipfarm on http://${config.host ?? "localhost"}:${config.port} (access gate: ${config.requireAccess ? "on" : "off"}, downloader: ${config.downloader.name}, transcriber: ${config.transcriber.name}, picker: ${config.picker.name}, posting: ${config.postingService.name})`,
  );
});

function shutdown() {
  // A running job is aborted and put back in the queue for the next start.
  queue.stop();
  clearInterval(refreshTimer);
  clearInterval(directTimer);
  clearInterval(proxyTimer);
  clearInterval(growthTimer);
  poller.stop();
  live.stop();
  proof.stop();
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
