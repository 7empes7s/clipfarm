import type { OutputFormat } from "../../../shared/creator.js";
import type { Word } from "../../../shared/types.js";
import { run } from "../../tools/exec.js";
import { assTime, captionText, chunkCaptions, karaokeEvents } from "../render/captions.js";
import { OUT_FPS } from "../render/layout.js";
import { cropFor, FORMAT_SIZE } from "./plan.js";

/** One piece of the output: a stretch of a downloaded section. */
export interface FormatInput {
  file: string;
  /** Where the piece starts in the file, and how long it runs. */
  offsetSec: number;
  durationSec: number;
}

/** "#ffd84d" → ASS "&H004DD8FF&" (ASS colours are BBGGRR). */
export function assColor(hex: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return "&H0000E5FF&";
  return `&H00${m[3]}${m[2]}${m[1]}&`.toUpperCase();
}

/** Word-by-word captions sized for a format's frame: lower third, the word being said in the brand colour. */
export function formatAss(words: Word[], format: OutputFormat, color: string): string {
  const { w, h } = FORMAT_SIZE[format];
  // Captions are as big on a square or wide frame as on a short, relative to its height.
  const fontSize = Math.round((h / 1920) * 76 * (format === "short" ? 1 : 1.5));
  const side = Math.round(w * 0.08);
  const marginV = Math.round(h * (format === "short" ? 0.3 : format === "audiogram" ? 0.12 : 0.08));
  const lines = chunkCaptions(words, { maxWords: format === "wide" ? 6 : 4, fontSize: Math.min(fontSize, 76) });
  const hi = assColor(color);
  const white = "&H00FFFFFF&";
  const out = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Caption,DejaVu Sans,${fontSize},${white},${white},&H00000000&,&H80000000&,-1,0,0,0,100,100,0,0,1,${Math.max(3, Math.round(fontSize / 11))},2,2,${side},${side},${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  for (const e of karaokeEvents(lines)) {
    const text = e.line.words.map((x, i) => (i === e.current ? `{\\c${hi}}${captionText(x.word)}{\\c${white}}` : captionText(x.word))).join(" ");
    out.push(`Dialogue: 0,${assTime(e.startSec)},${assTime(e.endSec)},Caption,,0,0,0,,${text}`);
  }
  return [...out, ""].join("\n");
}

export interface FormatRenderOptions {
  format: OutputFormat;
  inputs: FormatInput[];
  /** Size of the downloaded video (every input has the same). */
  src: { w: number; h: number };
  /** ASS file name relative to `cwd`, or null for no captions. */
  assFile: string | null;
  /** The brand colour, for the audiogram's waveform. */
  color: string;
  output: string;
  cwd: string;
  preset?: string;
  signal?: AbortSignal;
}

/**
 * ffmpeg arguments for one output: each piece cropped to the format's shape and scaled to its size
 * (an audiogram draws the sound as a waveform instead), joined in order, captions burned in.
 */
export function formatArgs(o: FormatRenderOptions): string[] {
  const { w, h } = FORMAT_SIZE[o.format];
  const total = o.inputs.reduce((s, i) => s + i.durationSec, 0);
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  for (const i of o.inputs) args.push("-ss", i.offsetSec.toFixed(3), "-t", i.durationSec.toFixed(3), "-i", i.file);
  const parts: string[] = [];
  const captions = o.assFile ? `,ass=${o.assFile}` : "";
  const audio = (n: number) => `[${n}:a]aresample=48000,aformat=channel_layouts=stereo[a${n}]`;
  if (o.format === "audiogram") {
    const waveH = Math.round(h / 3);
    parts.push(
      `color=c=0x111318:s=${w}x${h}:r=${OUT_FPS}:d=${total.toFixed(3)}[bg]`,
      `[0:a]asplit=2[aw][ar]`,
      `[aw]showwaves=s=${w}x${waveH}:mode=cline:rate=${OUT_FPS}:colors=${o.color.replace("#", "0x")},format=yuva420p[wave]`,
      `[bg][wave]overlay=0:${Math.round(h / 2 - waveH / 2 - h * 0.1)}:shortest=1${captions},format=yuv420p[v]`,
      `[ar]aresample=48000,aformat=channel_layouts=stereo[a]`,
    );
  } else {
    const crop = cropFor(o.format, o.src.w, o.src.h);
    o.inputs.forEach((_, n) => {
      parts.push(`[${n}:v]crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},scale=${w}:${h},setsar=1,fps=${OUT_FPS},format=yuv420p[v${n}]`, audio(n));
    });
    if (o.inputs.length > 1) {
      parts.push(`${o.inputs.map((_, n) => `[v${n}][a${n}]`).join("")}concat=n=${o.inputs.length}:v=1:a=1[vc][a]`, `[vc]null${captions}[v]`);
    } else {
      parts.push(`[v0]null${captions}[v]`, `[a0]anull[a]`);
    }
  }
  args.push(
    "-filter_complex", parts.join(";"),
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", o.preset ?? "veryfast", "-crf", "21", "-r", String(OUT_FPS),
    "-c:a", "aac", "-b:a", "160k", "-ac", "2",
    "-t", total.toFixed(3),
    "-movflags", "+faststart",
    o.output,
  );
  return args;
}

export async function renderFormat(o: FormatRenderOptions): Promise<void> {
  await run("ffmpeg", formatArgs(o), { signal: o.signal, cwd: o.cwd });
}
