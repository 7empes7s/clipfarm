import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { availableParallelism } from "node:os";
import { type ChatClient, OpenAiCompatibleChat } from "../pipeline/picks/llm.js";
import { type HookWriter, WriterUnavailableError } from "../pipeline/picks/local.js";
import { type MemoryReading, memoryProblem } from "./memory.js";
import { peakRssMb } from "./proc.js";

export interface LlamaSetup {
  /** llama.cpp's `llama-server`. */
  bin: string;
  model: string;
  modelId: string;
  needMb: number;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const force = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

/**
 * The small local model that writes hooks and titles, run by llama.cpp's server on a loopback
 * port. It is loaded only for the length of one session and its process ends afterwards, so the
 * memory goes back to the box. Refuses to load when memory is short (the guard).
 */
export class LlamaWriter implements HookWriter {
  constructor(
    private setup: () => LlamaSetup,
    private memory: () => MemoryReading,
    private startTimeoutMs = 120_000,
  ) {}

  async session<T>(fn: (chat: ChatClient) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const setup = this.setup();
    const short = memoryProblem(`the hook writer (${setup.modelId})`, setup.needMb, this.memory());
    if (short) throw new WriterUnavailableError(short);

    const port = await freePort();
    const child = spawn(
      setup.bin,
      ["-m", setup.model, "--host", "127.0.0.1", "--port", String(port), "-c", "2048", "-np", "1", "-t", String(Math.min(4, availableParallelism()))],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let tail = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      tail = (tail + chunk).slice(-400);
    });
    let spawnError: Error | null = null;
    child.once("error", (err) => {
      spawnError = err;
    });
    const started = Date.now();
    try {
      const baseUrl = `http://127.0.0.1:${port}`;
      for (;;) {
        signal?.throwIfAborted();
        if (spawnError || child.exitCode !== null || child.signalCode !== null) {
          const why = spawnError ? (spawnError as Error).message : tail.trim().split("\n").slice(-2).join(" ");
          throw new Error(`The hook writer did not start: ${why}`);
        }
        if (Date.now() - started > this.startTimeoutMs) throw new Error("The hook writer took too long to load its model.");
        const up = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
        if (up) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      const chat = new OpenAiCompatibleChat({ apiKey: "local", baseUrl: `${baseUrl}/v1`, model: setup.modelId, maxTokens: 200 });
      return await fn(chat);
    } finally {
      const peak = peakRssMb(child.pid);
      await stop(child);
      console.log(`[picks] hook writer ${setup.modelId} unloaded after ${Math.round((Date.now() - started) / 1000)} s, peak memory ${peak ?? "?"} MB`);
    }
  }
}
