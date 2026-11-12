/**
 * Frees disk: deletes the video files (render, master, thumbnail) of clips that were rejected more
 * than `keepDays` ago. Pending and approved clips are never touched, and the database is only read:
 * a cleaned-up clip stays in the lists, its video just says it is no longer there.
 */
import { existsSync, rmSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import Database from 'better-sqlite3';

export interface MediaCleanupOptions {
  dbFile: string;
  mediaDir: string;
  /** Days a rejected clip keeps its files (time to undo the reject). */
  keepDays: number;
  now?: Date;
  /** List what would be deleted, delete nothing. */
  dryRun?: boolean;
}

export interface MediaCleanupResult {
  removed: string[];
  bytes: number;
}

interface ClipFiles {
  file_path: string;
  master_path: string | null;
}

export function cleanupMedia(options: MediaCleanupOptions): MediaCleanupResult {
  const { dbFile, keepDays, now = new Date(), dryRun = false } = options;
  const mediaDir = resolve(options.mediaDir);
  const cutoff = new Date(now.getTime() - keepDays * 86_400_000).toISOString();

  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  let stale: ClipFiles[];
  let inUse: ClipFiles[];
  try {
    // Rejected, and the latest reject that still stands is older than the cutoff.
    const staleWhere = `status = 'rejected' AND (
      SELECT MAX(created_at) FROM clip_reviews r
      WHERE r.clip_id = clips.id AND r.action = 'reject' AND r.undone_at IS NULL
    ) < ?`;
    stale = db.prepare(`SELECT file_path, master_path FROM clips WHERE ${staleWhere}`).all(cutoff) as ClipFiles[];
    inUse = db.prepare(`SELECT file_path, master_path FROM clips WHERE NOT (${staleWhere})`).all(cutoff) as ClipFiles[];
  } finally {
    db.close();
  }

  const paths = (rows: ClipFiles[]) =>
    rows.flatMap((r) => [r.file_path, r.master_path, r.file_path.replace(/\.mp4$/, '.jpg')]).filter((p): p is string => !!p);
  const keep = new Set(paths(inUse).map((p) => resolve(p)));

  const result: MediaCleanupResult = { removed: [], bytes: 0 };
  for (const path of new Set(paths(stale).map((p) => resolve(p)))) {
    if (keep.has(path) || !path.startsWith(mediaDir + sep) || !existsSync(path)) continue;
    result.bytes += statSync(path).size;
    if (!dryRun) rmSync(path);
    result.removed.push(path);
  }
  return result;
}
