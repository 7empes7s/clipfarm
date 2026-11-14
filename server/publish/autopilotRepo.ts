import type { AutopilotAction, AutopilotRule, AutopilotStep } from "../../shared/publishing.js";
import type { Db } from "../db/index.js";
import { NotFoundError } from "../errors.js";

interface RuleRow {
  id: number;
  name: string;
  enabled: number;
  source_id: number | null;
  permission_id: number | null;
  min_score: number;
  needs_quality: number;
  account_ids: string;
  auto: number;
  burner_only: number;
  daily_cap: number;
  dry_run: number;
}

interface LogRow {
  rule_id: number;
  rule_name: string;
  clip_id: number;
  clip_title: string;
  account_id: string | null;
  account_name: string | null;
  action: AutopilotAction;
  at: string | null;
  reason: string;
  dry_run: number;
  created_at: string;
}

function toRule(r: RuleRow): AutopilotRule {
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled === 1,
    sourceId: r.source_id,
    permissionId: r.permission_id,
    minScore: r.min_score,
    needsQuality: r.needs_quality === 1,
    accountIds: JSON.parse(r.account_ids) as string[],
    auto: r.auto === 1,
    burnerOnly: r.burner_only === 1,
    dailyCap: r.daily_cap,
    dryRun: r.dry_run === 1,
  };
}

export type NewStep = Omit<AutopilotStep, "ruleName" | "createdAt">;

/** Autopilot rules, and what each one did (or, in dry run, would have done). */
export class AutopilotRepo {
  constructor(
    private db: Db,
    private now: () => Date = () => new Date(),
  ) {}

  list(): AutopilotRule[] {
    return (this.db.prepare("SELECT * FROM autopilot_rules ORDER BY id").all() as RuleRow[]).map(toRule);
  }

  get(id: number): AutopilotRule {
    const row = this.db.prepare("SELECT * FROM autopilot_rules WHERE id = ?").get(id) as RuleRow | undefined;
    if (!row) throw new NotFoundError("That rule was not found.");
    return toRule(row);
  }

  private values(r: Omit<AutopilotRule, "id">): unknown[] {
    return [
      r.name,
      r.enabled ? 1 : 0,
      r.sourceId,
      r.permissionId,
      r.minScore,
      r.needsQuality ? 1 : 0,
      JSON.stringify(r.accountIds),
      r.auto ? 1 : 0,
      r.burnerOnly ? 1 : 0,
      r.dailyCap,
      r.dryRun ? 1 : 0,
    ];
  }

  create(r: Omit<AutopilotRule, "id">): AutopilotRule {
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO autopilot_rules (name, enabled, source_id, permission_id, min_score, needs_quality, account_ids, auto, burner_only, daily_cap, dry_run, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(...this.values(r), this.now().toISOString());
    return this.get(Number(lastInsertRowid));
  }

  update(id: number, r: Omit<AutopilotRule, "id">): AutopilotRule {
    this.get(id);
    this.db
      .prepare(
        `UPDATE autopilot_rules SET name = ?, enabled = ?, source_id = ?, permission_id = ?, min_score = ?, needs_quality = ?, account_ids = ?,
           auto = ?, burner_only = ?, daily_cap = ?, dry_run = ? WHERE id = ?`,
      )
      .run(...this.values(r), id);
    return this.get(id);
  }

  remove(id: number): void {
    this.get(id);
    this.db.prepare("DELETE FROM autopilot_rules WHERE id = ?").run(id);
  }

  log(step: NewStep): void {
    this.db
      .prepare(
        `INSERT INTO autopilot_log (rule_id, clip_id, clip_title, account_id, account_name, action, at, reason, dry_run, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(step.ruleId, step.clipId, step.clipTitle, step.accountId, step.accountName, step.action, step.at, step.reason, step.dryRun ? 1 : 0, this.now().toISOString());
  }

  /** "<clipId>:<accountId>" pairs a rule already handled, in dry run or for real. */
  handled(ruleId: number, dryRun: boolean): Set<string> {
    const rows = this.db.prepare("SELECT clip_id, account_id FROM autopilot_log WHERE rule_id = ? AND dry_run = ?").all(ruleId, dryRun ? 1 : 0) as {
      clip_id: number;
      account_id: string | null;
    }[];
    return new Set(rows.map((r) => `${r.clip_id}:${r.account_id ?? ""}`));
  }

  /** Posts a rule made (or, in dry run, would have made) today (UTC). */
  doneToday(ruleId: number, dryRun: boolean): number {
    const day = this.now().toISOString().slice(0, 10);
    return this.db
      .prepare("SELECT COUNT(*) FROM autopilot_log WHERE rule_id = ? AND dry_run = ? AND action = 'post' AND substr(created_at, 1, 10) = ?")
      .pluck()
      .get(ruleId, dryRun ? 1 : 0, day) as number;
  }

  recent(limit = 30): AutopilotStep[] {
    return (
      this.db
        .prepare(`SELECT l.*, r.name AS rule_name FROM autopilot_log l JOIN autopilot_rules r ON r.id = l.rule_id ORDER BY l.id DESC LIMIT ?`)
        .all(limit) as LogRow[]
    ).map((r) => ({
      ruleId: r.rule_id,
      ruleName: r.rule_name,
      clipId: r.clip_id,
      clipTitle: r.clip_title,
      accountId: r.account_id,
      accountName: r.account_name,
      action: r.action,
      at: r.at,
      reason: r.reason,
      dryRun: r.dry_run === 1,
      createdAt: r.created_at,
    }));
  }
}
