import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "./index.js";

/** Main's shipped migrations: everything except the last entry, which adds the trend radar and hook lab tables. */
const SHIPPED_ON_MAIN = MIGRATIONS.length - 1;

function tables(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
}

describe("migrate", () => {
  it("upgrades a database that already ran main's migrations", () => {
    const db = new Database(":memory:");
    for (const sql of MIGRATIONS.slice(0, SHIPPED_ON_MAIN)) db.exec(sql);
    db.pragma(`user_version = ${SHIPPED_ON_MAIN}`);
    // The shipped migrations keep their places: the job queue's worker row, the permission proof
    // columns, Live mode, Clip polish and Campaign import all come before the trend radar and hook lab tables.
    expect(tables(db)).toContain("queue_worker");
    expect(tables(db)).toContain("live_captures");
    expect((db.prepare("PRAGMA table_info(clips)").all() as { name: string }[]).map((c) => c.name)).toContain("quality");
    const permissionCols = (db.prepare("PRAGMA table_info(permissions)").all() as { name: string }[]).map((c) => c.name);
    expect(permissionCols).toContain("proof_url");
    expect(permissionCols).toContain("campaign_rules");
    expect(tables(db)).not.toContain("trend_videos");

    expect(() => migrate(db)).not.toThrow();
    expect(tables(db)).toEqual(expect.arrayContaining(["trend_videos", "hook_tests", "hook_variants"]));
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    db.close();
  });
});
