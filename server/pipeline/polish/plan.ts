import type { ClipEffects, Word } from "../../../shared/types.js";
import { isHypeWord, secondScores } from "../picks/signals.js";

// Pure planning for the finishing touches of a render: hook card, punch-in zooms, loudness, loop
// ending and progress bar. The runner (run.ts) measures the audio and the frames, then calls this.

const OUT_W = 1080;
const OUT_H = 1920;
const OUT_FPS = 30;

/** How long the hook card stays on screen. */
export const HOOK_CARD_SEC = 1.5;
/** Loudness target for short-form platforms, and the peak the normalizer aims for (the limit is -1 dBTP). */
export const TARGET_LUFS = -14;
export const TARGET_TRUE_PEAK = -2;
export const MAX_TRUE_PEAK = -1;
/** Length of the fade back into the opening frame. */
export const LOOP_FADE_SEC = 0.3;
/** Mean grey difference (0-255) between the first and last frame above which the ending gets the fade. */
export const LOOP_DIFF_LIMIT = 20;

/** Mean absolute difference of two equally sized grey frames, 0 (same) to 255. */
export function meanDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length === 0 || a.length !== b.length) throw new Error("The two frames to compare are not the same size.");
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length;
}

/** Reads the JSON block the first loudnorm pass prints. Null when the audio is silent (nothing to measure). */
export function parseLoudnorm(log: string): LoudnessMeasure | null {
  const json = log.slice(log.lastIndexOf("{"), log.lastIndexOf("}") + 1);
  if (!json) throw new Error("ffmpeg did not report the loudness.");
  const r = JSON.parse(json) as Record<string, string>;
  const m = { i: Number(r.input_i), tp: Number(r.input_tp), lra: Number(r.input_lra), thresh: Number(r.input_thresh), offset: Number(r.target_offset) };
  return Object.values(m).every(Number.isFinite) ? m : null;
}

export interface Zoom {
  /** When the zoom starts, in clip seconds. */
  atSec: number;
  /** How far in it goes: 0.15 is a 1.0 → 1.15 zoom. */
  amount: number;
  inSec: number;
  holdSec: number;
  outSec: number;
}

const PUNCH = { amount: 0.15, inSec: 0.35, holdSec: 1.2, outSec: 0.5 };
const QUICK = { amount: 0.06, inSec: 0.12, holdSec: 0.35, outSec: 0.2 };
const MAX_QUICK_ZOOMS = 6;
const zoomEnd = (z: Zoom) => z.atSec + z.inSec + z.holdSec + z.outSec;

/** Loudness measured by the first loudnorm pass. */
export interface LoudnessMeasure {
  i: number;
  tp: number;
  lra: number;
  thresh: number;
  offset: number;
}

export interface PolishPlan {
  hookCard: boolean;
  zooms: Zoom[];
  loopFade: boolean;
  progressBar: boolean;
  /** Audio filter chain, or null when the video has no sound. */
  audio: string | null;
}

/** A render with no finishing touches: single-pass loudness, as before the effects existed. */
export const PLAIN: PolishPlan = { hookCard: true, zooms: [], loopFade: false, progressBar: false, audio: audioFilter(true, null) };

/**
 * The second of the clip where the reaction peaks: the loudest, fastest-talking, most shouted
 * second (the same score picks use), moved onto a shouted word when one is said there. `loudness` is
 * per clip second, or null when it is not known. Null when nothing stands out.
 */
export function reactionPeak(words: Word[], loudness: number[] | null, durationSec: number): number | null {
  const scores = secondScores(durationSec, words, { loudness: loudness ?? [], chat: null });
  if (scores.length === 0 || scores.every((s) => Math.abs(s - scores[0]!) < 1e-9)) return null;
  const max = Math.max(...scores);
  // The score is smoothed, so a spike shows as a short plateau: take its middle.
  const first = scores.findIndex((s) => s >= max - 1e-9);
  let last = first;
  while (last + 1 < scores.length && scores[last + 1]! >= max - 1e-9) last++;
  const sec = Math.floor((first + last) / 2);
  // Land on the shout itself when one is said right there.
  const shouts = words.filter((w) => isHypeWord(w.word) && Math.abs(w.startSec - sec) <= 1.5).map((w) => w.startSec);
  return shouts.length > 0 ? shouts.reduce((a, b) => (Math.abs(b - sec) < Math.abs(a - sec) ? b : a)) : sec;
}

/** The punch-in at the reaction peak plus quick zooms on shouted caption words, never overlapping. */
export function planZooms(words: Word[], peakSec: number | null, durationSec: number): Zoom[] {
  const zooms: Zoom[] = [];
  const inside = (z: Zoom) => z.atSec >= 0 && zoomEnd(z) <= durationSec;
  // Half a second of rest between zooms, so the picture does not pump.
  const clear = (z: Zoom) => zooms.every((o) => zoomEnd(z) + 0.5 <= o.atSec || z.atSec >= zoomEnd(o) + 0.5);
  if (peakSec !== null) {
    const punch = { atSec: Math.max(0, Math.min(peakSec, durationSec - zoomEnd({ atSec: 0, ...PUNCH }))), ...PUNCH };
    if (inside(punch)) zooms.push(punch);
  }
  let quick = 0;
  for (const w of words) {
    if (quick >= MAX_QUICK_ZOOMS) break;
    const z = { atSec: Math.round(w.startSec * 100) / 100, ...QUICK };
    if (isHypeWord(w.word) && inside(z) && clear(z)) {
      zooms.push(z);
      quick++;
    }
  }
  return zooms.sort((a, b) => a.atSec - b.atSec);
}

/** loudnorm to the target: the second pass (linear gain) with the measured values, a single pass without them. */
export function loudnormFilter(measured: LoudnessMeasure | null): string {
  const m = measured
    ? `:measured_I=${measured.i}:measured_TP=${measured.tp}:measured_LRA=${measured.lra}:measured_thresh=${measured.thresh}:offset=${measured.offset}:linear=true`
    : "";
  return `aformat=channel_layouts=stereo,loudnorm=I=${TARGET_LUFS}:TP=${TARGET_TRUE_PEAK}:LRA=11${m}`;
}

export function audioFilter(normalize: boolean, measured: LoudnessMeasure | null): string {
  return normalize ? `${loudnormFilter(measured)},aresample=48000` : "aresample=48000";
}

export function planPolish(o: {
  effects: ClipEffects;
  durationSec: number;
  hook: string;
  /** Caption words in clip seconds. */
  words: Word[];
  /** Where the reaction peaks, in clip seconds. */
  peakSec: number | null;
  /** Mean grey difference between the first and the last frame (see LOOP_DIFF_LIMIT). */
  loopDiff: number;
  hasAudio: boolean;
  loudness: LoudnessMeasure | null;
}): PolishPlan {
  return {
    hookCard: o.effects.hookCard && o.hook.trim() !== "",
    zooms: o.effects.zoom ? planZooms(o.words, o.peakSec, o.durationSec) : [],
    loopFade: o.effects.loopEnding && o.loopDiff > LOOP_DIFF_LIMIT && o.durationSec > 2 * LOOP_FADE_SEC,
    progressBar: o.effects.progressBar,
    audio: o.hasAudio ? audioFilter(o.effects.loudness, o.loudness) : null,
  };
}

const n = (v: number) => String(Math.round(v * 1000) / 1000);
/** Smoothstep of (it - from) / len, in ffmpeg's expression language (`it` is the frame's time). */
const ease = (from: number, len: number) => `st(0,clip((it-${n(from)})/${n(len)},0,1))*ld(0)*(3-2*ld(0))`;

/** The zoom factor over time: 1 plus an eased bump per zoom. */
export function zoomExpr(zooms: Zoom[]): string {
  return `1${zooms.map((z) => `+${n(z.amount)}*(${ease(z.atSec, z.inSec)}-${ease(z.atSec + z.inSec + z.holdSec, z.outSec)})`).join("")}`;
}

/**
 * The end of the video filter graph: the laid-out 1080×1920 picture [inLabel] gets the zooms, then
 * the captions (which never zoom), the fade back into the opening frame and the progress bar on top.
 */
export function finishFilter(
  inLabel: string,
  outLabel: string,
  assFile: string | null,
  p: Pick<PolishPlan, "zooms" | "loopFade" | "progressBar">,
  durationSec: number,
): string {
  const parts: string[] = [];
  const chain: string[] = [];
  let cur = inLabel;
  const close = (label: string, tail: string[] = []) => {
    parts.push(`[${cur}]${[...chain.splice(0), ...tail].join(",")}[${label}]`);
    cur = label;
  };
  if (p.zooms.length > 0) {
    chain.push(
      `zoompan=z='${zoomExpr(p.zooms)}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${OUT_W}x${OUT_H}:fps=${OUT_FPS}`,
      "setsar=1",
    );
  }
  if (assFile) chain.push(`ass=${assFile}`);
  if (p.loopFade) {
    parts.push(`[${cur}]${[...chain.splice(0), "split"].join(",")}[fmain][ffirst]`);
    const frames = Math.ceil(durationSec * OUT_FPS) + OUT_FPS;
    parts.push(
      `[ffirst]trim=end_frame=1,loop=loop=${frames}:size=1,format=yuva420p,` +
        `fade=t=in:st=${n(durationSec - LOOP_FADE_SEC)}:d=${LOOP_FADE_SEC}:alpha=1[fstill]`,
    );
    parts.push(`[fmain][fstill]overlay=shortest=1[floop]`);
    cur = "floop";
  }
  if (p.progressBar) {
    if (chain.length > 0) close("fbase");
    parts.push(`color=c=0xFFE500:s=${OUT_W}x10:r=${OUT_FPS}[fbar]`);
    parts.push(`[${cur}][fbar]overlay=x='-w+w*t/${n(durationSec)}':y=0:shortest=1[fbarred]`);
    cur = "fbarred";
  }
  close(outLabel, ["format=yuv420p"]);
  return parts.join(";");
}
