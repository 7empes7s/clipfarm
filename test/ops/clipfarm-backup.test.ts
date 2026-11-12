import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = new URL('../../ops/clipfarm/backup.sh', import.meta.url).pathname;
const repo = new URL('../..', import.meta.url).pathname;

describe('ops/clipfarm/backup.sh', () => {
  let root: string;
  let backups: string;
  let data: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'clipfarm-backup-test-'));
    backups = join(root, 'backups');
    data = join(root, 'data');
    mkdirSync(backups);
    mkdirSync(join(data, 'media', 'clips'), { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function run(day: string) {
    return execFileSync('bash', [script], {
      env: { ...process.env, BACKUP_ROOT: backups, DATA_DIR: data, CLIPFARM_APP_DIR: repo, CLIPFARM_USER: userInfo().username, BACKUP_DAY: day },
      encoding: 'utf8',
    });
  }

  /** A live database the way the server keeps it: WAL mode, with rows that are still only in the WAL. */
  function liveDb() {
    const db = new Database(join(data, 'clipfarm.db'));
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE clips (id INTEGER PRIMARY KEY, title TEXT)');
    db.prepare('INSERT INTO clips (title) VALUES (?)').run('He did NOT expect that');
    return db;
  }

  it('writes a gzipped, consistent copy of the open database and leaves the media out', () => {
    const db = liveDb();
    writeFileSync(join(data, 'media', 'clips', 'pick-1.mp4'), 'video');
    run('2026-11-12');
    db.close();

    const dayDir = join(backups, '2026-11-12');
    expect(readdirSync(dayDir)).toEqual(['clipfarm.db.gz']);
    expect(readdirSync(data).filter((f) => f.includes('backup'))).toEqual([]);
    expect(statSync(join(dayDir, 'clipfarm.db.gz')).mode & 0o777).toBe(0o600);

    const restored = join(root, 'restored.db');
    writeFileSync(restored, gunzipSync(readFileSync(join(dayDir, 'clipfarm.db.gz'))));
    const copy = new Database(restored, { readonly: true });
    expect(copy.prepare('SELECT title FROM clips').all()).toEqual([{ title: 'He did NOT expect that' }]);
    copy.close();
  });

  it('keeps only the 3 newest clipfarm backups and leaves other backups alone', () => {
    const db = liveDb();
    for (const day of ['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11']) {
      mkdirSync(join(backups, day));
      writeFileSync(join(backups, day, 'postiz.sql.gz'), 'other backup');
      run(day);
    }
    db.close();

    const withClipfarm = readdirSync(backups).filter((d) => existsSync(join(backups, d, 'clipfarm.db.gz')));
    expect(withClipfarm.sort()).toEqual(['2026-11-09', '2026-11-10', '2026-11-11']);
    expect(existsSync(join(backups, '2026-11-08', 'postiz.sql.gz'))).toBe(true);
  });

  it('fails and leaves no partial file when there is no database', () => {
    expect(() => run('2026-11-12')).toThrow();
    expect(readdirSync(join(backups, '2026-11-12'))).toEqual([]);
  });
});
