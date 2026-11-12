import express, { type ErrorRequestHandler } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Platform } from "../shared/types.js";
import { PLATFORMS } from "../shared/types.js";
import type { ClipsRepo } from "./clips/repo.js";
import type { JobQueue } from "./jobs/queue.js";
import { HttpError, NotFoundError, ValidationError } from "./errors.js";
import { INGEST_JOB } from "./pipeline/ingest/ingest.js";
import { parseRules, type Publisher, slug } from "./publish/publisher.js";
import type { PostsRepo } from "./publish/repo.js";
import type { PicksRepo } from "./picks/repo.js";
import { parseCropRect, parseNewSource, type SourcesRepo } from "./sources/repo.js";
import type { VodsRepo } from "./vods/repo.js";

export interface AppDeps {
  sources: SourcesRepo;
  vods: VodsRepo;
  picks: PicksRepo;
  queue: JobQueue;
  clips: ClipsRepo;
  posts: PostsRepo;
  publisher: Publisher;
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

function sendMedia(res: express.Response, file: string | null): void {
  if (!file || !existsSync(file)) throw new NotFoundError("That file is not there (yet).");
  // Paths come from the server, never the request; they may sit under a dot-folder (e.g. ~/.cubefarm).
  res.sendFile(file, { dotfiles: "allow" });
}

function platformParam(raw: unknown): Platform {
  if (!PLATFORMS.includes(raw as Platform)) throw new ValidationError("Pick a platform.");
  return raw as Platform;
}

export function createApp({ sources, vods, picks, queue, clips, posts, publisher, seedDemoClip, clientDir }: AppDeps): express.Express {
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

  // Where the creator's face cam sits, for the stacked layout. Send null to clear it.
  app.put("/api/sources/:id/face-cam", (req, res) => {
    const body = (req.body ?? {}) as { faceCam?: unknown };
    res.json(sources.setFaceCam(idParam(req.params.id), parseCropRect(body.faceCam)));
  });

  app.get("/api/sources/:id/frame", (req, res) => {
    sendMedia(res, sources.framePath(idParam(req.params.id)));
  });

  app.get("/api/vods/:id/picks", (req, res) => {
    const id = idParam(req.params.id);
    vods.get(id);
    res.json(picks.listForVod(id));
  });

  app.get("/api/picks", (_req, res) => {
    res.json(picks.list());
  });

  app.get("/api/picks/:id/video", (req, res) => {
    sendMedia(res, picks.files(idParam(req.params.id)).video);
  });

  app.get("/api/picks/:id/thumb", (req, res) => {
    sendMedia(res, picks.files(idParam(req.params.id)).thumb);
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

  app.get("/api/clips", (_req, res) => {
    res.json(clips.list());
  });

  app.post("/api/clips/:id/approve", (req, res) => {
    res.json(clips.setStatus(idParam(req.params.id), "approved"));
  });

  app.post("/api/clips/:id/reject", (req, res) => {
    res.json(clips.setStatus(idParam(req.params.id), "rejected"));
  });

  app.get("/api/clips/:id/video", (req, res, next) => {
    const id = idParam(req.params.id);
    const file = clips.filePath(id);
    if (!existsSync(file)) throw new NotFoundError("The video file for this clip is missing on the server.");
    // The data folder may sit under a dot folder (.e2e-data), which send() refuses by default.
    const opts = { dotfiles: "allow" as const };
    if (req.query.download) res.download(file, `${slug(clips.get(id).title)}.mp4`, opts, (err) => err && next(err));
    else res.sendFile(file, opts, (err) => err && next(err));
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
