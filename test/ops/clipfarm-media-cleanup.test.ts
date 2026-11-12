import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupMedia } from '../../ops/clipfarm/media-cleanup.ts';
import { openDb } from '../../server/db/index.js';

const NOW = new Date('2026-11-12T04:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe('ops/clipfarm/media-cleanup.ts', () => {
  let root: string;
  let media: string;
  let dbFile: string;
  let db: Database.Database;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'clipfarm-cleanup-test-'));
    media = join(root, 'media');
    dbFile = join(root, 'clipfarm.db');
    mkdirSync(join(media, 'clips'), { recursive: true });
    db = openDb(dbFile); // the server's real schema
    db.prepare("INSERT INTO sources (id, creator_name, created_at) VALUES (1, 'Streamer', ?)").run(daysAgo(60));
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  function file(name: string): string {
    const path = name.startsWith('/') ? name : join(media, 'clips', name);
    writeFileSync(path, 'video');
    return path;
  }

  /** A clip with its render, master and thumbnail on disk, and optionally a review `days` ago. */
  function clip(id: number, status: string, review?: { action: string; days: number; undone?: boolean }, master?: string) {
    const filePath = file(`pick-${id}.mp4`);
    const masterPath = master ?? file(`pick-${id}-master.mp4`);
    file(`pick-${id}.jpg`);
    db.prepare(
      `INSERT INTO clips (id, source_id, title, file_path, duration_sec, status, master_path, created_at)
       VALUES (?, 1, ?, ?, 20, ?, ?, ?)`,
    ).run(id, `clip ${id}`, filePath, status, masterPath, daysAgo(40));
    if (review) {
      db.prepare(
        "INSERT INTO clip_reviews (clip_id, action, reason, prev_status, created_at, undone_at) VALUES (?, ?, NULL, 'pending', ?, ?)",
      ).run(id, review.action, daysAgo(review.days), review.undone ? daysAgo(review.days) : null);
    }
    return { filePath, masterPath, thumb: join(media, 'clips', `pick-${id}.jpg`) };
  }

  const run = (dryRun = false) => cleanupMedia({ dbFile, mediaDir: media, keepDays: 14, now: NOW, dryRun });

  it('deletes the files of clips rejected more than 14 days ago', () => {
    const old = clip(1, 'rejected', { action: 'reject', days: 20 });
    const result = run();

    for (const path of Object.values(old)) expect(existsSync(path)).toBe(false);
    expect(result.removed.sort()).toEqual(Object.values(old).sort());
    expect(result.bytes).toBe(15);
  });

  it('keeps pending, approved and freshly rejected clips', () => {
    const kept = [
      clip(1, 'pending'),
      clip(2, 'approved', { action: 'approve', days: 30 }),
      clip(3, 'rejected', { action: 'reject', days: 3 }),
      clip(4, 'rendering', { action: 'edit', days: 30 }),
    ];
    expect(run().removed).toEqual([]);
    for (const files of kept) for (const path of Object.values(files)) expect(existsSync(path)).toBe(true);
  });

  it('goes by the latest reject that still stands: an old reject that was undone and redone last week keeps its files', () => {
    const files = clip(1, 'rejected', { action: 'reject', days: 30, undone: true });
    db.prepare(
      "INSERT INTO clip_reviews (clip_id, action, reason, prev_status, created_at) VALUES (1, 'reject', NULL, 'pending', ?)",
    ).run(daysAgo(5));
    expect(run().removed).toEqual([]);
    expect(existsSync(files.filePath)).toBe(true);
  });

  it('keeps a master that a clip still in use shares', () => {
    const shared = file('shared-master.mp4');
    const rejected = clip(1, 'rejected', { action: 'reject', days: 20 }, shared);
    clip(2, 'approved', { action: 'approve', days: 20 }, shared);

    run();
    expect(existsSync(rejected.filePath)).toBe(false);
    expect(existsSync(shared)).toBe(true);
  });

  it('never deletes outside the media folder, whatever the database says', () => {
    const outside = file(join(root, 'not-media.mp4'));
    const sneaky = join(media, 'clips', '..', '..', 'sneaky.mp4');
    file(join(root, 'sneaky.mp4'));
    db.prepare(
      `INSERT INTO clips (id, source_id, title, file_path, duration_sec, status, master_path, created_at)
       VALUES (1, 1, 'x', ?, 20, 'rejected', ?, ?)`,
    ).run(outside, sneaky, daysAgo(40));
    db.prepare(
      "INSERT INTO clip_reviews (clip_id, action, reason, prev_status, created_at) VALUES (1, 'reject', NULL, 'pending', ?)",
    ).run(daysAgo(20));

    expect(run().removed).toEqual([]);
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(join(root, 'sneaky.mp4'))).toBe(true);
  });

  it('only lists what it would delete on a dry run', () => {
    const old = clip(1, 'rejected', { action: 'reject', days: 20 });
    const result = run(true);
    expect(result.removed).toHaveLength(3);
    for (const path of Object.values(old)) expect(existsSync(path)).toBe(true);
  });
});
