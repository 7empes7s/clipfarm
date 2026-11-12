import type { Db } from "../db/index.js";
import type { Layout, Pick, PickFlags, PickStatus, StepTime } from "../../shared/types.js";
import { NotFoundError } from "../errors.js";

interface PickRow {
  id: number;
  vod_id: number;
  source_id: number;
  rank: number;
  start_sec: number;
  end_sec: number;
  title: string;
  hook: string;
  score: number;
  reason: string;
  flags: string;
  drop_reason: string | null;
  layout: Layout;
  status: PickStatus;
  error: string | null;
  cost_usd: number;
  steps: string;
  file_path: string | null;
  thumb_path: string | null;
  size_bytes: number | null;
  duration_sec: number | null;
  clip_id: number | null;
  created_at: string;
}

export interface NewPick {
  startSec: number;
  endSec: number;
  title: string;
  hook: string;
  score: number;
  reason: string;
  flags: PickFlags;
  dropReason: string | null;
  layout: Layout;
  costUsd: number;
  steps: StepTime[];
}

export interface RenderOutput {
  filePath: string;
  thumbPath: string;
  sizeBytes: number;
  durationSec: number;
  steps: StepTime[];
  /** The review/posting clip made from this render. */
  clipId: number;
}

function toPick(r: PickRow): Pick {
  const rendered = r.file_path !== null;
  return {
    id: r.id,
    vodId: r.vod_id,
    sourceId: r.source_id,
    rank: r.rank,
    startSec: r.start_sec,
    endSec: r.end_sec,
    title: r.title,
    hook: r.hook,
    score: r.score,
    reason: r.reason,
    flags: JSON.parse(r.flags) as PickFlags,
    dropReason: r.drop_reason,
    layout: r.layout,
    status: r.status,
    error: r.error,
    costUsd: r.cost_usd,
    steps: JSON.parse(r.steps) as StepTime[],
    sizeBytes: r.size_bytes,
    durationSec: r.duration_sec,
    videoUrl: rendered ? `/api/picks/${r.id}/video` : null,
    thumbUrl: r.thumb_path !== null ? `/api/picks/${r.id}/thumb` : null,
    clipId: r.clip_id,
    createdAt: r.created_at,
  };
}

export class PicksRepo {
  constructor(
    private db: Db,
    private now: () => Date = () => new Date(),
  ) {}

  /**
   * Replaces a VOD's picks that have no rendered file yet (so a retried picks job never leaves
   * duplicates). Dropped picks are stored too, with the reason, but are never queued to render.
   */
  replaceForVod(vodId: number, sourceId: number, picks: NewPick[]): Pick[] {
    const ts = this.now().toISOString();
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM picks WHERE vod_id = ? AND file_path IS NULL").run(vodId);
      const insert = this.db.prepare(
        `INSERT INTO picks (vod_id, source_id, rank, start_sec, end_sec, title, hook, score, reason, flags,
           drop_reason, layout, status, cost_usd, steps, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      picks.forEach((p, i) =>
        insert.run(
          vodId, sourceId, i + 1, p.startSec, p.endSec, p.title, p.hook, p.score, p.reason, JSON.stringify(p.flags),
          p.dropReason, p.layout, p.dropReason ? "dropped" : "picked", p.costUsd, JSON.stringify(p.steps), ts,
        ),
      );
    })();
    return this.listForVod(vodId);
  }

  private row(id: number): PickRow {
    const row = this.db.prepare("SELECT * FROM picks WHERE id = ?").get(id) as PickRow | undefined;
    if (!row) throw new NotFoundError("That clip was not found.");
    return row;
  }

  get(id: number): Pick {
    return toPick(this.row(id));
  }

  listForVod(vodId: number): Pick[] {
    return (this.db.prepare("SELECT * FROM picks WHERE vod_id = ? ORDER BY rank").all(vodId) as PickRow[]).map(toPick);
  }

  /** The newest VODs' picks first, best rank first within a VOD. */
  list(limit = 500): Pick[] {
    return (
      this.db.prepare("SELECT * FROM picks ORDER BY vod_id DESC, rank LIMIT ?").all(limit) as PickRow[]
    ).map(toPick);
  }

  /** Server-side paths of the clip and thumbnail; never sent to the client. */
  files(id: number): { video: string | null; thumb: string | null } {
    const r = this.row(id);
    return { video: r.file_path, thumb: r.thumb_path };
  }

  setStatus(id: number, status: PickStatus, error: string | null = null): void {
    this.db.prepare("UPDATE picks SET status = ?, error = ? WHERE id = ?").run(status, error, id);
  }

  saveRender(id: number, out: RenderOutput): Pick {
    this.db
      .prepare(
        `UPDATE picks SET status = 'rendered', error = NULL, file_path = ?, thumb_path = ?, size_bytes = ?,
           duration_sec = ?, steps = ?, clip_id = ? WHERE id = ?`,
      )
      .run(out.filePath, out.thumbPath, out.sizeBytes, out.durationSec, JSON.stringify(out.steps), out.clipId, id);
    return this.get(id);
  }
}
