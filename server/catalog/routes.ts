import { Router } from "express";
import type { CatalogInfo } from "../../shared/catalog.js";
import type { PostsRepo } from "../publish/repo.js";
import type { ScoreContext } from "../scout/score.js";
import { PROGRAMS, rankPrograms } from "./programs.js";
import type { StreamerRegistry } from "./registry.js";

/** Views of our own posts per platform (posts with a view count only). */
export function ourViews(posts: PostsRepo): ScoreContext["ourViews"] {
  const views: ScoreContext["ourViews"] = {};
  for (const p of posts.list()) if (p.views !== null) (views[p.platform] ??= []).push(p.views);
  return views;
}

/** The campaign catalog's API, under /api/catalog: the programs that pay for clips and the streamer registry. */
export function catalogRoutes(deps: { registry: StreamerRegistry; posts: PostsRepo }): Router {
  const r = Router();
  const info = (): CatalogInfo => ({ programs: rankPrograms(PROGRAMS, ourViews(deps.posts)), streamers: deps.registry.list() });

  r.get("/", (_req, res) => {
    res.json(info());
  });

  // "Check now" on one streamer.
  r.post("/streamers/:name/check", async (req, res) => {
    await deps.registry.check(String(req.params.name));
    res.json(info());
  });

  return r;
}
