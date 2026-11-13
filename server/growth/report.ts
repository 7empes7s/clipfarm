import {
  type CampaignComparison,
  type CampaignProgress,
  type CampaignReport,
  type ChartSeries,
  type Comparison,
  type GrowthCampaign,
  type GrowthDefaults,
  type Kpis,
  type PostMetrics,
  type Recommendation,
  type ReportPost,
  STAT_OFFSETS,
  type StatPoint,
  SUCCESS_METRIC_LABELS,
  type SuccessMetric,
  type Variant,
} from "../../shared/growth.js";
import { average, dayOf, median, round2 } from "../../shared/metrics.js";
import { compareGroups } from "../../shared/stats.js";
import { type Platform, PLATFORM_LABELS, type Post } from "../../shared/types.js";

const DAY = 24 * 3600_000;

/** One post of a campaign with everything a report needs. */
export interface ReportRow {
  post: Post;
  variantKey: string;
  series: StatPoint[];
  /** The latest reading. */
  metrics: PostMetrics;
  /** What the clip cost to make (AI and compute); null when it was not recorded. */
  clipCostUsd: number | null;
}

const METRIC_AT: Record<SuccessMetric, { offset: StatPoint["offset"]; perHour: boolean }> = {
  vph24: { offset: "24h", perHour: true },
  vph72: { offset: "72h", perHour: true },
  views7d: { offset: "7d", perHour: false },
};

/** A post's success metric, or null while it is too young (or its views were never given). */
export function metricValue(metric: SuccessMetric, series: StatPoint[]): number | null {
  const { offset, perHour } = METRIC_AT[metric];
  const point = series.find((p) => p.offset === offset);
  if (!point || point.views === null) return null;
  return perHour ? point.views / point.ageHours : point.views;
}

/** Posts whose success metric is still to come: not out yet, or too young for it. */
export function awaitingMetric(rows: ReportRow[], metric: SuccessMetric, now: Date): number {
  const hours = STAT_OFFSETS.find((o) => o.key === METRIC_AT[metric].offset)!.hours;
  // Past the offset plus the window a reading may be late by, the number will never come.
  const lastChance = (hours + Math.max(1, hours * 0.25)) * 3600_000;
  return rows.filter((r) => {
    if (r.post.status === "scheduled") return true;
    if (r.post.status !== "posted" || metricValue(metric, r.series) !== null) return false;
    return now.getTime() - new Date(r.post.postedAt ?? r.post.scheduledAt).getTime() <= lastChance;
  }).length;
}

const known = (values: (number | null)[]): number[] => values.filter((v): v is number => v !== null);
/** Adds up what is known; null when nothing is, so a tile says "not available" instead of 0. */
const sumKnown = (values: (number | null)[]): number | null => (known(values).length ? known(values).reduce((s, v) => s + v, 0) : null);

export function kpis(rows: ReportRow[], metric: SuccessMetric): Kpis {
  const out = rows.filter((r) => r.post.status === "posted");
  const measured = known(out.map((r) => metricValue(metric, r.series)));
  const totalViews = sumKnown(out.map((r) => r.post.views));
  const watch = average(known(out.map((r) => r.metrics.avgWatchPct)));
  // A clip posted on three accounts was still made once.
  const clipCosts = new Map(out.map((r) => [r.post.clipId, r.clipCostUsd]));
  const costUsd = sumKnown([...clipCosts.values()]);
  const earnings = out.reduce((s, r) => s + r.post.estimatedEarningsUsd + (r.metrics.revenueUsd ?? 0), 0);
  return {
    posts: out.length,
    scheduled: rows.filter((r) => r.post.status === "scheduled").length,
    totalViews,
    medianMetric: median(measured),
    measured: measured.length,
    avgWatchPct: watch === null ? null : Math.round(watch * 10) / 10,
    followsGained: sumKnown(out.map((r) => r.metrics.followsGained)),
    earningsUsd: round2(earnings),
    costUsd: costUsd === null ? null : Math.round(costUsd * 10000) / 10000,
    costPer1kViewsUsd: costUsd !== null && totalViews ? Math.round((costUsd / (totalViews / 1000)) * 10000) / 10000 : null,
  };
}

/** The most views a post was known to have by `t`. */
function viewsBy(row: ReportRow, t: number): number | null {
  const seen = row.series.filter((p) => p.views !== null && new Date(p.at).getTime() <= t).map((p) => p.views!);
  const { views, viewsUpdatedAt } = row.post;
  if (views !== null && viewsUpdatedAt && new Date(viewsUpdatedAt).getTime() <= t) seen.push(views);
  return seen.length ? Math.max(...seen) : null;
}

/** Views gained on one UTC day over the given posts, and the post that gained most; null without readings. */
export function viewsGainedOn(day: string, rows: ReportRow[]): { views: number; best: { title: string; views: number } | null } | null {
  const start = new Date(`${day}T00:00:00.000Z`).getTime();
  let total: number | null = null;
  let best: { title: string; views: number } | null = null;
  for (const r of rows) {
    const end = viewsBy(r, start + DAY - 1);
    if (end === null) continue;
    const gained = Math.max(0, end - (viewsBy(r, start - 1) ?? 0));
    total = (total ?? 0) + gained;
    if (gained > 0 && (!best || gained > best.views)) best = { title: r.post.clipTitle, views: gained };
  }
  return total === null ? null : { views: total, best };
}

/** Total views so far at the end of each day of the run, one line per variant. */
export function viewsChart(campaign: GrowthCampaign, rows: ReportRow[], now: Date): ChartSeries[] {
  const posted = rows.filter((r) => r.post.status === "posted");
  const starts = [campaign.startedAt, ...posted.map((r) => r.post.postedAt ?? r.post.scheduledAt)].filter((t): t is string => !!t).sort();
  if (starts.length === 0 || posted.every((r) => r.post.views === null && r.series.every((p) => p.views === null))) return [];
  const first = new Date(`${dayOf(starts[0]!)}T00:00:00.000Z`).getTime();
  const last = new Date(`${dayOf(now)}T00:00:00.000Z`).getTime();
  const days: number[] = [];
  for (let d = Math.max(first, last - 59 * DAY); d <= last; d += DAY) days.push(d);
  return campaign.variants.map((v) => {
    const mine = posted.filter((r) => r.variantKey === v.key);
    return {
      key: v.key,
      label: v.label,
      points: days.map((d) => ({
        date: dayOf(new Date(d)),
        value: mine.reduce((s, r) => s + (viewsBy(r, Math.min(d + DAY - 1, now.getTime())) ?? 0), 0),
      })),
    };
  });
}

export function progressOf(campaign: GrowthCampaign, rows: ReportRow[], now: Date): CampaignProgress {
  const day = campaign.startedAt
    ? Math.min(campaign.durationDays, Math.floor((now.getTime() - new Date(campaign.startedAt).getTime()) / DAY) + 1)
    : 0;
  return {
    day: Math.max(0, day),
    days: campaign.durationDays,
    posts: rows.filter((r) => r.post.status !== "failed").length,
    planned: campaign.accountIds.length * campaign.postsPerDay * campaign.durationDays,
  };
}

function values(rows: ReportRow[], metric: SuccessMetric): number[] {
  return known(rows.filter((r) => r.post.status === "posted").map((r) => metricValue(metric, r.series)));
}

/** The best variant against each of the others. */
export function variantComparisons(campaign: GrowthCampaign, rows: ReportRow[]): { best: Variant | null; comparisons: Comparison[] } {
  const groups = campaign.variants.map((v) => ({ variant: v, label: v.label, values: values(rows.filter((r) => r.variantKey === v.key), campaign.metric) }));
  const ranked = groups.filter((g) => g.values.length > 0).sort((a, b) => median(b.values)! - median(a.values)!);
  if (groups.length < 2 || ranked.length === 0) return { best: null, comparisons: [] };
  const best = ranked[0]!;
  return { best: best.variant, comparisons: groups.filter((g) => g !== best).map((g) => compareGroups(g, best)) };
}

const quote = (words: string[]) => words.map((w) => `"${w}"`).join(", ");

export function lengthText(v: Pick<Variant, "minSec" | "maxSec">): string {
  if (v.minSec !== null && v.maxSec !== null) return `${v.minSec}-${v.maxSec} s`;
  return v.minSec !== null ? `${v.minSec} s or longer` : `up to ${v.maxSec} s`;
}

export interface ProposedChange {
  variantKey: string;
  text: string;
  detail: string;
  change: Partial<GrowthDefaults>;
}

/** A change of defaults, offered only when one variant beat every other one for sure. */
export function recommendationFor(campaign: GrowthCampaign, rows: ReportRow[], platforms: Platform[]): ProposedChange | null {
  const { best, comparisons } = variantComparisons(campaign, rows);
  if (!best || comparisons.length === 0 || !comparisons.every((c) => c.significant && c.winner.label === best.label)) return null;
  let text: string;
  let change: Partial<GrowthDefaults>;
  if (campaign.variable === "length") {
    if (best.minSec === null && best.maxSec === null) return null;
    text = `Make ${lengthText(best)} the default clip length`;
    change = { clipMinSec: best.minSec, clipMaxSec: best.maxSec };
  } else if (campaign.variable === "time") {
    if (best.times.length === 0) return null;
    text = `Post at ${best.times.join(", ")} UTC by default`;
    change = { postTimes: best.times };
  } else {
    if (best.words.length === 0) return null;
    text = campaign.variable === "hook" ? `Favour hooks with ${quote(best.words)} when picking clips` : `Favour ${quote(best.words)} clips when picking`;
    change = { boostWords: best.words };
  }
  const n = comparisons[0]!.winner.n + comparisons.reduce((s, c) => s + c.loser.n, 0);
  const where = platforms.length ? ` on ${platforms.map((p) => PLATFORM_LABELS[p]).join(", ")}` : "";
  return { variantKey: best.key, text, detail: `${comparisons.map((c) => c.text).join(". ")}. Measured${where} over ${n} posts.`, change };
}

function reportPost(row: ReportRow, campaign: GrowthCampaign): ReportPost {
  return {
    postId: row.post.id,
    clipTitle: row.post.clipTitle,
    accountName: row.post.accountName,
    platform: row.post.platform,
    url: row.post.url,
    variantLabel: campaign.variants.find((v) => v.key === row.variantKey)?.label ?? row.variantKey,
    views: row.post.views,
    metric: metricValue(campaign.metric, row.series),
  };
}

export function buildReport(campaign: GrowthCampaign, rows: ReportRow[], now: Date, recommendation: Recommendation | null): CampaignReport {
  const posted = rows.filter((r) => r.post.status === "posted").map((r) => reportPost(r, campaign));
  // Ranked by the success metric once any post is old enough for it, by views until then.
  const by: "metric" | "views" = posted.some((p) => p.metric !== null) ? "metric" : "views";
  const ranked = posted.filter((p) => p[by] !== null).sort((a, b) => b[by]! - a[by]!);
  const top = ranked.slice(0, 5);
  return {
    campaign,
    metricLabel: SUCCESS_METRIC_LABELS[campaign.metric],
    platforms: [...new Set(rows.map((r) => r.post.platform))],
    progress: progressOf(campaign, rows, now),
    kpis: kpis(rows, campaign.metric),
    variants: campaign.variants.map((v) => ({ key: v.key, label: v.label, ...kpis(rows.filter((r) => r.variantKey === v.key), campaign.metric) })),
    chart: viewsChart(campaign, rows, now),
    comparisons: variantComparisons(campaign, rows).comparisons,
    top,
    bottom: ranked.slice(Math.max(top.length, ranked.length - 5)).reverse(),
    recommendation,
  };
}

/** Two or more campaigns side by side on one success metric: the best against each of the others. */
export function compareCampaigns(items: { campaign: GrowthCampaign; rows: ReportRow[] }[]): CampaignComparison {
  const metric = items[0]?.campaign.metric ?? "vph24";
  const groups = items.map((i) => ({ label: i.campaign.name, values: values(i.rows, metric) }));
  const best = [...groups].filter((g) => g.values.length > 0).sort((a, b) => median(b.values)! - median(a.values)!)[0];
  return {
    metricLabel: SUCCESS_METRIC_LABELS[metric],
    rows: items.map((i) => ({ id: i.campaign.id, name: i.campaign.name, kpis: kpis(i.rows, metric) })),
    comparisons: best ? groups.filter((g) => g !== best).map((g) => compareGroups(g, best)) : [],
  };
}

function csvCell(v: string | number | null): string {
  // An empty cell is a number the platform did not give: never a made-up 0.
  if (v === null) return "";
  const s = String(v);
  // A leading =, +, - or @ would run as a formula in a spreadsheet.
  const safe = typeof v === "string" && /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** One line per post, with every kept age of its views. */
export function toCsv(campaign: GrowthCampaign, rows: ReportRow[]): string {
  const head = [
    "post_id", "clip", "creator", "account", "platform", "variant", "status", "posted_at", "url", "views_latest",
    ...STAT_OFFSETS.map((o) => `views_${o.key}`),
    "views_per_hour_24h", "likes", "comments", "shares", "saves", "reach", "avg_watch_pct", "follows_gained",
    "estimated_earnings_usd", "clip_cost_usd",
  ];
  const lines = rows.map((r) => {
    const at = (key: string) => r.series.find((p) => p.offset === key)?.views ?? null;
    const vph = metricValue("vph24", r.series);
    const m = r.metrics;
    return [
      r.post.id, r.post.clipTitle, r.post.creatorName, r.post.accountName, r.post.platform,
      campaign.variants.find((v) => v.key === r.variantKey)?.label ?? r.variantKey,
      r.post.status, r.post.postedAt, r.post.url, r.post.views,
      ...STAT_OFFSETS.map((o) => at(o.key)),
      vph === null ? null : Math.round(vph * 10) / 10,
      m.likes, m.comments, m.shares, m.saves, m.reach, m.avgWatchPct, m.followsGained,
      round2(r.post.estimatedEarningsUsd + (m.revenueUsd ?? 0)), r.clipCostUsd,
    ].map(csvCell).join(",");
  });
  return [head.join(","), ...lines].join("\n") + "\n";
}
