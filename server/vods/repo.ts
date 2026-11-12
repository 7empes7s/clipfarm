import type { Db } from "../db/index.js";
import type { Chapter, Vod, VodDetail, VodStatus, Word } from "../../shared/types.js";
import { NotFoundError } from "../errors.js";
import type { VodMeta } from "../pipeline/ingest/downloader.js";

interface VodRow {
  id: number;
  source_id: number;
  url: string;
  status: VodStatus;
  title: string | null;
  duration_sec: number | null;
  chapters: string;
  transcriber: string | null;
  transcript_cost_usd: number | null;
  created_at: string;
  word_count: number;
}

const SELECT = `SELECT v.*, (SELECT COUNT(*) FROM transcript_words w WHERE w.vod_id = v.id) AS word_count FROM vods v`;

function toVod(r: VodRow): Vod {
  return {
    id: r.id,
    sourceId: r.source_id,
    url: r.url,
    status: r.status,
    title: r.title,
    durationSec: r.duration_sec,
    chapters: JSON.parse(r.chapters) as Chapter[],
    transcriber: r.transcriber,
    transcriptCostUsd: r.transcript_cost_usd,
    wordCount: r.word_count,
    createdAt: r.created_at,
  };
}

export class VodsRepo {
  constructor(
    private db: Db,
    private now: () => Date = () => new Date(),
  ) {}

  create(sourceId: number, url: string): Vod {
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO vods (source_id, url, status, created_at) VALUES (?, ?, 'queued', ?)")
      .run(sourceId, url, this.now().toISOString());
    return this.get(Number(lastInsertRowid));
  }

  get(id: number): Vod {
    const row = this.db.prepare(`${SELECT} WHERE v.id = ?`).get(id) as VodRow | undefined;
    if (!row) throw new NotFoundError("That video was not found.");
    return toVod(row);
  }

  detail(id: number): VodDetail {
    const words = this.db
      .prepare("SELECT word, start_sec AS startSec, end_sec AS endSec FROM transcript_words WHERE vod_id = ? ORDER BY idx")
      .all(id) as Word[];
    return { ...this.get(id), words };
  }

  list(): Vod[] {
    return (this.db.prepare(`${SELECT} ORDER BY v.id DESC`).all() as VodRow[]).map(toVod);
  }

  setStatus(id: number, status: VodStatus): void {
    this.db.prepare("UPDATE vods SET status = ? WHERE id = ?").run(status, id);
  }

  saveMeta(id: number, meta: VodMeta): void {
    this.db
      .prepare("UPDATE vods SET title = ?, duration_sec = ?, chapters = ? WHERE id = ?")
      .run(meta.title, meta.durationSec, JSON.stringify(meta.chapters), id);
  }

  /** Replaces the transcript (so a retried job never leaves duplicates) and marks the video ready. */
  saveTranscript(id: number, words: Word[], transcriber: string, costUsd: number): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM transcript_words WHERE vod_id = ?").run(id);
      const insert = this.db.prepare(
        "INSERT INTO transcript_words (vod_id, idx, word, start_sec, end_sec) VALUES (?, ?, ?, ?, ?)",
      );
      words.forEach((w, i) => insert.run(id, i, w.word, w.startSec, w.endSec));
      this.db
        .prepare("UPDATE vods SET transcriber = ?, transcript_cost_usd = ?, status = 'ready' WHERE id = ?")
        .run(transcriber, costUsd, id);
    })();
  }
}
