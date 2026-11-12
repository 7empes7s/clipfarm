import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = new URL('../../ops/postiz/backup.sh', import.meta.url).pathname;

describe('ops/postiz/backup.sh', () => {
  let root: string;
  let backups: string;
  let bin: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'postiz-backup-test-'));
    backups = join(root, 'backups');
    bin = join(root, 'bin');
    mkdirSync(backups);
    mkdirSync(bin);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** A fake `docker` that prints a SQL dump (or fails), so no container is needed. */
  function fakeDocker(body: string) {
    const path = join(bin, 'docker');
    writeFileSync(path, `#!/usr/bin/env bash\necho "$*" >> "${join(root, 'docker-args')}"\n${body}\n`);
    chmodSync(path, 0o755);
  }

  function run(day: string) {
    return execFileSync('bash', [script], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BACKUP_ROOT: backups, POSTIZ_DIR: root, BACKUP_DAY: day },
      encoding: 'utf8',
    });
  }

  it('writes a gzipped pg_dump of the Postiz database into BACKUP_ROOT/YYYY-MM-DD/postiz.sql.gz', () => {
    fakeDocker('echo "-- PostgreSQL database dump"; echo "CREATE TABLE posts ();"');
    run('2026-11-12');

    const file = join(backups, '2026-11-12', 'postiz.sql.gz');
    expect(gunzipSync(readFileSync(file)).toString()).toContain('CREATE TABLE posts');
    const args = readFileSync(join(root, 'docker-args'), 'utf8');
    expect(args).toContain(`compose --project-directory ${root} exec -T postiz-postgres pg_dump`);
    expect(readdirSync(join(backups, '2026-11-12'))).toEqual(['postiz.sql.gz']);
  });

  it('keeps only the 3 newest Postiz dumps and leaves other backups alone', () => {
    fakeDocker('echo "-- dump"');
    for (const day of ['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11']) {
      mkdirSync(join(backups, day));
      writeFileSync(join(backups, day, 'keel.sql.gz'), 'other backup');
      run(day);
    }

    const withPostiz = readdirSync(backups).filter((d) => existsSync(join(backups, d, 'postiz.sql.gz')));
    expect(withPostiz.sort()).toEqual(['2026-11-09', '2026-11-10', '2026-11-11']);
    expect(existsSync(join(backups, '2026-11-08', 'keel.sql.gz'))).toBe(true);
  });

  it('fails and leaves no partial file when the dump fails', () => {
    fakeDocker('echo "partial"; exit 1');
    expect(() => run('2026-11-12')).toThrow();
    expect(readdirSync(join(backups, '2026-11-12'))).toEqual([]);
  });
});
