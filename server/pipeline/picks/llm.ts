import type { PickFlags } from "../../../shared/types.js";
import { type Candidate, candidateWindows, secondScores } from "./signals.js";
import { MAX_CLIP_SEC, MIN_CLIP_SEC, type Sentence, toSentences } from "./sentences.js";
import { type PickInput, type Picker, type PickerResult, type RawPick, trendHintLine } from "./types.js";

export interface ChatRequest {
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
}

export interface ChatResponse {
  /** The model's JSON answer, as text. */
  content: string;
  costUsd: number;
}

/** A chat model that answers in JSON matching a schema. */
export interface ChatClient {
  readonly name: string;
  complete(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
}

export interface OpenAiCompatibleChatOptions {
  apiKey: string;
  /** e.g. https://api.openai.com/v1, https://openrouter.ai/api/v1, https://api.cerebras.ai/v1 */
  baseUrl: string;
  model: string;
  /** List prices in USD per million tokens, for the cost per clip. */
  usdPerMTokIn?: number;
  usdPerMTokOut?: number;
  /** A cap on the answer's length (local models: a schema alone does not stop a runaway string). */
  maxTokens?: number;
  /** Injected in tests so no real API is called. */
  fetchImpl?: typeof fetch;
}

interface ChatCompletion {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** `/chat/completions` with a strict JSON schema: works with OpenAI, OpenRouter and Cerebras. */
export class OpenAiCompatibleChat implements ChatClient {
  readonly name: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private opts: OpenAiCompatibleChatOptions) {
    this.name = `llm:${opts.model}`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async complete(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.opts.model,
        temperature: 0.2,
        ...(this.opts.maxTokens ? { max_tokens: this.opts.maxTokens } : {}),
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        response_format: { type: "json_schema", json_schema: { name: req.schemaName, strict: true, schema: req.schema } },
      }),
      signal,
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new Error(`The picking model failed (${res.status}): ${detail}`);
    }
    const body = (await res.json()) as ChatCompletion;
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error("The picking model sent an empty answer.");
    const inTok = body.usage?.prompt_tokens ?? 0;
    const outTok = body.usage?.completion_tokens ?? 0;
    const costUsd = (inTok * (this.opts.usdPerMTokIn ?? 0) + outTok * (this.opts.usdPerMTokOut ?? 0)) / 1e6;
    return { content, costUsd: Math.round(costUsd * 1e6) / 1e6 };
  }
}

const bool = { type: "boolean" };
export const PICKS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["picks"],
  properties: {
    picks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["candidate", "start", "end", "hook", "title", "score", "reason", "layout", "flags"],
        properties: {
          candidate: { type: "integer" },
          start: { type: "number" },
          end: { type: "number" },
          hook: { type: "string" },
          title: { type: "string" },
          score: { type: "integer" },
          reason: { type: "string" },
          layout: { type: "string", enum: ["center", "full"] },
          flags: {
            type: "object",
            additionalProperties: false,
            required: ["spoiler", "cutscene", "ending", "leak", "breaks_brief"],
            properties: { spoiler: bool, cutscene: bool, ending: bool, leak: bool, breaks_brief: bool },
          },
        },
      },
    },
  },
} as const;

const SYSTEM = `You pick short vertical clips (TikTok, YouTube Shorts, Reels) from a streamer's VOD transcript.
What wins: the first 1-3 seconds decide it, so start ON the reaction or payoff, not the setup (put context in the hook line).
${MIN_CLIP_SEC}-${MAX_CLIP_SEC} seconds, 20-35 s is best; end clean so it loops. Big reactions travel further than raw gameplay.
Rules you must follow:
- Only use times from the transcript lines given; start at the start of a line and end at the end of a line.
- Flag honestly: spoiler (story twists, plot reveals, deaths of characters), cutscene (mostly an unplayed story cutscene),
  ending (a game, mission chain or story ending), leak (unreleased or leaked footage/info), breaks_brief (anything the campaign brief or the creator's off-limits note forbids).
  Flagged clips are thrown away, so when unsure, flag it.
- hook: at most 8 words, shown on screen for the first 2 seconds. title: specific, with the streamer's name and a promise, at most 70 characters.
- score 0-100 for how likely the clip is to keep viewers watching. reason: one sentence on why it works.
- layout: "full" when the whole screen matters (map, menus, chat, wide action), else "center".`;

/** The user message: VOD facts, the brief, and each candidate window with its timed lines. */
export function buildPrompt(input: PickInput, candidates: Candidate[], sentences: Sentence[]): string {
  const lines = [
    `Streamer: ${input.creatorName}`,
    `VOD title: ${input.title ?? "(none)"}`,
    `Length: ${Math.round(input.durationSec)} s`,
    input.chapters.length > 0
      ? `Chapters: ${input.chapters.map((c) => `${c.title} (${Math.round(c.startSec)}-${Math.round(c.endSec)} s)`).join("; ")}`
      : "Chapters: (none)",
    `Campaign brief: ${input.briefRules || "(none)"}`,
    `Off limits: ${input.bannedContent || "(none)"}`,
    ...[trendHintLine(input)].filter((line) => line !== null),
    `Pick up to ${input.maxPicks} clips from these candidate moments (loud, fast or hype speech). You may move start/end within a candidate's lines.`,
  ];
  candidates.forEach((c, i) => {
    const from = c.startSec - 20;
    const to = c.endSec + 20;
    lines.push("", `Candidate ${i} (excitement ${c.signal}, peak at ${c.peakSec} s):`);
    for (const s of sentences) {
      if (s.endSec < from || s.startSec > to) continue;
      lines.push(`[${s.startSec.toFixed(1)}-${s.endSec.toFixed(1)}] ${s.text}`);
    }
  });
  return lines.join("\n");
}

interface LlmPick {
  candidate: number;
  start: number;
  end: number;
  hook: string;
  title: string;
  score: number;
  reason: string;
  layout: "center" | "full";
  flags: { spoiler: boolean; cutscene: boolean; ending: boolean; leak: boolean; breaks_brief: boolean };
}

/** Checks the model's JSON by hand too: a missing or odd flag counts as flagged, never as safe. */
export function parsePicks(content: string): RawPick[] {
  let body: { picks?: unknown };
  try {
    body = JSON.parse(content) as { picks?: unknown };
  } catch {
    throw new Error("The picking model did not answer in JSON.");
  }
  if (!Array.isArray(body.picks)) throw new Error("The picking model's answer has no list of picks.");
  return (body.picks as Partial<LlmPick>[])
    .filter((p) => typeof p.start === "number" && typeof p.end === "number" && p.end > p.start)
    .map((p) => {
      const f = (p.flags ?? {}) as Partial<LlmPick["flags"]>;
      const flags: PickFlags = {
        spoiler: f.spoiler !== false,
        cutscene: f.cutscene !== false,
        ending: f.ending !== false,
        leak: f.leak !== false,
        breaksBrief: f.breaks_brief !== false,
      };
      return {
        startSec: p.start!,
        endSec: p.end!,
        hook: String(p.hook ?? "").trim().slice(0, 80),
        title: String(p.title ?? "").trim().slice(0, 100),
        score: Math.max(0, Math.min(100, Math.round(Number(p.score) || 0))),
        reason: String(p.reason ?? "").trim(),
        layout: p.layout === "full" ? "full" : "center",
        flags,
      };
    });
}

/** Cheap signals find candidate moments; the LLM ranks them, writes hooks and titles, and flags risks. */
export class LlmPicker implements Picker {
  readonly name: string;

  constructor(
    private chat: ChatClient,
    private candidateCount = 30,
  ) {
    this.name = chat.name;
  }

  async pick(input: PickInput, signal?: AbortSignal): Promise<PickerResult> {
    const sentences = toSentences(input.words);
    const scores = secondScores(input.durationSec, input.words, input.signals);
    const candidates = candidateWindows(scores, sentences, { count: this.candidateCount });
    if (candidates.length === 0) return { picks: [], costUsd: 0 };
    const res = await this.chat.complete(
      { system: SYSTEM, user: buildPrompt(input, candidates, sentences), schemaName: "clip_picks", schema: PICKS_SCHEMA },
      signal,
    );
    return { picks: parsePicks(res.content), costUsd: res.costUsd };
  }
}
