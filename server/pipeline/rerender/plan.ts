import type { ClipLook, TimeRange } from "../../../shared/studio.js";
import type { ClipLayout, FaceCam, Word } from "../../../shared/types.js";
import { finishFilter, HOOK_CARD_SEC, PLAIN, type PolishPlan } from "../polish/plan.js";

// Pure planning for re-rendering an edited clip: crop math per layout, caption timing and the ffmpeg
// arguments. The runner (render.ts) only probes the master, writes the files and calls ffmpeg.

export const OUT_W = 1080;
export const OUT_H = 1920;
/** Stacked layout: face cam band on top, gameplay below. */
export const FACE_BAND_H = 640;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

/** The largest rectangle of `aspect` (w/h) centred inside `region`, in whole even pixels. */
export function coverCrop(region: Rect, aspect: number): Rect {
  let w = region.w;
  let h = w / aspect;
  if (h > region.h) {
    h = region.h;
    w = h * aspect;
  }
  const cw = even(w);
  const ch = even(h);
  return {
    x: Math.max(0, Math.round(region.x + (region.w - cw) / 2)),
    y: Math.max(0, Math.round(region.y + (region.h - ch) / 2)),
    w: cw,
    h: ch,
  };
}

/** Face cam fractions → pixels inside a frame of srcW × srcH. */
export function faceCamPixels(faceCam: FaceCam, srcW: number, srcH: number): Rect {
  const x = Math.round(faceCam.x * srcW);
  const y = Math.round(faceCam.y * srcH);
  return { x, y, w: Math.min(srcW - x, Math.round(faceCam.w * srcW)), h: Math.min(srcH - y, Math.round(faceCam.h * srcH)) };
}

const crop = (r: Rect) => `crop=${r.w}:${r.h}:${r.x}:${r.y}`;

/** Moves a crop so its centre sits at `cropX` (0..1) of the frame's width, kept inside the frame. Null leaves it centred. */
function shiftCrop(r: Rect, srcW: number, cropX: number | null): Rect {
  if (cropX === null) return r;
  return { ...r, x: Math.round(Math.min(srcW - r.w, Math.max(0, cropX * srcW - r.w / 2))) };
}

/**
 * The video part of the filter graph: [0:v] in, [v] out at 1080×1920.
 * - center: a 9:16 crop from the middle of the frame;
 * - full: the whole frame fitted to the width, over a blurred, zoomed copy of itself;
 * - stacked: the face cam on top (1080×640), a centre crop of the gameplay below (1080×1280).
 */
export function layoutFilter(srcW: number, srcH: number, layout: ClipLayout, faceCam: FaceCam | null, cropX: number | null = null): string {
  const frame: Rect = { x: 0, y: 0, w: srcW, h: srcH };
  if (layout === "center") {
    return `[0:v]${crop(shiftCrop(coverCrop(frame, OUT_W / OUT_H), srcW, cropX))},scale=${OUT_W}:${OUT_H},setsar=1[v]`;
  }
  if (layout === "full") {
    const fitH = srcW / srcH > OUT_W / OUT_H ? even((OUT_W * srcH) / srcW) : OUT_H;
    const fitW = fitH === OUT_H ? even((OUT_H * srcW) / srcH) : OUT_W;
    return (
      `[0:v]split=2[bg0][fg0];` +
      `[bg0]${crop(coverCrop(frame, OUT_W / OUT_H))},scale=${OUT_W}:${OUT_H},boxblur=20:2[bg];` +
      `[fg0]scale=${fitW}:${fitH}[fg];` +
      `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[v]`
    );
  }
  if (!faceCam) throw new Error("The stacked layout needs the creator's face cam position.");
  const gameH = OUT_H - FACE_BAND_H;
  const face = coverCrop(faceCamPixels(faceCam, srcW, srcH), OUT_W / FACE_BAND_H);
  const game = shiftCrop(coverCrop(frame, OUT_W / gameH), srcW, cropX);
  return (
    `[0:v]split=2[f0][g0];` +
    `[f0]${crop(face)},scale=${OUT_W}:${FACE_BAND_H}[face];` +
    `[g0]${crop(game)},scale=${OUT_W}:${gameH}[game];` +
    `[face][game]vstack=inputs=2,setsar=1[v]`
  );
}

export interface CaptionEvent {
  startSec: number;
  endSec: number;
  text: string;
  /** Word by word: the index (in `text`'s words) of the word being said, shown in the highlight colour. */
  highlight?: number;
}

/**
 * Caption lines for the cut [startSec, endSec], in clip seconds: up to `perLine` words each, shown
 * from the first word until the next line starts (or the last word ends). `wordByWord` gives one
 * event per word instead, the whole line on screen and the word being said highlighted.
 */
export function captionEvents(words: Word[], startSec: number, endSec: number, perLine = 3, wordByWord = false): CaptionEvent[] {
  const inside = words.filter((w) => w.endSec > startSec && w.startSec < endSec);
  const clipLen = endSec - startSec;
  const at = (t: number) => Math.round(Math.min(clipLen, Math.max(0, t - startSec)) * 100) / 100;
  const lines: Word[][] = [];
  for (let i = 0; i < inside.length; i += perLine) lines.push(inside.slice(i, i + perLine));
  return lines.flatMap((line, i) => {
    const lineEnd = lines[i + 1]?.[0]?.startSec ?? line.at(-1)!.endSec;
    const text = line.map((w) => w.word).join(" ");
    if (!wordByWord) return [{ startSec: at(line[0]!.startSec), endSec: at(lineEnd), text }];
    return line.map((w, j) => ({ startSec: at(w.startSec), endSec: at(line[j + 1]?.startSec ?? lineEnd), text, highlight: j }));
  });
}

/** "#RRGGBB" → an ASS colour, &HAABBGGRR (alpha 0 is opaque). */
export function assColor(hex: string, alpha = 0): string {
  const h = hex.replace("#", "").toUpperCase();
  const a = alpha.toString(16).toUpperCase().padStart(2, "0");
  return `&H${a}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`;
}

/** Caption alignment (numpad) and vertical margin per position; the top line stays under the hook card. */
const POSITION = { top: { align: 8, marginV: 520 }, middle: { align: 5, marginV: 0 }, bottom: { align: 2, marginV: 430 } } as const;
const OUTRO_SEC = 1.5;

function assTime(sec: number): string {
  const cs = Math.round(sec * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

const assText = (s: string) => s.replace(/\\/g, "/").replace(/[{}]/g, "").replace(/\r?\n/g, " ");

/** Seconds the hook card stays on screen at the start. */
export const HOOK_SEC = HOOK_CARD_SEC;

const CAPTION_SIZE = 86;
/** The width captions may use (1080 minus the margins below) and a generous width per character at size 1. */
const CAPTION_ROOM = OUT_W - 90 - 170;
const CHAR_WIDTH = 0.68;

/**
 * An ASS subtitle file: big white words with a black outline, kept out of the platform UI (bottom
 * 20 %, right 15 %), and the hook card near the top for the first 1.5 s. A line with a word too long
 * for the safe width is set smaller, so it still fits. A Studio look sets the caption font, size,
 * colours and position, the hook box colour, and adds a watermark and an outro.
 */
export function buildAss(events: CaptionEvent[], hook: string, clipLen: number, look?: ClipLook): string {
  const style = look?.captionStyle;
  const size = style?.size ?? CAPTION_SIZE;
  const font = style?.font ?? "DejaVu Sans";
  const colour = style ? assColor(style.color) : "&H00FFFFFF";
  const hookBox = style ? assColor(style.hookColor) : "&H0000E6FF";
  const pos = POSITION[style?.position ?? "bottom"];
  const lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${OUT_W}`,
    `PlayResY: ${OUT_H}`,
    "WrapStyle: 0",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Caption,${font},${size},${colour},${colour},&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,7,0,${pos.align},90,170,${pos.marginV},1`,
    `Style: Hook,DejaVu Sans,84,&H00000000,&H00000000,${hookBox},${hookBox},-1,0,0,0,100,100,0,0,3,18,0,8,90,170,240,1`,
    ...(look
      ? [
          "Style: Mark,DejaVu Sans,40,&H40FFFFFF,&H40FFFFFF,&H80000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,0,9,60,60,60,1",
          `Style: Outro,DejaVu Sans,72,&H00000000,&H00000000,${hookBox},${hookBox},-1,0,0,0,100,100,0,0,3,18,0,5,90,170,0,1`,
        ]
      : []),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  if (hook.trim()) lines.push(`Dialogue: 1,${assTime(0)},${assTime(Math.min(HOOK_SEC, clipLen))},Hook,,0,0,0,,${assText(hook.trim())}`);
  if (look?.watermark.trim()) lines.push(`Dialogue: 2,${assTime(0)},${assTime(clipLen)},Mark,,0,0,0,,${assText(look.watermark.trim())}`);
  if (look?.outro.trim() && clipLen > OUTRO_SEC + HOOK_SEC) {
    lines.push(`Dialogue: 1,${assTime(clipLen - OUTRO_SEC)},${assTime(clipLen)},Outro,,0,0,0,,${assText(look.outro.trim())}`);
  }
  const highlight = style ? assColor(style.highlight) : "";
  for (const e of events) {
    if (e.endSec <= e.startSec) continue;
    const words = assText(e.text).split(/\s+/);
    const longest = Math.max(...words.map((w) => w.length));
    const fit = Math.floor(CAPTION_ROOM / (longest * CHAR_WIDTH));
    const text = e.highlight === undefined ? words.join(" ") : words.map((w, i) => (i === e.highlight ? `{\\c${highlight}&}${w}{\\c${colour}&}` : w)).join(" ");
    lines.push(`Dialogue: 0,${assTime(e.startSec)},${assTime(e.endSec)},Caption,,0,0,0,,${fit < size ? `{\\fs${fit}}` : ""}${text}`);
  }
  return `${lines.join("\n")}\n`;
}

export interface RenderPlan {
  args: string[];
  ass: string | null;
}

/**
 * ffmpeg arguments for one re-render (run with cwd = the job's temp folder, which holds
 * `captions.ass`, so no path ever needs escaping inside the filter graph).
 */
export function planRender(opts: {
  masterPath: string;
  outPath: string;
  srcW: number;
  srcH: number;
  startSec: number;
  endSec: number;
  layout: ClipLayout;
  faceCam: FaceCam | null;
  hook: string;
  captionWords: Word[];
  /** The finishing touches; without it the clip gets none. */
  polish?: PolishPlan;
  /** The Studio look; without it the captions keep the plain style. */
  look?: ClipLook;
}): RenderPlan {
  const polish = opts.polish ?? PLAIN;
  const look = opts.look;
  const clipLen = Math.round((opts.endSec - opts.startSec) * 1000) / 1000;
  const events = captionEvents(opts.captionWords, opts.startSec, opts.endSec, 3, look?.captionStyle.wordByWord ?? false);
  const hook = polish.hookCard ? opts.hook : "";
  const extras = look ? look.watermark.trim() || look.outro.trim() : "";
  const ass = events.length || hook.trim() || extras ? buildAss(events, hook, clipLen, look) : null;
  let graph = `${layoutFilter(opts.srcW, opts.srcH, opts.layout, opts.faceCam, look?.cropX ?? null)};${finishFilter("v", "vout", ass ? "captions.ass" : null, polish, clipLen)}`;
  if (polish.audio) graph = `${graph};[0:a:0]${polish.audio}[a]`;
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", String(opts.startSec),
    "-i", opts.masterPath,
    "-t", String(clipLen),
    "-filter_complex", graph,
    "-map", "[vout]",
    ...(polish.audio ? ["-map", "[a]"] : []),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-r", "30",
    "-c:a", "aac", "-b:a", "128k",
    "-threads", "2",
    "-movflags", "+faststart",
    opts.outPath,
  ];
  return { args, ass };
}

/**
 * ffmpeg arguments that join the kept pieces of the master (the Studio's edit list) into one file,
 * which the normal render then lays out, captions and polishes. Quick and near-lossless: it is only
 * an input for the real encode.
 */
export function planConcat(o: { masterPath: string; outPath: string; hasAudio: boolean; segments: TimeRange[] }): { args: string[] } {
  const parts: string[] = [];
  const inputs: string[] = [];
  o.segments.forEach((s, i) => {
    const range = `start=${s.startSec}:end=${s.endSec}`;
    parts.push(`[0:v]trim=${range},setpts=PTS-STARTPTS[v${i}]`);
    inputs.push(`[v${i}]`);
    if (o.hasAudio) {
      parts.push(`[0:a:0]atrim=${range},asetpts=PTS-STARTPTS[a${i}]`);
      inputs.push(`[a${i}]`);
    }
  });
  const a = o.hasAudio ? 1 : 0;
  const graph = `${parts.join(";")};${inputs.join("")}concat=n=${o.segments.length}:v=1:a=${a}[v]${o.hasAudio ? "[a]" : ""}`;
  return {
    args: [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", o.masterPath,
      "-filter_complex", graph,
      "-map", "[v]",
      ...(o.hasAudio ? ["-map", "[a]", "-c:a", "aac", "-b:a", "192k"] : []),
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "16", "-pix_fmt", "yuv420p",
      "-threads", "2",
      o.outPath,
    ],
  };
}
