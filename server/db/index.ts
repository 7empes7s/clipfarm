import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = Database.Database;

// Append-only: never edit a migration that has shipped, add a new one.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE sources (
    id INTEGER PRIMARY KEY,
    creator_name TEXT NOT NULL,
    channel_urls TEXT NOT NULL DEFAULT '[]',
    banned_content TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE permissions (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    campaign_url TEXT,
    brief_rules TEXT NOT NULL DEFAULT '',
    cpm_rate_usd REAL,
    min_views INTEGER,
    allowed_platforms TEXT NOT NULL DEFAULT '[]',
    expires_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX permissions_source ON permissions(source_id);
  CREATE TABLE vods (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id),
    url TEXT NOT NULL,
    status TEXT NOT NULL,
    title TEXT,
    duration_sec REAL,
    chapters TEXT NOT NULL DEFAULT '[]',
    transcriber TEXT,
    transcript_cost_usd REAL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE transcript_words (
    vod_id INTEGER NOT NULL REFERENCES vods(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    word TEXT NOT NULL,
    start_sec REAL NOT NULL,
    end_sec REAL NOT NULL,
    PRIMARY KEY (vod_id, idx)
  );
  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL,
    progress REAL NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '',
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    vod_id INTEGER REFERENCES vods(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX jobs_status ON jobs(status, id);
  `,
  `
  CREATE TABLE clips (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id),
    vod_id INTEGER REFERENCES vods(id),
    title TEXT NOT NULL,
    file_path TEXT NOT NULL,
    duration_sec REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
  );
  CREATE TABLE posts (
    id INTEGER PRIMARY KEY,
    clip_id INTEGER NOT NULL REFERENCES clips(id),
    permission_id INTEGER NOT NULL REFERENCES permissions(id),
    platform TEXT NOT NULL,
    account_id TEXT NOT NULL,
    account_name TEXT NOT NULL,
    service TEXT NOT NULL,
    external_id TEXT,
    status TEXT NOT NULL,
    url TEXT,
    error TEXT,
    caption TEXT NOT NULL,
    scheduled_at TEXT NOT NULL,
    posted_at TEXT,
    views INTEGER,
    views_updated_at TEXT,
    views_source TEXT,
    whop_submitted_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX posts_account ON posts(account_id, scheduled_at);
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE sources ADD COLUMN face_cam TEXT;
  ALTER TABLE sources ADD COLUMN frame_path TEXT;
  ALTER TABLE vods ADD COLUMN loudness TEXT NOT NULL DEFAULT '[]';
  CREATE TABLE picks (
    id INTEGER PRIMARY KEY,
    vod_id INTEGER NOT NULL REFERENCES vods(id) ON DELETE CASCADE,
    source_id INTEGER NOT NULL REFERENCES sources(id),
    rank INTEGER NOT NULL,
    start_sec REAL NOT NULL,
    end_sec REAL NOT NULL,
    title TEXT NOT NULL,
    hook TEXT NOT NULL,
    score REAL NOT NULL,
    reason TEXT NOT NULL,
    flags TEXT NOT NULL,
    drop_reason TEXT,
    layout TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    cost_usd REAL NOT NULL DEFAULT 0,
    steps TEXT NOT NULL DEFAULT '[]',
    file_path TEXT,
    thumb_path TEXT,
    size_bytes INTEGER,
    duration_sec REAL,
    clip_id INTEGER REFERENCES clips(id),
    created_at TEXT NOT NULL
  );
  CREATE INDEX picks_vod ON picks(vod_id, rank);
  `,
];

export function migrate(db: Db): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

/** Opens (and migrates) a database. Pass ":memory:" in tests. */
export function openDb(file: string): Db {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}
