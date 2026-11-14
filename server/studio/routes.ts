import { existsSync } from "node:fs";
import { Router } from "express";
import { aiGate, splitEdit } from "../../shared/studio.js";
import type { Platform, StudioInfo } from "../../shared/types.js";
import type { ClipsRepo } from "../clips/repo.js";
import { parseStudioEdit, scoreBreakdown } from "../clips/studio.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { writeVariants } from "../hooklab/variants.js";
import type { JobQueue } from "../jobs/queue.js";
import type { ChatClient } from "../pipeline/picks/llm.js";
import { RENDER_CLIP_JOB } from "../pipeline/rerender/render.js";
import type { SourcesRepo } from "../sources/repo.js";
import { parseTemplate, type TemplatesRepo } from "./templates.js";

export interface StudioDeps {
  clips: ClipsRepo;
  sources: SourcesRepo;
  queue: JobQueue;
  templates?: TemplatesRepo;
  /** The connected posting accounts a template can be for. */
  accounts: () => { id: string; name: string; platform: Platform }[];
  /** The AI writer for hook ideas; null when none is set up. */
  aiChat?: () => ChatClient | null;
}

function idParam(raw: string | string[] | undefined): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError("Invalid id.");
  return id;
}

/** Whether AI is allowed for a clip: off when any of its creator's records bans AI content. */
export function clipAiGate(clipId: number, deps: Pick<StudioDeps, "clips" | "sources">) {
  return aiGate(deps.sources.get(deps.clips.get(clipId).sourceId).permissions);
}

/** The Studio's API under /api: one clip's editor, its versions, and brand templates. */
export function studioRoutes(deps: StudioDeps): Router {
  const { clips, sources, queue, templates } = deps;
  const r = Router();
  const render = (clipId: number) => queue.enqueue(RENDER_CLIP_JOB, { clipId }, { clipId, maxAttempts: 2 });

  r.get("/clips/:id/studio", (req, res) => {
    const clip = clips.get(idParam(req.params.id));
    const source = sources.get(clip.sourceId);
    const info: StudioInfo = {
      clip,
      source,
      breakdown: scoreBreakdown(clip),
      ai: aiGate(source.permissions),
      templates: templates?.list() ?? [],
      versions: clips.versions(clip.id),
      accounts: deps.accounts().map((a) => ({ id: a.id, name: a.name, platform: a.platform })),
    };
    res.json(info);
  });

  // Export: saves the edit list and look, then remakes the clip (one render job at a time, like all heavy work).
  r.post("/clips/:id/studio", (req, res) => {
    const clip = clips.get(idParam(req.params.id));
    const edit = parseStudioEdit(req.body, clip, sources.get(clip.sourceId));
    const updated = clips.applyStudio(clip.id, edit);
    res.status(202).json({ clip: updated, job: render(clip.id) });
  });

  r.post("/clips/:id/split", (req, res) => {
    const clip = clips.get(idParam(req.params.id));
    const edit = parseStudioEdit(req.body, clip, sources.get(clip.sourceId));
    const at = (req.body ?? {}).atSec;
    if (typeof at !== "number" || at <= edit.startSec || at >= edit.endSec) throw new ValidationError("Put the playhead inside the clip to split it.");
    let parts;
    try {
      parts = splitEdit(edit, at, clip.captionWords);
    } catch (err) {
      throw new ValidationError((err as Error).message);
    }
    const made = clips.split(clip.id, edit, parts[0], parts[1]);
    for (const c of made) render(c.id);
    res.status(202).json({ clips: made.map((c) => clips.get(c.id)) });
  });

  r.get("/clips/:id/renders", (req, res) => {
    res.json(clips.versions(idParam(req.params.id)));
  });

  r.get("/clips/:id/renders/:vid/video", (req, res, next) => {
    const file = clips.versionFile(idParam(req.params.id), idParam(req.params.vid));
    if (!existsSync(file)) throw new NotFoundError("The video file of this version is missing on the server.");
    res.sendFile(file, { dotfiles: "allow" }, (err) => err && !res.headersSent && next(err));
  });

  r.post("/clips/:id/renders/:vid/restore", (req, res) => {
    res.json(clips.restoreVersion(idParam(req.params.id), idParam(req.params.vid)));
  });

  r.post("/clips/:id/revert", (req, res) => {
    res.json(clips.revertToOriginal(idParam(req.params.id)));
  });

  // Hook ideas: from proven patterns, or by the AI writer when it is set up and the campaign allows AI.
  r.post("/clips/:id/hook-ideas", async (req, res) => {
    const clip = clips.get(idParam(req.params.id));
    const wantAi = (req.body ?? {}).ai === true;
    let chat: ChatClient | null = null;
    if (wantAi) {
      const gate = clipAiGate(clip.id, deps);
      if (gate.banned) throw new ValidationError(gate.reason!);
      chat = deps.aiChat?.() ?? null;
      if (!chat) throw new ValidationError("No AI writer is set up. Add an AI key in Settings, or use the hook ideas without AI.");
    }
    const copies = await writeVariants({ clip, creatorName: sources.get(clip.sourceId).creatorName, count: 4, prefer: [], chat });
    res.json(copies.filter((c) => c.hook && c.hook !== clip.hook));
  });

  if (templates) {
    r.get("/templates", (_req, res) => {
      res.json(templates.list());
    });
    r.post("/templates", (req, res) => {
      res.status(201).json(templates.create(parseTemplate(req.body)));
    });
    r.put("/templates/:id", (req, res) => {
      res.json(templates.update(idParam(req.params.id), parseTemplate(req.body)));
    });
    r.delete("/templates/:id", (req, res) => {
      templates.remove(idParam(req.params.id));
      res.status(204).end();
    });
  }
  return r;
}
