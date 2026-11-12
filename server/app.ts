import express, { type ErrorRequestHandler } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { JobQueue } from "./jobs/queue.js";
import { HttpError, NotFoundError, ValidationError } from "./errors.js";
import { INGEST_JOB } from "./pipeline/ingest/ingest.js";
import type { PicksRepo } from "./picks/repo.js";
import { parseCropRect, parseNewSource, type SourcesRepo } from "./sources/repo.js";
import type { VodsRepo } from "./vods/repo.js";

export interface AppDeps {
  sources: SourcesRepo;
  vods: VodsRepo;
  picks: PicksRepo;
  queue: JobQueue;
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

export function createApp({ sources, vods, picks, queue, clientDir }: AppDeps): express.Express {
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
