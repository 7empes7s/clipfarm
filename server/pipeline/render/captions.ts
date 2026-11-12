import type { Word } from "../../../shared/types.js";
import { OUT_H, OUT_W } from "./layout.js";

/** Platform buttons and captions cover the bottom 20% and the right 15% of a vertical video. */
export const SAFE = {
  left: Math.round(OUT_W * 0.1),
  right: Math.round(OUT_W * 0.15),
  bottom: Math.round(OUT_H * 0.2),
  top: Math.round(OUT_H * 0.1),
};
export const SAFE_WIDTH = OUT_W - SAFE.left - SAFE.right;

export const CAPTION_FONT_SIZE = 76;
const HOOK_FONT_SIZE = 64;
/** Captions sit above the bottom safe area, at about two thirds of the height. */
const CAPTION_MARGIN_V = SAFE.bottom + 340;
export const HOOK_SECONDS = 2;
/** Rough width of a bold capital at size 1 (generous, so real text is never wider). */
const CHAR_WIDTH = 0.68;

export interface CaptionLine {
  words: Word[];
  startSec: number;
  endSec: number;
  /** Font size, smaller than the default only when one long word would not fit. */
  fontSize: number;
}

export function captionText(word: string): string {
  // ASS treats { } and \ as markup; drop them from spoken words.
  return word.replace(/[{}\\]/g, "").toUpperCase();
}

/** Estimated rendered width in pixels of a caption line at a font size. */
export function lineWidth(words: string[], fontSize: number): number {
  return words.map(captionText).join(" ").length * fontSize * CHAR_WIDTH;
}

/**
 * Splits clip words (times from the clip start) into caption lines of 2-4 words that fit the safe
 * width, breaking early at sentence ends and pauses. Each line shows until the next one starts.
 */
export function chunkCaptions(words: Word[], opts: { maxWords?: number; fontSize?: number } = {}): CaptionLine[] {
  const maxWords = opts.maxWords ?? 4;
  const size = opts.fontSize ?? CAPTION_FONT_SIZE;
  const groups: Word[][] = [];
  let cur: Word[] = [];
  words.forEach((w, i) => {
    if (cur.length > 0 && (cur.length >= maxWords || lineWidth([...cur, w].map((x) => x.word), size) > SAFE_WIDTH)) {
      groups.push(cur);
      cur = [];
    }
    cur.push(w);
    const next = words[i + 1];
    const sentenceEnd = /[.!?…]$/.test(w.word) || (next !== undefined && next.startSec - w.endSec > 0.5);
    if (sentenceEnd || (/,$/.test(w.word) && cur.length >= 2)) {
      groups.push(cur);
      cur = [];
    }
  });
  if (cur.length > 0) groups.push(cur);

  return groups.map((g, i) => {
    const next = groups[i + 1];
    const last = g.at(-1)!;
    const endSec = next ? next[0]!.startSec : last.endSec + 0.4;
    const fit = Math.floor(SAFE_WIDTH / (lineWidth(g.map((x) => x.word), 1) || 1));
    return { words: g, startSec: g[0]!.startSec, endSec: Math.max(endSec, last.endSec), fontSize: Math.min(size, fit) };
  });
}

/** ASS time: h:mm:ss.cc */
export function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

export interface CaptionEvent {
  startSec: number;
  endSec: number;
  /** Index of the highlighted word in the line. */
  current: number;
  line: CaptionLine;
}

/** One event per spoken word: the whole line on screen, the word being said highlighted. */
export function karaokeEvents(lines: CaptionLine[]): CaptionEvent[] {
  return lines.flatMap((line) =>
    line.words.map((w, i) => ({
      startSec: w.startSec,
      endSec: i + 1 < line.words.length ? line.words[i + 1]!.startSec : line.endSec,
      current: i,
      line,
    })),
  );
}

const HIGHLIGHT = "&H0000E5FF&"; // ASS colours are &HBBGGRR: a warm yellow
const WHITE = "&H00FFFFFF&";

/**
 * Builds the ASS file: karaoke captions in the safe area and the hook title for the first 2 s.
 * `words` have times in seconds from the clip start.
 */
export function buildAss(words: Word[], hook: string): string {
  const lines = chunkCaptions(words);
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${OUT_W}`,
    `PlayResY: ${OUT_H}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Caption,DejaVu Sans,${CAPTION_FONT_SIZE},${WHITE},${WHITE},&H00000000&,&H80000000&,-1,0,0,0,100,100,0,0,1,7,2,2,${SAFE.left},${SAFE.right},${CAPTION_MARGIN_V},1`,
    `Style: Hook,DejaVu Sans,${HOOK_FONT_SIZE},&H00111111&,${WHITE},&H00FFFFFF&,&H00FFFFFF&,-1,0,0,0,100,100,0,0,3,18,0,8,${SAFE.left},${SAFE.right},${SAFE.top + 60},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const events: string[] = [];
  const hookText = captionText(hook.trim());
  if (hookText) events.push(`Dialogue: 1,${assTime(0)},${assTime(HOOK_SECONDS)},Hook,,0,0,0,,${hookText}`);
  for (const e of karaokeEvents(lines)) {
    const size = e.line.fontSize !== CAPTION_FONT_SIZE ? `{\\fs${e.line.fontSize}}` : "";
    const text = e.line.words
      .map((w, i) => (i === e.current ? `{\\c${HIGHLIGHT}}${captionText(w.word)}{\\c${WHITE}}` : captionText(w.word)))
      .join(" ");
    events.push(`Dialogue: 0,${assTime(e.startSec)},${assTime(e.endSec)},Caption,,0,0,0,,${size}${text}`);
  }
  return [...header, ...events, ""].join("\n");
}

/** Shifts words inside [startSec, endSec] to times from the clip start. */
export function clipWords(words: Word[], startSec: number, endSec: number): Word[] {
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return words
    .filter((w) => w.endSec > startSec && w.startSec < endSec)
    .map((w) => ({
      word: w.word,
      startSec: r(Math.max(0, w.startSec - startSec)),
      endSec: r(Math.min(endSec, w.endSec) - startSec),
    }));
}
