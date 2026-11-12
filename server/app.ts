import express, { type ErrorRequestHandler } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Platform, RejectReason } from "../shared/types.js";
import { PLATFORMS, REJECT_REASONS } from "../shared/types.js";
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
import type { PostsRepo } from "./publish/repo.js";
import { parseFaceCam, parseNewSource, type SourcesRepo } from "./sources/repo.js";
import type { VodsRepo } from "./vods/repo.js";

export interface AppDeps {
  sources: SourcesRepo;
  vods: VodsRepo;
  queue: JobQueue;
  clips: ClipsRepo;
  posts: PostsRepo;
  publisher: Publisher;
  /** Account stats from the posting service, for the dashboard. */
  accountStats?: AccountStatsStore;
  /** Demo/e2e only (CLIPFARM_FAKES=1): adds a campaign and a pending clip from a generated sample. */
  seedDemoClip?: () => Promise<unknown>;
  /** Built client to serve (npm run preview). Omitted in dev, where Vite serves it. */
  clientDir?: string;
}

function idParam(raw: string | string[] | undefined): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError("Invalid id.");
  return id;
}

function platformParam(raw: unknown): Platform {
  if (!PLATFORMS.includes(raw as Platform)) throw new ValidationError("Pick a platform.");
  return raw as Platform;
}

export function createApp({
  sources,
  vods,
  queue,
  clips,
  posts,
  publisher,
  accountStats,
  seedDemoClip,
  clientDir,
}: AppDeps): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/sources", (_req, res) => {
    res.json(sources.list());
  });

  app.post("/api/sources", (req, res) => {
    res.status(201).json(sources.create(parseNewSource(req.body)));
  });

  app.put("/api/sources/:id/face-cam", (req, res) => {
    const id = idParam(req.params.id);
    res.json(sources.setFaceCam(id, req.body === null || req.body?.clear ? null : parseFaceCam(req.body)));
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

  app.post("/api/clips/:id/posts", async (req, res) => {
    const body = (req.body ?? {}) as { accountIds?: unknown; when?: unknown };
    const accountIds = Array.isArray(body.accountIds) ? body.accountIds.filter((a): a is string => typeof a === "string") : [];
    let when: Date | null = null;
    if (typeof body.when === "string" && body.when) {
      when = new Date(body.when);
      if (Number.isNaN(when.getTime())) throw new ValidationError("The time is not a valid date.");
    }
    res.status(201).json(await publisher.post(idParam(req.params.id), accountIds, when));
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

  if (clientDir && existsSync(clientDir)) {
    app.use(express.static(clientDir));
    app.get("/{*splat}", (_req, res) => {
      res.sendFile(join(clientDir, "index.html"));
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
