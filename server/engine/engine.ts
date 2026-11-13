import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { basename, delimiter, dirname, join } from "node:path";
import type { EngineReport, EngineSettings, EngineStatus, EngineStepStatus, Job } from "../../shared/types.js";
import type { Db } from "../db/index.js";
import { HttpError, ValidationError } from "../errors.js";
import type { ChatClient } from "../pipeline/picks/llm.js";
import { chatWriter, LocalPicker, type WriterStep, WriterUnavailableError } from "../pipeline/picks/local.js";
import type { PickInput, Picker, PickerResult } from "../pipeline/picks/types.js";
import { cutSegment, findPauses, firstSpeech } from "../pipeline/transcript/audio.js";
import { type ChainThresholds, DEFAULT_THRESHOLDS, planSegments, runChain, type SttStep } from "../pipeline/transcript/chain.js";
import { detectLanguage, runWhisper, type WhisperSetup } from "../pipeline/transcript/local.js";
import type { TranscribeOptions, Transcriber, Transcript } from "../pipeline/transcript/types.js";
import { run } from "../tools/exec.js";
import { DEFAULT_LLM_MODEL, DEFAULT_STT_MODEL, defaultCatalog, type EnginePartSpec, MOONSHINE_MODEL, WHISPER_SMALL, WHISPER_TURBO } from "./catalog.js";
import { downloadVerified } from "./download.js";
import { LlamaWriter } from "./llama.js";
import { type MemoryReading, memoryProblem, NotEnoughMemoryError, readMemory } from "./memory.js";
import { type MoonshineSetup, runMoonshine } from "./moonshine.js";
import { EngineRuns, measuredSpeed, weekLines } from "./runs.js";

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
  /** The cloud model as a hook writer, for when the local writer fails and cloud fallback is on; null without a key. */
  cloudChat?: () => ChatClient | null;
  /** Python 3, which loads Moonshine's library (standard library only). */
  pythonBin?: string;
  /** When an answer counts as poor and how the audio is cut. */
  thresholds?: ChainThresholds;
  /** The speech-to-text steps, instead of the real ones (tests). */
  sttSteps?: (real: SttStep[]) => SttStep[];
  /** Free memory and the room under the service's cap; read from the system unless a test gives it. */
  memory?: () => MemoryReading;
  fetchImpl?: typeof fetch;
}

/**
 * The speech-to-text chain, most efficient first. `auto` steps are English-only or cover every
 * language; the cloud step is off until the manager switches it on.
 */
const STT_STEPS = [
  { id: "moonshine", label: "Moonshine", note: "English only. The fastest and lightest, so it goes first.", languages: "en", on: true },
  { id: "whisper-small", label: "Whisper small", note: "Every language. Takes over for other languages and for parts Moonshine got wrong.", languages: "any", on: true },
  { id: "whisper-turbo", label: "Whisper large-v3-turbo", note: "The most accurate and the slowest: only for parts the earlier steps got wrong, and only when memory allows.", languages: "any", on: true },
  { id: "whisper-en", label: "Whisper English", note: "The English speech model picked below.", languages: "en", on: false },
  { id: "cloud", label: "Cloud (OpenAI)", note: "A paid service: only when every local step fails.", languages: "any", on: false },
] as const;
type StepId = (typeof STT_STEPS)[number]["id"];

const DEFAULTS: EngineSettings = {
  cloud: false,
  sttModel: DEFAULT_STT_MODEL,
  writer: true,
  stt: STT_STEPS.map((s) => ({ id: s.id, on: s.on })),
};
const mb = (bytes: number) => Math.max(1, Math.round(bytes / 1024 / 1024));
/** The language is told from this much speech at the start. */
const LANGUAGE_SAMPLE_SEC = 30;

/** Whether a program can be started: a path that exists, or a name found on the PATH. */
function onPath(bin: string): boolean {
  if (bin.includes("/")) return existsSync(bin);
  const { PATH: path = "" } = process.env;
  return path.split(delimiter).some((dir) => dir && existsSync(join(dir, bin)));
}

/**
 * clipfarm's own engine: speech-to-text and picks on this server, with nothing outside it.
 * It knows what must be on disk, downloads and checks it, guards memory, and hands the pipeline
 * a transcriber and a picker that follow the settings (local by default, cloud as an option).
 */
export class Engine {
  private db: Db | null = null;
  private readonly catalog: EnginePartSpec[];
  private readonly memory: () => MemoryReading;
  private readonly thresholds: ChainThresholds;
  private runs: EngineRuns | null = null;
  readonly transcriber: Transcriber;
  readonly picker: Picker;

  constructor(private opts: EngineOptions) {
    this.catalog = opts.catalog ?? defaultCatalog();
    this.memory = opts.memory ?? readMemory;

    this.thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
    const settings = () => this.settings();
    this.transcriber = {
      get name() {
        return settings().cloud ? (opts.cloudTranscriber()?.name ?? "openai") : "local";
      },
      transcribe: (audio, o) => this.transcribe(audio, o),
    };
    const writer = new LlamaWriter(() => this.llamaSetup(), this.memory);
    const local = new LocalPicker((): WriterStep[] => {
      const s = this.settings();
      const cloud = s.cloud || s.stt.some((x) => x.id === "cloud" && x.on) ? (opts.cloudChat?.() ?? null) : null;
      return [
        ...(s.writer ? [{ id: "writer", label: "Local writer", writer }] : []),
        ...(cloud ? [{ id: "cloud-writer", label: "Cloud writer", writer: chatWriter(cloud) }] : []),
      ];
    });
    this.picker = {
      get name() {
        return settings().cloud ? (opts.cloudPicker()?.name ?? "llm") : local.name;
      },
      pick: (input, signal) => this.pick(local, input, signal),
    };
  }

  /** Cloud first when "Use cloud AI for speed" is on; if it fails, the local chain still makes the picks. */
  private async pick(local: LocalPicker, input: PickInput, signal?: AbortSignal): Promise<PickerResult> {
    let result: PickerResult | null = null;
    let cloudFailed: string | null = null;
    if (this.settings().cloud) {
      const started = Date.now();
      try {
        const picked = await this.cloud(this.opts.cloudPicker()).pick(input, signal);
        const use = { step: "cloud-picker", label: "Cloud picker", count: picked.picks.length, audioSec: 0, ms: Date.now() - started, peakMb: null, note: "" };
        result = { ...picked, report: { kind: "picks", language: null, uses: [use], fallbacks: [], summary: `Cloud picker ${picked.picks.length}` } };
      } catch (err) {
        signal?.throwIfAborted();
        cloudFailed = err instanceof Error ? err.message : String(err);
        console.warn(`[picks] cloud picker failed, using the local engine: ${cloudFailed}`);
      }
    }
    if (!result) {
      result = await local.pick(input, signal);
      if (cloudFailed && result.report) result.report.fallbacks.unshift({ step: "cloud-picker", reason: cloudFailed, count: 1 });
    }
    this.record(input.run, result.report);
    return result;
  }

  private record(target: { vodId: number; add?: boolean } | undefined, report: EngineReport | undefined): void {
    if (!this.runs || !report) return;
    if (target && !target.add) this.runs.replace(target.vodId, report);
    else this.runs.record(target?.vodId ?? null, report);
  }

  /**
   * Speech-to-text through the chain. With "Use cloud AI for speed" on, the cloud takes the whole
   * file first (one upload is faster than one per segment); if that fails, the local steps do it.
   */
  private async transcribe(audio: string, o: TranscribeOptions): Promise<Transcript> {
    let steps = this.sttSteps();
    const cloudFirst = this.settings().cloud;
    if (cloudFirst) {
      const started = Date.now();
      try {
        const done = await this.cloud(this.opts.cloudTranscriber()).transcribe(audio, o);
        const use = { step: "cloud", label: "Cloud (OpenAI)", count: 1, audioSec: o.durationSec, ms: Date.now() - started, peakMb: null, note: "" };
        const report: EngineReport = { kind: "stt", language: null, uses: [use], fallbacks: [], summary: "Cloud (OpenAI) 100%" };
        this.record(o.run, report);
        return { ...done, report };
      } catch (err) {
        o.signal?.throwIfAborted();
        steps = steps.filter((s) => !s.cloud);
        // No local step to fall back on: the cloud's own error is the one to show.
        if (!steps.some((s) => s.unavailable() === null)) throw err;
        console.warn(`[transcribe] cloud failed, using the local engine: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!steps.some((s) => s.unavailable() === null)) {
      if (this.missing().length > 0 || this.unsupported().length > 0) throw this.notReady(this.missing());
      // Everything is on disk, so what stops every step is memory: say so, in the first step's words.
      throw new NotEnoughMemoryError(steps.find((s) => !s.cloud)?.unavailable() ?? "No speech-to-text step can run right now.");
    }

    const t = this.thresholds;
    const started = Date.now();
    // Pauses only decide where to cut; without them the cuts fall at fixed lengths.
    const pauses = await findPauses(audio, o.durationSec, t.minPauseSec, o.signal).catch((err: unknown) => {
      o.signal?.throwIfAborted();
      console.warn(`[transcribe] ${err instanceof Error ? err.message : String(err)}`);
      return [];
    });
    const segments = planSegments(o.durationSec, pauses, t);
    const language = await this.language(audio, o);
    const result = await runChain(segments, language, {
      steps,
      thresholds: t,
      tmpDir: o.tmpDir,
      signal: o.signal,
      onProgress: o.onProgress,
      cut: (segment) => cutSegment(audio, segment, join(o.tmpDir, `segment-${segment.index}.wav`), o.signal),
      done: (path) => rm(path, { force: true }),
    });
    console.log(
      `[transcribe] ${Math.round(o.durationSec)} s of audio in ${Math.round((Date.now() - started) / 1000)} s, ${result.words.length} words, language ${language ?? "unknown"}: ${result.report.summary}` +
        result.report.uses.map((u) => `; ${u.label} ${Math.round(u.ms / 1000)} s, peak memory ${u.peakMb ?? "?"} MB`).join(""),
    );
    this.record(o.run, result.report);
    return result;
  }

  /**
   * The language of the first 30 s of speech, told by a multilingual Whisper model (its language
   * ID). Null when no such model can run now or it does not say: the stream is then taken as English.
   */
  private async language(audio: string, o: TranscribeOptions): Promise<string | null> {
    if (this.opts.sttSteps) return null;
    for (const id of [WHISPER_SMALL, WHISPER_TURBO]) {
      const setup = this.whisperSetupFor("stt-multi", id);
      if (typeof setup === "string") continue;
      const sample = join(o.tmpDir, "language.wav");
      try {
        await firstSpeech(audio, sample, LANGUAGE_SAMPLE_SEC, o.signal);
        return await detectLanguage(setup, sample, this.memory(), o.signal);
      } catch (err) {
        o.signal?.throwIfAborted();
        console.warn(`[transcribe] could not tell the language: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        await rm(sample, { force: true });
      }
    }
    return null;
  }

  /** The chain as it runs now: the steps switched on, in the saved order. */
  private sttSteps(): SttStep[] {
    const s = this.settings();
    const real = s.stt.filter((x) => x.on).map((x) => this.sttStep(x.id as StepId));
    return this.opts.sttSteps ? this.opts.sttSteps(real) : real;
  }

  private sttStep(id: StepId): SttStep {
    const def = STT_STEPS.find((d) => d.id === id)!;
    const base = { id, label: def.label, languages: def.languages };
    if (id === "cloud") {
      return {
        ...base,
        cloud: true,
        unavailable: () => (this.opts.cloudTranscriber() ? null : "there is no OpenAI key."),
        run: async (audio, o) => {
          const done = await this.cloud(this.opts.cloudTranscriber()).transcribe(audio, { durationSec: o.durationSec, tmpDir: o.tmpDir, signal: o.signal });
          return { words: done.words, costUsd: done.costUsd };
        },
      };
    }
    if (id === "moonshine") {
      const setup = () => this.moonshineSetup();
      return {
        ...base,
        unavailable: () => {
          const x = setup();
          return typeof x === "string" ? x : memoryProblem("the speech model (Moonshine)", x.needMb, this.memory());
        },
        run: (audio, o) => runMoonshine(setup() as MoonshineSetup, audio, o, this.memory()),
      };
    }
    const setup = () => (id === "whisper-en" ? this.whisperSetupFor("stt", this.settings().sttModel) : this.whisperSetupFor("stt-multi", id === "whisper-small" ? WHISPER_SMALL : WHISPER_TURBO));
    return {
      ...base,
      unavailable: () => {
        const x = setup();
        return typeof x === "string" ? x : memoryProblem(`the speech model (${x.modelId})`, x.needMb, this.memory());
      },
      run: (audio, o) => runWhisper(setup() as WhisperSetup, audio, { outBase: join(o.tmpDir, `whisper-${id}`), language: o.language, signal: o.signal }, this.memory()),
    };
  }

  /** Settings live in the database; until it is bound (and in tests without one) the defaults apply. */
  bind(db: Db): void {
    this.db = db;
    this.runs = new EngineRuns(db);
  }

  settings(): EngineSettings {
    const row = this.db?.prepare("SELECT value FROM settings WHERE key = 'engine'").get() as { value: string } | undefined;
    const saved = row ? (JSON.parse(row.value) as Partial<EngineSettings>) : {};
    const s = { ...DEFAULTS, ...saved };
    // A model that left the catalog falls back to the default instead of breaking transcription.
    if (!this.find("stt", s.sttModel)) s.sttModel = DEFAULT_STT_MODEL;
    // Steps saved before a new one existed keep their order; the new one joins where it sits by default.
    const known = (Array.isArray(saved.stt) ? saved.stt : []).filter((x) => STT_STEPS.some((d) => d.id === x.id));
    s.stt = [...known, ...DEFAULTS.stt.filter((d) => !known.some((x) => x.id === d.id))].map((x) => ({ id: x.id, on: x.on === true }));
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
    if (body.stt !== undefined) {
      const list = Array.isArray(body.stt) ? (body.stt as { id?: unknown; on?: unknown }[]) : [];
      const ids = list.map((x) => x?.id);
      if (ids.length !== STT_STEPS.length || STT_STEPS.some((d) => !ids.includes(d.id)) || list.some((x) => typeof x.on !== "boolean")) {
        throw new ValidationError("The speech-to-text order must list every step once, each on or off.");
      }
      if (list.some((x) => x.id === "cloud" && x.on) && !this.opts.cloudTranscriber()) {
        throw new ValidationError("Cloud AI needs an OpenAI key first. Add it in Settings.");
      }
      if (!list.some((x) => x.on && x.id !== "cloud")) throw new ValidationError("Keep at least one local speech-to-text step switched on.");
      next.stt = list.map((x) => ({ id: x.id as string, on: x.on as boolean }));
    }
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
    if (spec.file) return join(this.opts.modelsDir, spec.file);
    return join(this.opts.modelsDir, basename(new URL(spec.url).pathname));
  }

  private present(spec: EnginePartSpec): boolean {
    return this.override(spec) !== undefined || existsSync(this.pathOf(spec));
  }

  /** The files one speech-to-text step runs on. */
  private stepParts(id: string): EnginePartSpec[] {
    const whisper = [this.find("stt-runtime"), this.find("vad")];
    const parts: (EnginePartSpec | undefined)[] =
      id === "moonshine"
        ? [this.find("moonshine-runtime"), ...this.catalog.filter((p) => p.kind === "moonshine")]
        : id === "whisper-small"
          ? [...whisper, this.find("stt-multi", WHISPER_SMALL)]
          : id === "whisper-turbo"
            ? [...whisper, this.find("stt-multi", WHISPER_TURBO)]
            : id === "whisper-en"
              ? [...whisper, this.find("stt", this.settings().sttModel)]
              : [];
    return parts.filter((p): p is EnginePartSpec => p !== undefined);
  }

  /** The parts the current settings need: every speech step that is switched on, and the hook writer when it is on. */
  private wanted(): EnginePartSpec[] {
    const s = this.settings();
    const parts = s.stt.filter((x) => x.on).flatMap((x) => this.stepParts(x.id));
    if (s.writer) parts.push(...[this.find("llm-runtime"), this.find("llm", DEFAULT_LLM_MODEL)].filter((p): p is EnginePartSpec => p !== undefined));
    return [...new Set(parts)];
  }

  /** What still has to be downloaded: for the current settings, or for one step (its Download button). */
  missing(step?: string): EnginePartSpec[] {
    return (step ? this.stepParts(step) : this.wanted()).filter((p) => !this.present(p));
  }

  /** Why a step has no program to run on this kind of machine, or null. */
  private noProgram(id: string): string | null {
    const system = `${process.platform} ${process.arch}`;
    if (id === "moonshine") {
      if (!this.find("moonshine-runtime")) return `There is no ready-made Moonshine program for this system (${system}).`;
      const python = this.opts.pythonBin ?? "python3";
      return onPath(python) ? null : `Moonshine needs Python 3 (${python}), which is not installed on this server.`;
    }
    if (id.startsWith("whisper") && !this.find("stt-runtime") && !this.opts.whisperBin) {
      return `There is no ready-made speech-to-text program for this system (${system}). Set WHISPER_BIN to whisper.cpp's whisper-cli.`;
    }
    return null;
  }

  /** Programs this kind of machine has no ready-made build for (and no own one was given). */
  private unsupported(): string[] {
    const s = this.settings();
    const out = new Set<string>();
    for (const x of s.stt) {
      const why = x.on ? this.noProgram(x.id) : null;
      if (why) out.add(why);
    }
    if (s.writer && !this.find("llm-runtime") && !this.opts.llamaServerBin) {
      out.add(`There is no ready-made hook writer program for this system (${process.platform} ${process.arch}). Set LLAMA_SERVER_BIN to llama.cpp's llama-server, or switch the hook writer off.`);
    }
    return [...out];
  }

  private notReady(what: EnginePartSpec[]): EngineNotReadyError {
    const names = [...this.unsupported(), ...what.map((p) => `${p.label} is not downloaded.`)].join(" ");
    return new EngineNotReadyError(`The local engine is not set up yet. ${names} Open the Dashboard and tap "Set up the local engine".`);
  }

  /** Why a step cannot run for lack of files or a program, in plain words; null when all is there. */
  private notSetUp(id: string): string | null {
    const why = this.noProgram(id);
    if (why) return why;
    const gone = this.stepParts(id).filter((p) => !this.present(p));
    return gone.length > 0 ? `${gone.length === 1 ? gone[0]!.label : STT_STEPS.find((d) => d.id === id)!.label} is not downloaded yet.` : null;
  }

  /** What whisper.cpp runs on for one model, or why it cannot. */
  private whisperSetupFor(kind: "stt" | "stt-multi", modelId: string): WhisperSetup | string {
    const step = kind === "stt" ? "whisper-en" : modelId === WHISPER_SMALL ? "whisper-small" : "whisper-turbo";
    const why = this.notSetUp(step);
    if (why) return why;
    const [bin, vad, model] = [this.find("stt-runtime"), this.find("vad"), this.find(kind, modelId)];
    if (!model || !vad) return "its speech model is not in the catalog.";
    return {
      bin: bin ? this.pathOf(bin) : this.opts.whisperBin!,
      model: this.pathOf(model),
      vadModel: this.pathOf(vad),
      modelId: model.id,
      needMb: model.needMb ?? 0,
    };
  }

  /** What Moonshine runs on, or why it cannot. */
  private moonshineSetup(): MoonshineSetup | string {
    const why = this.notSetUp("moonshine");
    if (why) return why;
    const files = this.catalog.filter((p) => p.kind === "moonshine");
    if (files.length === 0) return "its speech model is not in the catalog.";
    return {
      python: this.opts.pythonBin ?? "python3",
      lib: this.pathOf(this.find("moonshine-runtime")!),
      modelDir: dirname(this.pathOf(files[0]!)),
      modelId: MOONSHINE_MODEL,
      arch: 0,
      needMb: Math.max(...files.map((p) => p.needMb ?? 0)),
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

  /** Each step of the speech-to-text chain as the Dashboard shows it: ready, missing or blocked, and its measured speed. */
  private steps(settings: EngineSettings, reports: EngineReport[]): EngineStepStatus[] {
    return settings.stt.map((x) => {
      const def = STT_STEPS.find((d) => d.id === x.id)!;
      const step = this.sttStep(def.id);
      const gone = this.missing(x.id);
      const blocked = gone.length > 0 ? null : step.unavailable();
      return {
        id: x.id,
        label: def.label,
        note: x.id === "whisper-en" ? `${def.note.replace(/\.$/, "")}: ${settings.sttModel}.` : def.note,
        on: x.on,
        state: gone.length > 0 ? "missing" : blocked ? "blocked" : "ready",
        problem: blocked,
        downloadBytes: gone.reduce((sum, p) => sum + p.bytes, 0),
        speed: measuredSpeed(reports, x.id),
      };
    });
  }

  /** What the Dashboard shows: ready, or exactly what is missing. `jobs` is the recent job list. */
  status(jobs: Job[], mode: "auto" | "test" = "auto", now = new Date()): EngineStatus {
    const settings = this.settings();
    const memory = this.memory();
    const sttModels = this.catalog
      .filter((p) => p.kind === "stt")
      .map((p) => ({ id: p.id, label: p.label, note: p.note ?? "", bytes: p.bytes, needMb: p.needMb ?? 0, present: this.present(p) }));
    const cloudAvailable = this.cloudAvailable();
    const all = this.runs?.list() ?? [];
    const week = all.filter((r) => new Date(r.createdAt).getTime() >= now.getTime() - 7 * 24 * 3600 * 1000).map((r) => r.report);
    const steps = this.steps(settings, all.map((r) => r.report));
    // The first local step that is on is the one most audio goes through: its memory is the one to watch.
    const first = settings.stt.find((x) => x.on && x.id !== "cloud");
    const needMb = first ? Math.max(0, ...this.stepParts(first.id).map((p) => p.needMb ?? 0)) : 0;
    const short = steps.filter((x) => x.on && x.state === "blocked" && x.id !== "cloud" && /memory/i.test(x.problem ?? "")).map((x) => x.problem!);
    const llm = settings.writer && !settings.cloud ? this.find("llm", DEFAULT_LLM_MODEL) : undefined;
    const writerNote = llm ? memoryProblem(`the hook writer (${llm.id})`, llm.needMb ?? 0, memory) : null;
    const base = {
      settings,
      steps,
      week: { jobs: week.length, lines: weekLines(week, { ...Object.fromEntries(STT_STEPS.map((d) => [d.id, d.label])), writer: "Local writer", "cloud-writer": "Cloud writer", "cloud-picker": "Cloud picker" }) },
      sttModels,
      cloudAvailable,
      writerNote,
      memory: { availableMb: memory.freeMb, needMb, ok: short.length === 0 },
    };
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
      ...short,
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

  /** Which engine handled a video's transcript and picks (the Dashboard's stream cards). */
  reportsFor(vodId: number): EngineReport[] {
    return this.runs?.forVod(vodId) ?? [];
  }
}
