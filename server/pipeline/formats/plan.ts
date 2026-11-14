import type { Brand, OutputChapter, OutputFormat, TimeRange } from "../../../shared/creator.js";
import type { Chapter, Word } from "../../../shared/types.js";
import { type Box, cropToAspect } from "../render/layout.js";

/** Output size per format, in pixels. */
export const FORMAT_SIZE: Record<OutputFormat, { w: number; h: number }> = {
  short: { w: 1080, h: 1920 },
  square: { w: 1080, h: 1080 },
  wide: { w: 1920, h: 1080 },
  "best-of": { w: 1920, h: 1080 },
  audiogram: { w: 1080, h: 1080 },
};

/** A best-of runs 3 to 8 minutes. */
export const BEST_OF_MIN_SEC = 180;
export const BEST_OF_MAX_SEC = 480;
/** Square and wide cuts (or audiograms) are made of this many of the best picks. */
export const EXTRA_CUTS = 3;

/** The centred crop of the source that fills a format's frame (even sizes, inside the frame). */
export function cropFor(format: OutputFormat, srcW: number, srcH: number): Box {
  const { w, h } = FORMAT_SIZE[format];
  return cropToAspect(srcW, srcH, w / h);
}

export interface PlannedPick {
  startSec: number;
  endSec: number;
  score: number;
  title: string;
}

export interface PlannedOutput {
  format: OutputFormat;
  ranges: TimeRange[];
  /** The pick it was cut from (single-range formats), for its title. */
  title: string;
}

export function rangesDuration(ranges: TimeRange[]): number {
  return ranges.reduce((sum, r) => sum + (r.endSec - r.startSec), 0);
}

/**
 * The best-of: the highest-scoring picks that fit in 8 minutes, played in the order they happened.
 * Null when the picks add up to less than 3 minutes: then there is not enough for one.
 */
export function planBestOf(picks: PlannedPick[]): TimeRange[] | null {
  const chosen: PlannedPick[] = [];
  let total = 0;
  for (const p of [...picks].sort((a, b) => b.score - a.score)) {
    const len = p.endSec - p.startSec;
    if (total + len > BEST_OF_MAX_SEC) continue;
    // Overlapping picks would play the same moment twice.
    if (chosen.some((c) => p.startSec < c.endSec && c.startSec < p.endSec)) continue;
    chosen.push(p);
    total += len;
  }
  if (total < BEST_OF_MIN_SEC) return null;
  return chosen.sort((a, b) => a.startSec - b.startSec).map((p) => ({ startSec: p.startSec, endSec: p.endSec }));
}

/**
 * What one long video becomes besides its 9:16 shorts (which the clip pipeline renders into the
 * Inbox): square and wide cuts of the best picks, or audiograms when it has no picture, and a
 * best-of when there is enough for 3 minutes.
 */
export function planFormats(input: { picks: PlannedPick[]; audioOnly: boolean }): PlannedOutput[] {
  const best = [...input.picks].sort((a, b) => b.score - a.score).slice(0, EXTRA_CUTS);
  const out: PlannedOutput[] = [];
  for (const p of best) {
    const ranges = [{ startSec: p.startSec, endSec: p.endSec }];
    if (input.audioOnly) out.push({ format: "audiogram", ranges, title: p.title });
    else out.push({ format: "square", ranges, title: p.title }, { format: "wide", ranges, title: p.title });
  }
  const bestOf = planBestOf(input.picks);
  if (bestOf) out.push({ format: "best-of", ranges: bestOf, title: "" });
  return out;
}

function sentence(words: Word[], range: TimeRange, maxChars: number): string {
  const text = words
    .filter((w) => w.startSec >= range.startSec && w.endSec <= range.endSec)
    .map((w) => w.word)
    .join(" ")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), maxChars - 20)).trim()}…`;
}

/** "1:05" or "1:02:03", as YouTube reads chapters. */
export function chapterTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return hh > 0 ? `${hh}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

export interface SuggestInput {
  format: OutputFormat;
  ranges: TimeRange[];
  /** Titles of the picks in each range, in order. */
  titles: string[];
  words: Word[];
  vodTitle: string | null;
  chapters: Chapter[];
  brand: Brand;
}

/**
 * Suggested title, description and chapters for an output, from its picks, what is said in it and
 * the workspace's brand. Written without AI, so they suit every source, campaigns that ban AI too.
 */
export function suggestMeta(i: SuggestInput): { title: string; description: string; chapters: OutputChapter[] } {
  const show = i.vodTitle?.trim() || "the full video";
  const title =
    i.format === "best-of"
      ? `Best of ${show}`.slice(0, 100)
      : `${i.titles[0] || show}${i.format === "audiogram" ? " (podcast clip)" : ""}`.slice(0, 100);
  // Chapters: one per moment of a best-of, timed in the output (YouTube wants the first at 0:00).
  const chapters: OutputChapter[] = [];
  if (i.format === "best-of") {
    let at = 0;
    i.ranges.forEach((r, n) => {
      chapters.push({ title: i.titles[n] || `Moment ${n + 1}`, startSec: Math.round(at) });
      at += r.endSec - r.startSec;
    });
  }
  const said = i.format === "best-of" ? "" : sentence(i.words, i.ranges[0]!, 180);
  const lines = [
    said ? `“${said}”` : `The best moments of ${show}.`,
    i.format === "best-of" ? chapters.map((c) => `${chapterTime(c.startSec)} ${c.title}`).join("\n") : `From ${show}.`,
    i.brand.callToAction,
    i.brand.handle,
  ];
  return { title, description: lines.filter(Boolean).join("\n\n").slice(0, 4900), chapters };
}

/** The loudest second inside a range (seconds of the source): the thumbnail frame. */
export function thumbnailAt(range: TimeRange, loudness: number[]): number {
  let best = range.startSec + Math.min(1, (range.endSec - range.startSec) / 2);
  let loudest = -Infinity;
  for (let s = Math.floor(range.startSec); s < Math.ceil(range.endSec); s++) {
    const v = loudness[s];
    if (v !== undefined && v > loudest) {
      loudest = v;
      best = s + 0.5;
    }
  }
  return Math.min(Math.max(best, range.startSec), range.endSec - 0.1);
}
