import type { ClipLayout, FaceCam, Word } from "../../../shared/types.js";

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

/**
 * The video part of the filter graph: [0:v] in, [v] out at 1080×1920.
 * - center: a 9:16 crop from the middle of the frame;
 * - full: the whole frame fitted to the width, over a blurred, zoomed copy of itself;
 * - stacked: the face cam on top (1080×640), a centre crop of the gameplay below (1080×1280).
 */
export function layoutFilter(srcW: number, srcH: number, layout: ClipLayout, faceCam: FaceCam | null): string {
  const frame: Rect = { x: 0, y: 0, w: srcW, h: srcH };
  if (layout === "center") {
    return `[0:v]${crop(coverCrop(frame, OUT_W / OUT_H))},scale=${OUT_W}:${OUT_H},setsar=1[v]`;
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
  const game = coverCrop(frame, OUT_W / gameH);
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
}

/**
 * Caption lines for the cut [startSec, endSec], in clip seconds: up to `perLine` words each, shown
 * from the first word until the next line starts (or the last word ends).
 */
export function captionEvents(words: Word[], startSec: number, endSec: number, perLine = 3): CaptionEvent[] {
  const inside = words.filter((w) => w.endSec > startSec && w.startSec < endSec);
  const clipLen = endSec - startSec;
  const at = (t: number) => Math.round(Math.min(clipLen, Math.max(0, t - startSec)) * 100) / 100;
  const lines: Word[][] = [];
  for (let i = 0; i < inside.length; i += perLine) lines.push(inside.slice(i, i + perLine));
  return lines.map((line, i) => ({
    startSec: at(line[0]!.startSec),
    endSec: at(lines[i + 1]?.[0]?.startSec ?? line.at(-1)!.endSec),
    text: line.map((w) => w.word).join(" "),
  }));
}

function assTime(sec: number): string {
  const cs = Math.round(sec * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

const assText = (s: string) => s.replace(/\\/g, "/").replace(/[{}]/g, "").replace(/\r?\n/g, " ");

/** Seconds the hook text stays on screen at the start. */
export const HOOK_SEC = 2;

/**
 * An ASS subtitle file: big white words with a black outline, kept out of the platform UI (bottom
 * 20 %, right 15 %), and the hook in a box near the top for the first seconds.
 */
export function buildAss(events: CaptionEvent[], hook: string, clipLen: number): string {
  const lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${OUT_W}`,
    `PlayResY: ${OUT_H}`,
    "WrapStyle: 0",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Caption,DejaVu Sans,86,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,7,0,2,90,170,430,1",
    "Style: Hook,DejaVu Sans,64,&H00000000,&H00000000,&H0000E6FF,&H0000E6FF,-1,0,0,0,100,100,0,0,3,18,0,8,90,170,240,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  if (hook.trim()) lines.push(`Dialogue: 1,${assTime(0)},${assTime(Math.min(HOOK_SEC, clipLen))},Hook,,0,0,0,,${assText(hook.trim())}`);
  for (const e of events) {
    if (e.endSec > e.startSec) lines.push(`Dialogue: 0,${assTime(e.startSec)},${assTime(e.endSec)},Caption,,0,0,0,,${assText(e.text)}`);
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
}): RenderPlan {
  const clipLen = Math.round((opts.endSec - opts.startSec) * 1000) / 1000;
  const events = captionEvents(opts.captionWords, opts.startSec, opts.endSec);
  const ass = events.length || opts.hook.trim() ? buildAss(events, opts.hook, clipLen) : null;
  let graph = layoutFilter(opts.srcW, opts.srcH, opts.layout, opts.faceCam);
  if (ass) graph = `${graph};[v]ass=captions.ass[vout]`;
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", String(opts.startSec),
    "-i", opts.masterPath,
    "-t", String(clipLen),
    "-filter_complex", graph,
    "-map", ass ? "[vout]" : "[v]",
    "-map", "0:a:0?",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-r", "30",
    "-c:a", "aac", "-b:a", "128k",
    "-threads", "2",
    "-movflags", "+faststart",
    opts.outPath,
  ];
  return { args, ass };
}
