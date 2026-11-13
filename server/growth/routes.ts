import { Router } from "express";
import { ValidationError } from "../errors.js";
import type { GrowthLab } from "./lab.js";
import { parseCampaign } from "./plan.js";

function id(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new ValidationError("Invalid id.");
  return n;
}

/** The growth lab's API, under /api/growth. */
export function growthRoutes(lab: GrowthLab): Router {
  const r = Router();
  const { repo } = lab;

  r.get("/", (_req, res) => {
    res.json(lab.info());
  });

  r.post("/campaigns", (req, res) => {
    res.status(201).json(lab.create(parseCampaign(req.body)));
  });

  r.put("/campaigns/:id", (req, res) => {
    res.json(repo.update(id(req.params.id), parseCampaign(req.body)));
  });

  r.delete("/campaigns/:id", (req, res) => {
    repo.remove(id(req.params.id));
    res.status(204).end();
  });

  r.post("/campaigns/:id/start", async (req, res) => {
    res.json(await lab.start(id(req.params.id)));
  });

  // Posts already handed to the posting service (at most 30 minutes ahead) still go out.
  r.post("/campaigns/:id/pause", (req, res) => {
    res.json(repo.pause(id(req.params.id)));
  });

  r.post("/campaigns/:id/stop", (req, res) => {
    res.json(repo.finish(id(req.params.id)));
  });

  r.get("/campaigns/:id/report", (req, res) => {
    res.json(lab.report(id(req.params.id)));
  });

  r.get("/campaigns/:id/export.csv", (req, res) => {
    const campaignId = id(req.params.id);
    res
      .type("text/csv")
      .setHeader("Content-Disposition", `attachment; filename="campaign-${campaignId}.csv"`)
      .send(lab.csv(campaignId));
  });

  r.get("/compare", (req, res) => {
    res.json(lab.compare(String(req.query.ids ?? "").split(",").filter(Boolean).map(id)));
  });

  r.post("/recommendations/:id/apply", (req, res) => {
    repo.apply(id(req.params.id));
    res.json(lab.info());
  });

  r.post("/recommendations/:id/undo", (req, res) => {
    repo.undo(id(req.params.id));
    res.json(lab.info());
  });

  r.post("/recommendations/:id/dismiss", (req, res) => {
    repo.dismiss(id(req.params.id));
    res.json(lab.info());
  });

  // The clock the 09:00 digest follows: the phone's time zone, sent by the app.
  r.put("/digest-zone", (req, res) => {
    repo.setDigestZone((req.body ?? {}).zone);
    res.json(lab.info());
  });

  return r;
}
