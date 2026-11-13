import type { Word } from "../../shared/types.js";
import { HOOK_PATTERN_LABELS, type HookPattern } from "../../shared/trends.js";
import type { ChatClient } from "../pipeline/picks/llm.js";
import { keywordFlags } from "../pipeline/picks/local.js";
import { keywordHook } from "../trends/tags.js";

export interface VariantCopy {
  pattern: HookPattern;
  hook: string;
  title: string;
}

export interface VariantsInput {
  clip: { title: string; hook: string; captionWords: Word[] };
  creatorName: string;
  /** How many variants in all, the clip's own hook included. */
  count: number;
  /** Patterns to try first: what wins today, then what has won for us. */
  prefer: HookPattern[];
  /** The AI writer; null writes from the templates below. */
  chat: ChatClient | null;
  /** False for a hook and title that must not be used (they break the campaign's rules); another pattern is tried. */
  allowed?: (copy: VariantCopy) => boolean;
  signal?: AbortSignal;
}

const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

/**
 * Hooks that need no AI and claim nothing the clip may not show: only patterns that are true of
 * any clip are here ("first time" and "a record" would be made-up facts).
 */
const TEMPLATES: Partial<Record<HookPattern, (creator: string, subject: string) => { hook: string; title: string }>> = {
  "name-reaction": (c, s) => ({ hook: `${c} can't believe it`, title: `${c} can't believe this: ${s}` }),
  question: (c, s) => ({ hook: "Did that really just happen?", title: `Did ${c} really just do this? ${s}` }),
  "wait-for-it": (_c, s) => ({ hook: "Wait for it…", title: `Wait for it: ${s}` }),
  pov: (c, s) => ({ hook: `POV: you are watching ${c} live`, title: `POV: ${c}, ${s}` }),
  quote: (c, s) => ({ hook: `"${s.split(/\s+/).slice(0, 6).join(" ")}"`, title: `${c}: "${s}"` }),
};
const TEMPLATE_ORDER = Object.keys(TEMPLATES) as HookPattern[];

/** The title without the streamer's name in front and without quote marks: what the clip is about. */
function subjectOf(title: string, creatorName: string): string {
  let s = title.trim();
  if (s.toLowerCase().startsWith(creatorName.toLowerCase())) s = s.slice(creatorName.length).replace(/^[\s:,\-–]+/, "");
  return s.replace(/^["“]+|["”]+$/g, "").trim() || title.trim();
}

function template(pattern: HookPattern, creatorName: string, subject: string): VariantCopy {
  const t = TEMPLATES[pattern]!(creatorName, subject);
  return { pattern, hook: cut(t.hook, 80), title: cut(t.title, 100) };
}

const VARIANTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["variants"],
  properties: {
    variants: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["pattern", "hook", "title"],
        properties: { pattern: { type: "string" }, hook: { type: "string", maxLength: 80 }, title: { type: "string", maxLength: 100 } },
      },
    },
  },
} as const;

const SYSTEM = `You rewrite the on-screen hook and the title of ONE short vertical clip, once for each pattern asked for, so they can be A/B tested. The video is the same cut every time.
- hook: at most 8 words, on screen for the first 2 seconds. title: specific, with the streamer's name, at most 70 characters.
- Stay true to the transcript: never add a fact, a number or a "first time" that is not in it.
- Never give away a story twist, an ending or anything unreleased.
Answer in JSON with one entry per pattern, using the pattern's exact name.`;

async function aiCopies(input: VariantsInput, patterns: HookPattern[]): Promise<Map<HookPattern, VariantCopy>> {
  const out = new Map<HookPattern, VariantCopy>();
  if (!input.chat || patterns.length === 0) return out;
  const user = [
    `Streamer: ${input.creatorName}`,
    `Title now: ${input.clip.title}`,
    `Hook now: ${input.clip.hook || "(none)"}`,
    `Transcript: ${cut(input.clip.captionWords.map((w) => w.word).join(" "), 1500) || "(none)"}`,
    "Patterns:",
    ...patterns.map((p) => `- ${p}: ${HOOK_PATTERN_LABELS[p]}`),
  ].join("\n");
  let rows: unknown;
  try {
    const res = await input.chat.complete({ system: SYSTEM, user, schemaName: "hook_variants", schema: VARIANTS_SCHEMA }, input.signal);
    rows = (JSON.parse(res.content) as { variants?: unknown }).variants;
  } catch {
    return out;
  }
  for (const row of Array.isArray(rows) ? rows : []) {
    const r = row as { pattern?: unknown; hook?: unknown; title?: unknown } | null;
    const pattern = patterns.find((p) => p === r?.pattern);
    const hook = typeof r?.hook === "string" ? r.hook.trim() : "";
    const title = typeof r?.title === "string" ? r.title.trim() : "";
    if (!pattern || !hook || !title || hook.length > 80 || title.length > 100) continue;
    // The same word screen the picker uses: a spoiler, an ending or a leak never becomes a hook.
    if (Object.values(keywordFlags(`${hook}\n${title}`)).some(Boolean)) continue;
    out.set(pattern, { pattern, hook, title });
  }
  return out;
}

/**
 * The hooks to test for one clip: A is the clip as it was approved, the others use different
 * patterns (the preferred ones first). The AI writes them when there is one and its lines pass the
 * checks; otherwise they come from the templates. A line that is not allowed is passed over for the
 * next pattern, so there can be fewer than asked for.
 */
export async function writeVariants(input: VariantsInput): Promise<VariantCopy[]> {
  const { clip, creatorName } = input;
  const own: VariantCopy = { pattern: keywordHook(clip.title), hook: clip.hook, title: clip.title };
  const order = [...new Set([...input.prefer, ...TEMPLATE_ORDER])].filter((p) => p !== own.pattern && TEMPLATES[p]);
  const wanted = Math.max(0, input.count - 1);
  const written = await aiCopies(input, order.slice(0, wanted));
  const subject = subjectOf(clip.title, creatorName);
  const allowed = input.allowed ?? (() => true);
  const used = new Set([own.hook.toLowerCase()]);
  const others: VariantCopy[] = [];
  for (const p of order) {
    if (others.length === wanted) break;
    const ai = written.get(p);
    const copy = [ai && !used.has(ai.hook.toLowerCase()) ? ai : null, template(p, creatorName, subject)].find((c) => c && allowed(c));
    if (!copy) continue;
    used.add(copy.hook.toLowerCase());
    others.push(copy);
  }
  return [own, ...others];
}
