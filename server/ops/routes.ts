import { type Request, Router } from "express";
import { ValidationError } from "../errors.js";
import type { Operations } from "./operations.js";

/** Who tapped: the signed-in email Cloudflare Access adds on the live box, else "manager" (local and demo runs). */
export function whoOf(req: Request): string {
  const email = req.get("cf-access-authenticated-user-email")?.trim();
  return email ? email.slice(0, 120) : "manager";
}

function id(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new ValidationError("Invalid id.");
  return n;
}

function body(req: Request): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

/** Destructive controls (cancel, skip, pause all publishing) only act on a confirmed request. */
function confirmed(req: Request, what: string): void {
  if (body(req).confirm !== true) throw new ValidationError(`Confirm first: ${what}`);
}

function onOff(req: Request): boolean {
  const paused = body(req).paused;
  if (typeof paused !== "boolean") throw new ValidationError("Say whether to pause or resume.");
  return paused;
}

/** The Operations page's API, under /api/ops. Every control answers with the whole page again. */
export function opsRoutes(ops: Operations): Router {
  const r = Router();
  const page = (fresh = false) => ops.info({ fresh });

  r.get("/", async (req, res) => {
    res.json(await page(req.query.fresh === "1"));
  });

  r.post("/keys/test", async (req, res) => {
    await ops.testKeys(whoOf(req));
    res.json(await page(true));
  });

  r.post("/jobs/:id/retry", async (req, res) => {
    ops.retryJob(id(req.params.id), whoOf(req));
    res.json(await page());
  });

  r.post("/jobs/:id/cancel", async (req, res) => {
    confirmed(req, "cancel this job.");
    ops.cancelJob(id(req.params.id), whoOf(req));
    res.json(await page());
  });

  r.post("/jobs/:id/top", async (req, res) => {
    ops.moveJobToTop(id(req.params.id), whoOf(req));
    res.json(await page());
  });

  r.post("/worker", async (req, res) => {
    ops.setWorkerPaused(onOff(req), whoOf(req));
    res.json(await page());
  });

  r.post("/posts/:id/retry", async (req, res) => {
    await ops.retryPost(id(req.params.id), whoOf(req));
    res.json(await page());
  });

  r.post("/posts/:id/reschedule", async (req, res) => {
    const at = new Date(String(body(req).at ?? ""));
    if (Number.isNaN(at.getTime())) throw new ValidationError("Pick a time.");
    await ops.reschedulePost(id(req.params.id), at, whoOf(req));
    res.json(await page());
  });

  r.post("/posts/:id/skip", async (req, res) => {
    confirmed(req, "skip this post.");
    ops.skipPost(id(req.params.id), whoOf(req));
    res.json(await page());
  });

  r.post("/publishing", async (req, res) => {
    const paused = onOff(req);
    if (paused) confirmed(req, "pause all publishing.");
    ops.setPublishingPaused(paused, whoOf(req));
    res.json(await page());
  });

  r.post("/posts/:id/submit", async (req, res) => {
    ops.submitNow(id(req.params.id), whoOf(req));
    res.json(await page());
  });

  r.post("/sources/:id/check", async (req, res) => {
    await ops.checkSource(id(req.params.id), whoOf(req));
    res.json(await page());
  });

  r.post("/sources/:id/pause", async (req, res) => {
    ops.setSourcePaused(id(req.params.id), onOff(req), whoOf(req));
    res.json(await page());
  });

  return r;
}
