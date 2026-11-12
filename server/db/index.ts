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
  ALTER TABLE clips ADD COLUMN hook TEXT NOT NULL DEFAULT '';
  ALTER TABLE clips ADD COLUMN reason TEXT NOT NULL DEFAULT '';
  ALTER TABLE clips ADD COLUMN score REAL;
  ALTER TABLE clips ADD COLUMN layout TEXT NOT NULL DEFAULT 'center';
  ALTER TABLE clips ADD COLUMN caption_words TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE clips ADD COLUMN master_path TEXT;
  ALTER TABLE clips ADD COLUMN master_duration_sec REAL;
  ALTER TABLE clips ADD COLUMN start_sec REAL NOT NULL DEFAULT 0;
  ALTER TABLE clips ADD COLUMN end_sec REAL;
  ALTER TABLE clips ADD COLUMN reject_reason TEXT;
  ALTER TABLE clips ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE sources ADD COLUMN face_cam TEXT;
  ALTER TABLE jobs ADD COLUMN clip_id INTEGER REFERENCES clips(id);
  CREATE TABLE clip_reviews (
    id INTEGER PRIMARY KEY,
    clip_id INTEGER NOT NULL REFERENCES clips(id),
    action TEXT NOT NULL,
    reason TEXT,
    prev_status TEXT NOT NULL,
    prev_reject_reason TEXT,
    created_at TEXT NOT NULL,
    undone_at TEXT
  );
  CREATE INDEX clip_reviews_clip ON clip_reviews(clip_id);
  `,
  `
  CREATE TABLE watchlist (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    channels TEXT NOT NULL DEFAULT '[]',
    language TEXT NOT NULL DEFAULT '',
    games TEXT NOT NULL DEFAULT '[]',
    program TEXT NOT NULL DEFAULT 'none',
    program_url TEXT,
    note TEXT NOT NULL DEFAULT '',
    source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
    auto_ingest INTEGER NOT NULL DEFAULT 0,
    live TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE detected_vods (
    id INTEGER PRIMARY KEY,
    creator_id INTEGER NOT NULL REFERENCES watchlist(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    external_id TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    category TEXT,
    published_at TEXT NOT NULL,
    duration_sec REAL,
    status TEXT NOT NULL,
    skip_reason TEXT,
    vod_id INTEGER REFERENCES vods(id),
    created_at TEXT NOT NULL,
    UNIQUE (platform, external_id)
  );
  CREATE INDEX detected_vods_creator ON detected_vods(creator_id, published_at);
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
