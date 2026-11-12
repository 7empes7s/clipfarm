import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../db/index.js";
import type { Job, JobStatus } from "../../shared/types.js";
import { HttpError, NotFoundError } from "../errors.js";

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
  created_at: string;
  updated_at: string;
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
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * A persistent job queue in SQLite that runs ONE job at a time: the server box is shared,
 * so heavy work (downloads, ffmpeg, transcription) never runs in parallel.
 */
export class JobQueue {
  private draining: Promise<void> | null = null;
  private current: { id: number; controller: AbortController } | null = null;
  private stopped = false;
  private readonly tmpRoot: string;
  private readonly now: () => Date;

  constructor(
    private db: Db,
    private opts: JobQueueOptions,
  ) {
    this.tmpRoot = opts.tmpRoot ?? tmpdir();
    this.now = opts.now ?? (() => new Date());
  }

  /** Puts jobs left "running" by a crash back in the queue and starts working. */
  start(): void {
    this.db
      .prepare("UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running'")
      .run(this.now().toISOString());
    this.stopped = false;
    this.kick();
  }

  stop(): void {
    this.stopped = true;
    this.current?.controller.abort();
  }

  enqueue(type: string, payload: unknown, opts: { vodId?: number; maxAttempts?: number } = {}): Job {
    if (!this.opts.handlers[type]) throw new Error(`No handler for job type "${type}"`);
    const ts = this.now().toISOString();
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO jobs (type, payload, status, max_attempts, vod_id, created_at, updated_at)
         VALUES (?, ?, 'queued', ?, ?, ?, ?)`,
      )
      .run(type, JSON.stringify(payload ?? {}), opts.maxAttempts ?? 3, opts.vodId ?? null, ts, ts);
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

  /** Starts working through the queue if it is not already. */
  kick(): Promise<void> {
    if (!this.draining) {
      this.draining = this.drainLoop().finally(() => {
        this.draining = null;
      });
    }
    return this.draining;
  }

  /** Resolves when the queue has nothing left to run. */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private async drainLoop(): Promise<void> {
    while (!this.stopped) {
      const row = this.db
        .prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1")
        .get() as JobRow | undefined;
      if (!row) return;
      await this.runOne(row);
    }
  }

  private async runOne(row: JobRow): Promise<void> {
    const handler = this.opts.handlers[row.type];
    const attempts = row.attempts + 1;
    this.db
      .prepare(
        "UPDATE jobs SET status = 'running', attempts = ?, progress = 0, error = NULL, message = 'Starting', updated_at = ? WHERE id = ?",
      )
      .run(attempts, this.now().toISOString(), row.id);

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
        "UPDATE jobs SET status = ?, progress = COALESCE(?, progress), message = ?, error = ?, updated_at = ? WHERE id = ?",
      )
      .run(status, fields.progress ?? null, fields.message, fields.error ?? null, this.now().toISOString(), id);
    if (this.opts.onFinished) {
      const { payload } = this.db.prepare("SELECT payload FROM jobs WHERE id = ?").get(id) as { payload: string };
      this.opts.onFinished(this.get(id), JSON.parse(payload));
    }
  }
}
