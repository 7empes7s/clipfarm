import express, { Router } from "express";
import { parsePayoutCsv } from "../../shared/business.js";
import { ValidationError } from "../errors.js";
import { parseRange } from "./build.js";
import type { BusinessService } from "./service.js";

/** The business dashboard's API, under /api/business. */
export function businessRoutes(business: BusinessService): Router {
  const r = Router();

  r.get("/", (req, res) => {
    res.json(business.board(parseRange(req.query.range)));
  });

  r.get("/health", (_req, res) => {
    res.json(business.health());
  });

  r.get("/export/:table.csv", (req, res) => {
    const table = String(req.params.table);
    const csv = business.csv(table, parseRange(req.query.range));
    res.type("text/csv").setHeader("Content-Disposition", `attachment; filename="clipfarm-${table}.csv"`).send(csv);
  });

  // A campaign's CSV export (Content Rewards has no clipper API): views counted, approved or rejected, payouts.
  r.post("/payouts", express.text({ type: ["text/csv", "text/plain"], limit: "2mb" }), (req, res) => {
    if (typeof req.body !== "string" || req.body.trim() === "") throw new ValidationError("Choose the campaign's CSV file.");
    let parsed;
    try {
      parsed = parsePayoutCsv(req.body);
    } catch (err) {
      throw new ValidationError((err as Error).message);
    }
    if (parsed.rows.length === 0) throw new ValidationError("No row in the file has a post link.");
    res.json({ ...business.repo.importPayouts(parsed.rows), skipped: parsed.skipped });
  });

  return r;
}
