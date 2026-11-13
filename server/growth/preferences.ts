import type { GrowthDefaults } from "../../shared/growth.js";

/** How much a preferred length, and a favoured word, lift a pick's score. */
export const LENGTH_BOOST = 1.15;
export const WORD_BOOST = 1.1;

/**
 * The defaults learned from test campaigns, applied to a picker's proposals: a pick inside the
 * preferred length, or with a favoured word in its title or hook, is ranked higher (score capped at
 * 100). Nothing is dropped here: the charter gate still decides what may render.
 */
export function applyPreferences<T extends { startSec: number; endSec: number; title: string; hook: string; score: number }>(
  picks: T[],
  d: GrowthDefaults,
): T[] {
  const hasLength = d.clipMinSec !== null || d.clipMaxSec !== null;
  return picks.map((p) => {
    const sec = p.endSec - p.startSec;
    const text = `${p.title} ${p.hook}`.toLowerCase();
    let score = p.score;
    if (hasLength && sec >= (d.clipMinSec ?? 0) && sec <= (d.clipMaxSec ?? Infinity)) score *= LENGTH_BOOST;
    if (d.boostWords.some((w) => text.includes(w.toLowerCase()))) score *= WORD_BOOST;
    return score === p.score ? p : { ...p, score: Math.min(100, Math.round(score * 10) / 10) };
  });
}
