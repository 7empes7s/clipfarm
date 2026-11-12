import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { ClipsRepo } from "../clips/repo.js";
import { openDb } from "../db/index.js";
import { JobQueue } from "../jobs/queue.js";
import { PicksRepo } from "../picks/repo.js";
import { FakePicker } from "../pipeline/picks/fake.js";
import { FakeTranscriber } from "../pipeline/transcript/fake.js";
import { FakePostingService } from "../publish/fake.js";
import { Publisher } from "../publish/publisher.js";
import { PostsRepo } from "../publish/repo.js";
import { SourcesRepo } from "../sources/repo.js";
import { run } from "../tools/exec.js";
import { VodsRepo } from "../vods/repo.js";
import type { EnginePartSpec } from "./catalog.js";
import { Engine, ENGINE_SETUP_JOB, EngineNotReadyError } from "./engine.js";
import { NotEnoughMemoryError } from "./memory.js";
import { engineSetupHandler } from "./setup.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

let dir: string;
let server: Server;
let files: Record<string, Buffer>;
let catalog: EnginePartSpec[];
let downloads: string[];

// A made-up catalog served by a local server: tiny stand-ins for the programs and models.
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "clipfarm-engine-"));
  const pack = join(dir, "pack", "whisper-bin");
  await mkdir(pack, { recursive: true });
  await writeFile(join(pack, "whisper-cli"), "#!/bin/sh\nexit 0\n");
  await chmod(join(pack, "whisper-cli"), 0o755);
  await run("tar", ["-czf", join(dir, "whisper.tar.gz"), "-C", join(dir, "pack"), "whisper-bin"]);
  files = {
    "/whisper.tar.gz": await readFile(join(dir, "whisper.tar.gz")),
    "/vad.bin": Buffer.alloc(2_000, 1),
    "/ggml-base.en.bin": Buffer.alloc(3_000_000, 2),
    "/ggml-small.en.bin": Buffer.alloc(4_000, 3),
    "/llama.tar.gz": await readFile(join(dir, "whisper.tar.gz")),
    "/writer.gguf": Buffer.alloc(5_000, 4),
  };
  downloads = [];
  server = createServer((req, res) => {
    downloads.push(req.url!);
    const body = files[req.url!];
    if (!body) return void res.writeHead(404).end();
    res.writeHead(200, { "Content-Length": body.length }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const part = (id: string, kind: EnginePartSpec["kind"], label: string, path: string, more: Partial<EnginePartSpec> = {}): EnginePartSpec => ({
    id, kind, label, url: base + path, sha256: sha(files[path]!), bytes: files[path]!.length, ...more,
  });
  catalog = [
    part("whisper-cpp", "stt-runtime", "Speech-to-text program (whisper.cpp)", "/whisper.tar.gz", { bin: "whisper-cli" }),
    part("silero-vad", "vad", "Speech finder (Silero VAD)", "/vad.bin"),
    part("base.en", "stt", "Speech model base.en", "/ggml-base.en.bin", { needMb: 500 }),
    part("small.en", "stt", "Speech model small.en", "/ggml-small.en.bin", { needMb: 1100 }),
    part("llama-cpp", "llm-runtime", "Hook writer program (llama.cpp)", "/llama.tar.gz", { bin: "whisper-cli" }),
    part("qwen2.5-1.5b", "llm", "Hook writer model (Qwen2.5 1.5B)", "/writer.gguf", { needMb: 1600 }),
  ];
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
});

function setup(opts: { availableMb?: number; capRoomMb?: number; cloud?: boolean } = {}) {
  const db = openDb(":memory:");
  const modelsDir = join(dir, "data", "models");
  const engine = new Engine({
    modelsDir,
    catalog,
    cloudTranscriber: opts.cloud ? new FakeTranscriber() : null,
    cloudPicker: opts.cloud ? new FakePicker() : null,
    memory: () => ({ freeMb: opts.availableMb ?? 4000, capRoomMb: opts.capRoomMb ?? null }),
  });
  engine.bind(db);
  const queue = new JobQueue(db, { handlers: { [ENGINE_SETUP_JOB]: engineSetupHandler(engine) }, tmpRoot: dir });
  const sources = new SourcesRepo(db);
  const clips = new ClipsRepo(db);
  const posts = new PostsRepo(db);
  const vods = new VodsRepo(db);
  const publisher = new Publisher({ sources, clips, posts, service: new FakePostingService(), vodTitle: () => null });
  const app = createApp({ sources, vods, picks: new PicksRepo(db), queue, clips, posts, publisher, engine: { engine, fake: false } });
  return { engine, queue, modelsDir, app };
}

const transcribeOpts = { durationSec: 10, tmpDir: tmpdir() };

describe("engine status", () => {
  it("is local by default and says exactly what is missing", () => {
    const { engine } = setup();
    const status = engine.status([]);
    expect(status.mode).toBe("local");
    expect(status.settings).toEqual({ cloud: false, sttModel: "base.en", writer: true });
    expect(status.ready).toBe(false);
    expect(status.headline).toBe("Local engine: not ready");
    expect(status.problems).toEqual([
      "Speech-to-text program (whisper.cpp) is not downloaded yet (1 MB).",
      "Speech finder (Silero VAD) is not downloaded yet (1 MB).",
      "Speech model base.en is not downloaded yet (3 MB).",
      "Hook writer program (llama.cpp) is not downloaded yet (1 MB).",
      "Hook writer model (Qwen2.5 1.5B) is not downloaded yet (1 MB).",
    ]);
    expect(status.downloads.map((d) => d.id)).toEqual(["whisper-cpp", "silero-vad", "base.en", "llama-cpp", "qwen2.5-1.5b"]);
  });

  it("refuses to transcribe, plainly and without retries, while the speech parts are missing", async () => {
    const { engine } = setup();
    await expect(engine.transcriber.transcribe("a.mp3", transcribeOpts)).rejects.toThrow(EngineNotReadyError);
    await expect(engine.transcriber.transcribe("a.mp3", transcribeOpts)).rejects.toThrow(
      'The local engine is not set up yet. Speech-to-text program (whisper.cpp) is not downloaded. Speech finder (Silero VAD) is not downloaded. Speech model base.en is not downloaded. Open the Dashboard and tap "Set up the local engine".',
    );
  });
});

describe("engine setup job", () => {
  it("downloads and checks every missing part with progress, unpacks the programs, and leaves the engine ready", async () => {
    const { engine, queue, modelsDir } = setup();
    const messages = new Set<string>();
    const job = queue.enqueue(ENGINE_SETUP_JOB, {});
    const watch = setInterval(() => messages.add(queue.get(job.id).message), 1);
    queue.start();
    await queue.idle();
    clearInterval(watch);

    expect(queue.get(job.id)).toMatchObject({ status: "done", progress: 1 });
    expect([...messages].some((m) => /^Downloading Speech model base\.en: \d of 3 MB$/.test(m))).toBe(true);
    expect((await readdir(modelsDir)).sort()).toEqual(["ggml-base.en.bin", "runtime", "vad.bin", "writer.gguf"]);
    expect((await readdir(join(modelsDir, "runtime"))).sort()).toEqual(["llama-cpp", "whisper-cpp"]);
    expect(existsSync(join(modelsDir, "runtime", "whisper-cpp", "whisper-cli"))).toBe(true);

    const status = engine.status(queue.list());
    expect(status).toMatchObject({ ready: true, headline: "Local engine: ready", problems: [], downloads: [], setupJob: null });
    expect(status.sttModels.map((m) => [m.id, m.present])).toEqual([["base.en", true], ["small.en", false]]);
  });

  it("fails with the checksum reason and shows the failed job when a download is not what was pinned", async () => {
    files["/vad.bin"] = Buffer.alloc(2_000, 9);
    const { engine, queue } = setup();
    const job = queue.enqueue(ENGINE_SETUP_JOB, {}, { maxAttempts: 1 });
    queue.start();
    await queue.idle();

    expect(queue.get(job.id)).toMatchObject({ status: "failed", error: "The download of vad.bin did not match its checksum, so it was thrown away. Try again." });
    const status = engine.status(queue.list());
    expect(status.ready).toBe(false);
    expect(status.setupJob).toMatchObject({ id: job.id, status: "failed" });
    expect(status.downloads.map((d) => d.id)).toContain("silero-vad");
  });

  it("only downloads the speech parts when the hook writer is switched off, and only what is still missing", async () => {
    const { engine, queue } = setup();
    engine.saveSettings({ writer: false });
    queue.enqueue(ENGINE_SETUP_JOB, {});
    queue.start();
    await queue.idle();
    expect(downloads).toEqual(["/whisper.tar.gz", "/vad.bin", "/ggml-base.en.bin"]);
    expect(engine.status(queue.list()).ready).toBe(true);

    engine.saveSettings({ sttModel: "small.en" });
    expect(engine.status(queue.list()).problems).toEqual(["Speech model small.en is not downloaded yet (1 MB)."]);
    queue.enqueue(ENGINE_SETUP_JOB, {});
    await queue.idle();
    expect(downloads.slice(3)).toEqual(["/ggml-small.en.bin"]);
  });
});

describe("engine memory guard", () => {
  it("refuses to start the speech model, with the reason, when free memory is below its need plus 1 GB", async () => {
    const { engine, queue } = setup({ availableMb: 1200 });
    engine.saveSettings({ writer: false });
    queue.enqueue(ENGINE_SETUP_JOB, {});
    queue.start();
    await queue.idle();

    const refusal = engine.transcriber.transcribe("a.mp3", transcribeOpts);
    await expect(refusal).rejects.toThrow(NotEnoughMemoryError);
    await expect(refusal).rejects.toThrow(
      "Not enough free memory to start the speech model (base.en): it needs 0.5 GB plus 1.0 GB spare, and 1.2 GB is free. Try again when other work on the server has finished.",
    );
    const status = engine.status(queue.list());
    expect(status).toMatchObject({ ready: false, memory: { availableMb: 1200, needMb: 500, ok: false } });
    expect(status.problems).toEqual([expect.stringContaining("Not enough free memory to start the speech model (base.en)")]);
  });
});

describe("engine memory guard under the service's own cap", () => {
  it("refuses the speech model when the cap leaves less than it needs, even on a box with free memory", async () => {
    const { engine, queue } = setup({ availableMb: 6000, capRoomMb: 300 });
    engine.saveSettings({ writer: false });
    queue.enqueue(ENGINE_SETUP_JOB, {});
    await queue.idle();
    await expect(engine.transcriber.transcribe("a.mp3", transcribeOpts)).rejects.toThrow(
      "Not enough memory to start the speech model (base.en): it needs 0.5 GB, and clipfarm's memory cap on this server leaves 0.3 GB. IT can raise the cap (MemoryMax in clipfarm.service).",
    );
  });
});

describe("engine settings", () => {
  it("keeps cloud AI off unless a key is on the server", () => {
    const { engine } = setup();
    expect(() => engine.saveSettings({ cloud: true })).toThrow("Cloud AI needs an OpenAI key on the server first");
    expect(engine.settings().cloud).toBe(false);
    expect(engine.transcriber.name).toBe("local:base.en");
    expect(engine.picker.name).toBe("local");
  });

  it("hands transcription and picks to the cloud adapters when cloud AI is switched on", async () => {
    const { engine } = setup({ cloud: true });
    expect(engine.status([]).cloudAvailable).toBe(true);
    engine.saveSettings({ cloud: true });
    expect(engine.transcriber.name).toBe("fake");
    expect(engine.picker.name).toBe("fake");
    expect((await engine.transcriber.transcribe("a.mp3", transcribeOpts)).words.length).toBeGreaterThan(0);
    expect(engine.status([])).toMatchObject({ mode: "cloud", ready: true, headline: "Cloud AI: on" });
  });

  it("rejects a speech model that is not on the list", () => {
    const { engine } = setup();
    expect(() => engine.saveSettings({ sttModel: "huge" })).toThrow("Pick one of the listed speech models.");
  });
});

describe("engine API", () => {
  it("shows the status, queues one setup job per tap, and saves settings", async () => {
    const { app, queue } = setup();
    const first = await request(app).get("/api/engine").expect(200);
    expect(first.body).toMatchObject({ mode: "local", ready: false, headline: "Local engine: not ready", setupJob: null });

    const queued = await request(app).post("/api/engine/setup").expect(202);
    expect(["queued", "running"]).toContain(queued.body.setupJob.status);
    await request(app).post("/api/engine/setup").expect(202);
    expect(queue.list().filter((j) => j.type === ENGINE_SETUP_JOB).length).toBe(1);

    const saved = await request(app).put("/api/engine/settings").send({ writer: false, sttModel: "small.en" }).expect(200);
    expect(saved.body.settings).toEqual({ cloud: false, sttModel: "small.en", writer: false });
    const refused = await request(app).put("/api/engine/settings").send({ cloud: true }).expect(400);
    expect(refused.body.error).toContain("Cloud AI needs an OpenAI key");

    await queue.idle();
    const done = await request(app).get("/api/engine").expect(200);
    expect(done.body).toMatchObject({ ready: true, headline: "Local engine: ready" });
  });
});
