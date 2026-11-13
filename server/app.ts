import express, { type ErrorRequestHandler } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Platform, PostFlag, RejectReason, WatchChannel, WhopStep } from "../shared/types.js";
import { PLATFORMS, POST_FLAGS, REJECT_REASONS, WHOP_STEPS } from "../shared/types.js";
import { accessGate, type AccessVerifier } from "./access.js";
import { parseChannelSettings } from "./accounts/repo.js";
import type { AccountStatsStore } from "./accounts/stats.js";
import { parseClipEdit } from "./clips/edit.js";
import type { ClipsRepo } from "./clips/repo.js";
import { buildDashboard } from "./dashboard/build.js";
import { DEMO_JOB } from "./dev/demo.js";
import { type Engine, ENGINE_SETUP_JOB } from "./engine/engine.js";
import { assertNoDemoData, DEMO_DATA_JOB } from "./dev/demoData.js";
import { directPlatform, type Isolation } from "./isolation/isolation.js";
import type { HookLab } from "./hooklab/lab.js";
import type { GrowthLab } from "./growth/lab.js";
import { growthRoutes } from "./growth/routes.js";
import type { JobQueue } from "./jobs/queue.js";
import { HttpError, NotFoundError, ValidationError } from "./errors.js";
import type { LiveManager } from "./live/manager.js";
import { parsePushSubscription } from "./live/notify.js";
import type { LiveRepo } from "./live/repo.js";
import { INGEST_JOB } from "./pipeline/ingest/ingest.js";
import { RENDER_CLIP_JOB } from "./pipeline/rerender/render.js";
import type { DirectPoster } from "./publish/direct/direct.js";
import { parseRules, type Publisher, slug } from "./publish/publisher.js";
import { buildChecklist } from "./settings/checklist.js";
import { configuredMap, integration, isConfigured, parseSettingsInput, settingsInfo } from "./settings/integrations.js";
import { testIntegration } from "./settings/keyTests.js";
import type { Settings } from "./settings/store.js";
import type { PostsRepo } from "./publish/repo.js";
import type { PicksRepo } from "./picks/repo.js";
import type { Campaigns } from "./sources/campaign/service.js";
import type { AllowanceChecker } from "./sources/proof.js";
import { parseFaceCam, parseNewSource, parsePermission, type SourcesRepo } from "./sources/repo.js";
import { addSuggested, listSuggested, type SeedCreator } from "./sources/suggested.js";
import type { WatchlistPoller } from "./sources/watchlist/poller.js";
import { parseWatchedCreator, type WatchlistRepo } from "./sources/watchlist/repo.js";
import type { TrendRadar } from "./trends/radar.js";
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
  /** Re-reads the proof of public clipping allowances ("Check again" and the weekly check). */
  allowance?: AllowanceChecker;
  /** Reads Whop / Content Rewards campaign pages: to fill the form from a pasted link, and to check they still run. */
  campaigns?: Campaigns;
  /** The starter list of creators who publicly allow clipping. */
  suggested?: SeedCreator[];
  /** Streamer watchlist and its live / new-VOD checks. */
  watchlist?: { repo: WatchlistRepo; poller: WatchlistPoller };
  /** Live mode: the Launch day card's switches, and who gets notifications. */
  live?: { manager: LiveManager; repo: LiveRepo };
  /** The local engine (speech-to-text and picks on this server); `fake` when the server runs on test doubles. */
  engine?: { engine: Engine; fake: boolean };
  /** Keys and connections pasted in the app. `demo`: outside services are stand-ins, so Test calls nothing. */
  settings?: { store: Settings; demo: boolean };
  /** Isolation groups (Settings, Accounts) and the uploads clipfarm does itself. `demo`: the platforms are stand-ins. */
  isolation?: { isolation: Isolation; direct: DirectPoster; demo: boolean };
  /** The trend radar: what GTA clips win today. */
  trends?: TrendRadar;
  /** A/B tests of hooks on burner accounts. */
  hookLab?: HookLab;
  /** Test campaigns, their reports and the daily digest. */
  growth?: GrowthLab;
  /** Demo/e2e only (CLIPFARM_FAKES=1): adds a campaign and a pending clip from a generated sample. */
  seedDemoClip?: () => Promise<unknown>;
  /** Built client to serve (npm run preview). Omitted in dev, where Vite serves it. */
  clientDir?: string;
  /** Live box (CLIPFARM_REQUIRE_ACCESS=1): refuse requests without a token signed by Cloudflare Access. */
  access?: AccessVerifier;
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
  allowance,
  campaigns,
  suggested = [],
  watchlist,
  live,
  engine,
  settings,
  isolation: groups,
  trends,
  hookLab,
  growth,
  seedDemoClip,
  clientDir,
  access,
}: AppDeps): express.Express {
  const app = express();
  if (access) app.use(accessGate(access));
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

  app.get("/api/sources/suggested", (_req, res) => {
    res.json(listSuggested(suggested, sources.list()));
  });

  // The manager picks from the starter list, each shown with its proof; nothing is added unasked.
  app.post("/api/sources/suggested", (req, res) => {
    const names = ((req.body ?? {}) as { names?: unknown }).names;
    const picked = Array.isArray(names) ? names.filter((n): n is string => typeof n === "string") : [];
    const added = addSuggested(picked, suggested, { sources, watchlist: watchlist?.repo, now: new Date() });
    res.status(201).json({ added, suggested: listSuggested(suggested, sources.list()) });
  });

  // Paste a campaign link: an imported campaign is saved onto its creator (made, or brought up to date).
  app.post("/api/campaigns", (req, res) => {
    res.status(201).json(sources.saveCampaign(parseNewSource(req.body)));
  });

  if (campaigns) {
    // Reads the campaign's public page into the form's starting values; nothing is saved.
    app.post("/api/campaigns/read", async (req, res) => {
      const { url, text } = (req.body ?? {}) as { url?: unknown; text?: unknown };
      res.json(await campaigns.read(url, text));
    });
  }

  if (allowance || campaigns) {
    // "Check again": re-reads a public allowance's proof page, or a campaign's page, and stores the outcome.
    app.post("/api/permissions/:id/check", async (req, res) => {
      const id = idParam(req.params.id);
      const checker = ((sources.permission(id).kind === "whop-campaign" ? campaigns : allowance) ?? allowance ?? campaigns)!;
      const result = await checker.check(id);
      res.json({ ...result, source: sources.get(sources.permission(id).sourceId) });
    });
  }

  if (allowance) {
    // "Look for a clipping allowance" in Add a creator: reads the creator's own channel pages.
    app.post("/api/allowance/find", async (req, res) => {
      const { channels } = parseWatchedCreator({ name: "-", channels: ((req.body ?? {}) as { channels?: WatchChannel[] }).channels });
      res.json(await allowance.find(channels));
    });
  }

  // Another record for a creator we already have (an experiment, or a campaign that replaces an old one).
  app.post("/api/sources/:id/permissions", (req, res) => {
    const id = idParam(req.params.id);
    sources.get(id);
    sources.addPermission(id, parsePermission(req.body));
    res.status(201).json(sources.get(id));
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

  // The Fix button on a quality warning: applies the suggested change and remakes the clip.
  app.post("/api/clips/:id/fix", (req, res) => {
    const clip = clips.applyFix(idParam(req.params.id));
    const job = queue.enqueue(RENDER_CLIP_JOB, { clipId: clip.id }, { clipId: clip.id, maxAttempts: 2 });
    res.status(202).json({ clip, job });
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
    await growth?.collectPlatformStats();
    res.json({ updated, error: publisher.lastRefreshError ?? growth?.lastStatsError ?? null });
  });

  app.post("/api/posts/:id/views", (req, res) => {
    const views = Number((req.body ?? {}).views);
    if (!Number.isInteger(views) || views < 0) throw new ValidationError("Views must be a whole number of zero or more.");
    res.json(posts.setManualViews(idParam(req.params.id), views));
  });

  // The Whop steps, tapped by hand: sent (the default), approved, paid (on: false takes one back).
  app.post("/api/posts/:id/whop", (req, res) => {
    const { step = "submitted", on } = (req.body ?? {}) as { step?: unknown; on?: unknown };
    if (!WHOP_STEPS.includes(step as WhopStep)) throw new ValidationError("Pick a step: submitted, approved or paid.");
    res.json(publisher.markWhop(idParam(req.params.id), step as WhopStep, on !== false));
  });

  // One tap on a post: a claim, removal or strike seen on the platform (on: false takes it back).
  app.post("/api/posts/:id/flags", (req, res) => {
    const { flag, on } = (req.body ?? {}) as { flag?: unknown; on?: unknown };
    if (!POST_FLAGS.includes(flag as PostFlag)) throw new ValidationError("Pick what happened: claim, removal or strike.");
    const post = posts.setFlag(idParam(req.params.id), flag as PostFlag, on !== false);
    // A strike pauses the campaign the post belongs to right away, not at the next round.
    growth?.pauseOnStrikes();
    res.json(post);
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
      const state = repo.get(id).permissionState;
      if (on && state === "needs-review") {
        throw new ValidationError("Their clipping allowance needs review: check it again in Sources first.");
      }
      if (on && state !== "active") {
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

  if (live) {
    const { manager, repo } = live;

    app.get("/api/live", (_req, res) => {
      res.json(manager.info());
    });

    app.put("/api/live/launch", async (req, res) => {
      await manager.setLaunchAt((req.body ?? {}).launchAt);
      res.json(manager.info());
    });

    app.post("/api/live/arm", async (_req, res) => {
      await manager.arm(true);
      res.json(manager.info());
    });

    app.post("/api/live/disarm", async (_req, res) => {
      await manager.arm(false);
      res.json(manager.info());
    });

    app.put("/api/live/creators/:id", async (req, res) => {
      await manager.setCreator(idParam(req.params.id), (req.body ?? {}).on === true);
      res.json(manager.info());
    });

    app.post("/api/live/push", (req, res) => {
      repo.addPushSubscription(parsePushSubscription(req.body), new Date());
      res.status(201).json(manager.info());
    });

    app.delete("/api/live/push", (req, res) => {
      const endpoint = (req.body ?? {}).endpoint as unknown;
      if (typeof endpoint === "string") repo.removePushSubscription(endpoint);
      res.json(manager.info());
    });
  }

  if (settings) {
    const { store, demo } = settings;
    const info = () => settingsInfo(store, { demo, posting: publisher.service.name });

    // A key's value is never in an answer: see settingsInfo.
    app.get("/api/settings", (_req, res) => {
      res.json(info());
    });

    app.put("/api/settings/:id", async (req, res) => {
      const def = integration(req.params.id);
      store.save(parseSettingsInput(def, req.body), [def.id]);
      // OpenAI is tested on every save: the badge and the model lists are right without a second tap.
      if (def.id === "openai" && isConfigured(store, def.id)) await testIntegration(def.id, store, demo);
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
          groups: groups?.isolation.info(publisher.accounts.list(), { lastConnect: null, demo }).groups,
        }),
      );
    });
  }

  if (groups) {
    const { isolation, direct, demo } = groups;
    // No key, token, proxy sign-in or full address is in this answer: see Isolation.info.
    const info = () => isolation.info(publisher.accounts.list(), { lastConnect: direct.lastConnect, demo });

    app.get("/api/groups", (_req, res) => {
      res.json(info());
    });

    app.post("/api/groups", (req, res) => {
      isolation.create(req.body);
      res.status(201).json(info());
    });

    app.delete("/api/groups/:id", (req, res) => {
      isolation.remove(idParam(req.params.id));
      res.json(info());
    });

    app.put("/api/groups/:id/apps/:platform", (req, res) => {
      isolation.setApp(idParam(req.params.id), directPlatform(req.params.platform), req.body);
      res.json(info());
    });

    app.delete("/api/groups/:id/apps/:platform", (req, res) => {
      isolation.removeApp(idParam(req.params.id), directPlatform(req.params.platform));
      res.json(info());
    });

    app.put("/api/groups/:id/proxy", (req, res) => {
      isolation.setProxy(idParam(req.params.id), (req.body ?? {}).url);
      res.json(info());
    });

    app.delete("/api/groups/:id/proxy", (req, res) => {
      isolation.setProxy(idParam(req.params.id), null);
      res.json(info());
    });

    // The Test button: where the proxy leaves from, and whether that differs from this server.
    app.post("/api/groups/:id/proxy/test", async (req, res) => {
      const check = await isolation.check(idParam(req.params.id));
      res.json({ check, ...info() });
    });

    // "Connect channel": where to send the browser to sign in with this group's app.
    app.post("/api/groups/:id/connect/:platform", async (req, res) => {
      res.json({ url: await direct.connectUrl(idParam(req.params.id), directPlatform(req.params.platform)) });
    });

    app.put("/api/accounts/:id/group", (req, res) => {
      const account = publisher.accounts.list().find((a) => a.id === String(req.params.id));
      if (!account) throw new NotFoundError("That account was not found.");
      isolation.moveAccount(account, (req.body ?? {}).groupId);
      res.json(info());
    });

    // Where the platform sends the browser after the sign-in. Open to the internet (see access.ts):
    // only a state we handed out counts, and the answer says nothing but where to go next.
    app.get("/oauth/:platform/callback", async (req, res) => {
      const ok = await direct.callback(directPlatform(req.params.platform), req.query.code, req.query.state);
      res.redirect(`/?connect=${ok ? "ok" : "failed"}#settings/accounts`);
    });
  }

  // "Load demo clips" on an empty gallery: generated test patterns, made by a queued job.
  if (engine) {
    const status = () => engine.engine.status(queue.list(200), engine.fake ? "test" : "auto");

    app.get("/api/engine", (_req, res) => {
      res.json(status());
    });

    app.put("/api/engine/settings", (req, res) => {
      engine.engine.saveSettings(req.body);
      res.json(status());
    });

    // "Set up the local engine": one download job at a time; a second tap joins the one waiting.
    // With a step (its Download button), only that step's files are fetched, switched on or not.
    app.post("/api/engine/setup", (req, res) => {
      const now = status();
      const step = now.steps.find((s) => s.id === (req.body as { step?: unknown } | undefined)?.step);
      const waiting = now.setupJob && now.setupJob.status !== "failed";
      if (step && now.mode !== "test") {
        if (step.downloadBytes > 0 && !waiting) queue.enqueue(ENGINE_SETUP_JOB, { step: step.id });
      } else if (now.mode === "local" && now.downloads.length > 0 && !waiting) {
        queue.enqueue(ENGINE_SETUP_JOB, {});
      } else if (now.setupJob?.status === "queued") {
        // Already waiting: make sure the queue is working on it, so the tap is never a dead end.
        void queue.kick();
      }
      res.status(202).json(status());
    });
  }

  if (trends) {
    const report = () => trends.report({ clips: clips.list(), sources: sources.list() });

    app.get("/api/trends", (_req, res) => {
      res.json(report());
    });

    app.post("/api/trends/refresh", async (_req, res) => {
      try {
        await trends.refresh();
      } catch (err) {
        if (err instanceof HttpError) throw err;
        // YouTube said no or could not be reached: say so instead of "something went wrong".
        throw new HttpError(502, (err as Error).message);
      }
      res.json(report());
    });

    app.put("/api/trends/weight", (req, res) => {
      trends.setWeight((req.body ?? {}).weight);
      res.json(report());
    });
  }

  if (hookLab) {
    app.get("/api/hooklab", (_req, res) => {
      res.json(hookLab.info());
    });

    app.put("/api/hooklab/settings", (req, res) => {
      hookLab.saveSettings(req.body);
      res.json(hookLab.info());
    });

    // One pass now instead of at the next timer: starts tests, sends variants, settles finished ones.
    app.post("/api/hooklab/run", async (_req, res) => {
      await hookLab.tick();
      res.json(hookLab.info());
    });
  }
  if (growth) app.use("/api/growth", growthRoutes(growth));

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
          growth: growth ? { campaigns: growth.summaries(), recommendations: growth.repo.recommendations() } : undefined,
          engineReports: engine ? (vodId) => engine.engine.reportsFor(vodId) : undefined,
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
