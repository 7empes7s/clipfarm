import type { CampaignRules, CaptionFix, Word } from "../../../shared/types.js";
import type { ChatClient, ChatRequest } from "../picks/llm.js";
import type { Glossary } from "./glossary.js";

/**
 * The correction pass: a chat model reads a clip's words with the source's glossary and points at
 * misheard ones ("I for God" → "I forgot", "Margaret" → "market"). Its answer is only a proposal:
 * a change is kept when it sounds like what was heard and adds at most one word, so nothing the audio
 * does not support gets in. Kept changes take the times of the words they replace, and each one is
 * logged so the Studio can undo it.
 */

/** What the model proposes: replace words first..last (indexes into the words it was sent) with `to`. */
export interface ProposedFix {
  first: number;
  last: number;
  to: string;
  why: string;
}

export const FIXES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["fixes"],
  properties: {
    fixes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["first", "last", "to", "why"],
        properties: { first: { type: "integer" }, last: { type: "integer" }, to: { type: "string" }, why: { type: "string" } },
      },
    },
  },
} as const;

const SYSTEM = `You proofread the auto captions of a short clip from a streamer's video. Speech-to-text sometimes mishears words: "I for God" for "I forgot", "Margaret" for "market".
Find words that are misheard and give the words that were really said. Use the glossary (the streamer's names and field) and the sense of the sentence.
Rules:
- Only fix words that sound like what you write: the audio decides, not style. Never add, reword, censor or improve what was said.
- first and last are the numbers of the misheard words (inclusive); to is what was said there, with its punctuation.
- Leave correct words alone. When unsure, leave it. No fixes is a fine answer.`;

/** The request for one clip: the glossary, some context, and the words numbered "3:Margaret". */
export function fixesRequest(words: Word[], glossary: Glossary, context: { creatorName: string; title: string | null }): ChatRequest {
  return {
    system: SYSTEM,
    user: [
      `Streamer: ${context.creatorName}`,
      `Video title: ${context.title ?? "(none)"}`,
      `Glossary: ${glossary.terms.join(", ") || "(none)"}`,
      `Words: ${words.map((w, i) => `${i}:${w.word}`).join(" ")}`,
    ].join("\n"),
    schemaName: "caption_fixes",
    schema: FIXES_SCHEMA,
  };
}

/** The model's answer; anything not shaped like a fix is left out. */
export function parseFixes(content: string): ProposedFix[] {
  let body: { fixes?: unknown };
  try {
    body = JSON.parse(content) as { fixes?: unknown };
  } catch {
    return [];
  }
  if (!Array.isArray(body.fixes)) return [];
  return body.fixes.flatMap((f: Record<string, unknown>) =>
    Number.isInteger(f?.first) && Number.isInteger(f?.last) && typeof f.to === "string"
      ? [{ first: f.first as number, last: f.last as number, to: f.to, why: typeof f.why === "string" ? f.why : "" }]
      : [],
  );
}

const core = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/** How alike two phrases are spelled once spaces and punctuation are gone, 0..1: a stand-in for how alike they sound. */
export function soundsLike(a: string, b: string): number {
  const x = core(a);
  const y = core(b);
  if (!x && !y) return 1;
  return 1 - distance(x, y) / Math.max(x.length, y.length);
}

/** Below this a change is a different word, not a misheard one. */
export const MIN_SOUNDS_LIKE = 0.5;

/** Why a proposed fix is refused, or null when it is kept. */
function refuse(words: Word[], p: ProposedFix): string | null {
  if (p.first < 0 || p.last < p.first || p.last >= words.length) return `no such words (${p.first} to ${p.last})`;
  const from = words.slice(p.first, p.last + 1).map((w) => w.word).join(" ");
  const to = p.to.trim().split(/\s+/).filter(Boolean);
  if (to.length === 0) return `would delete “${from}”`;
  if (to.length > p.last - p.first + 2) return `adds words: “${from}” → “${p.to.trim()}”`;
  if (core(from) === core(p.to)) return null;
  if (soundsLike(from, p.to) < MIN_SOUNDS_LIKE) return `“${p.to.trim()}” does not sound like “${from}”`;
  return null;
}

const TRAILING = /[^\p{L}\p{N}]+$/u;
const round = (n: number) => Math.round(n * 1000) / 1000;

/** The new words for one fix, over the time of the words they replace. */
function replacement(old: Word[], to: string): Word[] {
  const parts = to.trim().split(/\s+/);
  // The model dropped the comma or full stop the words had: keep it.
  const punct = TRAILING.exec(old.at(-1)!.word)?.[0] ?? "";
  if (punct && !TRAILING.test(parts.at(-1)!)) parts[parts.length - 1] += punct;
  if (parts.length === old.length) return parts.map((word, i) => ({ word, startSec: old[i]!.startSec, endSec: old[i]!.endSec }));
  const start = old[0]!.startSec;
  const span = old.at(-1)!.endSec - start;
  const total = parts.reduce((n, p) => n + Math.max(1, core(p).length), 0);
  let at = start;
  return parts.map((word, i) => {
    const end = i === parts.length - 1 ? old.at(-1)!.endSec : round(at + (span * Math.max(1, core(word).length)) / total);
    const w = { word, startSec: round(at), endSec: end };
    at = end;
    return w;
  });
}

/** Checks the proposals and applies the ones kept, first to last; overlapping ones after the first are refused. */
export function applyFixes(words: Word[], proposed: ProposedFix[]): { words: Word[]; fixes: CaptionFix[]; rejected: { fix: ProposedFix; why: string }[] } {
  const rejected: { fix: ProposedFix; why: string }[] = [];
  const kept: ProposedFix[] = [];
  for (const p of proposed) {
    const why = refuse(words, p) ?? (kept.some((k) => p.first <= k.last && k.first <= p.last) ? "overlaps another fix" : null);
    if (why) rejected.push({ fix: p, why });
    // The same letters (only case or punctuation differ): nothing to fix.
    else if (core(words.slice(p.first, p.last + 1).map((w) => w.word).join("")) !== core(p.to)) kept.push(p);
  }
  kept.sort((a, b) => a.first - b.first);
  const out: Word[] = [];
  const fixes: CaptionFix[] = [];
  let i = 0;
  for (const p of kept) {
    out.push(...words.slice(i, p.first));
    const old = words.slice(p.first, p.last + 1);
    const next = replacement(old, p.to);
    out.push(...next);
    fixes.push({
      startSec: old[0]!.startSec,
      endSec: old.at(-1)!.endSec,
      from: old.map((w) => w.word).join(" "),
      to: next.map((w) => w.word).join(" "),
      fromWords: old,
      why: p.why,
      applied: true,
    });
    i = p.last + 1;
  }
  out.push(...words.slice(i));
  return { words: out, fixes, rejected };
}

/** Runs the pass over a clip's words. The model's cost is returned for the cost per clip. */
export async function correctCaptions(o: {
  words: Word[];
  glossary: Glossary;
  chat: ChatClient;
  context: { creatorName: string; title: string | null };
  signal?: AbortSignal;
}): Promise<{ words: Word[]; fixes: CaptionFix[]; rejected: { fix: ProposedFix; why: string }[]; costUsd: number }> {
  if (o.words.length === 0) return { words: o.words, fixes: [], rejected: [], costUsd: 0 };
  const answer = await o.chat.complete(fixesRequest(o.words, o.glossary, o.context), o.signal);
  return { ...applyFixes(o.words, parseFixes(answer.content)), costUsd: answer.costUsd };
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.002;

/** Undoes (applied false) or redoes one fix in a clip's caption words, found by its time; unchanged when the words there are not the expected ones. */
export function setFixApplied(words: Word[], fix: CaptionFix, applied: boolean): Word[] {
  const now = applied ? fix.fromWords : replacement(fix.fromWords, fix.to);
  const next = applied ? replacement(fix.fromWords, fix.to) : fix.fromWords;
  const at = words.findIndex((w) => near(w.startSec, now[0]!.startSec) && w.word === now[0]!.word);
  if (at < 0 || !now.every((w, k) => words[at + k]?.word === w.word)) return words;
  return [...words.slice(0, at), ...next, ...words.slice(at + now.length)];
}

/**
 * Where two transcripts of the same audio differ, matched by time: each group of words that overlap
 * in time and read differently becomes a change ("for God," → "forgot,"). Used to carry what the
 * accurate engine heard into a title or hook written from the first transcript.
 */
export function changesBetween(before: Word[], after: Word[]): CaptionFix[] {
  const overlaps = (a: Word, b: Word) => a.startSec < b.endSec && b.startSec < a.endSec;
  const out: CaptionFix[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (!overlaps(before[i]!, after[j]!)) {
      if (before[i]!.endSec <= after[j]!.startSec) i++;
      else j++;
      continue;
    }
    // Grow the group while the next word on either side still overlaps the other side's last one.
    let bi = i + 1;
    let aj = j + 1;
    for (let grew = true; grew; ) {
      grew = false;
      if (bi < before.length && overlaps(before[bi]!, after[aj - 1]!)) (bi++, (grew = true));
      if (aj < after.length && overlaps(after[aj]!, before[bi - 1]!)) (aj++, (grew = true));
    }
    const old = before.slice(i, bi);
    const now = after.slice(j, aj);
    const from = old.map((w) => w.word).join(" ");
    const to = now.map((w) => w.word).join(" ");
    if (core(from) !== core(to)) out.push({ startSec: old[0]!.startSec, endSec: old.at(-1)!.endSec, from, to, fromWords: old, why: "", applied: true });
    i = bi;
    j = aj;
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The phrase as it can appear in a title: its words with any punctuation or spaces between. */
const phrase = (text: string) => {
  const cores = text.split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")).filter(Boolean);
  return cores.length ? new RegExp(`(?<![\\p{L}\\p{N}])${cores.map(escape).join("[^\\p{L}\\p{N}]+")}(?![\\p{L}\\p{N}])`, "giu") : null;
};

/** A title or hook with the applied fixes made in it too, so it never repeats a misheard line. */
export function fixText(text: string, fixes: CaptionFix[]): string {
  let out = text;
  for (const f of fixes.filter((x) => x.applied)) {
    const re = phrase(f.from);
    const to = f.to.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (!re || !to) continue;
    out = out.replace(re, (_m, offset: number, whole: string) => {
      const opensSentence = /(^|[.!?]\s+)$/.test(whole.slice(0, offset));
      return opensSentence ? to[0]!.toUpperCase() + to.slice(1) : to;
    });
  }
  return out;
}

/** Below this the speech-to-text was guessing at a word. */
export const UNSURE_CONFIDENCE = 0.5;

/**
 * The spell and sense check for a title or hook: a misheard phrase a fix replaced, a word the
 * speech-to-text was unsure of, or a word said twice in a row. Each problem in plain words.
 */
export function copyProblems(text: string, words: Word[], fixes: CaptionFix[]): string[] {
  const out: string[] = [];
  const said = new Set<string>();
  const flag = (w: string) => {
    const k = core(w);
    if (k && !said.has(k)) {
      said.add(k);
      out.push(`“${w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")}” may be misheard`);
    }
  };
  const tokens = text.split(/\s+/).map(core).filter(Boolean);
  for (const f of fixes.filter((x) => x.applied)) {
    // The words a fix replaced, still in the text (and not also in the fixed words).
    const kept = new Set(f.to.split(/\s+/).map(core));
    for (const w of f.fromWords) if (!kept.has(core(w.word)) && tokens.includes(core(w.word))) flag(w.word);
  }
  for (const w of words) if (typeof w.confidence === "number" && w.confidence < UNSURE_CONFIDENCE && tokens.includes(core(w.word))) flag(w.word);
  const twice = tokens.find((t, i) => i > 0 && t === tokens[i - 1] && t.length > 1);
  if (twice) out.push(`“${twice}” is written twice in a row`);
  return out;
}

/** Only these brief rules stop the pass: AI kept off the captions themselves. */
const CAPTION_AI_BAN = [
  /\b(no|ban(?:ned|s)?|not allowed|never use|do not use|don'?t use|without)\b[^.\n]{0,40}\bAI\b[^.\n]{0,20}\b(captions?|subtitles?|transcri\w*|text)\b/i,
  /\b(captions?|subtitles?)\b[^.\n]{0,40}\b(by hand|manually|no AI|not AI)\b/i,
];

/**
 * Whether the correction pass may run for a clip, and why. Fixing misheard words is text correction
 * of what the creator said, not AI-made content, so it stays on for a campaign that bans AI content
 * in general; only a brief that keeps AI off the captions themselves turns it off.
 */
export function captionFixGate(permissions: { briefRules: string; rules: Pick<CampaignRules, "aiBanned"> | null }[]): { allowed: boolean; why: string | null } {
  if (permissions.some((p) => CAPTION_AI_BAN.some((re) => re.test(p.briefRules)))) {
    return { allowed: false, why: "The campaign keeps AI off the captions, so misheard words are not fixed automatically. Check them in the Studio." };
  }
  if (permissions.some((p) => p.rules?.aiBanned === true)) {
    return { allowed: true, why: "The campaign bans AI content; fixing misheard caption words is text correction of what was said, so it stays on." };
  }
  return { allowed: true, why: null };
}
