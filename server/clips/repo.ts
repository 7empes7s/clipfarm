import { rmSync } from "node:fs";
import type { Db } from "../db/index.js";
import type { Clip, ClipEditInput, ClipEffects, ClipLayout, ClipQuality, ClipStatus, RejectReason, Word } from "../../shared/types.js";
import { DEFAULT_EFFECTS } from "../../shared/types.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { retimeCaptions } from "./edit.js";

interface ClipRow {
  id: number;
  source_id: number;
  vod_id: number | null;
  title: string;
  hook: string;
  reason: string;
  score: number | null;
  file_path: string;
  duration_sec: number;
  status: ClipStatus;
  reject_reason: RejectReason | null;
  layout: ClipLayout;
  caption_words: string;
  master_path: string | null;
  master_duration_sec: number | null;
  start_sec: number;
  end_sec: number | null;
  version: number;
  effects: string;
  peak_sec: number | null;
  quality: string | null;
  post_count?: number;
  live_stream_sec: number | null;
  live_moment_at: string | null;
  live_latency_sec: number | null;
  experiment?: number;
  proof?: number;
  created_at: string;
}

export interface NewClip {
  sourceId: number;
  vodId: number | null;
  title: string;
  filePath: string;
  durationSec: number;
  hook?: string;
  reason?: string;
  score?: number | null;
  layout?: ClipLayout;
  /** Timed in master seconds. */
  captionWords?: Word[];
  /** The longer source section the clip was cut from; without it the clip file is its own master. */
  masterPath?: string | null;
  masterDurationSec?: number | null;
  startSec?: number;
  endSec?: number | null;
  /** Where the reaction peaks, in master seconds (the punch-in zoom lands there). */
  peakSec?: number | null;
  quality?: ClipQuality | null;
  /** Cut from a stream that was still live: where in the stream, and when the moment happened. */
  live?: { streamSec: number; momentAt: string } | null;
}

/** What the renderer needs to make a new version of a clip. */
export interface RenderInput {
  clipId: number;
  sourceId: number;
  masterPath: string;
  startSec: number;
  endSec: number;
  layout: ClipLayout;
  hook: string;
  captionWords: Word[];
  effects: ClipEffects;
  /** Master seconds; null when the peak was never measured. */
  peakSec: number | null;
}

export type ReviewAction = "approve" | "reject";

function toClip(r: ClipRow): Clip {
  return {
    id: r.id,
    sourceId: r.source_id,
    vodId: r.vod_id,
    title: r.title,
    hook: r.hook,
    reason: r.reason,
    score: r.score,
    durationSec: r.duration_sec,
    status: r.status,
    rejectReason: r.reject_reason,
    layout: r.layout,
    startSec: r.start_sec,
    endSec: r.end_sec ?? r.start_sec + r.duration_sec,
    masterDurationSec: r.master_duration_sec ?? r.duration_sec,
    captionWords: JSON.parse(r.caption_words) as Word[],
    effects: { ...DEFAULT_EFFECTS, ...(JSON.parse(r.effects) as Partial<ClipEffects>) },
    quality: r.quality ? (JSON.parse(r.quality) as ClipQuality) : null,
    postCount: r.post_count ?? 0,
    experiment: r.experiment === 1,
    proof: r.proof === 1,
    videoUrl: `/api/clips/${r.id}/video?v=${r.version}`,
    masterUrl: `/api/clips/${r.id}/master`,
    live:
      r.live_moment_at === null
        ? null
        : { streamSec: r.live_stream_sec ?? 0, momentAt: r.live_moment_at, latencySec: r.live_latency_sec ?? 0 },
    createdAt: r.created_at,
  };
}

// "In force" for a permission: not on hold, and no end date or one after @now (ISO timestamps compare as text).
const IN_FORCE = "p.source_id = clips.source_id AND p.review_reason IS NULL AND (p.expires_at IS NULL OR p.expires_at > @now)";
// experiment: the source's records in force are all experiments (see isExperimentOnly).
const SELECT = `SELECT clips.*, (SELECT COUNT(*) FROM posts WHERE posts.clip_id = clips.id) AS post_count,
  (EXISTS (SELECT 1 FROM permissions p WHERE ${IN_FORCE} AND p.kind = 'experiment')
    AND NOT EXISTS (SELECT 1 FROM permissions p WHERE ${IN_FORCE} AND p.kind != 'experiment')) AS experiment,
  EXISTS (SELECT 1 FROM proof_runs r WHERE r.vod_id = clips.vod_id) AS proof
  FROM clips`;

export class ClipsRepo {
  constructor(
    private db: Db,
    private now: () => Date = () => new Date(),
  ) {}

  create(c: NewClip): Clip {
    const now = this.now();
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO clips (source_id, vod_id, title, file_path, duration_sec, hook, reason, score, layout, caption_words,
           master_path, master_duration_sec, start_sec, end_sec, peak_sec, quality,
           live_stream_sec, live_moment_at, live_latency_sec, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.sourceId,
        c.vodId,
        c.title,
        c.filePath,
        c.durationSec,
        c.hook ?? "",
        c.reason ?? "",
        c.score ?? null,
        c.layout ?? "center",
        JSON.stringify(c.captionWords ?? []),
        c.masterPath ?? null,
        c.masterDurationSec ?? null,
        c.startSec ?? 0,
        c.endSec ?? null,
        c.peakSec ?? null,
        c.quality ? JSON.stringify(c.quality) : null,
        c.live?.streamSec ?? null,
        c.live?.momentAt ?? null,
        // Moment to Inbox: the clip exists (and shows in the Inbox) from this insert on.
        c.live ? Math.max(0, Math.round((now.getTime() - new Date(c.live.momentAt).getTime()) / 1000)) : null,
        now.toISOString(),
      );
    return this.get(Number(lastInsertRowid));
  }

  private row(id: number): ClipRow {
    const row = this.db.prepare(`${SELECT} WHERE clips.id = @id`).get({ id, now: this.now().toISOString() }) as ClipRow | undefined;
    if (!row) throw new NotFoundError("That clip was not found.");
    return row;
  }

  get(id: number): Clip {
    return toClip(this.row(id));
  }

  /** Server-side path of the MP4; never sent to the client. */
  filePath(id: number): string {
    return this.row(id).file_path;
  }

  /** Server-side path of the source section the clip is cut from. */
  masterPath(id: number): string {
    const r = this.row(id);
    return r.master_path ?? r.file_path;
  }

  list(): Clip[] {
    return (this.db.prepare(`${SELECT} ORDER BY clips.id DESC`).all({ now: this.now().toISOString() }) as ClipRow[]).map(toClip);
  }

  setStatus(id: number, status: ClipStatus): Clip {
    this.row(id);
    this.db.prepare("UPDATE clips SET status = ?, reject_reason = NULL WHERE id = ?").run(status, id);
    return this.get(id);
  }

  /** Approves or rejects a clip and stores the decision (and reason) for tuning the picks later. */
  review(id: number, action: ReviewAction, reason: RejectReason | null = null): Clip {
    const r = this.row(id);
    if (r.status === "rendering") throw new ValidationError("A new version of this clip is being made. Review it when it is back.");
    if (action === "reject" && (r.post_count ?? 0) > 0) throw new ValidationError("This clip is already posted.");
    const status: ClipStatus = action === "approve" ? "approved" : "rejected";
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO clip_reviews (clip_id, action, reason, prev_status, prev_reject_reason, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(id, action, reason, r.status, r.reject_reason, this.now().toISOString());
      this.db.prepare("UPDATE clips SET status = ?, reject_reason = ? WHERE id = ?").run(status, reason, id);
    })();
    return this.get(id);
  }

  /** Takes back the latest approve or reject: the clip gets its old status back. */
  undoLastReview(): Clip {
    const last = this.db
      .prepare(
        "SELECT * FROM clip_reviews WHERE undone_at IS NULL AND action IN ('approve', 'reject') ORDER BY id DESC LIMIT 1",
      )
      .get() as { id: number; clip_id: number; prev_status: ClipStatus; prev_reject_reason: RejectReason | null } | undefined;
    if (!last) throw new ValidationError("There is nothing to undo.");
    const r = this.row(last.clip_id);
    if ((r.post_count ?? 0) > 0) throw new ValidationError("This clip is already posted, so the approval stays.");
    if (r.status === "rendering") throw new ValidationError("A new version of this clip is being made. Wait for it first.");
    this.db.transaction(() => {
      this.db.prepare("UPDATE clip_reviews SET undone_at = ? WHERE id = ?").run(this.now().toISOString(), last.id);
      this.db.prepare("UPDATE clips SET status = ?, reject_reason = ? WHERE id = ?").run(last.prev_status, last.prev_reject_reason, r.id);
    })();
    return this.get(r.id);
  }

  /** Stored decisions, newest first (later used to tune picks). */
  reviews(clipId: number): { action: string; reason: string | null; undone: boolean }[] {
    return (
      this.db.prepare("SELECT action, reason, undone_at FROM clip_reviews WHERE clip_id = ? ORDER BY id DESC").all(clipId) as {
        action: string;
        reason: string | null;
        undone_at: string | null;
      }[]
    ).map((r) => ({ action: r.action, reason: r.reason, undone: r.undone_at !== null }));
  }

  /**
   * Saves an edit and marks the clip "rendering" until the new version is made. The first edit keeps
   * the original file as the master, so later trims can still reach the full section.
   */
  applyEdit(id: number, edit: ClipEditInput): Clip {
    const r = this.row(id);
    const before = toClip(r);
    const words = retimeCaptions(before.captionWords, edit.captionText, before.startSec, before.endSec);
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO clip_reviews (clip_id, action, reason, prev_status, prev_reject_reason, created_at) VALUES (?, 'edit', NULL, ?, ?, ?)",
        )
        .run(id, r.status, r.reject_reason, this.now().toISOString());
      this.db
        .prepare(
          `UPDATE clips SET title = ?, hook = ?, caption_words = ?, layout = ?, start_sec = ?, end_sec = ?, effects = ?,
             status = 'rendering', reject_reason = NULL, master_path = COALESCE(master_path, file_path),
             master_duration_sec = COALESCE(master_duration_sec, duration_sec) WHERE id = ?`,
        )
        .run(edit.title, edit.hook, JSON.stringify(words), edit.layout, edit.startSec, edit.endSec, JSON.stringify(edit.effects), id);
    })();
    return this.get(id);
  }

  /** Applies the change the quality check suggested and marks the clip "rendering", like an edit. */
  applyFix(id: number): Clip {
    const r = this.row(id);
    const clip = toClip(r);
    if (clip.status === "rendering") throw new ValidationError("A new version of this clip is already being made.");
    if (clip.postCount > 0) throw new ValidationError("This clip is already posted, so it cannot be changed.");
    const fix = clip.quality?.fix;
    if (!fix) throw new ValidationError("There is no automatic fix for this clip. Use Edit.");
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO clip_reviews (clip_id, action, reason, prev_status, prev_reject_reason, created_at) VALUES (?, 'edit', NULL, ?, ?, ?)",
        )
        .run(id, r.status, r.reject_reason, this.now().toISOString());
      this.db
        .prepare(
          `UPDATE clips SET start_sec = ?, end_sec = ?, effects = ?, status = 'rendering', reject_reason = NULL,
             master_path = COALESCE(master_path, file_path),
             master_duration_sec = COALESCE(master_duration_sec, duration_sec) WHERE id = ?`,
        )
        .run(fix.startSec ?? clip.startSec, fix.endSec ?? clip.endSec, JSON.stringify({ ...clip.effects, ...fix.effects }), id);
    })();
    return this.get(id);
  }

  renderInput(id: number): RenderInput {
    const r = this.row(id);
    const clip = toClip(r);
    return {
      clipId: id,
      sourceId: r.source_id,
      masterPath: r.master_path ?? r.file_path,
      startSec: clip.startSec,
      endSec: clip.endSec,
      layout: r.layout,
      hook: r.hook,
      captionWords: clip.captionWords,
      effects: clip.effects,
      peakSec: r.peak_sec,
    };
  }

  /** Swaps in a newly rendered file (deleting the previous render, never the master) and puts the clip back in the inbox. */
  setRendered(id: number, filePath: string, durationSec: number, quality: ClipQuality | null = null): Clip {
    const r = this.row(id);
    this.db
      .prepare("UPDATE clips SET file_path = ?, duration_sec = ?, quality = ?, status = 'pending', version = version + 1 WHERE id = ?")
      .run(filePath, durationSec, quality ? JSON.stringify(quality) : null, id);
    if (r.file_path !== filePath && r.file_path !== (r.master_path ?? r.file_path)) rmSync(r.file_path, { force: true });
    return this.get(id);
  }

  /** Stores the result of the automatic check on the clip's current render. */
  setQuality(id: number, quality: ClipQuality): void {
    this.db.prepare("UPDATE clips SET quality = ? WHERE id = ?").run(JSON.stringify(quality), id);
  }

  /** When each approve or reject still in force was made, oldest first (review speed on the dashboard). */
  decisionTimes(): string[] {
    return (
      this.db
        .prepare("SELECT created_at FROM clip_reviews WHERE undone_at IS NULL AND action IN ('approve', 'reject') ORDER BY id")
        .all() as { created_at: string }[]
    ).map((r) => r.created_at);
  }

  countApproved(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM clips WHERE status = 'approved'").get() as { n: number }).n;
  }
}
