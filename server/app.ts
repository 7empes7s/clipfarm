import express, { type ErrorRequestHandler } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Platform, RejectReason } from "../shared/types.js";
import { PLATFORMS, REJECT_REASONS } from "../shared/types.js";
import { accessGate } from "./access.js";
import { parseChannelSettings } from "./accounts/repo.js";
import type { AccountStatsStore } from "./accounts/stats.js";
import { parseClipEdit } from "./clips/edit.js";
import type { ClipsRepo } from "./clips/repo.js";
import { buildDashboard } from "./dashboard/build.js";
import { DEMO_JOB } from "./dev/demo.js";
import { assertNoDemoData, DEMO_DATA_JOB } from "./dev/demoData.js";
import type { JobQueue } from "./jobs/queue.js";
import { HttpError, NotFoundError, ValidationError } from "./errors.js";
import { INGEST_JOB } from "./pipeline/ingest/ingest.js";
import { RENDER_CLIP_JOB } from "./pipeline/rerender/render.js";
import { parseRules, type Publisher, slug } from "./publish/publisher.js";
import { buildChecklist } from "./settings/checklist.js";
import { configuredMap, integration, parseSettingsInput, settingsInfo } from "./settings/integrations.js";
import { testIntegration } from "./settings/keyTests.js";
import type { Settings } from "./settings/store.js";
import type { PostsRepo } from "./publish/repo.js";
import type { PicksRepo } from "./picks/repo.js";
import { parseFaceCam, parseNewSource, type SourcesRepo } from "./sources/repo.js";
import type { WatchlistPoller } from "./sources/watchlist/poller.js";
import { parseWatchedCreator, type WatchlistRepo } from "./sources/watchlist/repo.js";
import type { VodsRepo } from "./vods/repo.js";

export interface AppDeps {
  sources: SourcesRepo;
  vods: VodsRepo;
  picks: PicksRepo;
  queue: JobQueue;
  clips: ClipsRepo;
  posts: PostsRepo;
  publisher: Publisher;
  /** Account stats from the posting service, for the dashboard. */
  accountStats?: AccountStatsStore;
  /** Streamer watchlist and its live / new-VOD checks. */
  watchlist?: { repo: WatchlistRepo; poller: WatchlistPoller };
  /** Keys and connections pasted in the app. `demo`: outside services are stand-ins, so Test calls nothing. */
  settings?: { store: Settings; demo: boolean };
  /** Demo/e2e only (CLIPFARM_FAKES=1): adds a campaign and a pending clip from a generated sample. */
  seedDemoClip?: () => Promise<unknown>;
  /** Built client to serve (npm run preview). Omitted in dev, where Vite serves it. */
  clientDir?: string;
  /** Live box (CLIPFARM_REQUIRE_ACCESS=1): refuse requests that did not come through Cloudflare Access. */
  requireAccess?: boolean;
}

/** What is wrong with the built client at `clientDir`, in plain words, or null when it can be served. */
export function clientBuildProblem(clientDir: string): string | null {
  return existsSync(join(clientDir, "index.html"))
    ? null
    : `The clipfarm app is not built (${join(clientDir, "index.html")} is missing). Run "npm run build", then reload.`;
}

function idParam(raw: string | string[] | undefined): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError("Invalid id.");
  return id;
}

function sendMedia(res: express.Response, next: express.NextFunction, file: string | null): void {
  if (!file || !existsSync(file)) throw new NotFoundError("That file is not there (yet).");
  // Paths come from the server, never the request; they may sit under a dot-folder (e.g. ~/.cubefarm).
  // A player that stops a range request mid-way is not an error worth answering.
  res.sendFile(file, { dotfiles: "allow" }, (err) => err && !res.headersSent && next(err));
}

function platformParam(raw: unknown): Platform {
  if (!PLATFORMS.includes(raw as Platform)) throw new ValidationError("Pick a platform.");
  return raw as Platform;
}

export function createApp({
  sources,
  vods,
  picks,
  queue,
  clips,
  posts,
  publisher,
  accountStats,
  watchlist,
  settings,
  seedDemoClip,
  clientDir,
  requireAccess,
}: AppDeps): express.Express {
  const app = express();
  if (requireAccess) app.use(accessGate());
  app.use(express.json({ limit: "1mb" }));

  // Open to anyone (see access.ts), so about keys it says only yes or no per connection.
  app.get("/api/health", (_req, res) => {
    res.json(settings ? { ok: true, configured: configuredMap(settings.store) } : { ok: true });
  });

  app.get("/api/sources", (_req, res) => {
    res.json(sources.list());
  });

  app.post("/api/sources", (req, res) => {
    res.status(201).json(sources.create(parseNewSource(req.body)));
  });

  // Clears a source and everything made from it (the end-to-end test tidies up with this).
  app.delete("/api/sources/:id", (req, res) => {
    res.json({ removed: sources.remove(idParam(req.params.id)) });
  });

  app.put("/api/sources/:id/face-cam", (req, res) => {
    const id = idParam(req.params.id);
    res.json(sources.setFaceCam(id, req.body === null || req.body?.clear ? null : parseFaceCam(req.body)));
  });

  app.get("/api/vods/:id/picks", (req, res) => {
    const id = idParam(req.params.id);
    vods.get(id);
    res.json(picks.listForVod(id));
  });

  app.get("/api/picks", (_req, res) => {
    res.json(picks.list());
  });

  app.get("/api/picks/:id/video", (req, res, next) => {
    sendMedia(res, next, picks.files(idParam(req.params.id)).video);
  });

  app.get("/api/picks/:id/thumb", (req, res, next) => {
    sendMedia(res, next, picks.files(idParam(req.params.id)).thumb);
  });

  app.get("/api/vods", (_req, res) => {
    res.json(vods.list());
  });

  app.get("/api/vods/:id", (req, res) => {
    res.json(vods.detail(idParam(req.params.id)));
  });

  app.post("/api/vods", (req, res) => {
    const body = (req.body ?? {}) as { sourceId?: unknown; url?: unknown };
    const sourceId = idParam(String(body.sourceId));
    const url = typeof body.url === "string" ? body.url.trim() : "";
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      /* handled below */
    }
    if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
      throw new ValidationError("Paste a link to the stream or video (starting with https://).");
    }
    // Server-side gate: nothing is ingested without an active permission record.
    sources.assertCanUse(sourceId);
    const vod = vods.create(sourceId, parsed.toString());
    const job = queue.enqueue(INGEST_JOB, { vodId: vod.id }, { vodId: vod.id });
    res.status(201).json({ vod, job });
  });

  app.get("/api/jobs", (_req, res) => {
    res.json(queue.list());
  });

  app.post("/api/jobs/:id/cancel", (req, res) => {
    res.json(queue.cancel(idParam(req.params.id)));
  });

  app.post("/api/jobs/:id/retry", (req, res) => {
    const job = queue.retry(idParam(req.params.id));
    if (job.type === RENDER_CLIP_JOB && job.clipId !== null) clips.setStatus(job.clipId, "rendering");
    res.json(job);
  });

  app.get("/api/clips", (_req, res) => {
    res.json(clips.list());
  });

  app.post("/api/clips/undo", (_req, res) => {
    res.json(clips.undoLastReview());
  });

  app.post("/api/clips/:id/approve", (req, res) => {
    res.json(clips.review(idParam(req.params.id), "approve"));
  });

  app.post("/api/clips/:id/reject", (req, res) => {
    const reason = (req.body ?? {}).reason as unknown;
    if (reason !== undefined && reason !== null && !REJECT_REASONS.includes(reason as RejectReason)) {
      throw new ValidationError("Pick a reason: boring, spoiler, bad crop, bad captions or other.");
    }
    res.json(clips.review(idParam(req.params.id), "reject", (reason as RejectReason | undefined) ?? null));
  });

  app.post("/api/clips/:id/edit", (req, res) => {
    const clip = clips.get(idParam(req.params.id));
    const edit = parseClipEdit(req.body, clip, sources.get(clip.sourceId));
    const updated = clips.applyEdit(clip.id, edit);
    const job = queue.enqueue(RENDER_CLIP_JOB, { clipId: clip.id }, { clipId: clip.id, maxAttempts: 2 });
    res.status(202).json({ clip: updated, job });
  });

  // The data folder may sit under a dot folder (.e2e-data), which send() refuses by default.
  const sendOpts = { dotfiles: "allow" as const };

  app.get("/api/clips/:id/video", (req, res, next) => {
    const id = idParam(req.params.id);
    const file = clips.filePath(id);
    if (!existsSync(file)) throw new NotFoundError("The video file for this clip is missing on the server.");
    if (req.query.download) res.download(file, `${slug(clips.get(id).title)}.mp4`, sendOpts, (err) => err && next(err));
    else res.sendFile(file, sendOpts, (err) => err && next(err));
  });

  app.get("/api/clips/:id/master", (req, res, next) => {
    const file = clips.masterPath(idParam(req.params.id));
    if (!existsSync(file)) throw new NotFoundError("The source video for this clip is missing on the server.");
    res.sendFile(file, sendOpts, (err) => err && next(err));
  });

  app.get("/api/clips/:id/export", (req, res) => {
    res.json(publisher.exportPack(idParam(req.params.id), platformParam(req.query.platform)));
  });

  function postRequest(rawBody: unknown): { accountIds: string[]; when: Date | null } {
    const body = (rawBody ?? {}) as { accountIds?: unknown; when?: unknown };
    const accountIds = Array.isArray(body.accountIds) ? body.accountIds.filter((a): a is string => typeof a === "string") : [];
    let when: Date | null = null;
    if (typeof body.when === "string" && body.when) {
      when = new Date(body.when);
      if (Number.isNaN(when.getTime())) throw new ValidationError("The time is not a valid date.");
    }
    return { accountIds, when };
  }

  app.post("/api/clips/:id/posts", async (req, res) => {
    const { accountIds, when } = postRequest(req.body);
    res.status(201).json(await publisher.post(idParam(req.params.id), accountIds, when));
  });

  // Its own path, so a server too old to know dry runs answers 404 instead of posting.
  app.post("/api/clips/:id/posts/dry-run", async (req, res) => {
    const { accountIds, when } = postRequest(req.body);
    res.json({ dryRun: true, ...(await publisher.dryRun(idParam(req.params.id), accountIds, when)) });
  });

  // The account picker for a clip: who can take it and who is suggested.
  app.get("/api/clips/:id/accounts", async (req, res) => {
    res.json(await publisher.choices(idParam(req.params.id)));
  });

  app.get("/api/posting", async (_req, res) => {
    res.json(await publisher.info());
  });

  app.put("/api/posting/rules", (req, res) => {
    res.json(posts.saveRules(parseRules(req.body)));
  });

  app.get("/api/posts", (_req, res) => {
    res.json(posts.list());
  });

  app.post("/api/posts/refresh", async (_req, res) => {
    const updated = await publisher.refresh();
    res.json({ updated, error: publisher.lastRefreshError });
  });

  app.post("/api/posts/:id/views", (req, res) => {
    const views = Number((req.body ?? {}).views);
    if (!Number.isInteger(views) || views < 0) throw new ValidationError("Views must be a whole number of zero or more.");
    res.json(posts.setManualViews(idParam(req.params.id), views));
  });

  app.post("/api/posts/:id/whop", (req, res) => {
    res.json(posts.markWhopSubmitted(idParam(req.params.id)));
  });

  app.get("/api/stats", (_req, res) => {
    res.json(publisher.stats());
  });

  if (watchlist) {
    const { repo, poller } = watchlist;

    app.get("/api/watchlist", (_req, res) => {
      res.json({ creators: repo.list(), platforms: poller.status(), lastPollAt: poller.lastPollAt?.toISOString() ?? null });
    });

    app.post("/api/watchlist", (req, res) => {
      res.status(201).json(repo.create(parseWatchedCreator(req.body)));
    });

    app.put("/api/watchlist/:id", (req, res) => {
      res.json(repo.update(idParam(req.params.id), parseWatchedCreator(req.body)));
    });

    app.delete("/api/watchlist/:id", (req, res) => {
      repo.remove(idParam(req.params.id));
      res.status(204).end();
    });

    // Turning auto-ingest on checks that creator right away, so a new VOD is queued without waiting.
    app.put("/api/watchlist/:id/auto-ingest", async (req, res) => {
      const id = idParam(req.params.id);
      const on = (req.body ?? {}).on === true;
      if (on && repo.get(id).permissionState !== "active") {
        throw new ValidationError("Needs permission: join their program and add it as a campaign first.");
      }
      repo.setAutoIngest(id, on);
      if (on) await poller.pollCreator(id);
      res.json(repo.get(id));
    });

    app.post("/api/watchlist/poll", async (_req, res) => {
      await poller.pollAll();
      res.json({ creators: repo.list(), platforms: poller.status(), lastPollAt: poller.lastPollAt?.toISOString() ?? null });
    });
  }

  if (settings) {
    const { store, demo } = settings;
    const info = () => settingsInfo(store, { demo, posting: publisher.service.name });

    // A key's value is never in an answer: see settingsInfo.
    app.get("/api/settings", (_req, res) => {
      res.json(info());
    });

    app.put("/api/settings/:id", (req, res) => {
      const def = integration(req.params.id);
      store.save(parseSettingsInput(def, req.body), [def.id]);
      res.json(info());
    });

    app.delete("/api/settings/:id", (req, res) => {
      const def = integration(req.params.id);
      store.save(Object.fromEntries(def.fields.map((f) => [f.name, null])), [def.id]);
      res.json(info());
    });

    app.post("/api/settings/:id/test", async (req, res) => {
      const result = await testIntegration(integration(req.params.id).id, store, demo);
      res.json({ ...result, settings: info() });
    });

    app.get("/api/setup", async (_req, res) => {
      let postingAccounts: number | null = null;
      if (publisher.service.name !== "none") {
        try {
          // The same sync the Posting accounts screen runs, so a newly linked account shows up there too.
          postingAccounts = (await publisher.syncAccounts()).filter((a) => !a.disabled).length;
        } catch {
          // Not reachable or a bad key: the Settings row says why when it is tested.
        }
      }
      res.json(
        buildChecklist({
          integrations: info().integrations,
          postingAccounts,
          postingLabel: publisher.service.label,
          activePermissions: sources.list().filter((s) => s.permissionState === "active").length,
          clips: clips.list().length,
          posted: posts.list().filter((p) => p.status === "posted").length,
        }),
      );
    });
  }

  // "Load demo clips" on an empty gallery: generated test patterns, made by a queued job.
  app.post("/api/demo", (_req, res) => {
    res.status(201).json(queue.enqueue(DEMO_JOB, {}, { maxAttempts: 1 }));
  });

  if (accountStats) {
    app.get("/api/dashboard", (_req, res) => {
      res.json(
        buildDashboard({
          now: new Date(),
          clips: clips.list(),
          posts: posts.list(),
          vods: vods.list(),
          jobs: queue.list(500),
          sources: sources.list(),
          accounts: accountStats.info(posts.rules()).cards,
          decisionTimes: clips.decisionTimes(),
        }),
      );
    });

    // Reads the posting service only when the cached stats are due (see AccountStatsStore).
    app.get("/api/accounts", async (_req, res) => {
      await accountStats.refresh();
      res.json(accountStats.info(posts.rules()));
    });

    // Reads the connected accounts from the posting service now (stats keep their own interval).
    app.post("/api/accounts/sync", async (_req, res) => {
      await publisher.syncAccounts();
      res.json(accountStats.info(posts.rules()));
    });

    app.put("/api/accounts/:id", (req, res) => {
      publisher.accounts.update(String(req.params.id), parseChannelSettings(req.body));
      res.json(accountStats.info(posts.rules()));
    });

    app.post("/api/accounts/:id/followers", (req, res) => {
      const followers = Number((req.body ?? {}).followers);
      if (!Number.isInteger(followers) || followers < 0) throw new ValidationError("Followers must be a whole number of zero or more.");
      accountStats.setManualFollowers(String(req.params.id), followers);
      res.json(accountStats.info(posts.rules()));
    });

    // "Load demo data" on an empty dashboard: demo clips plus history, made by a queued job.
    app.post("/api/demo-data", (_req, res) => {
      assertNoDemoData(accountStats);
      if (queue.list().some((j) => j.type === DEMO_DATA_JOB && (j.status === "queued" || j.status === "running"))) {
        throw new ValidationError("Demo data is already being made.");
      }
      res.status(201).json(queue.enqueue(DEMO_DATA_JOB, {}, { maxAttempts: 1 }));
    });
  }

  if (seedDemoClip) {
    app.post("/api/dev/seed-clip", async (_req, res) => {
      res.status(201).json(await seedDemoClip());
    });
  }

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found." });
  });

  if (clientDir) {
    // Checked per request, not once at startup: a build that finishes (or reruns) after the server
    // started is picked up, and a missing one is said out loud instead of Express's "Cannot GET /".
    app.use(express.static(clientDir));
    app.get("/{*splat}", (_req, res) => {
      if (clientBuildProblem(clientDir)) {
        // The server's paths stay in its log (see index.ts), not in the answer.
        res.status(503).type("text/plain").send('The clipfarm app is not built. Run "npm run build", then reload.');
        return;
      }
      // `root` keeps the dotfile check on "index.html" only: the checkout may sit under a dot-folder.
      res.sendFile("index.html", { root: clientDir });
    });
  }

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (err?.type === "entity.parse.failed") {
      res.status(400).json({ error: "The request was not valid JSON." });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Something went wrong on the server. Check the server log." });
  };
  app.use(onError);
  return app;
}
