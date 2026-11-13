import type { EngineReport, EngineUse, PickFlags } from "../../../shared/types.js";
import type { ChatClient } from "./llm.js";
import { type Sentence, toSentences, wordsIn } from "./sentences.js";
import { type Candidate, candidateWindows, isHypeWord, secondScores } from "./signals.js";
import type { PickInput, Picker, PickerResult, RawPick } from "./types.js";

/** How many of the best moments are ranked and (when the writer is on) get a written hook. */
export const LOCAL_CANDIDATES = 30;

/** The hook writer cannot run right now (not downloaded, not enough memory). The message says why, plainly. */
export class WriterUnavailableError extends Error {}

/** A model that writes hooks and titles. A local one is loaded for one session and unloaded after it. */
export interface HookWriter {
  session<T>(fn: (chat: ChatClient) => Promise<T>, signal?: AbortSignal): Promise<T>;
}

/** One writer in the picks chain, tried in order: the local model first, a cloud model only when it is enabled. */
export interface WriterStep {
  id: string;
  /** Plain name, e.g. "Local writer". */
  label: string;
  writer: HookWriter;
}

/** A cloud chat model as a writer: nothing to load or unload. */
export function chatWriter(chat: ChatClient): HookWriter {
  return { session: (fn) => fn(chat) };
}

/**
 * Words that must not reach a clip, checked without any AI. Small local models miss these too
 * often to be trusted alone, so this screen always runs; when unsure it flags.
 */
const RISK_PATTERNS: Record<Exclude<keyof PickFlags, "breaksBrief">, RegExp> = {
  spoiler: /\bspoilers?\b|\bplot twist\b|\btwist ending\b|\b(dies|die|died|is dead|gets killed|is killed) (at|in) the end\b|\bkilled off\b|\bturns out (he|she|they) (is|was|were|are)\b/i,
  cutscene: /\bcut ?scenes?\b/i,
  ending: /\b(final|last) (mission|boss|chapter|level)\b|\bthe ending\b|\bend(ing)? credits\b|\bcredits (are )?(roll|rolling)\b|\bepilogue\b|\b(beat|finished|completed) the (game|story|campaign)\b|\bend of the (game|story|campaign)\b/i,
  leak: /\bleak(s|ed|ing)?\b|\bunreleased\b|\bnot (out|released) yet\b|\bdata ?min(e|ed|ing)\b|\bunder (nda|embargo)\b|\bearly copy\b/i,
};
/** In a chapter title one bare word is enough ("Ending", "Credits"). */
const ENDING_CHAPTER = /\b(ending|finale|credits|epilogue)\b/i;

/** Flags from what is said in the window and from the titles of the chapters it falls in. */
export function keywordFlags(text: string, chapterTitles: string[] = []): PickFlags {
  const all = [text, ...chapterTitles].join("\n");
  return {
    spoiler: RISK_PATTERNS.spoiler.test(all),
    cutscene: RISK_PATTERNS.cutscene.test(all),
    ending: RISK_PATTERNS.ending.test(all) || chapterTitles.some((t) => ENDING_CHAPTER.test(t)),
    leak: RISK_PATTERNS.leak.test(all),
    breaksBrief: false,
  };
}

/** Shouted or asked words per second: "!" counts double a "?", a word in capitals counts too. */
export function emphasisScores(durationSec: number, words: PickInput["words"]): number[] {
  const out = new Array<number>(Math.max(0, Math.ceil(durationSec))).fill(0);
  for (const w of words) {
    const s = Math.floor(w.startSec);
    if (s < 0 || s >= out.length) continue;
    if (/!["')\]]*$/.test(w.word)) out[s]! += 1;
    else if (/\?["')\]]*$/.test(w.word)) out[s]! += 0.5;
    if (/^[A-Z]{3,}[!?.,]*$/.test(w.word)) out[s]! += 0.5;
  }
  return out;
}

const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

function cutAtWord(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 1)).trimEnd()}…`;
}

/** The line said at the peak (or the first one after it): the reaction the clip opens on. */
function peakSentence(c: Candidate, inWindow: Sentence[]): Sentence | undefined {
  return (
    inWindow.find((s) => s.startSec <= c.peakSec && s.endSec >= c.peakSec) ??
    inWindow.find((s) => s.startSec >= c.peakSec) ??
    inWindow[0]
  );
}

/** A hook without any AI: the line said at the peak, at most 8 words. */
export function templateHook(sentence: string): string {
  const words = sentence.replace(/[.,;:]+$/, "").split(/\s+/).filter(Boolean);
  if (words.length <= 8) return words.join(" ");
  return `${words.slice(0, 8).join(" ").replace(/[.,;:]+$/, "")}…`;
}

/** A title without any AI: the streamer's name and what they said, at most 70 characters. */
export function templateTitle(creatorName: string, sentence: string): string {
  const quote = sentence.replace(/[.,;:]+$/, "");
  return `${creatorName}: "${cutAtWord(quote, Math.max(10, 70 - creatorName.length - 4))}"`;
}

/** Why a moment was ranked, in plain words, from the same signals that ranked it. */
function describe(input: PickInput, c: Candidate): string {
  const loud = input.signals.loudness.filter((v) => v > -70).sort((a, b) => a - b);
  const usual = loud[Math.floor(loud.length / 2)];
  const here = input.signals.loudness.slice(Math.max(0, Math.floor(c.startSec)), Math.ceil(c.endSec));
  const peak = here.length > 0 ? Math.max(...here) : undefined;
  const inside = wordsIn(input.words, c);
  const hype = inside.filter((w) => isHypeWord(w.word)).length;
  const overall = input.durationSec > 0 ? input.words.length / input.durationSec : 0;
  const rate = inside.length / Math.max(1, c.endSec - c.startSec);
  const whys: string[] = [];
  if (usual !== undefined && peak !== undefined && peak - usual >= 3) whys.push(`${Math.round(peak - usual)} dB louder than usual`);
  if (hype > 0) whys.push(`${hype} hype word${hype === 1 ? "" : "s"}`);
  if (overall > 0 && rate > overall * 1.2) whys.push("fast talking");
  if (input.signals.chat) whys.push("chat spike");
  return `Peak at ${clock(c.peakSec)}: ${whys.length > 0 ? whys.join(", ") : "the most going on in this stretch"}.`;
}

const bool = { type: "boolean" };
export const CLIP_COPY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["hook", "title", "flags"],
  properties: {
    hook: { type: "string", maxLength: 80 },
    title: { type: "string", maxLength: 100 },
    flags: {
      type: "object",
      additionalProperties: false,
      required: ["spoiler", "cutscene", "ending", "leak", "breaks_brief"],
      properties: { spoiler: bool, cutscene: bool, ending: bool, leak: bool, breaks_brief: bool },
    },
  },
} as const;

const WRITER_SYSTEM = `You write the on-screen hook and the title for ONE short vertical clip (TikTok, Shorts, Reels) cut from a streamer's VOD, and you check it for content that must not be posted.
- hook: at most 8 words, shown on screen for the first 1.5 seconds. It gives the context and makes people stay. Do not just repeat the first line.
- title: specific, with the streamer's name and a promise, at most 70 characters.
- flags: each one is true ONLY when the transcript clearly shows it, otherwise false. Most clips have every flag false.
  spoiler: a story twist, plot reveal or a story character's death is given away.
  cutscene: the clip is mostly an unplayed story cutscene (game characters talking, the streamer silent).
  ending: the ending of the game or of its story is shown or described.
  leak: unreleased or leaked footage or information.
  breaks_brief: something the campaign brief or the off-limits note forbids.
Answer in JSON.`;

export function writerPrompt(input: PickInput, lines: Sentence[]): string {
  const transcript: string[] = [];
  let chars = 0;
  for (const s of lines) {
    chars += s.text.length;
    if (chars > 1500) break;
    transcript.push(`[${s.startSec.toFixed(1)}-${s.endSec.toFixed(1)}] ${s.text}`);
  }
  return [
    `Streamer: ${input.creatorName}`,
    `VOD title: ${input.title ?? "(none)"}`,
    `Campaign brief: ${input.briefRules || "(none)"}`,
    `Off limits: ${input.bannedContent || "(none)"}`,
    "Transcript of the clip (times in seconds):",
    ...transcript,
  ].join("\n");
}

export interface ClipCopy {
  hook: string;
  title: string;
  flags: PickFlags;
}

/**
 * Checks the writer's answer against the schema by hand: a hook, a title and all five flags as
 * true/false. Anything else is not usable (null), and the clip keeps its transcript hook.
 */
export function parseClipCopy(content: string): ClipCopy | null {
  let body: { hook?: unknown; title?: unknown; flags?: Record<string, unknown> };
  try {
    body = JSON.parse(content) as typeof body;
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const hook = typeof body.hook === "string" ? body.hook.trim() : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const f = body.flags;
  if (!hook || !title || hook.length > 80 || title.length > 100 || !f || typeof f !== "object") return null;
  const keys = ["spoiler", "cutscene", "ending", "leak", "breaks_brief"] as const;
  if (keys.some((k) => typeof f[k] !== "boolean")) return null;
  return {
    hook,
    title,
    flags: {
      spoiler: f.spoiler === true,
      cutscene: f.cutscene === true,
      ending: f.ending === true,
      leak: f.leak === true,
      breaksBrief: f.breaks_brief === true,
    },
  };
}

interface Draft {
  pick: RawPick;
  lines: Sentence[];
  written: boolean;
}

/**
 * Picks with no outside service. Plain signals rank the moments (loudness spikes, speech rate,
 * hype and laughing words, shouted lines, chat spikes when there are any) and a keyword screen
 * flags spoilers, endings and leaks. Hooks and titles then go down a chain: each writer in turn
 * (the local model, then a cloud model when one is enabled) writes what the one before could not,
 * and whatever is left keeps its hook from the transcript. So picks always come out, whatever
 * fails. A writer can add flags, never clear them.
 */
export class LocalPicker implements Picker {
  readonly name = "local";
  private readonly getWriters: () => WriterStep[];

  constructor(
    /** The writers to try, in order; or (as before the chain) the one local writer, null when it is off. */
    writers: (() => WriterStep[]) | (() => HookWriter | null) = () => [],
    private candidateCount = LOCAL_CANDIDATES,
  ) {
    this.getWriters = () => {
      const w = writers();
      if (Array.isArray(w)) return w;
      return w ? [{ id: "writer", label: "Local writer", writer: w }] : [];
    };
  }

  async pick(input: PickInput, signal?: AbortSignal): Promise<PickerResult> {
    const started = Date.now();
    const sentences = toSentences(input.words);
    const emphasis = emphasisScores(input.durationSec, input.words);
    const scores = secondScores(input.durationSec, input.words, input.signals).map((s, i) => s + emphasis[i]!);
    const candidates = candidateWindows(scores, sentences, { count: this.candidateCount });
    const top = candidates[0]?.signal ?? 0;

    const drafts = candidates.map((c, i): Draft => {
      const lines = sentences.filter((s) => s.startSec >= c.startSec - 0.05 && s.endSec <= c.endSec + 0.05);
      const said = peakSentence(c, lines)?.text ?? "";
      const chapters = input.chapters.filter((ch) => ch.startSec < c.endSec && c.startSec < ch.endSec).map((ch) => ch.title);
      return {
        lines,
        written: false,
        pick: {
          startSec: c.startSec,
          endSec: c.endSec,
          hook: templateHook(said),
          title: templateTitle(input.creatorName, said),
          score: Math.max(0, Math.min(100, top > 0 ? Math.round(40 + 55 * (c.signal / top)) : 50 - i)),
          reason: describe(input, c),
          layout: "center",
          flags: keywordFlags(lines.map((s) => s.text).join(" "), chapters),
        },
      };
    });
    const use = (step: string, label: string, count: number, ms: number): EngineUse => ({ step, label, count, audioSec: 0, ms, peakMb: null, note: "" });
    const uses = [use("signals", "Signal scoring", drafts.length, Date.now() - started)];
    const fallbacks: EngineReport["fallbacks"] = [];
    let costUsd = 0;

    // Why the hooks still to be written are plain quotes; the last writer's reason is the one shown.
    let why = "";
    for (const step of drafts.length > 0 ? this.getWriters() : []) {
      const todo = drafts.filter((d) => !d.written);
      if (todo.length === 0) break;
      const began = Date.now();
      let unusable = 0;
      let failure: string | null = null;
      try {
        await step.writer.session(async (chat) => {
          for (const d of todo) {
            const cost = await this.write(chat, input, d, signal);
            if (cost === null) unusable += 1;
            else costUsd += cost;
          }
        }, signal);
      } catch (err) {
        // Cancelled by the user: stop. Anything else: the next writer, or the transcript, takes over.
        signal?.throwIfAborted();
        failure = err instanceof Error ? err.message : String(err);
      }
      const wrote = todo.filter((d) => d.written).length;
      uses.push(use(step.id, step.label, wrote, Date.now() - began));
      if (failure) {
        why = failure;
        fallbacks.push({ step: step.id, reason: failure, count: 1 });
      } else if (unusable > 0) {
        why = "the writer's answer was not usable.";
      }
      if (unusable > 0) fallbacks.push({ step: step.id, reason: "the writer's answer was not usable", count: unusable });
    }
    const plain = drafts.filter((d) => !d.written);
    // Said on every such pick, so the reviewer sees why the hook is a plain quote.
    if (why) for (const d of plain) d.pick.reason += ` Hook taken from the transcript: ${why}`;
    if (plain.length > 0) uses.push(use("template", "Hooks from the transcript", plain.length, 0));

    const hooks = uses.filter((u) => u.step !== "signals" && u.count > 0);
    return {
      picks: drafts.map((d) => d.pick),
      costUsd: Math.round(costUsd * 1e6) / 1e6,
      report: {
        kind: "picks",
        language: null,
        uses,
        fallbacks,
        summary: `Signal scoring ranked ${drafts.length}${hooks.length > 0 ? `; ${hooks.map((u) => `${u.label} ${u.count}`).join(", ")}` : ""}`,
      },
    };
  }

  /** Writes one clip's hook and title. Returns what it cost, or null when the answer was not usable. */
  private async write(chat: ChatClient, input: PickInput, d: Draft, signal?: AbortSignal): Promise<number | null> {
    const res = await chat.complete(
      { system: WRITER_SYSTEM, user: writerPrompt(input, d.lines), schemaName: "clip_copy", schema: CLIP_COPY_SCHEMA },
      signal,
    );
    const copy = parseClipCopy(res.content);
    if (!copy) return null;
    d.written = true;
    d.pick.hook = copy.hook;
    d.pick.title = copy.title;
    const k = d.pick.flags;
    d.pick.flags = {
      spoiler: k.spoiler || copy.flags.spoiler,
      cutscene: k.cutscene || copy.flags.cutscene,
      ending: k.ending || copy.flags.ending,
      leak: k.leak || copy.flags.leak,
      breaksBrief: k.breaksBrief || copy.flags.breaksBrief,
    };
    return res.costUsd;
  }
}
