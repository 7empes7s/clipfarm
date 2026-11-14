import {
  CAPTION_FONTS,
  CAPTION_POSITIONS,
  CAPTION_SIZE_MAX,
  CAPTION_SIZE_MIN,
  type CaptionStyle,
  type ClipLook,
  DEFAULT_CAPTION_STYLE,
  DEFAULT_LOOK,
  editedLength,
  editedWords,
  HEX_COLOR,
  keptSegments,
  normalizeCuts,
  type TimeRange,
} from "../../shared/studio.js";
import type { Clip, ClipEffects, ClipLayout, ScorePart, Source, StudioEditInput, Word } from "../../shared/types.js";
import { CLIP_EFFECTS, CLIP_LAYOUTS, CLIP_MAX_SEC, CLIP_MIN_SEC } from "../../shared/types.js";
import { ValidationError } from "../errors.js";
import { isHypeWord } from "../pipeline/picks/signals.js";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);

function text(v: unknown, label: string, max: number, required = false): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (required && !s) throw new ValidationError(`Enter the ${label}.`);
  if (s.length > max) throw new ValidationError(`The ${label} is too long (${max} characters at most).`);
  return s;
}

function colour(v: unknown, label: string): string {
  if (typeof v !== "string" || !HEX_COLOR.test(v)) throw new ValidationError(`Pick a colour for the ${label}.`);
  return v.toUpperCase();
}

/** Checks a caption style from the Studio or a template; anything left out keeps the default. */
export function parseCaptionStyle(raw: unknown): CaptionStyle {
  const b = { ...DEFAULT_CAPTION_STYLE, ...((raw ?? {}) as Partial<CaptionStyle>) };
  if (!CAPTION_FONTS.includes(b.font)) throw new ValidationError("Pick a caption font.");
  if (!CAPTION_POSITIONS.includes(b.position)) throw new ValidationError("Pick where the captions sit.");
  const size = num(b.size);
  if (size === null || size < CAPTION_SIZE_MIN || size > CAPTION_SIZE_MAX) {
    throw new ValidationError(`The caption size must be ${CAPTION_SIZE_MIN} to ${CAPTION_SIZE_MAX}.`);
  }
  return {
    font: b.font,
    size: Math.round(size),
    color: colour(b.color, "captions"),
    highlight: colour(b.highlight, "highlighted word"),
    hookColor: colour(b.hookColor, "hook box"),
    wordByWord: b.wordByWord === true,
    position: b.position,
  };
}

export function parseLook(raw: unknown): ClipLook {
  const b = { ...DEFAULT_LOOK, ...((raw ?? {}) as Partial<ClipLook>) };
  const cropX = b.cropX === null ? null : num(b.cropX);
  if (cropX !== null && (cropX < 0 || cropX > 1)) throw new ValidationError("The crop must stay inside the frame.");
  if (b.cropX !== null && cropX === null) throw new ValidationError("The crop must stay inside the frame.");
  return {
    captionStyle: parseCaptionStyle(b.captionStyle),
    cropX,
    watermark: text(b.watermark, "watermark", 40),
    outro: text(b.outro, "outro text", 60),
    templateId: Number.isInteger(b.templateId) ? (b.templateId as number) : null,
  };
}

export function parseEffects(raw: unknown, fallback: ClipEffects): ClipEffects {
  const sent = (raw ?? {}) as Record<string, unknown>;
  return Object.fromEntries(CLIP_EFFECTS.map((e) => [e, typeof sent[e] === "boolean" ? sent[e] : fallback[e]])) as ClipEffects;
}

function parseCuts(raw: unknown): TimeRange[] {
  if (!Array.isArray(raw)) return [];
  const cuts = raw.map((c) => {
    const s = num((c as TimeRange)?.startSec);
    const e = num((c as TimeRange)?.endSec);
    if (s === null || e === null || e <= s) throw new ValidationError("A cut must end after it starts.");
    return { startSec: s, endSec: e };
  });
  return normalizeCuts(cuts);
}

/** Checks a Studio export against the clip and its creator; throws a plain ValidationError. */
export function parseStudioEdit(body: unknown, clip: Clip, source: Source): StudioEditInput {
  if (clip.status === "rendering") throw new ValidationError("A new version of this clip is already being made.");
  if (clip.postCount > 0) throw new ValidationError("This clip is already posted, so it cannot be changed.");
  const b = (body ?? {}) as Record<string, unknown>;
  const layout = b.layout as ClipLayout;
  if (!CLIP_LAYOUTS.includes(layout)) throw new ValidationError("Pick a layout.");
  if (layout === "stacked" && !source.faceCam) {
    throw new ValidationError(`Set where ${source.creatorName}'s face cam is first (Sources > Face cam).`);
  }
  const startSec = num(b.startSec);
  const rawEnd = num(b.endSec);
  if (startSec === null || rawEnd === null) throw new ValidationError("The start and end must be numbers of seconds.");
  if (startSec < 0) throw new ValidationError("The start cannot be before the beginning of the video.");
  if (rawEnd > clip.masterDurationSec + 0.05) throw new ValidationError("The end cannot be after the end of the video.");
  const endSec = Math.min(rawEnd, clip.masterDurationSec);
  // Only the cuts inside the window matter.
  const cuts = parseCuts(b.cuts).filter((c) => c.endSec > startSec && c.startSec < endSec);
  const length = editedLength(keptSegments(startSec, endSec, cuts));
  if (length < CLIP_MIN_SEC) throw new ValidationError(`The clip must be at least ${CLIP_MIN_SEC} seconds long once the cuts are out.`);
  if (length > CLIP_MAX_SEC) throw new ValidationError(`The clip must be ${CLIP_MAX_SEC} seconds or shorter once the cuts are out.`);
  return {
    title: text(b.title, "title", 100, true),
    hook: text(b.hook, "hook", 100),
    layout,
    startSec,
    endSec,
    cuts,
    effects: parseEffects(b.effects, clip.effects),
    look: parseLook(b.look),
  };
}

const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

/**
 * "Why this clip": what the clip has going for it, from its words as they are after the edit list.
 * The picker's own score is one number; this shows where it comes from, so a pick can be trusted or
 * overridden. Chat is only scored once chat replays are fetched.
 */
export function scoreBreakdown(clip: Pick<Clip, "captionWords" | "startSec" | "endSec" | "cuts">): ScorePart[] {
  const segs = keptSegments(clip.startSec, clip.endSec, clip.cuts);
  const len = editedLength(segs);
  const words: Word[] = editedWords(clip.captionWords, segs);
  const opening = words.filter((w) => w.startSec < 3);
  const openShout = opening.some((w) => isHypeWord(w.word));
  const late = words.filter((w) => w.startSec >= len * 0.5 && isHypeWord(w.word));
  const wps = len > 0 ? words.length / len : 0;

  const hook = clamp((Math.min(opening.length, 6) / 6) * 60 + (openShout ? 40 : 0));
  const payoff = clamp(late.length === 0 ? 30 : 40 + 30 * late.length);
  const energy = clamp((wps / 3) * 100);
  const length = clamp(len < 20 ? 100 - (20 - len) * 5 : len > 35 ? 100 - (len - 35) * 2.5 : 100);
  const s = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  return [
    {
      key: "hook",
      label: "Hook",
      value: hook,
      note: `${s(opening.length, "word")} in the first 3 s${openShout ? ", opens on a reaction" : ", no reaction yet"}.`,
    },
    {
      key: "payoff",
      label: "Payoff",
      value: payoff,
      note: late.length ? `${s(late.length, "reaction word")} in the second half.` : "No reaction words in the second half.",
    },
    { key: "energy", label: "Energy", value: energy, note: `${wps.toFixed(1)} words a second.` },
    { key: "chat", label: "Chat", value: null, note: "Not measured: there is no chat replay for this clip." },
    {
      key: "length",
      label: "Length",
      value: length,
      note: `${len.toFixed(1)} s${length === 100 ? ", in the 20–35 s sweet spot" : len < 20 ? ", shorter than the 20–35 s sweet spot" : ", longer than the 20–35 s sweet spot"}.`,
    },
  ];
}
