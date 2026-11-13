// Pure maths for the dashboard: no I/O, the same on the server and in the client.
import type { DailyPoint, Growth } from "./types.js";

const DAY_MS = 24 * 3600_000;

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** YYYY-MM-DD (UTC) of a date. */
export function dayOf(d: Date | string): string {
  return (typeof d === "string" ? new Date(d) : d).toISOString().slice(0, 10);
}

/** The last `n` days (YYYY-MM-DD, UTC), oldest first, ending on the day of `now`. */
export function lastDays(now: Date, n: number): string[] {
  return Array.from({ length: n }, (_, i) => dayOf(new Date(now.getTime() - (n - 1 - i) * DAY_MS)));
}

/** Monday 00:00 UTC of the week `now` is in. */
export function weekStart(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - sinceMonday * DAY_MS);
}

/** Change from the first to the last point of a series; null with fewer than two points. */
export function growth(series: DailyPoint[]): Growth | null {
  if (series.length < 2) return null;
  const first = series[0]!.value;
  const change = series.at(-1)!.value - first;
  return { change, pct: first === 0 ? null : change / first };
}

export function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Spend divided by approved clips, to 4 decimals; null before the first approval. */
export function costPerApprovedClip(spendUsd: number, approvedClips: number): number | null {
  return approvedClips > 0 ? Math.round((spendUsd / approvedClips) * 10000) / 10000 : null;
}

/** Seconds left for a job, from how long it has run and how far it got; null while under 5 %. */
export function etaSeconds(progress: number, startedAt: string | null, now: Date): number | null {
  if (!startedAt || progress < 0.05 || progress >= 1) return null;
  const elapsed = (now.getTime() - new Date(startedAt).getTime()) / 1000;
  if (elapsed <= 0) return null;
  return Math.round((elapsed * (1 - progress)) / progress);
}

/**
 * Typical seconds spent per clip in review: the median gap between one decision and the next.
 * Gaps over `breakSec` are breaks between sessions, not review time, and are left out.
 */
export function secondsPerReview(decidedAt: string[], breakSec = 120): number | null {
  const times = decidedAt.map((t) => new Date(t).getTime()).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) {
    const gap = (times[i]! - times[i - 1]!) / 1000;
    if (gap > 0 && gap <= breakSec) gaps.push(gap);
  }
  return median(gaps);
}

/**
 * Merges freshly read daily points into the stored ones: a fresh value replaces the stored value of
 * the same day, and only the last `keepDays` days (counted back from the newest point) are kept.
 */
export function mergeSeries(stored: DailyPoint[], fresh: DailyPoint[], keepDays = 90): DailyPoint[] {
  const byDate = new Map(stored.map((p) => [p.date, p.value]));
  for (const p of fresh) byDate.set(p.date, p.value);
  const merged = [...byDate].map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date));
  if (merged.length === 0) return merged;
  const newest = new Date(`${merged.at(-1)!.date}T00:00:00Z`).getTime();
  return merged.filter((p) => newest - new Date(`${p.date}T00:00:00Z`).getTime() < keepDays * DAY_MS);
}

/** Share of `target` reached, capped at 1. For "lower is better" targets pass `lowerIsBetter`. */
export function towards(actual: number | null, target: number, lowerIsBetter = false): number | null {
  if (actual === null) return null;
  if (lowerIsBetter) return actual <= 0 ? 1 : Math.min(1, target / actual);
  return Math.max(0, Math.min(1, actual / target));
}
