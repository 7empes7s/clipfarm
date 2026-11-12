import type { Clip, ClipEditInput, ClipLayout, Source, Word } from "../../shared/types.js";
import { CLIP_LAYOUTS, CLIP_MAX_SEC, CLIP_MIN_SEC } from "../../shared/types.js";
import { ValidationError } from "../errors.js";

/** The caption words shown inside [startSec, endSec] (master seconds). */
export function wordsInWindow(words: Word[], startSec: number, endSec: number): Word[] {
  return words.filter((w) => w.endSec > startSec && w.startSec < endSec);
}

/**
 * Applies fixed caption text (typos) to the words shown in the clip's window. Same number of words:
 * each keeps its timing. Otherwise the new words share the old words' time span evenly. Words outside
 * the window are kept, so a later, longer trim still has captions.
 */
export function retimeCaptions(words: Word[], text: string, startSec: number, endSec: number): Word[] {
  const inside = wordsInWindow(words, startSec, endSec);
  const outside = words.filter((w) => !inside.includes(w));
  const next = text.split(/\s+/).filter(Boolean);
  let replaced: Word[];
  if (next.length === inside.length) {
    replaced = inside.map((w, i) => ({ ...w, word: next[i]! }));
  } else {
    const from = inside[0]?.startSec ?? startSec;
    const to = inside.at(-1)?.endSec ?? endSec;
    const step = next.length ? (to - from) / next.length : 0;
    const round = (v: number) => Math.round(v * 1000) / 1000;
    replaced = next.map((word, i) => ({ word, startSec: round(from + i * step), endSec: round(from + (i + 1) * step) }));
  }
  return [...outside, ...replaced].sort((a, b) => a.startSec - b.startSec);
}

function text(v: unknown, label: string, max: number, required: boolean): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (required && !s) throw new ValidationError(`Enter the ${label}.`);
  if (s.length > max) throw new ValidationError(`The ${label} is too long (${max} characters at most).`);
  return s;
}

/** Checks an edit from the gallery against the clip and its creator; throws a plain ValidationError. */
export function parseClipEdit(body: unknown, clip: Clip, source: Source): ClipEditInput {
  if (clip.status === "rendering") throw new ValidationError("A new version of this clip is already being made.");
  if (clip.postCount > 0) throw new ValidationError("This clip is already posted, so it cannot be changed.");
  const b = (body ?? {}) as Record<string, unknown>;
  const layout = b.layout as ClipLayout;
  if (!CLIP_LAYOUTS.includes(layout)) throw new ValidationError("Pick a layout.");
  if (layout === "stacked" && !source.faceCam) {
    throw new ValidationError(`Set where ${source.creatorName}'s face cam is first (Sources > Face cam).`);
  }
  const round = (v: number) => Math.round(v * 100) / 100;
  const startSec = typeof b.startSec === "number" && Number.isFinite(b.startSec) ? round(b.startSec) : NaN;
  const rawEnd = typeof b.endSec === "number" && Number.isFinite(b.endSec) ? round(b.endSec) : NaN;
  if (Number.isNaN(startSec) || Number.isNaN(rawEnd)) throw new ValidationError("The start and end must be numbers of seconds.");
  if (startSec < 0) throw new ValidationError("The start cannot be before the beginning of the video.");
  if (rawEnd > clip.masterDurationSec + 0.05) throw new ValidationError("The end cannot be after the end of the video.");
  const endSec = Math.min(rawEnd, round(clip.masterDurationSec));
  const length = endSec - startSec;
  if (length < CLIP_MIN_SEC) throw new ValidationError(`The clip must be at least ${CLIP_MIN_SEC} seconds long.`);
  if (length > CLIP_MAX_SEC) throw new ValidationError(`The clip must be ${CLIP_MAX_SEC} seconds or shorter.`);
  return {
    title: text(b.title, "title", 100, true),
    hook: text(b.hook, "hook", 100, false),
    captionText: text(b.captionText, "caption text", 2000, false),
    layout,
    startSec,
    endSec,
  };
}
