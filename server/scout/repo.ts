import { SCOUT_STATUSES, type ScoutFacts, type ScoutStatus } from "../../shared/scout.js";
import type { Db } from "../db/index.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { campaignKey } from "../sources/campaign/extract.js";

export interface ScoutRow {
  id: number;
  key: string;
  url: string;
  facts: ScoutFacts;
  status: ScoutStatus;
  notified: boolean;
  firstSeenAt: string;
  readAt: string;
}

interface DbRow {
  id: number;
  key: string;
  url: string;
  facts: string;
  status: ScoutStatus;
  notified: number;
  first_seen_at: string;
  read_at: string;
}

function toRow(r: DbRow): ScoutRow {
  return {
    id: r.id,
    key: r.key,
    url: r.url,
    facts: JSON.parse(r.facts) as ScoutFacts,
    status: r.status,
    notified: r.notified === 1,
    firstSeenAt: r.first_seen_at,
    readAt: r.read_at,
  };
}

/** The campaigns the scout has read, what the manager said about each, and the scout's own switches. */
export class ScoutRepo {
  constructor(private db: Db) {}

  /** Every campaign read so far, the one read longest ago first. */
  list(): ScoutRow[] {
    return (this.db.prepare("SELECT * FROM scouted_campaigns ORDER BY read_at, id").all() as DbRow[]).map(toRow);
  }

  /** Keeps what a campaign page said just now; a campaign seen before keeps its status. */
  save(url: string, facts: ScoutFacts, at: Date): void {
    this.db
      .prepare(
        `INSERT INTO scouted_campaigns (key, url, facts, first_seen_at, read_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET url = excluded.url, facts = excluded.facts, read_at = excluded.read_at`,
      )
      .run(campaignKey(url), url, JSON.stringify(facts), at.toISOString(), at.toISOString());
  }

  /** The campaign's page is gone. */
  remove(url: string): void {
    this.db.prepare("DELETE FROM scouted_campaigns WHERE key = ?").run(campaignKey(url));
  }

  setStatus(id: number, status: unknown): void {
    if (!SCOUT_STATUSES.includes(status as ScoutStatus)) throw new ValidationError("Pick what to do with this campaign.");
    const done = this.db.prepare("UPDATE scouted_campaigns SET status = ? WHERE id = ?").run(status, id);
    if (done.changes === 0) throw new NotFoundError("That campaign is no longer on the list.");
  }

  markNotified(ids: number[]): void {
    const mark = this.db.prepare("UPDATE scouted_campaigns SET notified = 1 WHERE id = ?");
    for (const id of ids) mark.run(id);
  }

  private setting(key: string): string | null {
    return (this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
  }

  private saveSetting(key: string, value: string): void {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** Auto mode: off until the manager turns it on. */
  auto(): boolean {
    return this.setting("scout_auto") === "1";
  }

  setAuto(on: boolean): void {
    this.saveSetting("scout_auto", on ? "1" : "0");
  }

  lastRun(): { at: string | null; error: string | null } {
    return { at: this.setting("scout_last_run"), error: this.setting("scout_last_error") || null };
  }

  markRun(at: Date, error: string | null): void {
    this.saveSetting("scout_last_run", at.toISOString());
    this.saveSetting("scout_last_error", error ?? "");
  }

  /** Joined campaigns (permission ids) whose budget notice already went out. */
  budgetNotified(): number[] {
    return JSON.parse(this.setting("scout_budget_notified") ?? "[]") as number[];
  }

  markBudgetNotified(permissionIds: number[]): void {
    this.saveSetting("scout_budget_notified", JSON.stringify([...new Set([...this.budgetNotified(), ...permissionIds])]));
  }
}
