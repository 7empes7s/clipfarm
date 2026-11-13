import type { ProofAskedBy, ProofKind, ProofMetrics, ProofProblem, ProofStatus, ProofTarget } from "../../shared/proof.js";
import type { Db } from "../db/index.js";
import { EMPTY_METRICS, type KeyCheck } from "./plan.js";

export interface RunOptions {
  /** Drill: how long to record, and whose stream (a name, a channel link or a source id); the first allowed live creator when empty. */
  minutes?: number;
  who?: string;
}

/** A proof run as stored (table `proof_runs`); the Proof card adds the clips and the checks. */
export interface StoredRun {
  id: number;
  kind: ProofKind;
  target: ProofTarget;
  askedBy: ProofAskedBy;
  status: ProofStatus;
  label: string;
  url: string | null;
  vodId: number | null;
  step: string;
  problems: ProofProblem[];
  metrics: ProofMetrics;
  options: RunOptions;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface Row {
  id: number;
  kind: ProofKind;
  target: ProofTarget;
  asked_by: ProofAskedBy;
  status: ProofStatus;
  label: string;
  url: string | null;
  vod_id: number | null;
  step: string;
  problems: string;
  metrics: string;
  options: string;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
}

function toRun(r: Row): StoredRun {
  return {
    id: r.id,
    kind: r.kind,
    target: r.target,
    askedBy: r.asked_by,
    status: r.status,
    label: r.label,
    url: r.url,
    vodId: r.vod_id,
    step: r.step,
    problems: JSON.parse(r.problems) as ProofProblem[],
    metrics: { ...EMPTY_METRICS, ...(JSON.parse(r.metrics) as Partial<ProofMetrics>) },
    options: JSON.parse(r.options) as RunOptions,
    requestedAt: r.requested_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

const KEYS_KEY = "proof_keys";
const TIMER_KEY = "proof_timer_at";

export class ProofRepo {
  constructor(private db: Db) {}

  add(kind: ProofKind, target: ProofTarget, askedBy: ProofAskedBy, at: Date, options: RunOptions = {}): StoredRun {
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO proof_runs (kind, target, asked_by, options, requested_at) VALUES (?, ?, ?, ?, ?)")
      .run(kind, target, askedBy, JSON.stringify(options), at.toISOString());
    return this.get(Number(lastInsertRowid));
  }

  get(id: number): StoredRun {
    return toRun(this.db.prepare("SELECT * FROM proof_runs WHERE id = ?").get(id) as Row);
  }

  /** Newest first. */
  list(limit = 200): StoredRun[] {
    return (this.db.prepare("SELECT * FROM proof_runs ORDER BY id DESC LIMIT ?").all(limit) as Row[]).map(toRun);
  }

  /** Waiting or running runs, oldest first. */
  open(): StoredRun[] {
    return (this.db.prepare("SELECT * FROM proof_runs WHERE status IN ('waiting', 'running') ORDER BY id").all() as Row[]).map(toRun);
  }

  /** Takes a waiting run; false when another worker took it first. */
  claim(id: number, at: Date): boolean {
    return this.db.prepare("UPDATE proof_runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'waiting'").run(at.toISOString(), id).changes === 1;
  }

  update(id: number, change: { label?: string; url?: string | null; vodId?: number | null; step?: string; metrics?: ProofMetrics }): void {
    const run = this.get(id);
    this.db
      .prepare("UPDATE proof_runs SET label = ?, url = ?, vod_id = ?, step = ?, metrics = ? WHERE id = ?")
      .run(
        change.label ?? run.label,
        change.url === undefined ? run.url : change.url,
        change.vodId === undefined ? run.vodId : change.vodId,
        change.step ?? run.step,
        JSON.stringify(change.metrics ?? run.metrics),
        id,
      );
  }

  finish(id: number, status: "passed" | "failed" | "skipped", step: string, problems: ProofProblem[], at: Date): void {
    this.db
      .prepare("UPDATE proof_runs SET status = ?, step = ?, problems = ?, finished_at = ? WHERE id = ?")
      .run(status, step, JSON.stringify(problems), at.toISOString(), id);
  }

  private setting<T>(key: string): T | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  }

  private saveSetting(key: string, value: unknown): void {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
  }

  /** The last test of every saved key; null before the first. */
  keys(): KeyCheck[] | null {
    return this.setting<KeyCheck[]>(KEYS_KEY);
  }

  saveKeys(keys: KeyCheck[]): void {
    this.saveSetting(KEYS_KEY, keys);
  }

  /** When the daily timer last started a proof. */
  timerAt(): string | null {
    return this.setting<string>(TIMER_KEY);
  }

  saveTimerAt(at: Date): void {
    this.saveSetting(TIMER_KEY, at.toISOString());
  }
}
