import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "./index.js";

/** How many migrations main had shipped before the trend radar and hook lab tables were added. */
const SHIPPED_ON_MAIN = 11;

function tables(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
}

describe("migrate", () => {
  it("upgrades a database that already ran main's migrations", () => {
    const db = new Database(":memory:");
    for (const sql of MIGRATIONS.slice(0, SHIPPED_ON_MAIN)) db.exec(sql);
    db.pragma(`user_version = ${SHIPPED_ON_MAIN}`);
    // The shipped migrations keep their places: the job queue's worker row and the permission proof columns.
    expect(tables(db)).toContain("queue_worker");
    expect((db.prepare("PRAGMA table_info(permissions)").all() as { name: string }[]).map((c) => c.name)).toContain("proof_url");
    expect(tables(db)).not.toContain("trend_videos");

    expect(() => migrate(db)).not.toThrow();
    expect(tables(db)).toEqual(expect.arrayContaining(["trend_videos", "hook_tests", "hook_variants"]));
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    db.close();
  });
});
