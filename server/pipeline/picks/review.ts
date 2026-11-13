import type { PickFlags, Word } from "../../../shared/types.js";
import { type Sentence, snapWindow, type TimeRange, wordsIn } from "./sentences.js";
import type { RawPick } from "./types.js";

const FLAG_REASONS: Record<keyof PickFlags, string> = {
  spoiler: "story spoiler",
  cutscene: "story cutscene",
  ending: "shows an ending",
  leak: "leaked content",
  breaksBrief: "breaks the campaign brief",
};

/**
 * Banned phrases written in the brief or the creator's "off limits" note, e.g. "No story spoilers,
 * no talking about his ex" → ["story spoilers", "talking about his ex"].
 */
export function bannedTerms(...texts: string[]): string[] {
  const terms: string[] = [];
  for (const text of texts) {
    for (const part of text.split(/[\n,;.]+/)) {
      const m = /^\s*(?:no|don'?t(?: show| clip| post| use)?|do not(?: show| clip| post| use)?|never|avoid)\s+(.+?)\s*$/i.exec(part);
      if (m) terms.push(m[1]!.toLowerCase());
    }
  }
  return [...new Set(terms)];
}

function mentions(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i").test(text);
}

export type Reviewed =
  | { keep: true; range: TimeRange }
  | { keep: false; dropReason: string; range: TimeRange };

/**
 * The charter gate for a proposed pick: anything flagged (spoiler, cutscene, ending, leak, brief)
 * or mentioning a banned phrase is dropped, and the window must snap to sentence boundaries
 * within the length limits.
 */
export function reviewPick(
  pick: RawPick,
  sentences: Sentence[],
  words: Word[],
  bans: string[],
  /** The campaign's own clip length, when it has one. */
  length: { minSec: number | null; maxSec: number | null } = { minSec: null, maxSec: null },
): Reviewed {
  const wanted = { startSec: pick.startSec, endSec: pick.endSec };
  const flagged = (Object.keys(FLAG_REASONS) as (keyof PickFlags)[]).filter((k) => pick.flags[k]);
  if (flagged.length > 0) {
    return { keep: false, dropReason: `Left out: ${flagged.map((k) => FLAG_REASONS[k]).join(", ")}`, range: wanted };
  }
  const range = snapWindow(sentences, wanted);
  if (!range) return { keep: false, dropReason: "Left out: no 15-60 s cut on sentence boundaries", range: wanted };
  const text = [pick.title, pick.hook, wordsIn(words, range).map((w) => w.word).join(" ")].join(" \n ");
  const banned = bans.find((t) => mentions(text, t));
  if (banned) return { keep: false, dropReason: `Left out: the brief bans "${banned}"`, range };
  const sec = range.endSec - range.startSec;
  if (length.maxSec !== null && sec > length.maxSec) return { keep: false, dropReason: `Left out: the campaign takes clips of ${length.maxSec} s at most`, range };
  if (length.minSec !== null && sec < length.minSec) return { keep: false, dropReason: `Left out: the campaign takes clips of ${length.minSec} s at least`, range };
  return { keep: true, range };
}

export interface ReviewedPick extends RawPick {
  dropReason: string | null;
}

/**
 * Reviews every proposed pick, best score first. Kept picks get their snapped times; a pick that
 * overlaps a better one is dropped too, and at most `maxPicks` are kept.
 */
export function reviewPicks(
  picks: RawPick[],
  sentences: Sentence[],
  words: Word[],
  bans: string[],
  maxPicks: number,
  length?: { minSec: number | null; maxSec: number | null },
): ReviewedPick[] {
  const kept: TimeRange[] = [];
  return [...picks]
    .sort((a, b) => b.score - a.score)
    .map((p): ReviewedPick | null => {
      const r = reviewPick(p, sentences, words, bans, length);
      if (!r.keep) return { ...p, ...r.range, dropReason: r.dropReason };
      if (kept.some((k) => r.range.startSec < k.endSec && k.startSec < r.range.endSec)) {
        return { ...p, ...r.range, dropReason: "Left out: overlaps a better pick" };
      }
      if (kept.length >= maxPicks) return null;
      kept.push(r.range);
      return { ...p, ...r.range, dropReason: null };
    })
    .filter((p): p is ReviewedPick => p !== null);
}
