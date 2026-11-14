import type { Db } from "../db/index.js";
import type { OpsActivity } from "../../shared/ops.js";

/** The switches flipped in Operations. Kept in the database, so every process (server, clipfarm-ops) sees them. */
export type OpsSwitch = "worker_paused" | "publishing_paused";

interface ActivityRow {
  id: number;
  at: string;
  who: string;
  action: string;
  target: string;
  detail: string;
}

/** Operations' state: the pause switches, the last rollback seen, and the Activity list (who did what, when). */
export class OpsState {
  constructor(
    private db: Db,
    private now: () => Date = () => new Date(),
  ) {}

  private get(key: string): { value: string; updatedAt: string } | null {
    const row = this.db.prepare("SELECT value, updated_at FROM ops_state WHERE key = ?").get(key) as { value: string; updated_at: string } | undefined;
    return row ? { value: row.value, updatedAt: row.updated_at } : null;
  }

  private set(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO ops_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(key, value, this.now().toISOString());
  }

  /** Whether the switch is on, and since when (null: never flipped). */
  switchOf(name: OpsSwitch): { on: boolean; since: string | null } {
    const row = this.get(name);
    return { on: row?.value === "1", since: row?.updatedAt ?? null };
  }

  isOn(name: OpsSwitch): boolean {
    return this.get(name)?.value === "1";
  }

  setSwitch(name: OpsSwitch, on: boolean): void {
    this.set(name, on ? "1" : "0");
  }

  /** The newest rollback the auto-deploy reported; kept here because its status file only holds the last deploy. */
  lastRollback(): { sha: string; at: string; reason: string } | null {
    const row = this.get("last_rollback");
    return row ? (JSON.parse(row.value) as { sha: string; at: string; reason: string }) : null;
  }

  noteRollback(r: { sha: string; at: string; reason: string }): void {
    const known = this.lastRollback();
    if (!known || known.at < r.at) this.set("last_rollback", JSON.stringify(r));
  }

  log(who: string, action: string, target: string, detail = ""): void {
    this.db
      .prepare("INSERT INTO ops_activity (at, who, action, target, detail) VALUES (?, ?, ?, ?, ?)")
      .run(this.now().toISOString(), who.slice(0, 120), action, target.slice(0, 200), detail.slice(0, 300));
  }

  activity(limit = 50): OpsActivity[] {
    return (this.db.prepare("SELECT * FROM ops_activity ORDER BY id DESC LIMIT ?").all(limit) as ActivityRow[]).map((r) => ({ ...r }));
  }
}
