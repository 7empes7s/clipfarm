import type { Word } from "../../shared/types.js";
import { HOOK_PATTERN_LABELS, type HookPattern, MOMENT_TYPE_LABELS, type MomentType } from "../../shared/trends.js";
import { wordsIn } from "../pipeline/picks/sentences.js";
import type { RawPick } from "../pipeline/picks/types.js";
import { keywordMoment } from "./tags.js";

/** What is trending today, as the picker uses it. */
export interface TrendBoost {
  /** Points for a pick of the top moment type; weaker trends get their share of it. 0 is off. */
  weight: number;
  /** Today's top moment types; `share` is 1 for the first and less for the rest. */
  momentTypes: { type: MomentType; share: number }[];
  hookPatterns: { pattern: HookPattern; example: string }[];
}

/**
 * A small lift for picks whose moment type is trending today, read from the pick's title, hook and
 * the words said in it. The reason says so ("+trend: police chase"), so the reviewer sees why it moved up.
 */
export function applyTrendBoost(picks: RawPick[], words: Word[], boost: TrendBoost | null): RawPick[] {
  if (!boost || boost.weight <= 0) return picks;
  return picks.map((p) => {
    const said = wordsIn(words, p).map((w) => w.word).join(" ");
    const type = keywordMoment(`${p.title} ${p.hook} ${said}`);
    const trend = boost.momentTypes.find((m) => m.type === type);
    if (!trend) return p;
    const points = Math.max(1, Math.round(boost.weight * trend.share));
    return { ...p, score: Math.min(100, p.score + points), reason: `${p.reason} +trend: ${MOMENT_TYPE_LABELS[type].toLowerCase()}`.trim() };
  });
}

/** The title patterns winning today, as lines for the hook writer's prompt. */
export function trendHints(boost: TrendBoost | null): string[] {
  return (boost?.hookPatterns ?? []).map((h) => `${HOOK_PATTERN_LABELS[h.pattern]} (like "${h.example}")`);
}
