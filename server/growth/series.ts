import { METRIC_KEYS, NO_METRICS, type PostMetrics, STAT_OFFSETS, type StatOffset } from "../../shared/growth.js";

/**
 * Which kept age a reading belongs to: the latest offset the post has passed, as long as the
 * reading is not too late for it (an hour, or a quarter of the offset, whichever is longer).
 * A reading at 1.4 h is the 1 h point; one at 5 h is none (too late for 1 h, too early for 6 h).
 * The real age is stored with the point, so views per hour stay exact.
 */
export function offsetFor(ageHours: number): StatOffset | null {
  const passed = STAT_OFFSETS.filter((o) => ageHours >= o.hours).at(-1);
  if (!passed) return null;
  return ageHours <= passed.hours + Math.max(1, passed.hours * 0.25) ? passed.key : null;
}

/** Fresh numbers over the ones already known; what the platform left out keeps its last value (or stays null). */
export function mergeMetrics(base: PostMetrics, fresh: Partial<PostMetrics>): PostMetrics {
  const out = { ...base };
  for (const k of METRIC_KEYS) {
    const v = fresh[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

export function parseMetrics(json: string | null): PostMetrics {
  return json ? mergeMetrics(NO_METRICS, JSON.parse(json) as Partial<PostMetrics>) : { ...NO_METRICS };
}
