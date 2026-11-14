import type { CaptionFix, ClipEffects, ClipFix, ClipQuality, QualityIssue, Word } from "../../../shared/types.js";
import { CLIP_MAX_SEC, CLIP_MIN_SEC } from "../../../shared/types.js";
import { run } from "../../tools/exec.js";
import { probeVideo, type VideoInfo } from "../../tools/ffmpeg.js";
import { copyProblems, UNSURE_CONFIDENCE } from "../accuracy/correct.js";
import { MAX_TRUE_PEAK, TARGET_LUFS } from "./plan.js";

// The automatic check after each render: plain ffmpeg detectors and arithmetic, no AI.

const OUT_W = 1080;
const OUT_H = 1920;
/** The apps' own buttons and text cover this much of a vertical video. */
const UNSAFE_RIGHT = OUT_W * 0.15;
const UNSAFE_BOTTOM = OUT_H * 0.2;
/** Rough width of a bold capital at size 1 (generous, so real text is never wider). */
const CHAR_WIDTH = 0.68;
const LINE_HEIGHT = 1.25;

const BLACK_SEC = 0.5;
const FROZEN_SEC = 0.5;
const SILENCE_SEC = 1.5;
/** How far from the target the loudness may land. */
const LUFS_TOLERANCE = 1;

/** A stretch of the clip, in clip seconds. */
export interface Span {
  startSec: number;
  endSec: number;
}

export interface Detected {
  black: Span[];
  frozen: Span[];
  silence: Span[];
  /** Integrated loudness and true peak; null when there is no sound to measure. */
  lufs: number | null;
  truePeak: number | null;
}

/** One pass over the finished clip with every detector; the findings land in the log. */
export function detectArgs(file: string, hasAudio: boolean): string[] {
  const args = [
    "-hide_banner", "-nostats", "-loglevel", "info", "-i", file,
    "-vf", `blackdetect=d=${BLACK_SEC}:pix_th=0.1,freezedetect=n=0.003:d=${FROZEN_SEC}`,
  ];
  if (hasAudio) args.push("-af", `silencedetect=n=-50dB:d=${SILENCE_SEC},ebur128=peak=true`);
  return [...args, "-f", "null", "-"];
}

function spans(log: string, start: RegExp, end: RegExp, durationSec: number): Span[] {
  const ends = [...log.matchAll(end)].map((m) => Number(m[1]));
  return [...log.matchAll(start)].map((m, i) => ({ startSec: Math.max(0, Number(m[1])), endSec: Math.min(durationSec, ends[i] ?? durationSec) }));
}

const overlaps = (a: Span, b: Span) => a.startSec < b.endSec && b.startSec < a.endSec;

/** Reads blackdetect, freezedetect, silencedetect and the ebur128 summary out of an ffmpeg log. */
export function parseDetected(log: string, durationSec: number): Detected {
  const black = spans(log, /black_start:([\d.]+)/g, /black_end:([\d.]+)/g, durationSec);
  const summary = log.slice(log.lastIndexOf("Summary:"));
  const lufs = Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1] ?? NaN);
  const peak = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(summary)?.[1] ?? NaN);
  return {
    black,
    // A black screen is also a frozen one; say it once.
    frozen: spans(log, /freeze_start: ([\d.]+)/g, /freeze_end: ([\d.]+)/g, durationSec).filter((f) => !black.some((b) => overlaps(f, b))),
    silence: spans(log, /silence_start: (-?[\d.]+)/g, /silence_end: ([\d.]+)/g, durationSec),
    // ebur128 reports -70 LUFS for pure silence.
    lufs: Number.isFinite(lufs) && lufs > -70 ? lufs : null,
    truePeak: Number.isFinite(peak) ? peak : null,
  };
}

interface AssStyle {
  size: number;
  alignment: number;
  marginL: number;
  marginR: number;
  marginV: number;
}

/**
 * Checks the burned-in text against the safe area (clear of the bottom 20% and the right 15%),
 * from the ASS file the render used. Returns the problem in plain words, or null.
 */
export function captionProblem(ass: string): string | null {
  const styles = new Map<string, AssStyle>();
  for (const line of ass.split("\n")) {
    if (line.startsWith("Style: ")) {
      const f = line.slice(7).split(",");
      styles.set(f[0]!, { size: Number(f[2]), alignment: Number(f[18]), marginL: Number(f[19]), marginR: Number(f[20]), marginV: Number(f[21]) });
    }
    if (!line.startsWith("Dialogue: ")) continue;
    const f = line.slice(10).split(",");
    const style = styles.get(f[3]!);
    if (!style) continue;
    const raw = f.slice(9).join(",");
    const isHook = f[3] === "Hook";
    const outside = isHook
      ? "The hook text is too long to fit on screen. Shorten it in Edit."
      : "The captions run outside the safe area (the apps cover the bottom 20% and the right 15%).";
    const size = Number(/\\fs(\d+)/.exec(raw)?.[1] ?? style.size);
    const words = raw.replace(/\{[^}]*\}/g, "").split(/\s+/).filter(Boolean);
    const room = OUT_W - style.marginL - style.marginR;
    const width = (text: string) => text.length * size * CHAR_WIDTH;
    if (style.marginR < UNSAFE_RIGHT || words.some((w) => width(w) > room)) return outside;
    const height = Math.ceil(width(words.join(" ")) / room) * size * LINE_HEIGHT;
    // Bottom-aligned text (1-3) grows up from its margin; top-aligned text (7-9) grows down.
    if (style.alignment <= 3 ? style.marginV < UNSAFE_BOTTOM || style.marginV + height > OUT_H : style.marginV + height > OUT_H - UNSAFE_BOTTOM) {
      return outside;
    }
  }
  return null;
}

const at = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
const len = (s: Span) => (s.endSec - s.startSec).toFixed(1);

/** One reason per kind of problem: "… for 1.0 s at 0:03.", or "… 3 times (3.4 s in all), first at 0:00." */
function stretch(what: string, list: Span[]): string {
  const first = list[0]!;
  if (list.length === 1) return `${what} for ${len(first)} s at ${at(first.startSec)}.`;
  const total = list.reduce((sum, s) => sum + s.endSec - s.startSec, 0);
  return `${what} ${list.length} times (${total.toFixed(1)} s in all), first at ${at(first.startSec)}.`;
}

/** More unsure caption words than this hold the clip for review. */
export const MAX_UNSURE_WORDS = 3;

/** The words on screen the speech-to-text was guessing at (the Studio marks them). */
export function unsureWords(words: Word[]): Word[] {
  return words.filter((w) => typeof w.confidence === "number" && w.confidence < UNSURE_CONFIDENCE);
}

/** The words, title and hook of a clip, for the caption accuracy check. */
export interface ClipText {
  words: Word[];
  title: string;
  hook: string;
  fixes?: CaptionFix[];
}

/** The caption accuracy check: too many unsure words, or a misheard word in the title or hook. */
export function accuracyIssues(t: ClipText): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const unsure = unsureWords(t.words);
  if (unsure.length > MAX_UNSURE_WORDS) {
    const list = [...new Set(unsure.map((w) => `“${w.word.replace(/[^\p{L}\p{N}'-]+$/u, "")}”`))].slice(0, 5).join(", ");
    issues.push({ code: "accuracy", reason: `${unsure.length} caption words may be misheard (${list}). Check them in the Studio before posting.` });
  }
  for (const [what, text] of [["title", t.title], ["hook", t.hook]] as const) {
    const problems = text ? copyProblems(text, t.words, t.fixes ?? []) : [];
    if (problems.length > 0) issues.push({ code: "accuracy", reason: `The ${what} may have a misheard word: ${problems.join("; ")}. Fix it in Edit.` });
  }
  return issues;
}

/** Turns the measurements into the list of problems, each with a plain reason. */
export function judgeQuality(o: { info: VideoInfo; detected: Detected; ass: string | null } & Partial<ClipText>): QualityIssue[] {
  const { info, detected: d } = o;
  const issues: QualityIssue[] = [];
  if (info.width !== OUT_W || info.height !== OUT_H) {
    issues.push({ code: "size", reason: `The video is ${info.width}×${info.height}, not ${OUT_W}×${OUT_H}.` });
  }
  if (info.durationSec < CLIP_MIN_SEC - 0.1 || info.durationSec > CLIP_MAX_SEC + 0.1) {
    issues.push({ code: "duration", reason: `The clip is ${info.durationSec.toFixed(1)} s long. It should be ${CLIP_MIN_SEC} to ${CLIP_MAX_SEC} s.` });
  }
  if (d.black.length > 0) issues.push({ code: "black", reason: stretch("Black screen", d.black) });
  if (d.frozen.length > 0) issues.push({ code: "frozen", reason: stretch("The picture freezes", d.frozen) });
  if (!info.hasAudio || d.lufs === null) {
    issues.push({ code: "silence", reason: "The clip has no sound." });
  } else {
    if (d.silence.length > 0) issues.push({ code: "silence", reason: stretch("No sound", d.silence) });
    if (Math.abs(d.lufs - TARGET_LUFS) > LUFS_TOLERANCE) {
      const how = d.lufs < TARGET_LUFS ? "too quiet" : "too loud";
      issues.push({ code: "loudness", reason: `The sound is ${how} (${d.lufs.toFixed(1)} LUFS, the target is ${TARGET_LUFS}).` });
    } else if (d.truePeak !== null && d.truePeak > MAX_TRUE_PEAK) {
      issues.push({ code: "loudness", reason: `The sound peaks too high (${d.truePeak.toFixed(1)} dB, the limit is ${MAX_TRUE_PEAK}).` });
    }
  }
  const captions = o.ass ? captionProblem(o.ass) : null;
  if (captions) issues.push({ code: "captions", reason: captions });
  if (o.words) issues.push(...accuracyIssues({ words: o.words, title: o.title ?? "", hook: o.hook ?? "", fixes: o.fixes }));
  return issues;
}

/**
 * The change that should clear the problems: trim to the longest part without black, frozen or
 * silent stretches (or to the longest allowed length), and turn loudness back on. Null when no
 * automatic change would help. `startSec` is where the clip starts in its master.
 */
export function suggestFix(o: { issues: QualityIssue[]; detected: Detected; startSec: number; durationSec: number; effects: ClipEffects }): ClipFix | null {
  const fix: ClipFix = { label: "" };
  const labels: string[] = [];
  const round = (v: number) => Math.round(v * 100) / 100;
  const bad = [...o.detected.black, ...o.detected.frozen, ...o.detected.silence].sort((a, b) => a.startSec - b.startSec);
  let clean: Span = { startSec: 0, endSec: 0 };
  let from = 0;
  for (const s of [...bad, { startSec: o.durationSec, endSec: o.durationSec }]) {
    if (s.startSec - from > clean.endSec - clean.startSec) clean = { startSec: from, endSec: s.startSec };
    from = Math.max(from, s.endSec);
  }
  if (clean.endSec - clean.startSec > CLIP_MAX_SEC) clean.endSec = clean.startSec + CLIP_MAX_SEC;
  const cleanSec = clean.endSec - clean.startSec;
  if (cleanSec >= CLIP_MIN_SEC && cleanSec < o.durationSec - 0.05) {
    fix.startSec = round(o.startSec + clean.startSec);
    fix.endSec = round(o.startSec + clean.endSec);
    labels.push(bad.length > 0 ? `trim to the clean ${cleanSec.toFixed(1)} s` : `shorten to ${CLIP_MAX_SEC} s`);
  }
  if (!o.effects.loudness && o.issues.some((i) => i.code === "loudness")) {
    fix.effects = { loudness: true };
    labels.push("even out the loudness");
  }
  if (labels.length === 0) return null;
  const label = labels.join(" and ");
  return { ...fix, label: label[0]!.toUpperCase() + label.slice(1) };
}

/** Runs the check on a finished clip. `ass` is the caption file it was rendered with. */
export async function checkQuality(
  file: string,
  o: { ass: string | null; effects: ClipEffects; startSec: number; signal?: AbortSignal; text?: ClipText },
): Promise<ClipQuality> {
  const info = await probeVideo(file, o.signal);
  const { stderr } = await run("ffmpeg", detectArgs(file, info.hasAudio), { signal: o.signal });
  const detected = parseDetected(stderr, info.durationSec);
  const issues = judgeQuality({ info, detected, ass: o.ass, ...o.text });
  return { issues, fix: suggestFix({ issues, detected, startSec: o.startSec, durationSec: info.durationSec, effects: o.effects }) };
}
