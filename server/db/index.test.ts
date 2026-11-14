import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate, MIGRATIONS } from "./index.js";

/** Steps 13 and 14 as main shipped them before the growth lab; an install on main has run exactly these. */
const SHIPPED_ON_MAIN = [
  `
  ALTER TABLE permissions ADD COLUMN campaign_rules TEXT;
  ALTER TABLE permissions ADD COLUMN campaign_checked_at TEXT;
  ALTER TABLE posts ADD COLUMN whop_approved_at TEXT;
  ALTER TABLE posts ADD COLUMN whop_paid_at TEXT;
  `,
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
];

/** Everything main ships up to the proof runs; the submit window, creator mode, the publishing tables, the campaign payouts and the chat column come after those. */
const ALL_OF_MAIN = 21;

function tables(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
}

describe("migrate", () => {
  it("upgrades a database that main already took to version 15", () => {
    const db = new Database(":memory:");
    for (const sql of [...MIGRATIONS.slice(0, 13), ...SHIPPED_ON_MAIN]) db.exec(sql);
    db.pragma("user_version = 15");

    expect(() => migrate(db)).not.toThrow();

    // Step 16 is the growth lab, step 17 the trend radar and hook lab, step 18 the Google tables,
    // step 19 the campaign scout's table, step 20 the isolation groups, step 21 the proof runs,
    // step 22 the submit window.
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(tables(db)).toEqual(
      expect.arrayContaining([
        "growth_campaigns",
        "growth_posts",
        "post_stats",
        "growth_recommendations",
        "trend_videos",
        "hook_tests",
        "google_calls",
        "clip_thumbs",
        "isolation_groups",
        "scouted_campaigns",
        "proof_runs",
      ]),
    );
    const postColumns = db.prepare("SELECT name FROM pragma_table_info('posts')").pluck().all();
    expect(postColumns).toEqual(expect.arrayContaining(["metrics", "whop_approved_at", "whop_paid_at"]));
    db.close();
  });

  it("upgrades a database that already ran all of main's migrations", () => {
    const db = new Database(":memory:");
    for (const sql of MIGRATIONS.slice(0, ALL_OF_MAIN)) db.exec(sql);
    db.pragma(`user_version = ${ALL_OF_MAIN}`);
    // The shipped migrations keep their places: the job queue's worker row, the permission proof columns, Live mode,
    // Clip polish, Campaign import, the engine runs, the growth lab, the trend radar, the hook lab and the Google tables,
    // the scout's table, the isolation groups and the proof runs all come before the submit window.
    expect(tables(db)).toContain("queue_worker");
    expect(tables(db)).toContain("live_captures");
    expect(tables(db)).toContain("engine_runs");
    expect(tables(db)).toContain("growth_campaigns");
    expect((db.prepare("PRAGMA table_info(clips)").all() as { name: string }[]).map((c) => c.name)).toContain("quality");
    const permissionCols = (db.prepare("PRAGMA table_info(permissions)").all() as { name: string }[]).map((c) => c.name);
    expect(permissionCols).toContain("proof_url");
    expect(permissionCols).toContain("campaign_rules");
    expect(tables(db)).toEqual(expect.arrayContaining(["trend_videos", "hook_tests", "hook_variants", "google_calls", "clip_thumbs"]));
    expect(tables(db)).toContain("scouted_campaigns");
    expect(tables(db)).toEqual(expect.arrayContaining(["isolation_groups", "youtube_quota", "proof_runs"]));
    const postColsBefore = db.prepare("SELECT name FROM pragma_table_info('posts')").pluck().all();
    expect(postColsBefore).not.toContain("needs_submit");

    expect(() => migrate(db)).not.toThrow();
    // A waiting post keeps the video of its hook variant.
    expect(db.prepare("SELECT name FROM pragma_table_info('posts')").pluck().all()).toEqual(
      expect.arrayContaining(["group_id", "variant_file", "needs_submit", "held", "submit_missed_at", "whop_rejected_at", "retried_by"]),
    );
    expect(tables(db)).toEqual(expect.arrayContaining(["post_versions", "autopilot_rules", "autopilot_log"]));
    // Chat-spike picks: a VOD's chat replay, bucketed.
    expect(db.prepare("SELECT name FROM pragma_table_info('vods')").pluck().all()).toContain("chat");
    // Creator mode: workspaces ("Me" first), uploads, outputs, and the owner's dated tick on own-content records.
    expect(tables(db)).toEqual(expect.arrayContaining(["workspaces", "uploads", "outputs"]));
    expect(db.prepare("SELECT name FROM workspaces WHERE id = 1").pluck().get()).toBe("Me");
    expect(db.prepare("SELECT name FROM pragma_table_info('permissions')").pluck().all()).toEqual(expect.arrayContaining(["owner_name", "attested_at"]));
    for (const t of ["sources", "posting_accounts", "watchlist"]) {
      expect(db.prepare(`SELECT name FROM pragma_table_info('${t}')`).pluck().all()).toContain("workspace_id");
    }
    // Campaign payouts (the CSV import) come after the submit window.
    expect(tables(db)).toContain("campaign_payouts");
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    db.close();
  });
});
