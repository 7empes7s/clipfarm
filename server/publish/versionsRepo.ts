import type { Platform } from "../../shared/types.js";
import type { Db } from "../db/index.js";
import type { VersionFields } from "./versions.js";

/** Per-platform versions of a clip saved in the sheet: title, caption, hashtags and cover. */
export class VersionsRepo {
  constructor(
    private db: Db,
    private now: () => Date = () => new Date(),
  ) {}

  get(clipId: number, platform: Platform): VersionFields | null {
    const row = this.db.prepare("SELECT title, caption, hashtags, cover_id FROM post_versions WHERE clip_id = ? AND platform = ?").get(clipId, platform) as
      | { title: string; caption: string; hashtags: string; cover_id: number | null }
      | undefined;
    return row ? { title: row.title, caption: row.caption, hashtags: JSON.parse(row.hashtags) as string[], coverId: row.cover_id } : null;
  }

  save(clipId: number, platform: Platform, v: VersionFields): void {
    this.db
      .prepare(
        `INSERT INTO post_versions (clip_id, platform, title, caption, hashtags, cover_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(clip_id, platform) DO UPDATE SET title = excluded.title, caption = excluded.caption, hashtags = excluded.hashtags,
           cover_id = excluded.cover_id, updated_at = excluded.updated_at`,
      )
      .run(clipId, platform, v.title, v.caption, JSON.stringify(v.hashtags), v.coverId, this.now().toISOString());
  }

  remove(clipId: number, platform: Platform): void {
    this.db.prepare("DELETE FROM post_versions WHERE clip_id = ? AND platform = ?").run(clipId, platform);
  }
}
