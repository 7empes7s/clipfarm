import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { EngineSettings, EngineStatus, Job } from "../../shared/types.js";
import type { Db } from "../db/index.js";
import { HttpError, ValidationError } from "../errors.js";
import { LocalPicker, WriterUnavailableError } from "../pipeline/picks/local.js";
import type { Picker } from "../pipeline/picks/types.js";
import { transcribeLocally, type WhisperSetup } from "../pipeline/transcript/local.js";
import type { Transcriber } from "../pipeline/transcript/types.js";
import { run } from "../tools/exec.js";
import { DEFAULT_LLM_MODEL, DEFAULT_STT_MODEL, defaultCatalog, type EnginePartSpec } from "./catalog.js";
import { downloadVerified } from "./download.js";
import { LlamaWriter } from "./llama.js";
import { type MemoryReading, memoryProblem, readMemory } from "./memory.js";

export const ENGINE_SETUP_JOB = "engine-setup";

/** Something the local engine needs is not downloaded yet. Trying again will not help, setting up will. */
export class EngineNotReadyError extends HttpError {
  constructor(message: string) {
    super(409, message);
  }
}

export interface EngineOptions {
  /** DATA_DIR/models: where the programs and models are kept. */
  modelsDir: string;
  catalog?: EnginePartSpec[];
  /** Your own whisper.cpp `whisper-cli` / llama.cpp `llama-server`, instead of the downloaded ones. */
  whisperBin?: string;
  llamaServerBin?: string;
  /** The optional speed-up, asked for on each use (a key can be added while running); null without an OpenAI key. */
  cloudTranscriber: () => Transcriber | null;
  cloudPicker: () => Picker | null;
  /** Free memory and the room under the service's cap; read from the system unless a test gives it. */
  memory?: () => MemoryReading;
  fetchImpl?: typeof fetch;
}

const DEFAULTS: EngineSettings = { cloud: false, sttModel: DEFAULT_STT_MODEL, writer: true };
const mb = (bytes: number) => Math.max(1, Math.round(bytes / 1024 / 1024));

/**
 * clipfarm's own engine: speech-to-text and picks on this server, with nothing outside it.
 * It knows what must be on disk, downloads and checks it, guards memory, and hands the pipeline
 * a transcriber and a picker that follow the settings (local by default, cloud as an option).
 */
export class Engine {
  private db: Db | null = null;
  private readonly catalog: EnginePartSpec[];
  private readonly memory: () => MemoryReading;
  readonly transcriber: Transcriber;
  readonly picker: Picker;

  constructor(private opts: EngineOptions) {
    this.catalog = opts.catalog ?? defaultCatalog();
    this.memory = opts.memory ?? readMemory;

    const settings = () => this.settings();
    this.transcriber = {
      get name() {
        const s = settings();
        return s.cloud ? (opts.cloudTranscriber()?.name ?? "openai") : `local:${s.sttModel}`;
      },
      transcribe: async (audio, o) => {
        if (this.settings().cloud) return this.cloud(opts.cloudTranscriber()).transcribe(audio, o);
        return transcribeLocally(this.whisperSetup(), audio, o, this.memory());
      },
    };
    const writer = new LlamaWriter(() => this.llamaSetup(), this.memory);
    const local = new LocalPicker(() => (this.settings().writer ? writer : null));
    this.picker = {
      get name() {
        return settings().cloud ? (opts.cloudPicker()?.name ?? "llm") : local.name;
      },
      pick: async (input, signal) => (this.settings().cloud ? this.cloud(opts.cloudPicker()) : local).pick(input, signal),
    };
  }

  /** Settings live in the database; until it is bound (and in tests without one) the defaults apply. */
  bind(db: Db): void {
    this.db = db;
  }

  settings(): EngineSettings {
    const row = this.db?.prepare("SELECT value FROM settings WHERE key = 'engine'").get() as { value: string } | undefined;
    const saved = row ? (JSON.parse(row.value) as Partial<EngineSettings>) : {};
    const s = { ...DEFAULTS, ...saved };
    // A model that left the catalog falls back to the default instead of breaking transcription.
    if (!this.find("stt", s.sttModel)) s.sttModel = DEFAULT_STT_MODEL;
    return s;
  }

  saveSettings(raw: unknown): EngineSettings {
    const body = (raw ?? {}) as Record<string, unknown>;
    const next = { ...this.settings() };
    if (typeof body.cloud === "boolean") {
      if (body.cloud && !this.cloudAvailable()) {
        throw new ValidationError("Cloud AI needs an OpenAI key first. Add it in Settings.");
      }
      next.cloud = body.cloud;
    }
    if (body.sttModel !== undefined) {
      if (typeof body.sttModel !== "string" || !this.find("stt", body.sttModel)) throw new ValidationError("Pick one of the listed speech models.");
      next.sttModel = body.sttModel;
    }
    if (typeof body.writer === "boolean") next.writer = body.writer;
    if (!this.db) throw new Error("Engine settings cannot be saved before the database is open.");
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES ('engine', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(next));
    return next;
  }

  private cloudAvailable(): boolean {
    return Boolean(this.opts.cloudTranscriber() && this.opts.cloudPicker());
  }

  private cloud<T>(adapter: T | null): T {
    if (!adapter) throw new EngineNotReadyError("Cloud AI is switched on, but there is no OpenAI key. Add it in Settings, or switch cloud AI off on the Dashboard to use the local engine.");
    return adapter;
  }

  private find(kind: EnginePartSpec["kind"], id?: string): EnginePartSpec | undefined {
    return this.catalog.find((p) => p.kind === kind && (id === undefined || p.id === id));
  }

  private override(spec: EnginePartSpec): string | undefined {
    return spec.kind === "stt-runtime" ? this.opts.whisperBin : spec.kind === "llm-runtime" ? this.opts.llamaServerBin : undefined;
  }

  /** Where a part is (or will be) on disk: the program to run, or the model file. */
  pathOf(spec: EnginePartSpec): string {
    const own = this.override(spec);
    if (own) return own;
    if (spec.bin) return join(this.opts.modelsDir, "runtime", spec.id, spec.bin);
    return join(this.opts.modelsDir, basename(new URL(spec.url).pathname));
  }

  private present(spec: EnginePartSpec): boolean {
    return this.override(spec) !== undefined || existsSync(this.pathOf(spec));
  }

  /** The parts the current settings need: speech always, the hook writer when it is on. */
  private wanted(): EnginePartSpec[] {
    const s = this.settings();
    const ids: (EnginePartSpec | undefined)[] = [this.find("stt-runtime"), this.find("vad"), this.find("stt", s.sttModel)];
    if (s.writer) ids.push(this.find("llm-runtime"), this.find("llm", DEFAULT_LLM_MODEL));
    return ids.filter((p): p is EnginePartSpec => p !== undefined);
  }

  /** What still has to be downloaded for the current settings. */
  missing(): EnginePartSpec[] {
    return this.wanted().filter((p) => !this.present(p));
  }

  /** Programs this kind of machine has no ready-made build for (and no own one was given). */
  private unsupported(): string[] {
    const s = this.settings();
    const system = `${process.platform} ${process.arch}`;
    const out: string[] = [];
    if (!this.find("stt-runtime") && !this.opts.whisperBin) {
      out.push(`There is no ready-made speech-to-text program for this system (${system}). Set WHISPER_BIN to whisper.cpp's whisper-cli.`);
    }
    if (s.writer && !this.find("llm-runtime") && !this.opts.llamaServerBin) {
      out.push(`There is no ready-made hook writer program for this system (${system}). Set LLAMA_SERVER_BIN to llama.cpp's llama-server, or switch the hook writer off.`);
    }
    return out;
  }

  private notReady(what: EnginePartSpec[]): EngineNotReadyError {
    const names = [...this.unsupported(), ...what.map((p) => `${p.label} is not downloaded.`)].join(" ");
    return new EngineNotReadyError(`The local engine is not set up yet. ${names} Open the Dashboard and tap "Set up the local engine".`);
  }

  private whisperSetup(): WhisperSetup {
    const [bin, vad, model] = [this.find("stt-runtime"), this.find("vad"), this.find("stt", this.settings().sttModel)];
    const gone = [bin, vad, model].filter((p): p is EnginePartSpec => p !== undefined && !this.present(p));
    if (!model || !vad || (!bin && !this.opts.whisperBin) || gone.length > 0) throw this.notReady(gone);
    return {
      bin: bin ? this.pathOf(bin) : this.opts.whisperBin!,
      model: this.pathOf(model),
      vadModel: this.pathOf(vad),
      modelId: model.id,
      needMb: model.needMb ?? 0,
    };
  }

  private llamaSetup() {
    const [bin, model] = [this.find("llm-runtime"), this.find("llm", DEFAULT_LLM_MODEL)];
    const gone = [bin, model].filter((p): p is EnginePartSpec => p !== undefined && !this.present(p));
    if (!model || (!bin && !this.opts.llamaServerBin) || gone.length > 0) {
      throw new WriterUnavailableError(
        gone.length > 0 ? `${gone.map((p) => p.label).join(" and ")} ${gone.length === 1 ? "is" : "are"} not downloaded yet.` : "the hook writer cannot run on this system.",
      );
    }
    return { bin: bin ? this.pathOf(bin) : this.opts.llamaServerBin!, model: this.pathOf(model), modelId: model.id, needMb: model.needMb ?? 0 };
  }

  /** Downloads one part, checks it, and (for a program) unpacks it. Safe to run again after an interruption. */
  async install(spec: EnginePartSpec, o: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}): Promise<void> {
    const common = { url: spec.url, sha256: spec.sha256, bytes: spec.bytes, fetchImpl: this.opts.fetchImpl, ...o };
    if (!spec.bin) {
      await downloadVerified({ ...common, dest: this.pathOf(spec) });
      return;
    }
    const dir = join(this.opts.modelsDir, "runtime", spec.id);
    const archive = `${dir}.tar.gz`;
    const unpacked = `${dir}.unpacking`;
    await downloadVerified({ ...common, dest: archive });
    await rm(unpacked, { recursive: true, force: true });
    await mkdir(unpacked, { recursive: true });
    try {
      await run("tar", ["-xzf", archive, "-C", unpacked, "--strip-components=1"], { signal: o.signal });
      await rm(dir, { recursive: true, force: true });
      await rename(unpacked, dir);
    } finally {
      await rm(unpacked, { recursive: true, force: true });
      await rm(archive, { force: true });
    }
  }

  /** What the Dashboard shows: ready, or exactly what is missing. `jobs` is the recent job list. */
  status(jobs: Job[], mode: "auto" | "test" = "auto"): EngineStatus {
    const settings = this.settings();
    const memory = this.memory();
    const stt = this.find("stt", settings.sttModel);
    const needMb = stt?.needMb ?? 0;
    const sttModels = this.catalog
      .filter((p) => p.kind === "stt")
      .map((p) => ({ id: p.id, label: p.label, note: p.note ?? "", bytes: p.bytes, needMb: p.needMb ?? 0, present: this.present(p) }));
    const cloudAvailable = this.cloudAvailable();
    const short = stt ? memoryProblem(`the speech model (${stt.id})`, needMb, memory) : null;
    const base = { settings, sttModels, cloudAvailable, memory: { availableMb: memory.freeMb, needMb, ok: short === null } };
    if (mode === "test") {
      return { ...base, mode, ready: true, headline: "Test engine: no real transcription (demo mode)", problems: [], downloads: [], setupJob: null };
    }
    if (settings.cloud) {
      return {
        ...base,
        mode: "cloud",
        ready: cloudAvailable,
        headline: cloudAvailable ? "Cloud AI: on" : "Cloud AI: no key",
        problems: cloudAvailable ? [] : ["Cloud AI is switched on, but there is no OpenAI key. Add it in Settings, or switch cloud AI off."],
        downloads: [],
        setupJob: null,
      };
    }
    const missing = this.missing();
    const problems = [
      ...this.unsupported(),
      ...missing.map((p) => `${p.label} is not downloaded yet (${mb(p.bytes)} MB).`),
      ...(short ? [short] : []),
    ];
    const last = jobs.filter((j) => j.type === ENGINE_SETUP_JOB).sort((a, b) => b.id - a.id)[0];
    const showJob = last && (last.status === "queued" || last.status === "running" || (last.status === "failed" && missing.length > 0));
    return {
      ...base,
      mode: "local",
      ready: problems.length === 0,
      headline: problems.length === 0 ? "Local engine: ready" : "Local engine: not ready",
      problems,
      downloads: missing.map((p) => ({ id: p.id, label: p.label, bytes: p.bytes })),
      setupJob: showJob ? { id: last.id, status: last.status, progress: last.progress, message: last.message, error: last.error } : null,
    };
  }
}
