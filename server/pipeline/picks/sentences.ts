import type { Word } from "../../../shared/types.js";

/** Clip length limits in seconds: long enough to land, short enough to finish (and loop). */
export const MIN_CLIP_SEC = 15;
export const MAX_CLIP_SEC = 60;

/** A pause this long between two words counts as a sentence break (Whisper words often lack punctuation). */
export const SENTENCE_GAP_SEC = 0.6;

export interface Sentence {
  startSec: number;
  endSec: number;
  text: string;
}

/** Groups words into sentences, breaking after end punctuation or a pause. */
export function toSentences(words: Word[], gapSec = SENTENCE_GAP_SEC): Sentence[] {
  const out: Sentence[] = [];
  let current: Word[] = [];
  words.forEach((w, i) => {
    current.push(w);
    const next = words[i + 1];
    if (!next || /[.!?…]["')\]]*$/.test(w.word) || next.startSec - w.endSec >= gapSec) {
      out.push({
        startSec: current[0]!.startSec,
        endSec: w.endSec,
        text: current.map((c) => c.word).join(" "),
      });
      current = [];
    }
  });
  return out;
}

export interface TimeRange {
  startSec: number;
  endSec: number;
}

/**
 * Moves a wanted window onto sentence boundaries: it starts where the sentence nearest the wanted
 * start begins and ends where the sentence nearest the wanted end finishes, keeping the length
 * within [min, max]. Returns null when no sentence-aligned window fits.
 */
export function snapWindow(
  sentences: Sentence[],
  wanted: TimeRange,
  limits: { min: number; max: number } = { min: MIN_CLIP_SEC, max: MAX_CLIP_SEC },
): TimeRange | null {
  if (sentences.length === 0) return null;
  const byDistance = (t: number, pick: (s: Sentence) => number) => (a: number, b: number) =>
    Math.abs(pick(sentences[a]!) - t) - Math.abs(pick(sentences[b]!) - t) || a - b;

  const starts = sentences.map((_, i) => i).sort(byDistance(wanted.startSec, (s) => s.startSec));
  for (const i of starts) {
    const startSec = sentences[i]!.startSec;
    const ends = sentences
      .map((_, j) => j)
      .filter((j) => j >= i)
      .filter((j) => {
        const len = sentences[j]!.endSec - startSec;
        return len >= limits.min && len <= limits.max;
      })
      .sort(byDistance(wanted.endSec, (s) => s.endSec));
    if (ends.length > 0) return { startSec, endSec: sentences[ends[0]!]!.endSec };
  }
  return null;
}

/** The words that fall inside a time range (a small tolerance keeps edge words). */
export function wordsIn(words: Word[], range: TimeRange, toleranceSec = 0.05): Word[] {
  return words.filter((w) => w.startSec >= range.startSec - toleranceSec && w.endSec <= range.endSec + toleranceSec);
}
