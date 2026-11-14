import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../db/index.js";
import { ValidationError } from "../errors.js";
import { type JobHandler, JobQueue, pickFair } from "./queue.js";

let tmpRoot: string;
beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "clipfarm-queue-test-"));
});
afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

function makeQueue(handlers: Record<string, JobHandler>) {
  const db = openDb(":memory:");
  const finished: string[] = [];
  const queue = new JobQueue(db, { handlers, tmpRoot, onFinished: (j) => finished.push(`${j.id}:${j.status}`) });
  return { db, queue, finished };
}

describe("JobQueue", () => {
  it("runs one job at a time, in order", async () => {
    let running = 0;
    let maxRunning = 0;
    const order: number[] = [];
    const { queue } = makeQueue({
      work: async ({ payload }) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 20));
        order.push((payload as { n: number }).n);
        running--;
      },
    });
    queue.enqueue("work", { n: 1 });
    queue.enqueue("work", { n: 2 });
    queue.enqueue("work", { n: 3 });
    await queue.idle();
    expect(maxRunning).toBe(1);
    expect(order).toEqual([1, 2, 3]);
    expect(queue.list().map((j) => j.status)).toEqual(["done", "done", "done"]);
  });

  it("runs waiting jobs with a higher priority first, still one at a time, without interrupting the running one", async () => {
    let running = 0;
    let maxRunning = 0;
    const order: string[] = [];
    const { queue } = makeQueue({
      work: async ({ payload }) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 20));
        order.push((payload as { n: string }).n);
        running--;
      },
    });
    // The first VOD job starts at once; the rest wait.
    queue.enqueue("work", { n: "vod 1" });
    queue.enqueue("work", { n: "vod 2" });
    queue.enqueue("work", { n: "vod 3" });
    queue.enqueue("work", { n: "live, small creator" }, { priority: 1000 });
    queue.enqueue("work", { n: "live, big creator" }, { priority: 1500 });
    queue.enqueue("work", { n: "live clip" }, { priority: 2000 });
    queue.enqueue("work", { n: "live, small creator, later" }, { priority: 1000 });
    await queue.idle();
    expect(maxRunning).toBe(1);
    expect(order).toEqual(["vod 1", "live clip", "live, big creator", "live, small creator", "live, small creator, later", "vod 2", "vod 3"]);
  });

  it("skips a waiting job with a reason the job list shows, and leaves a running one alone", async () => {
    let release!: () => void;
    const { queue, finished } = makeQueue({ work: () => new Promise<void>((r) => (release = r)) });
    const running = queue.enqueue("work", {});
    const waiting = queue.enqueue("work", {});
    await new Promise((r) => setTimeout(r, 10));
    expect(queue.queued("work").map((j) => j.id)).toEqual([waiting.id]);
    expect(queue.skip(waiting.id, "Skipped: the server fell behind.")).toMatchObject({ status: "cancelled", error: "Skipped: the server fell behind." });
    expect(queue.skip(running.id, "no")).toMatchObject({ status: "running", error: null });
    release();
    await queue.idle();
    expect(finished).toEqual([`${waiting.id}:cancelled`, `${running.id}:done`]);
  });

  it("runs a job added in the same tick as start()", async () => {
    let calls = 0;
    const { queue } = makeQueue({
      work: async () => {
        calls++;
      },
    });
    queue.start();
    const job = queue.enqueue("work", {});
    await new Promise((r) => setTimeout(r, 50));
    await queue.idle();
    expect(calls).toBe(1);
    expect(queue.get(job.id).status).toBe("done");
  });

  it("retries a failing job, then succeeds", async () => {
    let calls = 0;
    const { queue } = makeQueue({
      flaky: async () => {
        calls++;
        if (calls < 3) throw new Error("network blip");
      },
    });
    const job = queue.enqueue("flaky", {}, { maxAttempts: 3 });
    await queue.idle();
    expect(calls).toBe(3);
    expect(queue.get(job.id)).toMatchObject({ status: "done", attempts: 3, error: null, progress: 1 });
  });

  it("marks a job failed after its last try, keeping the error", async () => {
    const { queue, finished } = makeQueue({
      broken: async () => {
        throw new Error("still broken");
      },
    });
    const job = queue.enqueue("broken", {}, { maxAttempts: 2 });
    await queue.idle();
    expect(queue.get(job.id)).toMatchObject({ status: "failed", attempts: 2, error: "still broken" });
    expect(finished).toEqual([`${job.id}:failed`]);
  });

  it("tries a failed job again with fresh tries, and refuses to retry a finished one", async () => {
    let calls = 0;
    const { queue } = makeQueue({
      once: async () => {
        calls++;
        if (calls === 1) throw new Error("disk full");
      },
    });
    const job = queue.enqueue("once", {}, { maxAttempts: 1 });
    await queue.idle();
    expect(queue.get(job.id).status).toBe("failed");
    queue.retry(job.id);
    await queue.idle();
    expect(queue.get(job.id)).toMatchObject({ status: "done", attempts: 1, error: null });
    expect(() => queue.retry(job.id)).toThrow(ValidationError);
  });

  it("does not retry errors that a retry cannot fix", async () => {
    let calls = 0;
    const { queue } = makeQueue({
      refused: async () => {
        calls++;
        throw new ValidationError("bad input");
      },
    });
    const job = queue.enqueue("refused", {});
    await queue.idle();
    expect(calls).toBe(1);
    expect(queue.get(job.id).status).toBe("failed");
  });

  it("cancels a queued job before it runs", async () => {
    const ran: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { queue } = makeQueue({
      work: async ({ payload }) => {
        const n = (payload as { n: number }).n;
        if (n === 1) await gate;
        ran.push(n);
      },
    });
    queue.enqueue("work", { n: 1 });
    const second = queue.enqueue("work", { n: 2 });
    expect(queue.cancel(second.id).status).toBe("cancelled");
    release();
    await queue.idle();
    expect(ran).toEqual([1]);
  });

  it("cancels a running job through its abort signal", async () => {
    let seenTmp = "";
    const { queue } = makeQueue({
      long: ({ signal, tmpDir }) => {
        seenTmp = tmpDir;
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
    });
    const job = queue.enqueue("long", {});
    await new Promise((r) => setTimeout(r, 20));
    expect(queue.get(job.id).status).toBe("running");
    queue.cancel(job.id);
    await queue.idle();
    expect(queue.get(job.id)).toMatchObject({ status: "cancelled", attempts: 1 });
    expect(existsSync(seenTmp)).toBe(false);
  });

  it("removes the temp folder after success and after failure", async () => {
    const dirs: string[] = [];
    const { queue } = makeQueue({
      ok: async ({ tmpDir }) => {
        dirs.push(tmpDir);
        await writeFile(join(tmpDir, "audio.mp3"), "x");
      },
      bad: async ({ tmpDir }) => {
        dirs.push(tmpDir);
        await writeFile(join(tmpDir, "audio.mp3"), "x");
        throw new Error("boom");
      },
    });
    queue.enqueue("ok", {});
    queue.enqueue("bad", {}, { maxAttempts: 1 });
    await queue.idle();
    expect(dirs).toHaveLength(2);
    expect(dirs.every((d) => d.startsWith(tmpRoot) && !existsSync(d))).toBe(true);
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it("reports progress while running", async () => {
    const seen: number[] = [];
    const { queue } = makeQueue({
      work: async ({ job, progress }) => {
        progress(0.5, "Halfway");
        seen.push(queue.get(job.id).progress);
        expect(queue.get(job.id).message).toBe("Halfway");
      },
    });
    queue.enqueue("work", {});
    await queue.idle();
    expect(seen).toEqual([0.5]);
  });

  it("puts a job interrupted by shutdown back in the queue without using up a try", async () => {
    const { queue } = makeQueue({
      long: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const job = queue.enqueue("long", {}, { maxAttempts: 1 });
    await new Promise((r) => setTimeout(r, 20));
    queue.stop();
    await queue.idle();
    expect(queue.get(job.id)).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("puts jobs left running by a crash back in the queue on start", async () => {
    const { db, queue } = makeQueue({ work: async () => {} });
    queue.stop();
    const job = queue.enqueue("work", {});
    db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(job.id);
    queue.start();
    await queue.idle();
    expect(queue.get(job.id).status).toBe("done");
  });

  describe("two processes on one database (the server and clipfarm-ops)", () => {
    function twoQueues(leaseMs = 30_000) {
      const file = join(tmpRoot, "shared.db");
      const ran: string[] = [];
      const make = (name: string) => {
        const db = openDb(file);
        const handlers: Record<string, JobHandler> = {
          work: async () => {
            ran.push(name);
            await new Promise((r) => setTimeout(r, 30));
          },
        };
        return { db, queue: new JobQueue(db, { handlers, tmpRoot, pollMs: 10, leaseMs }) };
      };
      return { server: make("server"), ops: make("ops"), ran };
    }
    const done = async (queue: JobQueue, id: number) => {
      for (let i = 0; i < 200 && queue.get(id).status !== "done"; i++) await new Promise((r) => setTimeout(r, 10));
      return queue.get(id).status;
    };

    it("a job queued by the second process is run by the one that is already working, never by both", async () => {
      const { server, ops, ran } = twoQueues();
      server.queue.start();
      ops.queue.start();
      expect(server.queue.working).toBe(true);
      expect(ops.queue.working).toBe(false);
      expect(ops.queue.workerSeenAt()).not.toBeNull();

      const a = ops.queue.enqueue("work", {});
      const b = ops.queue.enqueue("work", {});
      expect(await done(ops.queue, a.id)).toBe("done");
      expect(await done(ops.queue, b.id)).toBe("done");
      expect(ran).toEqual(["server", "server"]);
      server.queue.stop();
      ops.queue.stop();
    });

    it("takes the queue over when the worker stops, and when it has gone silent", async () => {
      const { server, ops, ran } = twoQueues(60);
      server.queue.start();
      ops.queue.start();
      server.queue.stop();
      const a = ops.queue.enqueue("work", {});
      expect(await done(ops.queue, a.id)).toBe("done");
      expect(ran).toEqual(["ops"]);
      ops.queue.stop();
      await ops.queue.idle();
      expect(ops.queue.workerSeenAt()).toBeNull();

      // A worker that died without saying so: its lease and its "running" job are still there.
      const stuck = ops.queue.enqueue("work", {});
      server.db.prepare("INSERT INTO queue_worker (id, owner, beat_at) VALUES (1, 'dead', ?)").run(new Date().toISOString());
      server.db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(stuck.id);
      ops.queue.start();
      expect(ops.queue.working).toBe(false);
      expect(await done(ops.queue, stuck.id)).toBe("done");
      expect(ran).toEqual(["ops", "ops"]);
      ops.queue.stop();
    });
  });
});

describe("fair share between workspaces", () => {
  it("picks the workspace that waited longest since its last start, oldest job first within it", () => {
    const last = new Map([
      [1, "2026-11-14T10:00:00.000Z"],
      [2, "2026-11-14T09:00:00.000Z"],
    ]);
    // Workspace 3 never ran: it goes first. Then 2 (ran longer ago), then 1.
    expect(pickFair([{ id: 5, workspaceId: 1 }, { id: 6, workspaceId: 2 }, { id: 7, workspaceId: 3 }], last)).toBe(7);
    expect(pickFair([{ id: 5, workspaceId: 1 }, { id: 9, workspaceId: 2 }, { id: 6, workspaceId: 2 }], last)).toBe(6);
    expect(pickFair([], last)).toBeUndefined();
  });

  it("a client's long backlog does not hold our jobs (or another client's) up, and still one job at a time", async () => {
    const order: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const { queue } = makeQueue({
      work: async ({ payload }) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 5));
        order.push((payload as { tag: string }).tag);
        running--;
      },
    });
    queue.stop();
    for (let i = 1; i <= 3; i++) queue.enqueue("work", { tag: `client-a-${i}` }, { workspaceId: 2 });
    queue.enqueue("work", { tag: "ours-1" }, { workspaceId: 1 });
    queue.enqueue("work", { tag: "client-b-1" }, { workspaceId: 3 });
    queue.enqueue("work", { tag: "ours-2" }, { workspaceId: 1 });
    queue.start();
    await queue.idle();
    queue.stop();
    expect(maxRunning).toBe(1);
    expect(order).toEqual(["client-a-1", "ours-1", "client-b-1", "client-a-2", "ours-2", "client-a-3"]);
  });

  it("a job takes its workspace from its video or clip when none is given", () => {
    const { db, queue } = makeQueue({ work: async () => undefined });
    queue.stop();
    db.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (7, 'Client', '2026-11-14')").run();
    db.prepare("INSERT INTO sources (id, creator_name, channel_urls, created_at, workspace_id) VALUES (70, 'C', '[]', '2026-11-14', 7)").run();
    db.prepare("INSERT INTO vods (id, source_id, url, status, created_at) VALUES (700, 70, 'x', 'queued', '2026-11-14')").run();
    const job = queue.enqueue("work", {}, { vodId: 700 });
    const plain = queue.enqueue("work", {});
    const ws = (id: number) => (db.prepare("SELECT workspace_id AS ws FROM jobs WHERE id = ?").get(id) as { ws: number }).ws;
    expect(ws(job.id)).toBe(7);
    expect(ws(plain.id)).toBe(1);
  });
});
