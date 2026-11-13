import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
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
import type { ChatClient } from "../pipeline/picks/llm.js";
import type { StepResult, SttStep } from "../pipeline/transcript/chain.js";
import { FakeTranscriber } from "../pipeline/transcript/fake.js";
import type { Transcriber } from "../pipeline/transcript/types.js";
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
    "/moonshine.tar.gz": await readFile(join(dir, "whisper.tar.gz")),
    "/encoder_model.ort": Buffer.alloc(1_500, 5),
    "/tokenizer.bin": Buffer.alloc(500, 6),
    "/ggml-small-q8_0.bin": Buffer.alloc(2_500_000, 7),
    "/ggml-large-v3-turbo-q8_0.bin": Buffer.alloc(6_000, 8),
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
    part("moonshine-lib", "moonshine-runtime", "Moonshine program", "/moonshine.tar.gz", { bin: "whisper-cli" }),
    part("moonshine-tiny-en/encoder_model.ort", "moonshine", "Moonshine English model (encoder_model.ort)", "/encoder_model.ort", { file: "moonshine-tiny-en/encoder_model.ort", needMb: 300 }),
    part("moonshine-tiny-en/tokenizer.bin", "moonshine", "Moonshine English model (tokenizer.bin)", "/tokenizer.bin", { file: "moonshine-tiny-en/tokenizer.bin", needMb: 300 }),
    part("small-q8", "stt-multi", "Speech model Whisper small (every language)", "/ggml-small-q8_0.bin", { needMb: 600 }),
    part("large-v3-turbo-q8", "stt-multi", "Speech model Whisper large-v3-turbo", "/ggml-large-v3-turbo-q8_0.bin", { needMb: 1300 }),
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

const STEPS = [
  { id: "moonshine", on: true },
  { id: "whisper-small", on: true },
  { id: "whisper-turbo", on: true },
  { id: "whisper-en", on: false },
  { id: "cloud", on: false },
];
const SPEECH_DOWNLOADS = ["/moonshine.tar.gz", "/encoder_model.ort", "/tokenizer.bin", "/whisper.tar.gz", "/vad.bin", "/ggml-small-q8_0.bin", "/ggml-large-v3-turbo-q8_0.bin"];

function setup(opts: { availableMb?: number; capRoomMb?: number; cloud?: boolean; sttSteps?: (real: SttStep[]) => SttStep[]; cloudTranscriber?: Transcriber } = {}) {
  const db = openDb(":memory:");
  const modelsDir = join(dir, "data", "models");
  const engine = new Engine({
    modelsDir,
    catalog,
    cloudTranscriber: () => (opts.cloud ? (opts.cloudTranscriber ?? new FakeTranscriber()) : null),
    pythonBin: process.execPath,
    sttSteps: opts.sttSteps,
    cloudPicker: () => (opts.cloud ? new FakePicker() : null),
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
  return { engine, queue, modelsDir, app, db };
}

const transcribeOpts = { durationSec: 10, tmpDir: tmpdir() };

describe("engine status", () => {
  it("is local by default and says exactly what is missing", () => {
    const { engine } = setup();
    const status = engine.status([]);
    expect(status.mode).toBe("local");
    expect(status.settings).toEqual({ cloud: false, sttModel: "base.en", writer: true, stt: STEPS });
    expect(status.ready).toBe(false);
    expect(status.headline).toBe("Local engine: not ready");
    expect(status.problems).toEqual([
      "Moonshine program is not downloaded yet (1 MB).",
      "Moonshine English model (encoder_model.ort) is not downloaded yet (1 MB).",
      "Moonshine English model (tokenizer.bin) is not downloaded yet (1 MB).",
      "Speech-to-text program (whisper.cpp) is not downloaded yet (1 MB).",
      "Speech finder (Silero VAD) is not downloaded yet (1 MB).",
      "Speech model Whisper small (every language) is not downloaded yet (2 MB).",
      "Speech model Whisper large-v3-turbo is not downloaded yet (1 MB).",
      "Hook writer program (llama.cpp) is not downloaded yet (1 MB).",
      "Hook writer model (Qwen2.5 1.5B) is not downloaded yet (1 MB).",
    ]);
    expect(status.downloads.map((d) => d.id)).toEqual([
      "moonshine-lib", "moonshine-tiny-en/encoder_model.ort", "moonshine-tiny-en/tokenizer.bin",
      "whisper-cpp", "silero-vad", "small-q8", "large-v3-turbo-q8", "llama-cpp", "qwen2.5-1.5b",
    ]);
  });

  it("shows each step of the speech-to-text chain in order: on or off, missing with its download size, never measured", () => {
    const { engine } = setup();
    expect(engine.status([]).steps.map((s) => [s.id, s.label, s.on, s.state, s.downloadBytes, s.speed])).toEqual([
      ["moonshine", "Moonshine", true, "missing", files["/moonshine.tar.gz"]!.length + 2_000, null],
      ["whisper-small", "Whisper small", true, "missing", files["/whisper.tar.gz"]!.length + 2_000 + 2_500_000, null],
      ["whisper-turbo", "Whisper large-v3-turbo", true, "missing", files["/whisper.tar.gz"]!.length + 2_000 + 6_000, null],
      ["whisper-en", "Whisper English", false, "missing", files["/whisper.tar.gz"]!.length + 2_000 + 3_000_000, null],
      ["cloud", "Cloud (OpenAI)", false, "blocked", 0, null],
    ]);
    expect(engine.status([]).steps.at(-1)!.problem).toBe("there is no OpenAI key.");
  });

  it("refuses to transcribe, plainly and without retries, while the speech parts are missing", async () => {
    const { engine } = setup();
    await expect(engine.transcriber.transcribe("a.mp3", transcribeOpts)).rejects.toThrow(EngineNotReadyError);
    await expect(engine.transcriber.transcribe("a.mp3", transcribeOpts)).rejects.toThrow(
      'The local engine is not set up yet. Moonshine program is not downloaded. Moonshine English model (encoder_model.ort) is not downloaded. Moonshine English model (tokenizer.bin) is not downloaded. Speech-to-text program (whisper.cpp) is not downloaded. Speech finder (Silero VAD) is not downloaded. Speech model Whisper small (every language) is not downloaded. Speech model Whisper large-v3-turbo is not downloaded. Hook writer program (llama.cpp) is not downloaded. Hook writer model (Qwen2.5 1.5B) is not downloaded. Open the Dashboard and tap "Set up the local engine".',
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
    expect([...messages].some((m) => /^Downloading Speech model Whisper small \(every language\): \d of 2 MB$/.test(m))).toBe(true);
    expect((await readdir(modelsDir)).sort()).toEqual(["ggml-large-v3-turbo-q8_0.bin", "ggml-small-q8_0.bin", "moonshine-tiny-en", "runtime", "vad.bin", "writer.gguf"]);
    expect((await readdir(join(modelsDir, "moonshine-tiny-en"))).sort()).toEqual(["encoder_model.ort", "tokenizer.bin"]);
    expect((await readdir(join(modelsDir, "runtime"))).sort()).toEqual(["llama-cpp", "moonshine-lib", "whisper-cpp"]);
    expect(existsSync(join(modelsDir, "runtime", "whisper-cpp", "whisper-cli"))).toBe(true);

    const status = engine.status(queue.list());
    expect(status).toMatchObject({ ready: true, headline: "Local engine: ready", problems: [], downloads: [], setupJob: null });
    expect(status.sttModels.map((m) => [m.id, m.present])).toEqual([["base.en", false], ["small.en", false]]);
    expect(status.steps.map((s) => `${s.id}:${s.state}`)).toEqual(["moonshine:ready", "whisper-small:ready", "whisper-turbo:ready", "whisper-en:missing", "cloud:blocked"]);
  });

  it("one step's Download button fetches that step only, switched on or not", async () => {
    const { engine, queue, app } = setup();
    engine.saveSettings({ writer: false });
    const tapped = await request(app).post("/api/engine/setup").send({ step: "whisper-en" }).expect(202);
    expect(tapped.body.setupJob).not.toBeNull();
    await queue.idle();
    expect(downloads).toEqual(["/whisper.tar.gz", "/vad.bin", "/ggml-base.en.bin"]);
    const steps = engine.status(queue.list()).steps;
    expect(steps.map((s) => `${s.id}:${s.state}`)).toEqual(["moonshine:missing", "whisper-small:missing", "whisper-turbo:missing", "whisper-en:ready", "cloud:blocked"]);
    // Whisper small now only misses its model: the program and the speech finder are shared.
    expect(steps[1]!.downloadBytes).toBe(2_500_000);

    // Nothing left for that step: another tap queues nothing.
    await request(app).post("/api/engine/setup").send({ step: "whisper-en" }).expect(202);
    expect(queue.list().filter((j) => j.type === ENGINE_SETUP_JOB).length).toBe(1);
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
    expect(downloads).toEqual(SPEECH_DOWNLOADS);
    expect(engine.status(queue.list()).ready).toBe(true);

    // Switching the English Whisper step on asks for its model (the one picked), and nothing else.
    engine.saveSettings({ sttModel: "small.en", stt: STEPS.map((s) => (s.id === "whisper-en" ? { ...s, on: true } : s)) });
    expect(engine.status(queue.list()).problems).toEqual(["Speech model small.en is not downloaded yet (1 MB)."]);
    queue.enqueue(ENGINE_SETUP_JOB, {});
    await queue.idle();
    expect(downloads.slice(SPEECH_DOWNLOADS.length)).toEqual(["/ggml-small.en.bin"]);
  });
});

describe("engine memory guard", () => {
  it("refuses to start the speech model, with the reason, when free memory is below its need plus 1 GB", async () => {
    const { engine, queue } = setup({ availableMb: 1200 });
    engine.saveSettings({ writer: false, stt: STEPS.map((s) => ({ ...s, on: s.id === "whisper-en" })) });
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

  it("marks only the step that does not fit as blocked: large-v3-turbo waits for memory, the lighter steps stay ready", async () => {
    const { engine, queue } = setup({ availableMb: 2000 });
    engine.saveSettings({ writer: false });
    queue.enqueue(ENGINE_SETUP_JOB, {});
    await queue.idle();
    const status = engine.status(queue.list());
    expect(status.steps.slice(0, 3).map((s) => `${s.id}:${s.state}`)).toEqual(["moonshine:ready", "whisper-small:ready", "whisper-turbo:blocked"]);
    expect(status.steps[2]!.problem).toContain("Not enough free memory to start the speech model (large-v3-turbo-q8): it needs 1.3 GB plus 1.0 GB spare, and 2.0 GB is free.");
    expect(status.memory).toEqual({ availableMb: 2000, needMb: 300, ok: false });
  });
});

describe("engine status: the hook writer and memory", () => {
  it("says when the writer would be refused for memory, and nothing when it fits or is off", () => {
    const tight = setup({ availableMb: 2000 }).engine;
    expect(tight.status([]).writerNote).toContain("Not enough free memory to start the hook writer (qwen2.5-1.5b): it needs 1.6 GB plus 1.0 GB spare, and 2.0 GB is free.");
    expect(tight.status([]).memory.ok).toBe(true);
    tight.saveSettings({ writer: false });
    expect(tight.status([]).writerNote).toBeNull();
    expect(setup({ availableMb: 4000 }).engine.status([]).writerNote).toBeNull();
  });
});

describe("engine setup job: settings changed while it runs", () => {
  it("leaves out the hook writer when it is switched off before its download starts", async () => {
    const { engine, queue } = setup();
    const install = engine.install.bind(engine);
    engine.install = async (spec, o) => {
      if (spec.id === "whisper-cpp") engine.saveSettings({ writer: false });
      await install(spec, o);
    };
    queue.enqueue(ENGINE_SETUP_JOB, {});
    await queue.idle();
    expect(downloads).toEqual(SPEECH_DOWNLOADS);
    expect(engine.status(queue.list()).ready).toBe(true);
  });
});

describe("engine memory guard under the service's own cap", () => {
  it("refuses the speech model when the cap leaves less than it needs, even on a box with free memory", async () => {
    const { engine, queue } = setup({ availableMb: 6000, capRoomMb: 300 });
    engine.saveSettings({ writer: false, stt: STEPS.map((s) => ({ ...s, on: s.id === "whisper-en" })) });
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
    expect(() => engine.saveSettings({ cloud: true })).toThrow("Cloud AI needs an OpenAI key first. Add it in Settings.");
    expect(engine.settings().cloud).toBe(false);
    expect(() => engine.saveSettings({ stt: STEPS.map((s) => ({ ...s, on: true })) })).toThrow("Cloud AI needs an OpenAI key first. Add it in Settings.");
    expect(engine.transcriber.name).toBe("local");
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

  it("saves the order of the speech-to-text steps, and refuses a list that drops a step or leaves no local one on", () => {
    const { engine } = setup({ cloud: true });
    const order = [STEPS[1]!, STEPS[0]!, { id: "cloud", on: true }, STEPS[2]!, STEPS[3]!];
    expect(engine.saveSettings({ stt: order }).stt).toEqual(order);
    expect(engine.status([]).steps.map((s) => s.id)).toEqual(["whisper-small", "moonshine", "cloud", "whisper-turbo", "whisper-en"]);
    expect(() => engine.saveSettings({ stt: order.slice(1) })).toThrow("The speech-to-text order must list every step once, each on or off.");
    expect(() => engine.saveSettings({ stt: [...order.slice(1), { id: "magic", on: true }] })).toThrow("The speech-to-text order must list every step once");
    expect(() => engine.saveSettings({ stt: order.map((s) => ({ ...s, on: s.id === "cloud" })) })).toThrow("Keep at least one local speech-to-text step switched on.");
    expect(engine.settings().stt).toEqual(order);
  });

  it("keeps the order saved before a step existed, and adds the new step", () => {
    const { engine, db } = setup();
    db.prepare("INSERT INTO settings (key, value) VALUES ('engine', ?)").run(
      JSON.stringify({ cloud: false, sttModel: "base.en", writer: false, stt: [{ id: "whisper-small", on: true }, { id: "retired", on: true }, { id: "moonshine", on: false }] }),
    );
    expect(engine.settings().stt).toEqual([{ id: "whisper-small", on: true }, { id: "moonshine", on: false }, STEPS[2], STEPS[3], STEPS[4]]);
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
    expect(saved.body.settings).toEqual({ cloud: false, sttModel: "small.en", writer: false, stt: STEPS });
    const refused = await request(app).put("/api/engine/settings").send({ cloud: true }).expect(400);
    expect(refused.body.error).toContain("Cloud AI needs an OpenAI key");

    await queue.idle();
    const done = await request(app).get("/api/engine").expect(200);
    expect(done.body).toMatchObject({ ready: true, headline: "Local engine: ready" });
  });

  it("a tap gets a setup job that is sitting in the queue going", async () => {
    const { app, queue, db } = setup();
    const ts = new Date().toISOString();
    // A waiting job nothing is working on: the queue was never told about it.
    db.prepare(
      "INSERT INTO jobs (type, payload, status, max_attempts, created_at, updated_at) VALUES (?, '{}', 'queued', 3, ?, ?)",
    ).run(ENGINE_SETUP_JOB, ts, ts);

    await request(app).post("/api/engine/setup").expect(202);
    await queue.idle();
    expect(queue.list().map((j) => `${j.type}:${j.status}`)).toEqual([`${ENGINE_SETUP_JOB}:done`]);
    const done = await request(app).get("/api/engine").expect(200);
    expect(done.body).toMatchObject({ ready: true, headline: "Local engine: ready" });
  });
});

describe("engine: the speech-to-text chain on real audio (fake engine runners, real cutting)", () => {
  const heard = (text: string): StepResult => ({ words: text.split(" ").map((w, i) => ({ word: w, startSec: 1 + i, endSec: 1.5 + i })), avgLogProb: -0.2, heardSec: 20, silentSec: 0 });
  const step = (id: string, label: string, run: (audio: string) => StepResult, cloud = false): SttStep => ({
    id, label, languages: "any", cloud, unavailable: () => null,
    run: async (audio) => {
      // A real step takes time; a few milliseconds here give the measured speed something to divide by.
      await new Promise((r) => setTimeout(r, 5));
      return run(audio);
    },
  });
  const broken = (id: string, label: string) =>
    step(id, label, () => {
      throw new Error(`${label} crashed`);
    });

  /** 150 s of a tone with half a second of silence at 58 s and at 121 s: three segments, cut at the pauses. */
  async function audio(): Promise<string> {
    const file = join(dir, "tone.wav");
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=150",
      "-af", "volume=enable='between(t,58,58.5)+between(t,121,121.5)':volume=0", "-ar", "16000", "-ac", "1", file,
    ]);
    return file;
  }

  it("cuts at the pauses, hands each segment's own audio to the step, stitches the words and records which step did what", async () => {
    const lengths: number[] = [];
    const { engine, db } = setup({
      sttSteps: () => [
        step("moonshine", "Moonshine", (file) => {
          if (/segment-1/.test(file)) throw new Error("crashed");
          lengths.push(Math.round(statSync(file).size / 32000));
          return heard("fast words");
        }),
        step("whisper-small", "Whisper small", () => heard("careful words")),
      ],
    });
    const vodId = Number(db.prepare("INSERT INTO engine_runs (vod_id, kind, report, created_at) VALUES (7, 'stt', ?, ?)").run(JSON.stringify({ kind: "stt", language: null, uses: [], fallbacks: [], summary: "old try" }), new Date().toISOString()).lastInsertRowid) && 7;
    const tmpDir = join(dir, "job");
    await mkdir(tmpDir);
    const progress: number[] = [];
    const transcript = await engine.transcriber.transcribe(await audio(), { durationSec: 150, tmpDir, run: { vodId }, onProgress: (f) => progress.push(Math.round(f * 100)) });

    // Segments of 58.25 s, 63 s and 28.75 s: each step got that much audio, not the whole file.
    expect(lengths).toEqual([58, 29]);
    // Each word keeps the time its step gave it, moved to where its segment starts (the cuts are within 20 ms of 58.25 and 121.25).
    expect(transcript.words.map((w) => `${w.word} ${w.startSec.toFixed(1)}-${w.endSec.toFixed(1)}`)).toEqual([
      "fast 1.0-1.5", "words 2.0-2.5", "careful 59.3-59.8", "words 60.3-60.8", "fast 122.3-122.8", "words 123.3-123.8",
    ]);
    expect(transcript.report!.summary).toBe("Moonshine 58%, Whisper small 42%");
    expect(progress).toEqual([39, 81, 100]);
    // Segment audio is deleted as it goes.
    expect(await readdir(tmpDir)).toEqual([]);

    // The retry replaced the video's earlier run; the Dashboard reads the new one.
    expect(engine.reportsFor(7).map((r) => r.summary)).toEqual(["Moonshine 58%, Whisper small 42%"]);
    const status = engine.status([]);
    expect(status.week.jobs).toBe(1);
    expect(status.week.lines).toEqual(["Moonshine: 58% of the audio. Passed over 1 time: 1 failed", "Whisper small: 42% of the audio"]);
    expect(status.steps.find((s) => s.id === "moonshine")!.speed).toBeGreaterThan(0);
    expect(status.steps.find((s) => s.id === "whisper-turbo")!.speed).toBeNull();
  });

  it("fails the job with a clear error when every local step fails and cloud is off", async () => {
    const { engine } = setup({ sttSteps: () => [broken("moonshine", "Moonshine"), broken("whisper-small", "Whisper small")] });
    const tmpDir = join(dir, "job");
    await mkdir(tmpDir);
    await expect(engine.transcriber.transcribe(await audio(), { durationSec: 150, tmpDir })).rejects.toThrow(
      'Speech-to-text failed for the part at 0:00: no step could transcribe it. Moonshine: Moonshine crashed Whisper small: Whisper small crashed Cloud AI is off; switch on "Fall back to cloud AI" on the Dashboard to let it take over when this happens.',
    );
    expect(await readdir(tmpDir)).toEqual([]);
  });

  it("falls back to cloud when every local step fails and the cloud step is switched on", async () => {
    const sent: number[] = [];
    const cloudTranscriber: Transcriber = {
      name: "openai",
      transcribe: async (_file, o) => {
        sent.push(Math.round(o.durationSec));
        return { words: [{ word: "cloud", startSec: 0.5, endSec: 1 }], costUsd: 0.006 };
      },
    };
    const { engine } = setup({ cloud: true, cloudTranscriber, sttSteps: (real) => [broken("moonshine", "Moonshine"), ...real.filter((s) => s.cloud)] });
    // Off by default: the real chain has no cloud step until it is switched on.
    engine.saveSettings({ stt: STEPS.map((s) => (s.id === "cloud" ? { ...s, on: true } : s)) });
    const tmpDir = join(dir, "job");
    await mkdir(tmpDir);
    const transcript = await engine.transcriber.transcribe(await audio(), { durationSec: 150, tmpDir });
    expect(sent).toEqual([58, 63, 29]);
    expect(transcript.words.map((w) => w.startSec.toFixed(1))).toEqual(["0.5", "58.8", "121.8"]);
    expect(transcript.costUsd).toBe(0.018);
    expect(transcript.report!.summary).toBe("Cloud (OpenAI) 100%");
    expect(engine.transcriber.name).toBe("local");
  });

  it('with "Use cloud AI for speed" on, a cloud failure falls back to the local chain instead of failing the job', async () => {
    const cloudTranscriber: Transcriber = { name: "openai", transcribe: () => Promise.reject(new Error("OpenAI transcription failed (500): down")) };
    const { engine } = setup({ cloud: true, cloudTranscriber, sttSteps: (real) => [step("moonshine", "Moonshine", () => heard("local words")), ...real.filter((s) => s.cloud)] });
    engine.saveSettings({ cloud: true });
    const tmpDir = join(dir, "job");
    await mkdir(tmpDir);
    const transcript = await engine.transcriber.transcribe(await audio(), { durationSec: 150, tmpDir });
    expect(transcript.report!.summary).toBe("Moonshine 100%");
    expect(transcript.words.length).toBe(6);
  });
});

describe("engine: the picks chain", () => {
  const words = (text: string, at: number) => text.split(" ").map((w, i) => ({ word: w, startSec: at + i * 0.5, endSec: at + i * 0.5 + 0.4 }));
  const input = {
    title: "GTA night", durationSec: 120, chapters: [],
    words: [...words("we are driving to the next mission now.", 5), ...words("NO WAY! He actually jumped off the roof! That was insane, clip it!", 40), ...words("okay calm down we still need to finish the delivery.", 80)],
    signals: { loudness: Array.from({ length: 120 }, (_, i) => (i >= 40 && i < 50 ? -8 : -30)), chat: null },
    creatorName: "Kai", briefRules: "", bannedContent: "", maxPicks: 15, run: { vodId: 3 },
  };

  it("with cloud AI on and the cloud picker down, the local chain still makes the picks and says the cloud was passed over", async () => {
    const db = openDb(":memory:");
    const engine = new Engine({
      modelsDir: join(dir, "none"),
      catalog,
      cloudTranscriber: () => new FakeTranscriber(),
      cloudPicker: () => ({ name: "llm", pick: () => Promise.reject(new Error("The picking model failed (500): down")) }),
    });
    engine.bind(db);
    engine.saveSettings({ cloud: true, writer: false });
    const result = await engine.picker.pick(input);
    expect(result.picks.length).toBeGreaterThan(0);
    expect(result.picks[0]!.hook).toBe("He actually jumped off the roof!");
    expect(result.report!.fallbacks).toEqual([{ step: "cloud-picker", reason: "The picking model failed (500): down", count: 1 }]);
    expect(engine.reportsFor(3).map((r) => r.kind)).toEqual(["picks"]);
  });

  it("uses the cloud writer for hooks only when cloud is enabled and the local writer cannot run", async () => {
    const asked: string[] = [];
    const cloudChat: ChatClient = {
      name: "llm:test",
      complete: async (req) => {
        asked.push(req.schemaName);
        return { content: JSON.stringify({ hook: "He jumped off the ROOF", title: "Kai cannot believe this jump", flags: { spoiler: false, cutscene: false, ending: false, leak: false, breaks_brief: false } }), costUsd: 0.001 };
      },
    };
    const make = () => {
      const engine = new Engine({ modelsDir: join(dir, "none"), catalog, cloudTranscriber: () => new FakeTranscriber(), cloudPicker: () => new FakePicker(), cloudChat: () => cloudChat });
      engine.bind(openDb(":memory:"));
      return engine;
    };
    // Cloud off: the local writer is not downloaded, so hooks come from the transcript and no cloud call is made.
    const off = await make().picker.pick(input);
    expect(asked).toEqual([]);
    expect(off.picks[0]!.hook).toBe("He actually jumped off the roof!");
    expect(off.picks[0]!.reason).toContain("Hook taken from the transcript: Hook writer program (llama.cpp) and Hook writer model (Qwen2.5 1.5B) are not downloaded yet.");

    const on = make();
    on.saveSettings({ stt: STEPS.map((s) => (s.id === "cloud" ? { ...s, on: true } : s)) });
    const result = await on.picker.pick(input);
    expect(asked.length).toBe(result.picks.length);
    expect(result.picks[0]!.hook).toBe("He jumped off the ROOF");
    expect(result.costUsd).toBeCloseTo(0.001 * result.picks.length, 6);
    expect(result.report!.summary).toBe(`Signal scoring ranked ${result.picks.length}; Cloud writer ${result.picks.length}`);
  });

  it("Gemini writes the hooks ahead of OpenAI when Google is connected, and OpenAI takes over when Google stops", async () => {
    const copy = (hook: string) => JSON.stringify({ hook, title: "Kai cannot believe this jump", flags: { spoiler: false, cutscene: false, ending: false, leak: false, breaks_brief: false } });
    const asked: string[] = [];
    let googleUp = true;
    const gemini: ChatClient = {
      name: "gemini:test",
      complete: async () => {
        asked.push("gemini");
        if (!googleUp) throw new Error("Today's Google limit (€3.00) is reached.");
        return { content: copy("GEMINI saw the jump"), costUsd: 0.0005 };
      },
    };
    const openai: ChatClient = { name: "llm:test", complete: async () => (asked.push("openai"), { content: copy("OPENAI saw the jump"), costUsd: 0.001 }) };
    const engine = new Engine({
      modelsDir: join(dir, "none"), catalog, cloudTranscriber: () => new FakeTranscriber(), cloudPicker: () => new FakePicker(),
      cloudChat: () => openai, googleChat: () => gemini,
    });
    engine.bind(openDb(":memory:"));
    engine.saveSettings({ stt: STEPS.map((s) => (s.id === "cloud" ? { ...s, on: true } : s)) });

    const first = await engine.picker.pick(input);
    expect(new Set(asked)).toEqual(new Set(["gemini"]));
    expect(first.picks[0]!.hook).toBe("GEMINI saw the jump");
    expect(first.report!.summary).toBe(`Signal scoring ranked ${first.picks.length}; Gemini writer ${first.picks.length}`);

    googleUp = false;
    asked.length = 0;
    const second = await engine.picker.pick(input);
    expect(asked[0]).toBe("gemini");
    expect(second.picks[0]!.hook).toBe("OPENAI saw the jump");
    expect(second.report!.fallbacks).toContainEqual({ step: "gemini-writer", reason: "Today's Google limit (€3.00) is reached.", count: 1 });
  });
});
