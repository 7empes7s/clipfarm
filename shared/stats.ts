// Pure statistics for comparing groups of posts. Views are heavy-tailed (a few posts take most of
// them), so nothing here assumes a bell curve: ranks (Mann-Whitney U) and resampling (bootstrap).
import type { Comparison } from "./growth.js";
import { median } from "./metrics.js";

/** Fewest posts per group before a difference is called. */
export const MIN_PER_GROUP = 5;

/** Standard normal CDF (Abramowitz-Stegun 7.1.26, accurate to about 1e-7). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * (Math.abs(z) / Math.SQRT2));
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp((-z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

export interface MannWhitney {
  /** Chance that a random post of `b` beats a random post of `a` (ties count half). */
  superiority: number;
  /** Two-sided, normal approximation with tie and continuity corrections. */
  pValue: number;
}

export function mannWhitney(a: number[], b: number[]): MannWhitney | null {
  const n1 = a.length;
  const n2 = b.length;
  if (n1 === 0 || n2 === 0) return null;
  const all = [...a.map((v) => ({ v, g: 0 })), ...b.map((v) => ({ v, g: 1 }))].sort((x, y) => x.v - y.v);
  // Average ranks over ties.
  let rankSumB = 0;
  let tieTerm = 0;
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j < all.length && all[j]!.v === all[i]!.v) j++;
    const rank = (i + 1 + j) / 2;
    const t = j - i;
    tieTerm += t * t * t - t;
    for (let k = i; k < j; k++) if (all[k]!.g === 1) rankSumB += rank;
    i = j;
  }
  const n = n1 + n2;
  const uB = rankSumB - (n2 * (n2 + 1)) / 2;
  const mean = (n1 * n2) / 2;
  const variance = ((n1 * n2) / 12) * (n + 1 - tieTerm / (n * (n - 1)));
  if (variance <= 0) return { superiority: 0.5, pValue: 1 };
  const z = Math.max(0, Math.abs(uB - mean) - 0.5) / Math.sqrt(variance);
  return { superiority: uB / (n1 * n2), pValue: Math.min(1, 2 * (1 - normalCdf(z))) };
}

/** A small seeded generator (mulberry32), so the same data always gives the same read. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 95 % range of median(b) / median(a), from resampling each group with replacement. */
export function bootstrapRatioRange(a: number[], b: number[], rounds = 2000, seed = 34): [number, number] | null {
  if (a.length < 2 || b.length < 2) return null;
  const rand = seeded(seed);
  const draw = (xs: number[]) => median(xs.map(() => xs[Math.floor(rand() * xs.length)]!))!;
  const ratios: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const base = draw(a);
    if (base > 0) ratios.push(draw(b) / base);
  }
  if (ratios.length < rounds / 2) return null;
  ratios.sort((x, y) => x - y);
  return [ratios[Math.floor(ratios.length * 0.025)]!, ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * 0.975))]!];
}

/**
 * Posts still needed (over both groups) before a difference this size could be called at 95 %
 * with 80 % power: Noether's sample size for the Mann-Whitney test. null when no difference shows.
 */
export function morePostsNeeded(superiority: number, have: number): number | null {
  const edge = Math.abs(superiority - 0.5);
  if (edge < 0.03) return null;
  const total = Math.ceil((1.96 + 0.8416) ** 2 / (3 * edge * edge));
  return Math.max(2, total - have);
}

export interface Group {
  label: string;
  values: number[];
}

/**
 * Compares two groups on a "higher is better" number and says it in plain words:
 * "B beats A by 2.1× (95% sure)" or "Not enough data yet: ~12 more posts needed".
 * A winner is called only when the rank test is under 5 % and the bootstrap range of the ratio
 * stays above 1, with at least MIN_PER_GROUP posts on each side.
 */
export function compareGroups(x: Group, y: Group): Comparison {
  const mx = median(x.values);
  const my = median(y.values);
  const [win, lose] = (my ?? -1) > (mx ?? -1) ? [y, x] : [x, y];
  const winner = { label: win.label, n: win.values.length, median: median(win.values) };
  const loser = { label: lose.label, n: lose.values.length, median: median(lose.values) };
  const test = mannWhitney(lose.values, win.values);
  const ratio = winner.median !== null && loser.median ? winner.median / loser.median : null;
  const ratioRange = bootstrapRatioRange(lose.values, win.values);
  const enough = winner.n >= MIN_PER_GROUP && loser.n >= MIN_PER_GROUP;
  const significant = enough && test !== null && test.pValue < 0.05 && ratioRange !== null && ratioRange[0] > 1 && ratio !== null;

  let text: string;
  let more: number | null = null;
  if (significant) {
    text = `${winner.label} beats ${loser.label} by ${ratio.toFixed(1)}× (${test.pValue < 0.01 ? 99 : 95}% sure)`;
  } else {
    const short = Math.max(0, MIN_PER_GROUP - winner.n) + Math.max(0, MIN_PER_GROUP - loser.n);
    const byPower = test ? morePostsNeeded(test.superiority, winner.n + loser.n) : null;
    more = short > 0 ? Math.max(short, byPower ?? 0) : byPower;
    text =
      more === null || more > 1000
        ? "Not enough data yet: no clear difference so far"
        : `Not enough data yet: ~${more} more posts needed`;
    if (more !== null && more > 1000) more = null;
  }
  return { winner, loser, significant, ratio, pValue: test?.pValue ?? null, ratioRange, morePostsNeeded: more, text };
}
