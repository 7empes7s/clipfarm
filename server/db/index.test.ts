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

/** Everything main ships: all but the last entry, which adds the campaign scout's table. */
const ALL_OF_MAIN = MIGRATIONS.length - 1;

function tables(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
}

describe("migrate", () => {
  it("upgrades a database that main already took to version 15", () => {
    const db = new Database(":memory:");
    for (const sql of [...MIGRATIONS.slice(0, 13), ...SHIPPED_ON_MAIN]) db.exec(sql);
    db.pragma("user_version = 15");

    expect(() => migrate(db)).not.toThrow();

    // Every later step runs too (the trend radar/hook lab and Google tables came after the growth lab's).
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(tables(db)).toEqual(
      expect.arrayContaining(["growth_campaigns", "growth_posts", "post_stats", "growth_recommendations", "google_calls", "clip_thumbs"]),
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
    // Clip polish, Campaign import, the engine runs, the growth lab, the trend radar, the hook lab and the Google tables
    // all come before the scout's table.
    expect(tables(db)).toContain("queue_worker");
    expect(tables(db)).toContain("live_captures");
    expect(tables(db)).toContain("engine_runs");
    expect(tables(db)).toContain("growth_campaigns");
    expect((db.prepare("PRAGMA table_info(clips)").all() as { name: string }[]).map((c) => c.name)).toContain("quality");
    const permissionCols = (db.prepare("PRAGMA table_info(permissions)").all() as { name: string }[]).map((c) => c.name);
    expect(permissionCols).toContain("proof_url");
    expect(permissionCols).toContain("campaign_rules");
    expect(tables(db)).toEqual(expect.arrayContaining(["trend_videos", "hook_tests", "hook_variants", "google_calls", "clip_thumbs"]));
    expect(tables(db)).not.toContain("scouted_campaigns");

    expect(() => migrate(db)).not.toThrow();
    expect(tables(db)).toContain("scouted_campaigns");
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    db.close();
  });
});
