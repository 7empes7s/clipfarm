import type { PostingRules } from "../../shared/types.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function dayStart(t: number): number {
  return Math.floor(t / DAY) * DAY;
}

/**
 * The earliest time at or after `wanted` when an account can post again: at least
 * `minGapMinutes` away from each of its other posts and under `maxPerDay` posts that UTC day.
 * Keeps a launch-day burst from getting accounts flagged. `sameClip` holds the times the same clip
 * goes out on our other accounts: the post keeps the same distance from those (a minute at least),
 * so two accounts never carry one clip at the same time.
 */
export function nextFreeSlot(taken: Date[], wanted: Date, rules: PostingRules, sameClip: Date[] = []): Date {
  const gap = rules.minGapMinutes * MINUTE;
  const stagger = Math.max(gap, MINUTE);
  const times = taken.map((d) => d.getTime()).sort((a, b) => a - b);
  const others = sameClip.map((d) => d.getTime()).sort((a, b) => a - b);
  let t = wanted.getTime();
  // Each pass moves t forward past one conflict, so this ends within a pass per time plus the days.
  for (;;) {
    const day = dayStart(t);
    const sameDay = times.filter((x) => dayStart(x) === day).length;
    if (rules.maxPerDay > 0 && sameDay >= rules.maxPerDay) {
      t = day + DAY;
      continue;
    }
    const clash = times.find((x) => Math.abs(x - t) < gap);
    if (clash !== undefined) {
      t = clash + gap;
      continue;
    }
    const other = others.find((x) => Math.abs(x - t) < stagger);
    if (other === undefined) return new Date(t);
    t = other + stagger;
  }
}
