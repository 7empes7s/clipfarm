import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = Database.Database;

// Append-only: never edit a migration that has shipped, add a new one.
export const MIGRATIONS: string[] = [
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
  ALTER TABLE vods ADD COLUMN loudness TEXT NOT NULL DEFAULT '[]';
  CREATE TABLE picks (
    -- AUTOINCREMENT: a re-run replaces picks, and a stale render job must never reach a new one.
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  `
  ALTER TABLE jobs ADD COLUMN started_at TEXT;
  ALTER TABLE jobs ADD COLUMN finished_at TEXT;
  CREATE TABLE account_stats (
    account_id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    name TEXT NOT NULL,
    followers TEXT NOT NULL DEFAULT '[]',
    views TEXT NOT NULL DEFAULT '[]',
    manual_followers TEXT NOT NULL DEFAULT '[]',
    fetched_at TEXT,
    demo INTEGER NOT NULL DEFAULT 0
  );
  `,
  `
  CREATE TABLE posting_accounts (
    account_id TEXT PRIMARY KEY,
    service TEXT NOT NULL,
    platform TEXT NOT NULL,
    name TEXT NOT NULL,
    handle TEXT,
    avatar_url TEXT,
    disabled INTEGER NOT NULL DEFAULT 0,
    listed INTEGER NOT NULL DEFAULT 1,
    role TEXT NOT NULL DEFAULT 'main',
    niche TEXT NOT NULL DEFAULT '',
    max_per_day INTEGER,
    min_gap_minutes INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1,
    health TEXT NOT NULL DEFAULT 'healthy',
    created_at TEXT NOT NULL
  );
  ALTER TABLE account_stats ADD COLUMN claims INTEGER;
  `,
  `
  -- Routing: the permission kinds an account takes (NULL: every kind) and the Whop campaigns pinned to it.
  ALTER TABLE posting_accounts ADD COLUMN takes TEXT;
  ALTER TABLE posting_accounts ADD COLUMN pinned_campaigns TEXT NOT NULL DEFAULT '[]';
  `,
  `
  ALTER TABLE permissions ADD COLUMN note TEXT NOT NULL DEFAULT '';
  ALTER TABLE posts ADD COLUMN claim_at TEXT;
  ALTER TABLE posts ADD COLUMN removal_at TEXT;
  ALTER TABLE posts ADD COLUMN strike_at TEXT;
  ALTER TABLE posting_accounts ADD COLUMN paused_reason TEXT;
  `,
  `
  -- Which process works the job queue right now (the server, or clipfarm-ops when it is down).
  CREATE TABLE queue_worker (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    owner TEXT NOT NULL,
    beat_at TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE permissions ADD COLUMN proof_url TEXT;
  ALTER TABLE permissions ADD COLUMN proof_quote TEXT;
  ALTER TABLE permissions ADD COLUMN proof_checked_at TEXT;
  ALTER TABLE permissions ADD COLUMN review_reason TEXT;
  `,
  `
  -- Live mode: jobs with a higher priority run first; streams recorded in rolling segments.
  ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX jobs_next ON jobs(status, priority DESC, id);
  ALTER TABLE clips ADD COLUMN live_stream_sec REAL;
  ALTER TABLE clips ADD COLUMN live_moment_at TEXT;
  ALTER TABLE clips ADD COLUMN live_latency_sec REAL;
  CREATE TABLE live_captures (
    id INTEGER PRIMARY KEY,
    creator_id INTEGER NOT NULL,
    source_id INTEGER NOT NULL REFERENCES sources(id),
    vod_id INTEGER NOT NULL REFERENCES vods(id),
    platform TEXT NOT NULL,
    handle TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    game TEXT,
    rank INTEGER NOT NULL,
    -- Seconds the stream had already run when the recording began.
    stream_offset_sec REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    end_reason TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    first_clip_at TEXT
  );
  CREATE INDEX live_captures_creator ON live_captures(creator_id, id);
  CREATE TABLE live_segments (
    id INTEGER PRIMARY KEY,
    capture_id INTEGER NOT NULL REFERENCES live_captures(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    -- Seconds from the start of the recording to the start of this segment.
    start_sec REAL NOT NULL,
    duration_sec REAL,
    file_path TEXT,
    status TEXT NOT NULL,
    note TEXT,
    job_id INTEGER,
    started_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX live_segments_capture ON live_segments(capture_id, idx);
  CREATE TABLE push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    keys TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  `
  -- Clip polish: the effects turned off per clip, where the reaction peaks in the master, and the
  -- result of the automatic check on the latest render.
  ALTER TABLE clips ADD COLUMN effects TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE clips ADD COLUMN peak_sec REAL;
  ALTER TABLE clips ADD COLUMN quality TEXT;
  `,
  `
  -- Campaign import: a campaign's rules (JSON), when its page was last read, and Whop's approval and payout taps.
  ALTER TABLE permissions ADD COLUMN campaign_rules TEXT;
  ALTER TABLE permissions ADD COLUMN campaign_checked_at TEXT;
  ALTER TABLE posts ADD COLUMN whop_approved_at TEXT;
  ALTER TABLE posts ADD COLUMN whop_paid_at TEXT;
  `,
  // Which engine handled what in each transcript and round of picks (the fallback chain).
  `
  CREATE TABLE engine_runs (
    id INTEGER PRIMARY KEY,
    vod_id INTEGER,
    kind TEXT NOT NULL,
    report TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX engine_runs_vod ON engine_runs(vod_id);
  `,
  `
  -- The growth lab: test campaigns, which post belongs to which variant, and each post's numbers over time.
  CREATE TABLE growth_campaigns (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    hypothesis TEXT NOT NULL DEFAULT '',
    config TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    paused_reason TEXT,
    note TEXT,
    started_at TEXT,
    resumed_at TEXT,
    ends_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE growth_posts (
    campaign_id INTEGER NOT NULL REFERENCES growth_campaigns(id) ON DELETE CASCADE,
    slot TEXT NOT NULL,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    variant_key TEXT NOT NULL,
    PRIMARY KEY (campaign_id, slot)
  );
  CREATE INDEX growth_posts_post ON growth_posts(post_id);
  CREATE TABLE post_stats (
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    offset_key TEXT NOT NULL,
    age_hours REAL NOT NULL,
    at TEXT NOT NULL,
    metrics TEXT NOT NULL,
    PRIMARY KEY (post_id, offset_key)
  );
  -- The latest reading of everything the platform said about a post (views stay in their own column).
  ALTER TABLE posts ADD COLUMN metrics TEXT;
  CREATE TABLE growth_recommendations (
    id INTEGER PRIMARY KEY,
    campaign_id INTEGER NOT NULL REFERENCES growth_campaigns(id) ON DELETE CASCADE,
    variant_key TEXT NOT NULL,
    text TEXT NOT NULL,
    detail TEXT NOT NULL,
    change TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    prev TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (campaign_id, variant_key)
  );
  `,
  `
  -- Trend radar: today's fastest short videos (titles and numbers only, never media).
  CREATE TABLE trend_videos (
    video_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    channel TEXT NOT NULL,
    duration_sec REAL,
    views INTEGER NOT NULL,
    published_at TEXT NOT NULL,
    views_per_hour INTEGER NOT NULL,
    streamer TEXT,
    moment_type TEXT NOT NULL,
    hook_pattern TEXT NOT NULL
  );
  -- Hook lab: one A/B test per clip, and its variants (each on its own burner account).
  CREATE TABLE hook_tests (
    id INTEGER PRIMARY KEY,
    clip_id INTEGER NOT NULL REFERENCES clips(id),
    status TEXT NOT NULL,
    note TEXT,
    ends_at TEXT,
    winner_variant_id INTEGER,
    main_posts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX hook_tests_clip ON hook_tests(clip_id);
  CREATE TABLE hook_variants (
    id INTEGER PRIMARY KEY,
    test_id INTEGER NOT NULL REFERENCES hook_tests(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    hook TEXT NOT NULL,
    title TEXT NOT NULL,
    pattern TEXT NOT NULL,
    account_id TEXT NOT NULL,
    account_name TEXT NOT NULL,
    -- NULL: variant A, which is the clip's own video.
    file_path TEXT,
    rendered INTEGER NOT NULL DEFAULT 0,
    post_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
    views_per_hour INTEGER
  );
  CREATE INDEX hook_variants_test ON hook_variants(test_id);
  -- The title and hook a post went out with when they are a hook variant's; NULL: the clip's own.
  ALTER TABLE posts ADD COLUMN variant_title TEXT;
  ALTER TABLE posts ADD COLUMN variant_hook TEXT;
  `,
  `
  -- Gemini on the Google credit: every call with its estimated cost, and the thumbnail options of a clip.
  CREATE TABLE google_calls (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    model TEXT NOT NULL,
    in_tokens INTEGER NOT NULL,
    out_tokens INTEGER NOT NULL,
    cost_eur REAL NOT NULL
  );
  CREATE INDEX google_calls_at ON google_calls(at);
  CREATE TABLE clip_thumbs (
    id INTEGER PRIMARY KEY,
    clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    ai INTEGER NOT NULL,
    cover_path TEXT NOT NULL,
    wide_path TEXT NOT NULL,
    chosen INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX clip_thumbs_clip ON clip_thumbs(clip_id);
  `,
  `
  -- Campaigns the scout read from public pages; "key" is the campaign link without query, hash or "www.".
  CREATE TABLE scouted_campaigns (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL,
    facts TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new',
    notified INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT NOT NULL,
    read_at TEXT NOT NULL
  );
  `,
  `
  -- Account isolation: groups of accounts that share developer apps and a way out to the internet.
  -- Keys and proxy addresses are in the secrets file, not here. A NULL group_id is the built-in
  -- group of the account's role (1 Main, 2 Burners).
  CREATE TABLE isolation_groups (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    proxy_check TEXT,
    created_at TEXT NOT NULL
  );
  INSERT INTO isolation_groups (id, name, kind, created_at) VALUES
    (1, 'Main', 'main', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    (2, 'Burners', 'burner', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  ALTER TABLE posting_accounts ADD COLUMN group_id INTEGER REFERENCES isolation_groups(id);
  ALTER TABLE posting_accounts ADD COLUMN token_expires_at TEXT;
  ALTER TABLE posts ADD COLUMN group_id INTEGER;
  ALTER TABLE posts ADD COLUMN exit_ip TEXT;
  ALTER TABLE posts ADD COLUMN note TEXT;
  -- The video of the hook variant a waiting upload goes out with; NULL: the clip's own video.
  ALTER TABLE posts ADD COLUMN variant_file TEXT;
  -- YouTube API units a group's app used, per Pacific day.
  CREATE TABLE youtube_quota (
    group_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    units INTEGER NOT NULL,
    PRIMARY KEY (group_id, day)
  );
  `,
  `
  -- The daily live proof and the launch drill: one row per video (or live stream) it ran on.
  -- vod_id has no foreign key: removing a source removes its videos, and the run's numbers stay.
  CREATE TABLE proof_runs (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    target TEXT NOT NULL,
    asked_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'waiting',
    label TEXT NOT NULL DEFAULT '',
    url TEXT,
    vod_id INTEGER,
    step TEXT NOT NULL DEFAULT '',
    problems TEXT NOT NULL DEFAULT '[]',
    metrics TEXT NOT NULL DEFAULT '{}',
    options TEXT NOT NULL DEFAULT '{}',
    requested_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );
  CREATE INDEX proof_runs_vod ON proof_runs(vod_id);
  `,
  `
  -- Submit window: a campaign post that has to be submitted by hand within 30 minutes of going live.
  -- "held" posts wait in clipfarm and are handed to the posting service when they are due.
  ALTER TABLE posts ADD COLUMN needs_submit INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE posts ADD COLUMN held INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE posts ADD COLUMN submit_notified_at TEXT;
  ALTER TABLE posts ADD COLUMN submit_reminded_at TEXT;
  ALTER TABLE posts ADD COLUMN submit_missed_at TEXT;
  `,
  `
  -- Creator mode. Workspaces: "Me" and each client, with their own sources, accounts and brand.
  CREATE TABLE workspaces (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    brand TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  INSERT INTO workspaces (id, name, created_at) VALUES (1, 'Me', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  ALTER TABLE sources ADD COLUMN workspace_id INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE posting_accounts ADD COLUMN workspace_id INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE watchlist ADD COLUMN workspace_id INTEGER NOT NULL DEFAULT 1;
  CREATE INDEX sources_workspace ON sources(workspace_id);
  -- "own-content": who owns the videos, and when the manager ticked "I own these videos or have the owner's OK".
  ALTER TABLE permissions ADD COLUMN owner_name TEXT;
  ALTER TABLE permissions ADD COLUMN attested_at TEXT;
  -- Video files sent from the phone or computer, in pieces, so a dropped connection resumes.
  CREATE TABLE uploads (
    id INTEGER PRIMARY KEY,
    workspace_id INTEGER NOT NULL,
    file_name TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    received_bytes INTEGER NOT NULL DEFAULT 0,
    path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'receiving',
    vod_id INTEGER,
    created_at TEXT NOT NULL
  );
  -- The other formats made from one long video: square and wide cuts, a best-of, audiograms.
  CREATE TABLE outputs (
    id INTEGER PRIMARY KEY,
    vod_id INTEGER NOT NULL REFERENCES vods(id) ON DELETE CASCADE,
    source_id INTEGER NOT NULL REFERENCES sources(id),
    format TEXT NOT NULL,
    ranges TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'waiting',
    error TEXT,
    file_path TEXT,
    thumb_path TEXT,
    duration_sec REAL,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    chapters TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );
  CREATE INDEX outputs_vod ON outputs(vod_id);
  `,
  `
  -- Cross-platform publishing: per-platform versions of a clip, autopilot rules and what they did,
  -- a campaign's rejection with its reason, and the post a failed post was tried again as.
  CREATE TABLE post_versions (
    clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    title TEXT NOT NULL,
    caption TEXT NOT NULL,
    hashtags TEXT NOT NULL,
    cover_id INTEGER,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (clip_id, platform)
  );
  CREATE TABLE autopilot_rules (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    source_id INTEGER,
    permission_id INTEGER,
    min_score REAL NOT NULL,
    needs_quality INTEGER NOT NULL,
    account_ids TEXT NOT NULL,
    auto INTEGER NOT NULL,
    burner_only INTEGER NOT NULL,
    daily_cap INTEGER NOT NULL,
    dry_run INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE autopilot_log (
    id INTEGER PRIMARY KEY,
    rule_id INTEGER NOT NULL REFERENCES autopilot_rules(id) ON DELETE CASCADE,
    clip_id INTEGER NOT NULL,
    clip_title TEXT NOT NULL,
    account_id TEXT,
    account_name TEXT,
    action TEXT NOT NULL,
    at TEXT,
    reason TEXT NOT NULL,
    dry_run INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX autopilot_log_rule ON autopilot_log(rule_id, created_at);
  ALTER TABLE posts ADD COLUMN whop_rejected_at TEXT;
  ALTER TABLE posts ADD COLUMN whop_reject_reason TEXT;
  ALTER TABLE posts ADD COLUMN retried_by INTEGER;
  `,
  `
  -- Campaign payouts read from a campaign's CSV export (Content Rewards has no clipper API): the views
  -- it counted, approved or rejected (with its reason) and what it paid, matched to our post by link.
  CREATE TABLE campaign_payouts (
    link_key TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    post_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
    views_counted INTEGER,
    status TEXT NOT NULL,
    payout_usd REAL,
    reason TEXT NOT NULL DEFAULT '',
    imported_at TEXT NOT NULL
  );
  CREATE INDEX campaign_payouts_post ON campaign_payouts(post_id);
  `,
  `
  -- Studio: a non-destructive edit list and look per clip, every export kept as a version, brand templates.
  ALTER TABLE clips ADD COLUMN cuts TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE clips ADD COLUMN look TEXT;
  CREATE TABLE clip_versions (
    id INTEGER PRIMARY KEY,
    clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    n INTEGER NOT NULL,
    label TEXT NOT NULL,
    file_path TEXT NOT NULL,
    duration_sec REAL NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX clip_versions_clip ON clip_versions(clip_id, n);
  CREATE TABLE brand_templates (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  `
  -- A VOD's chat replay in 10 s buckets (JSON), for chat-spike picks; NULL when it has no chat.
  ALTER TABLE vods ADD COLUMN chat TEXT;
  `,
  `
  -- Clipping as a service: plans, outside creators (one workspace each), their sign-ins, Stripe's
  -- events (each applied once) and invoices. Jobs carry their workspace, for the fair-share queue.
  CREATE TABLE service_plans (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE clients (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    workspace_id INTEGER NOT NULL UNIQUE REFERENCES workspaces(id),
    google_sub TEXT UNIQUE,
    plan_id TEXT,
    status TEXT NOT NULL DEFAULT 'none',
    stripe_customer_id TEXT UNIQUE,
    stripe_subscription_id TEXT,
    stripe_event_at INTEGER NOT NULL DEFAULT 0,
    period_start TEXT,
    period_end TEXT,
    auto_approve INTEGER NOT NULL DEFAULT 0,
    views_reported INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE client_sessions (
    token_hash TEXT PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    read_only INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE client_login_links (
    token_hash TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE,
    client_id INTEGER,
    read_only INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE stripe_events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    received_at TEXT NOT NULL
  );
  CREATE TABLE client_invoices (
    id TEXT PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    number TEXT,
    status TEXT NOT NULL,
    amount_due INTEGER NOT NULL,
    amount_paid INTEGER NOT NULL,
    tax INTEGER NOT NULL,
    currency TEXT NOT NULL,
    hosted_url TEXT,
    pdf_url TEXT,
    period_start TEXT,
    period_end TEXT,
    due_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX client_invoices_client ON client_invoices(client_id, created_at);
  ALTER TABLE jobs ADD COLUMN workspace_id INTEGER NOT NULL DEFAULT 1;
  `,
  `
  -- The streamer registry: who publicly pays for or allows clipping (with proof), and who has no program.
  CREATE TABLE streamer_registry (
    name TEXT PRIMARY KEY COLLATE NOCASE,
    status TEXT NOT NULL,
    program TEXT,
    proof_url TEXT,
    proof_quote TEXT,
    checked_at TEXT NOT NULL,
    next_check_at TEXT NOT NULL,
    last_result TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT ''
  );
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
