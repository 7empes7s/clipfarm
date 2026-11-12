import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../db/index.js";
import { ValidationError } from "../errors.js";
import { type JobHandler, JobQueue } from "./queue.js";

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
});
