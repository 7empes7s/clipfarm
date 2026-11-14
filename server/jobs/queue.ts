import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../db/index.js";
import type { Job, JobStatus } from "../../shared/types.js";
import { HttpError, NotFoundError, ValidationError } from "../errors.js";

export interface JobContext {
  job: Job;
  payload: unknown;
  /** A fresh temp folder, removed after the handler finishes, whether it succeeds or not. */
  tmpDir: string;
  /** Aborted when the job is cancelled. Pass it to child processes and fetches. */
  signal: AbortSignal;
  progress(fraction: number, message?: string): void;
}

export type JobHandler = (ctx: JobContext) => Promise<void>;

export interface JobQueueOptions {
  handlers: Record<string, JobHandler>;
  /** Where per-job temp folders are made. Defaults to the OS temp dir. */
  tmpRoot?: string;
  /** Called after a job ends for good (done, failed after its last try, or cancelled). */
  onFinished?: (job: Job, payload: unknown) => void;
  now?: () => Date;
  /** How often a started queue looks for jobs another process queued, and says it is still working. */
  pollMs?: number;
  /** How long a worker may stay silent before another process takes the queue over. */
  leaseMs?: number;
}

interface JobRow {
  id: number;
  type: string;
  payload: string;
  status: JobStatus;
  progress: number;
  message: string;
  error: string | null;
  attempts: number;
  max_attempts: number;
  cancel_requested: number;
  vod_id: number | null;
  clip_id: number | null;
  priority: number;
  workspace_id: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

function toJob(r: JobRow): Job {
  return {
    id: r.id,
    type: r.type,
    status: r.status,
    progress: r.progress,
    message: r.message,
    error: r.error,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    vodId: r.vod_id,
    clipId: r.clip_id,
    priority: r.priority,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

/**
 * Fair share between workspaces (us and each client) among jobs of the same priority: the
 * workspace whose last job started longest ago (or never) goes next, its oldest job first. One
 * client's long backlog never holds everyone else up, and with one workspace it is plain FIFO.
 */
export function pickFair(waiting: { id: number; workspaceId: number }[], lastStarted: Map<number, string>): number | undefined {
  let best: { id: number; at: string } | undefined;
  for (const j of [...waiting].sort((a, b) => a.id - b.id)) {
    const at = lastStarted.get(j.workspaceId) ?? "";
    if (!best || at < best.at) best = { id: j.id, at };
  }
  return best?.id;
}

/**
 * A persistent job queue in SQLite that runs ONE job at a time: the server box is shared,
 * so heavy work (downloads, ffmpeg, transcription) never runs in parallel. The next job is the
 * waiting one with the highest priority (oldest first among equals); a running job is never interrupted.
 *
 * That holds across processes too: only the queue that holds the lease (the `queue_worker` row)
 * runs jobs. The server holds it while it is up, so a job queued by `clipfarm-ops` is run by the
 * server; when no one has renewed the lease for `leaseMs`, the next started queue takes over.
 */
export class JobQueue {
  private draining: Promise<void> | null = null;
  private current: { id: number; controller: AbortController } | null = null;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private holdsLease = false;
  private readonly owner = randomUUID();
  private readonly tmpRoot: string;
  private readonly now: () => Date;
  private readonly pollMs: number;
  private readonly leaseMs: number;

  constructor(
    private db: Db,
    private opts: JobQueueOptions,
  ) {
    this.tmpRoot = opts.tmpRoot ?? tmpdir();
    this.now = opts.now ?? (() => new Date());
    this.pollMs = opts.pollMs ?? 2000;
    this.leaseMs = opts.leaseMs ?? 30_000;
  }

  /**
   * Starts working, and keeps looking for jobs queued by other processes. Jobs left "running" by
   * a crash go back in the queue once this queue holds the lease.
   */
  start(): void {
    this.stopped = false;
    this.timer ??= setInterval(() => {
      // A long job keeps the lease by renewing it here; an idle queue takes it and looks for work.
      if (this.current) this.takeLease();
      else void this.kick();
    }, this.pollMs);
    this.timer.unref();
    void this.kick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.current?.controller.abort();
    // A running job gives the lease back once it has wound down (see drainLoop).
    if (!this.draining) this.releaseLease();
  }

  /** True when this queue is the one that runs jobs right now. */
  get working(): boolean {
    return this.holdsLease;
  }

  /** When the process that runs jobs last said it is alive; null when none is. */
  workerSeenAt(): Date | null {
    const row = this.db.prepare("SELECT beat_at FROM queue_worker WHERE id = 1").get() as { beat_at: string } | undefined;
    if (!row || this.now().getTime() - new Date(row.beat_at).getTime() > this.leaseMs) return null;
    return new Date(row.beat_at);
  }

  /** Takes or renews the lease. False while another live process holds it. */
  private takeLease(): boolean {
    const now = this.now();
    const { changes } = this.db
      .prepare(
        `INSERT INTO queue_worker (id, owner, beat_at) VALUES (1, @owner, @now)
         ON CONFLICT(id) DO UPDATE SET owner = @owner, beat_at = @now
         WHERE queue_worker.owner = @owner OR queue_worker.beat_at < @stale`,
      )
      .run({ owner: this.owner, now: now.toISOString(), stale: new Date(now.getTime() - this.leaseMs).toISOString() });
    const held = changes === 1;
    if (held && !this.holdsLease) {
      // Newly ours: whatever is marked running belongs to a worker that is gone.
      this.db.prepare("UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running'").run(now.toISOString());
    }
    this.holdsLease = held;
    return held;
  }

  private releaseLease(): void {
    this.db.prepare("DELETE FROM queue_worker WHERE owner = ?").run(this.owner);
    this.holdsLease = false;
  }

  enqueue(
    type: string,
    payload: unknown,
    opts: { vodId?: number; clipId?: number; maxAttempts?: number; priority?: number; workspaceId?: number } = {},
  ): Job {
    if (!this.opts.handlers[type]) throw new Error(`No handler for job type "${type}"`);
    const ts = this.now().toISOString();
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO jobs (type, payload, status, max_attempts, vod_id, clip_id, priority, created_at, updated_at, workspace_id)
         VALUES (@type, @payload, 'queued', @maxAttempts, @vodId, @clipId, @priority, @ts, @ts, COALESCE(@workspaceId,
           (SELECT s.workspace_id FROM vods v JOIN sources s ON s.id = v.source_id WHERE v.id = @vodId),
           (SELECT s.workspace_id FROM clips c JOIN sources s ON s.id = c.source_id WHERE c.id = @clipId), 1))`,
      )
      .run({
        type,
        payload: JSON.stringify(payload ?? {}),
        maxAttempts: opts.maxAttempts ?? 3,
        vodId: opts.vodId ?? null,
        clipId: opts.clipId ?? null,
        priority: opts.priority ?? 0,
        ts,
        workspaceId: opts.workspaceId ?? null,
      });
    const job = this.get(Number(lastInsertRowid));
    if (!this.stopped) this.kick();
    return job;
  }

  get(id: number): Job {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
    if (!row) throw new NotFoundError("That job was not found.");
    return toJob(row);
  }

  list(limit = 50): Job[] {
    return (this.db.prepare("SELECT * FROM jobs ORDER BY id DESC LIMIT ?").all(limit) as JobRow[]).map(toJob);
  }

  /** Waiting jobs of one type, oldest first. */
  queued(type: string): Job[] {
    return (this.db.prepare("SELECT * FROM jobs WHERE status = 'queued' AND type = ? ORDER BY id").all(type) as JobRow[]).map(toJob);
  }

  /** Takes a waiting job out of the queue for a stated reason, which the job list shows. */
  skip(id: number, reason: string): Job {
    if (this.get(id).status === "queued") this.finish(id, "cancelled", { message: "Skipped", error: reason });
    return this.get(id);
  }

  cancel(id: number): Job {
    const job = this.get(id);
    if (job.status === "queued") {
      this.finish(id, "cancelled", { message: "Cancelled" });
    } else if (job.status === "running") {
      this.db.prepare("UPDATE jobs SET cancel_requested = 1 WHERE id = ?").run(id);
      if (this.current?.id === id) this.current.controller.abort();
    }
    return this.get(id);
  }

  /** Puts a failed or cancelled job back in the queue with fresh tries. */
  retry(id: number): Job {
    const job = this.get(id);
    if (job.status !== "failed" && job.status !== "cancelled") {
      throw new ValidationError("Only a failed or cancelled job can be tried again.");
    }
    this.db
      .prepare(
        `UPDATE jobs SET status = 'queued', attempts = 0, progress = 0, error = NULL, cancel_requested = 0,
           message = 'Waiting', updated_at = ? WHERE id = ?`,
      )
      .run(this.now().toISOString(), id);
    if (!this.stopped) this.kick();
    return this.get(id);
  }

  /** Starts working through the queue if it is not already. */
  kick(): Promise<void> {
    if (!this.draining) {
      this.draining = this.drainLoop().finally(() => {
        this.draining = null;
        // A job added after the loop saw an empty queue but before this ran (for example
        // enqueue() right after start()) found the old drain still set: pick it up now.
        // Only while this queue is the worker: another process's jobs are found by the timer.
        if (!this.stopped && this.holdsLease && this.hasQueued()) void this.kick();
      });
    }
    return this.draining;
  }

  /** Resolves when the queue has nothing left to run. */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private hasQueued(): boolean {
    return this.db.prepare("SELECT 1 FROM jobs WHERE status = 'queued' LIMIT 1").get() !== undefined;
  }

  private async drainLoop(): Promise<void> {
    while (!this.stopped && this.takeLease()) {
      const row = this.nextJob();
      if (!row) break;
      await this.runOne(row);
    }
    if (this.stopped) this.releaseLease();
  }

  /** The next job to run: highest priority first, then fair share between workspaces (see pickFair). */
  private nextJob(): JobRow | undefined {
    const top = this.db
      .prepare("SELECT * FROM jobs WHERE status = 'queued' AND priority = (SELECT MAX(priority) FROM jobs WHERE status = 'queued') ORDER BY id LIMIT 500")
      .all() as JobRow[];
    if (top.length <= 1) return top[0];
    const lastStarted = new Map(
      (this.db.prepare("SELECT workspace_id AS ws, MAX(started_at) AS at FROM jobs WHERE started_at IS NOT NULL GROUP BY workspace_id").all() as { ws: number; at: string }[]).map((r) => [r.ws, r.at]),
    );
    const id = pickFair(top.map((r) => ({ id: r.id, workspaceId: r.workspace_id })), lastStarted);
    return top.find((r) => r.id === id);
  }

  private async runOne(row: JobRow): Promise<void> {
    const handler = this.opts.handlers[row.type];
    const attempts = row.attempts + 1;
    this.db
      .prepare(
        "UPDATE jobs SET status = 'running', attempts = ?, progress = 0, error = NULL, message = 'Starting', updated_at = ?, started_at = ?, finished_at = NULL WHERE id = ?",
      )
      .run(attempts, this.now().toISOString(), this.now().toISOString(), row.id);

    const controller = new AbortController();
    this.current = { id: row.id, controller };
    let tmpDir: string | null = null;
    try {
      if (!handler) throw new Error(`No handler for job type "${row.type}"`);
      tmpDir = await mkdtemp(join(this.tmpRoot, `clipfarm-job-${row.id}-`));
      await handler({
        job: this.get(row.id),
        payload: JSON.parse(row.payload),
        tmpDir,
        signal: controller.signal,
        progress: (fraction, message) => {
          this.db
            .prepare("UPDATE jobs SET progress = ?, message = COALESCE(?, message), updated_at = ? WHERE id = ?")
            .run(Math.max(0, Math.min(1, fraction)), message ?? null, this.now().toISOString(), row.id);
        },
      });
      if (this.cancelRequested(row.id)) this.finish(row.id, "cancelled", { message: "Cancelled" });
      else this.finish(row.id, "done", { progress: 1, message: "Done" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.cancelRequested(row.id) || this.stopped) {
        if (this.stopped && !this.cancelRequested(row.id)) {
          // Server shutting down: leave it for the next start(), without counting this try.
          this.db
            .prepare("UPDATE jobs SET status = 'queued', attempts = ?, message = 'Waiting', updated_at = ? WHERE id = ?")
            .run(row.attempts, this.now().toISOString(), row.id);
        } else {
          this.finish(row.id, "cancelled", { message: "Cancelled" });
        }
      } else if (err instanceof HttpError || attempts >= row.max_attempts) {
        // HttpErrors (missing permission, bad input) will not fix themselves on a retry.
        this.finish(row.id, "failed", { error: message, message: "Failed" });
      } else {
        this.db
          .prepare("UPDATE jobs SET status = 'queued', error = ?, message = ?, updated_at = ? WHERE id = ?")
          .run(message, `Retrying (try ${attempts + 1} of ${row.max_attempts})`, this.now().toISOString(), row.id);
      }
    } finally {
      this.current = null;
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
    }
  }

  private cancelRequested(id: number): boolean {
    const r = this.db.prepare("SELECT cancel_requested FROM jobs WHERE id = ?").get(id) as { cancel_requested: number };
    return r.cancel_requested === 1;
  }

  private finish(
    id: number,
    status: "done" | "failed" | "cancelled",
    fields: { progress?: number; message: string; error?: string },
  ): void {
    this.db
      .prepare(
        "UPDATE jobs SET status = ?, progress = COALESCE(?, progress), message = ?, error = ?, updated_at = ?, finished_at = ? WHERE id = ?",
      )
      .run(status, fields.progress ?? null, fields.message, fields.error ?? null, this.now().toISOString(), this.now().toISOString(), id);
    if (this.opts.onFinished) {
      const { payload } = this.db.prepare("SELECT payload FROM jobs WHERE id = ?").get(id) as { payload: string };
      this.opts.onFinished(this.get(id), JSON.parse(payload));
    }
  }
}
