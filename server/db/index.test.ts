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

describe("migrate", () => {
  it("upgrades a database that main already took to version 15", () => {
    const db = new Database(":memory:");
    for (const sql of [...MIGRATIONS.slice(0, 13), ...SHIPPED_ON_MAIN]) db.exec(sql);
    db.pragma("user_version = 15");

    expect(() => migrate(db)).not.toThrow();

    expect(db.pragma("user_version", { simple: true })).toBe(17);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all();
    expect(tables).toEqual(expect.arrayContaining(["growth_campaigns", "growth_posts", "post_stats", "growth_recommendations"]));
    const postColumns = db.prepare("SELECT name FROM pragma_table_info('posts')").pluck().all();
    expect(postColumns).toEqual(expect.arrayContaining(["metrics", "whop_approved_at", "whop_paid_at"]));
    db.close();
  });
});
