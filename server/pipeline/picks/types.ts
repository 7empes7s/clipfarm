import type { Chapter, EngineReport, PickFlags, Word } from "../../../shared/types.js";
import type { Signals } from "./signals.js";

export interface PickInput {
  title: string | null;
  durationSec: number;
  chapters: Chapter[];
  words: Word[];
  signals: Signals;
  creatorName: string;
  /** The campaign brief from the source's permission record. */
  briefRules: string;
  /** What the creator does not want clipped. */
  bannedContent: string;
  maxPicks: number;
  /** Title patterns winning today (from the trend radar), offered to whoever writes hooks and titles. */
  trendHints?: string[];
  /** The video these picks are for, so the engine can note which step did what; `add` on a live stream, where each segment adds to the last. */
  run?: { vodId: number; add?: boolean };
}

/** One line for a writer's prompt; null when the radar has nothing to offer. */
export function trendHintLine(input: PickInput): string | null {
  return input.trendHints?.length ? `Title patterns winning today (use one only when it fits this clip): ${input.trendHints.join("; ")}` : null;
}

/** What a picker proposes. Times are seconds in the VOD; they get snapped and checked afterwards. */
export interface RawPick {
  startSec: number;
  endSec: number;
  hook: string;
  title: string;
  score: number;
  reason: string;
  /** Gameplay center crop, or the full frame on a blurred background (when the whole screen matters). */
  layout: "center" | "full";
  flags: PickFlags;
}

export interface PickerResult {
  picks: RawPick[];
  costUsd: number;
  /** Which step ranked and which wrote the hooks, with the time each took. */
  report?: EngineReport;
}

/** Ranks highlight windows in a transcribed VOD. Real adapters call a paid LLM; tests use fakes. */
export interface Picker {
  readonly name: string;
  pick(input: PickInput, signal?: AbortSignal): Promise<PickerResult>;
}

export const NO_FLAGS: PickFlags = { spoiler: false, cutscene: false, ending: false, leak: false, breaksBrief: false };
