import { rmSync } from "node:fs";
import type { Db } from "../db/index.js";
import type { Output, OutputChapter, OutputFormat, TimeRange } from "../../shared/creator.js";
import { NotFoundError } from "../errors.js";

interface Row {
  id: number;
  vod_id: number;
  source_id: number;
  format: OutputFormat;
  ranges: string;
  status: Output["status"];
  error: string | null;
  file_path: string | null;
  thumb_path: string | null;
  duration_sec: number | null;
  title: string;
  description: string;
  chapters: string;
  created_at: string;
}

function toOutput(r: Row): Output {
  return {
    id: r.id,
    vodId: r.vod_id,
    sourceId: r.source_id,
    format: r.format,
    ranges: JSON.parse(r.ranges) as TimeRange[],
    status: r.status,
    error: r.error,
    durationSec: r.duration_sec,
    title: r.title,
    description: r.description,
    chapters: JSON.parse(r.chapters) as OutputChapter[],
    videoUrl: r.file_path ? `/api/outputs/${r.id}/video` : null,
    thumbUrl: r.thumb_path ? `/api/outputs/${r.id}/thumb` : null,
    createdAt: r.created_at,
  };
}

/** The square, wide, best-of and audiogram outputs of long videos. */
export class OutputsRepo {
  constructor(
    private db: Db,
    private now: () => Date = () => new Date(),
  ) {}

  /** A new plan for a video: its old outputs (and their files) make way for the new, waiting ones. */
  replaceForVod(vodId: number, sourceId: number, planned: { format: OutputFormat; ranges: TimeRange[]; title: string }[]): Output[] {
    const old = this.db.prepare("SELECT file_path, thumb_path FROM outputs WHERE vod_id = ?").all(vodId) as { file_path: string | null; thumb_path: string | null }[];
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM outputs WHERE vod_id = ?").run(vodId);
      const insert = this.db.prepare("INSERT INTO outputs (vod_id, source_id, format, ranges, title, created_at) VALUES (?, ?, ?, ?, ?, ?)");
      for (const p of planned) insert.run(vodId, sourceId, p.format, JSON.stringify(p.ranges), p.title, this.now().toISOString());
    })();
    for (const o of old) for (const f of [o.file_path, o.thumb_path]) if (f) rmSync(f, { force: true });
    return this.listForVod(vodId);
  }

  finish(id: number, done: { filePath: string; thumbPath: string; durationSec: number; title: string; description: string; chapters: OutputChapter[] }): void {
    this.db
      .prepare("UPDATE outputs SET status = 'done', error = NULL, file_path = ?, thumb_path = ?, duration_sec = ?, title = ?, description = ?, chapters = ? WHERE id = ?")
      .run(done.filePath, done.thumbPath, done.durationSec, done.title, done.description, JSON.stringify(done.chapters), id);
  }

  fail(id: number, error: string): void {
    this.db.prepare("UPDATE outputs SET status = 'failed', error = ? WHERE id = ?").run(error, id);
  }

  listForVod(vodId: number): Output[] {
    return (this.db.prepare("SELECT * FROM outputs WHERE vod_id = ? ORDER BY id").all(vodId) as Row[]).map(toOutput);
  }

  /** A workspace's outputs, newest videos first. */
  listForWorkspace(workspaceId: number): Output[] {
    return (
      this.db
        .prepare("SELECT o.* FROM outputs o JOIN sources s ON s.id = o.source_id WHERE s.workspace_id = ? ORDER BY o.vod_id DESC, o.id")
        .all(workspaceId) as Row[]
    ).map(toOutput);
  }

  /** Server-side paths; never sent to the client. */
  files(id: number): { video: string | null; thumb: string | null; workspaceId: number } {
    const row = this.db
      .prepare("SELECT o.file_path, o.thumb_path, s.workspace_id FROM outputs o JOIN sources s ON s.id = o.source_id WHERE o.id = ?")
      .get(id) as { file_path: string | null; thumb_path: string | null; workspace_id: number } | undefined;
    if (!row) throw new NotFoundError("That output was not found.");
    return { video: row.file_path, thumb: row.thumb_path, workspaceId: row.workspace_id };
  }
}
