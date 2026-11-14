// The Studio's pure parts, shared by the editor and the renderer: the non-destructive edit list
// (ranges cut out of a clip), word snapping, splitting, the clip's look, brand templates and the
// AI-ban gate. Times are master seconds unless a name says otherwise.
import type { CampaignRules, ClipEffects, ClipLayout, Word } from "./types.js";
import { CLIP_MIN_SEC } from "./types.js";

export interface TimeRange {
  startSec: number;
  endSec: number;
}

/** Shorter kept or cut pieces than this are rounding noise, not edits. */
const SLIVER = 0.05;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Cuts sorted and merged, so no two overlap or touch. */
export function normalizeCuts(cuts: TimeRange[]): TimeRange[] {
  const sorted = cuts.filter((c) => c.endSec - c.startSec > 0).sort((a, b) => a.startSec - b.startSec);
  const out: TimeRange[] = [];
  for (const c of sorted) {
    const last = out.at(-1);
    if (last && c.startSec <= last.endSec) last.endSec = Math.max(last.endSec, c.endSec);
    else out.push({ startSec: r3(c.startSec), endSec: r3(c.endSec) });
  }
  return out.map((c) => ({ startSec: r3(c.startSec), endSec: r3(c.endSec) }));
}

export function addCut(cuts: TimeRange[], range: TimeRange): TimeRange[] {
  return normalizeCuts([...cuts, range]);
}

/** Puts a range back: whatever part of a cut falls inside it is kept again. */
export function removeCut(cuts: TimeRange[], range: TimeRange): TimeRange[] {
  return normalizeCuts(
    cuts.flatMap((c) => {
      if (c.endSec <= range.startSec || c.startSec >= range.endSec) return [c];
      const parts: TimeRange[] = [];
      if (c.startSec < range.startSec) parts.push({ startSec: c.startSec, endSec: range.startSec });
      if (c.endSec > range.endSec) parts.push({ startSec: range.endSec, endSec: c.endSec });
      return parts;
    }),
  );
}

/** The pieces of [startSec, endSec] that stay once the cuts are taken out, in order. */
export function keptSegments(startSec: number, endSec: number, cuts: TimeRange[]): TimeRange[] {
  const segs: TimeRange[] = [];
  let at = startSec;
  for (const c of normalizeCuts(cuts)) {
    if (c.endSec <= at || c.startSec >= endSec) continue;
    if (c.startSec - at > SLIVER) segs.push({ startSec: r3(at), endSec: r3(c.startSec) });
    at = Math.max(at, c.endSec);
  }
  if (endSec - at > SLIVER) segs.push({ startSec: r3(at), endSec: r3(endSec) });
  return segs;
}

export function editedLength(segs: TimeRange[]): number {
  return r3(segs.reduce((sum, s) => sum + s.endSec - s.startSec, 0));
}

/** Master seconds → seconds of the edited clip; null when that moment is cut out. */
export function toEditedTime(t: number, segs: TimeRange[]): number | null {
  let before = 0;
  for (const s of segs) {
    if (t >= s.startSec && t <= s.endSec) return r3(before + t - s.startSec);
    before += s.endSec - s.startSec;
  }
  return null;
}

/** The words that are kept, timed in seconds of the edited clip (a word half cut keeps its kept half). */
export function editedWords(words: Word[], segs: TimeRange[]): Word[] {
  const out: Word[] = [];
  let before = 0;
  for (const s of segs) {
    for (const w of words) {
      const from = Math.max(w.startSec, s.startSec);
      const to = Math.min(w.endSec, s.endSec);
      // At least half of the word (or 0.1 s of it) must be inside the piece.
      if (to - from < Math.min(0.1, (w.endSec - w.startSec) / 2) || to <= from) continue;
      out.push({ word: w.word, startSec: r3(before + from - s.startSec), endSec: r3(before + to - s.startSec) });
    }
    before += s.endSec - s.startSec;
  }
  return out;
}

/** The time range covered by the words from index `a` to index `b` (either order). */
export function wordRange(words: Word[], a: number, b: number): TimeRange {
  const [from, to] = a <= b ? [a, b] : [b, a];
  return { startSec: words[from]!.startSec, endSec: words[to]!.endSec };
}

const FILLER = /^(u+m+|u+h+m*|e+r+m*|h+m+|m+h*m+|a+h+)$/;

/** "um", "uh", "erm", "hmm"… with any punctuation or case. Real words ("like", "so") are never fillers. */
export function isFiller(word: string): boolean {
  return FILLER.test(word.toLowerCase().replace(/[^\p{L}]/gu, ""));
}

/** A silence longer than this between two words is a long pause; this much of it stays on each side. */
export const LONG_PAUSE_SEC = 0.7;
export const PAUSE_KEEP_SEC = 0.15;

/** One tap: every filler word and every long pause inside the window, as cuts. */
export function fillerCuts(words: Word[], startSec: number, endSec: number): TimeRange[] {
  const inside = words.filter((w) => w.startSec >= startSec && w.endSec <= endSec);
  const cuts: TimeRange[] = inside.filter((w) => isFiller(w.word)).map((w) => ({ startSec: w.startSec, endSec: w.endSec }));
  for (let i = 1; i < inside.length; i++) {
    const gap = inside[i]!.startSec - inside[i - 1]!.endSec;
    if (gap > LONG_PAUSE_SEC) cuts.push({ startSec: inside[i - 1]!.endSec + PAUSE_KEEP_SEC, endSec: inside[i]!.startSec - PAUSE_KEEP_SEC });
  }
  return normalizeCuts(cuts);
}

/** Moves a start onto the nearest word start, or an end onto the nearest word end. */
export function snapToWord(t: number, words: Word[], edge: "start" | "end"): number {
  let best = t;
  let dist = Infinity;
  for (const w of words) {
    const at = edge === "start" ? w.startSec : w.endSec;
    if (Math.abs(at - t) < dist) {
      dist = Math.abs(at - t);
      best = at;
    }
  }
  return best;
}

/** The middle of the silence between two words that is nearest `t`, so a split never lands inside a word. */
export function splitPoint(t: number, words: Word[]): number {
  let best = t;
  let dist = Infinity;
  for (let i = 1; i < words.length; i++) {
    const mid = r3((words[i - 1]!.endSec + words[i]!.startSec) / 2);
    if (Math.abs(mid - t) < dist) {
      dist = Math.abs(mid - t);
      best = mid;
    }
  }
  return best;
}

export interface EditWindow {
  startSec: number;
  endSec: number;
  cuts: TimeRange[];
}

/** Splits one clip into two at the word gap nearest `atSec`; each part keeps the cuts that fall inside it. */
export function splitEdit(edit: EditWindow, atSec: number, words: Word[]): [EditWindow, EditWindow] {
  const at = splitPoint(atSec, words.filter((w) => w.startSec >= edit.startSec && w.endSec <= edit.endSec));
  const part = (startSec: number, endSec: number): EditWindow => ({
    startSec,
    endSec,
    cuts: normalizeCuts(edit.cuts.filter((c) => c.endSec > startSec && c.startSec < endSec)),
  });
  const a = part(edit.startSec, at);
  const b = part(at, edit.endSec);
  for (const p of [a, b]) {
    if (editedLength(keptSegments(p.startSec, p.endSec, p.cuts)) < CLIP_MIN_SEC) {
      throw new Error(`Each part must be at least ${CLIP_MIN_SEC} seconds long. Move the playhead and split again.`);
    }
  }
  return [a, b];
}

// ---- The look of a clip -------------------------------------------------------------------------

export const CAPTION_FONTS = ["DejaVu Sans", "DejaVu Serif", "DejaVu Sans Mono"] as const;
export type CaptionFont = (typeof CAPTION_FONTS)[number];

export const CAPTION_POSITIONS = ["top", "middle", "bottom"] as const;
export type CaptionPosition = (typeof CAPTION_POSITIONS)[number];

export const CAPTION_POSITION_LABELS: Record<CaptionPosition, string> = { top: "Top", middle: "Middle", bottom: "Bottom" };

export const CAPTION_SIZE_MIN = 48;
export const CAPTION_SIZE_MAX = 120;

export interface CaptionStyle {
  font: CaptionFont;
  /** Font size on the 1080×1920 frame. */
  size: number;
  /** "#RRGGBB" */
  color: string;
  /** The word being said, when `wordByWord` is on. */
  highlight: string;
  /** The box behind the hook text. */
  hookColor: string;
  wordByWord: boolean;
  position: CaptionPosition;
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  font: "DejaVu Sans",
  size: 86,
  color: "#FFFFFF",
  highlight: "#FFE500",
  hookColor: "#FFE600",
  wordByWord: true,
  position: "bottom",
};

/** How a clip looks beyond its layout and effects. */
export interface ClipLook {
  captionStyle: CaptionStyle;
  /** Centre of the crop across the frame (0 left … 1 right); null centres it on the face cam, or the middle. */
  cropX: number | null;
  /** Small text in the top corner for the whole clip (the channel's @handle). */
  watermark: string;
  /** Text on screen for the last 1.5 s. */
  outro: string;
  /** The brand template last applied, if any. */
  templateId: number | null;
}

export const DEFAULT_LOOK: ClipLook = { captionStyle: DEFAULT_CAPTION_STYLE, cropX: null, watermark: "", outro: "", templateId: null };

export const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

// ---- Brand templates ----------------------------------------------------------------------------

/** A channel's look: applied by itself to clips going to its accounts, editable in Settings. */
export interface BrandTemplate {
  id: number;
  name: string;
  /** The posting accounts it is for. */
  accountIds: string[];
  /** Null keeps each clip's own layout. */
  layout: ClipLayout | null;
  captionStyle: CaptionStyle;
  watermark: string;
  outro: string;
  effects: ClipEffects;
  /** Added to the caption when a clip posts to one of its accounts. */
  hashtags: string[];
}

export type BrandTemplateInput = Omit<BrandTemplate, "id">;

export function templateForAccount(templates: BrandTemplate[], accountId: string | null): BrandTemplate | null {
  if (!accountId) return null;
  return templates.find((t) => t.accountIds.includes(accountId)) ?? null;
}

export interface LookState {
  look: ClipLook;
  layout: ClipLayout;
  effects: ClipEffects;
}

/** The template's fonts, colours, watermark, outro, layout and effects on a clip. */
export function applyTemplate(state: LookState, t: BrandTemplate, o: { hasFaceCam: boolean }): LookState {
  const layout = t.layout && (t.layout !== "stacked" || o.hasFaceCam) ? t.layout : state.layout;
  return {
    layout,
    effects: { ...t.effects },
    look: { ...state.look, captionStyle: { ...t.captionStyle }, watermark: t.watermark, outro: t.outro, templateId: t.id },
  };
}

// ---- AI-ban gate --------------------------------------------------------------------------------

export const AI_ELEMENTS = ["hook", "thumbnails", "voice"] as const;
export type AiElement = (typeof AI_ELEMENTS)[number];

export const AI_ELEMENT_LABELS: Record<AiElement, string> = {
  hook: "AI hook text",
  thumbnails: "AI thumbnails",
  voice: "AI voice-over",
};

export interface AiGate {
  banned: boolean;
  /** Why AI is off, in plain words; null when it is allowed. */
  reason: string | null;
  elements: Record<AiElement, { allowed: boolean; why: string | null }>;
}

// "No AI", "AI-generated clips are not allowed", "do not use AI voices", "Banned: AI".
const AI_BAN = [
  /\b(no|zero|without|ban(?:ned|s)?|prohibit(?:ed|s)?|forbid(?:den|s)?|not allowed|never use|do not use|don'?t use)\b[^.\n]{0,40}\bAI\b/i,
  /\bAI\b[^.\n]{0,40}\b(not allowed|banned|prohibited|forbidden|strike|disqualif\w*|rejected)\b/i,
];

/** Whether any permission the clip posts under bans AI content: then every AI element is off. */
export function aiGate(permissions: { briefRules: string; rules: CampaignRules | null }[]): AiGate {
  const banned = permissions.some((p) => p.rules?.aiBanned === true || AI_BAN.some((re) => re.test(p.briefRules)));
  const reason = banned ? "This clip's campaign bans AI content (one strike can end it), so AI is off for it." : null;
  const elements = Object.fromEntries(AI_ELEMENTS.map((e) => [e, { allowed: !banned, why: reason }])) as AiGate["elements"];
  return { banned, reason, elements };
}
