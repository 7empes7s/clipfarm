import type { Db } from "../db/index.js";
import type { Clip, ClipStatus } from "../../shared/types.js";
import { NotFoundError } from "../errors.js";

interface ClipRow {
  id: number;
  source_id: number;
  vod_id: number | null;
  title: string;
  file_path: string;
  duration_sec: number;
  status: ClipStatus;
  created_at: string;
}

export interface NewClip {
  sourceId: number;
  vodId: number | null;
  title: string;
  filePath: string;
  durationSec: number;
}

function toClip(r: ClipRow): Clip {
  return {
    id: r.id,
    sourceId: r.source_id,
    vodId: r.vod_id,
    title: r.title,
    durationSec: r.duration_sec,
    status: r.status,
    videoUrl: `/api/clips/${r.id}/video`,
    createdAt: r.created_at,
  };
}

export class ClipsRepo {
  constructor(
    private db: Db,
    private now: () => Date = () => new Date(),
  ) {}

  create(c: NewClip): Clip {
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO clips (source_id, vod_id, title, file_path, duration_sec, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(c.sourceId, c.vodId, c.title, c.filePath, c.durationSec, this.now().toISOString());
    return this.get(Number(lastInsertRowid));
  }

  private row(id: number): ClipRow {
    const row = this.db.prepare("SELECT * FROM clips WHERE id = ?").get(id) as ClipRow | undefined;
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

  list(): Clip[] {
    return (this.db.prepare("SELECT * FROM clips ORDER BY id DESC").all() as ClipRow[]).map(toClip);
  }

  setStatus(id: number, status: ClipStatus): Clip {
    this.row(id);
    this.db.prepare("UPDATE clips SET status = ? WHERE id = ?").run(status, id);
    return this.get(id);
  }

  countApproved(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM clips WHERE status = 'approved'").get() as { n: number }).n;
  }
}
