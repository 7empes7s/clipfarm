import { Router } from "express";
import { ValidationError } from "../errors.js";
import type { Scout } from "./service.js";

/** The campaign scout's API, under /api/scout. */
export function scoutRoutes(scout: Scout): Router {
  const r = Router();

  r.get("/", (_req, res) => {
    res.json(scout.info());
  });

  // "Scout now": the run goes on in the background (one page every five seconds); the app asks again until it is done.
  r.post("/run", (_req, res) => {
    void scout.run().catch((err: unknown) => console.error("Campaign scout failed:", err));
    res.status(202).json(scout.info());
  });

  // Join was tapped ("opened"), "Not interested" ("hidden"), or back on the list ("new").
  r.put("/campaigns/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new ValidationError("Invalid id.");
    scout.repo.setStatus(id, (req.body ?? {}).status);
    res.json(scout.info());
  });

  r.put("/auto", (req, res) => {
    const on = (req.body ?? {}).on;
    if (typeof on !== "boolean") throw new ValidationError("Say whether auto mode is on or off.");
    scout.repo.setAuto(on);
    res.json(scout.info());
  });

  return r;
}
