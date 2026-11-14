import {
  type BusinessBoard,
  type CampaignMoney,
  type CostLine,
  type DayPoint,
  GROUPS,
  type GroupBy,
  type GroupRow,
  type HealthBoard,
  type PostFacts,
  type QuotaRow,
  RANGES,
  type RangeId,
  type RiskRow,
  type StatsAvailability,
  bestClips,
  bestHooks,
  bestTimes,
  costPerApproved,
  funnelOf,
  groupPosts,
  perThousand,
  quotaLeft,
  sumKnown,
  totalsOf,
  usedInWindow,
} from "../../shared/business.js";
import { METRIC_KEYS, type PostMetrics } from "../../shared/growth.js";
import { dayOf, lastDays, round2 } from "../../shared/metrics.js";
import {
  type ChannelAccount,
  type Clip,
  type Job,
  PERMISSION_KIND_LABELS,
  PLATFORM_LABELS,
  PLATFORMS,
  type Platform,
  type Post,
  type Source,
  YOUTUBE_DAILY_UNITS,
} from "../../shared/types.js";
import { STATS_CAPABILITIES } from "../growth/platformStats.js";
import type { Payout, RecordedSpend } from "./repo.js";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** Posts a day each platform's posting API allows one account (a rolling 24 h). YouTube counts quota units instead. */
export const POST_LIMITS: Partial<Record<Platform, number>> = { instagram: 50, tiktok: 15, x: 17 };

/** Midnight UTC `days - 1` days before `now`: the start of a "today", "7 days" or "30 days" range. */
export function rangeStart(now: Date, range: RangeId): Date {
  const days = RANGES.find((r) => r.id === range)!.days;
  return new Date(`${lastDays(now, days)[0]}T00:00:00.000Z`);
}

export function parseRange(raw: unknown): RangeId {
  return RANGES.find((r) => r.id === raw)?.id ?? "7d";
}

const when = (p: Post) => p.postedAt ?? p.scheduledAt;

/** The campaign a post earns under: its campaign link, else its permission. */
export function campaignOf(p: Post, sources: Source[]): { key: string; label: string } {
  if (p.campaignUrl) {
    let host = p.campaignUrl;
    try {
      host = new URL(p.campaignUrl).hostname.replace(/^www\./, "");
    } catch {
      // A link that is not a URL is shown as it is.
    }
    return { key: String(p.permissionId), label: `${p.creatorName} · ${host}` };
  }
  const perm = sources.flatMap((s) => s.permissions).find((x) => x.id === p.permissionId);
  return { key: String(p.permissionId), label: `${p.creatorName} · ${perm ? PERMISSION_KIND_LABELS[perm.kind] : "permission"}` };
}

export interface BoardInput {
  now: Date;
  range: RangeId;
  clips: Clip[];
  posts: Post[];
  sources: Source[];
  metrics: Map<number, PostMetrics>;
  payouts: Payout[];
  spend: RecordedSpend;
  eurPerUsd: number;
  computeUsdPerHour: number;
  digest: { title: string; lines: string[] };
  demo: boolean;
  /** Workspace names by id ("Me" and each client); a missing one shows as "Me". */
  workspaceNames?: Map<number, string>;
}

/** One posted post with its numbers. Experiment posts (burner tests) earn nothing and stay out. */
export function postFacts(input: Pick<BoardInput, "clips" | "posts" | "sources" | "metrics" | "payouts" | "workspaceNames">): PostFacts[] {
  const clips = new Map(input.clips.map((c) => [c.id, c]));
  const workspaceOf = new Map(input.sources.map((s) => [s.id, input.workspaceNames?.get(s.workspaceId) ?? "Me"]));
  const paid = new Map(input.payouts.filter((p) => p.postId !== null && p.status === "paid").map((p) => [p.postId!, p.payoutUsd]));
  return input.posts
    .filter((p) => p.status === "posted" && !p.experiment)
    .map((p) => {
      const m = input.metrics.get(p.id);
      const campaign = campaignOf(p, input.sources);
      return {
        postId: p.id,
        clipId: p.clipId,
        clipTitle: p.clipTitle,
        hook: clips.get(p.clipId)?.hook ?? "",
        url: p.url,
        platform: p.platform,
        accountId: p.accountId,
        accountName: p.accountName,
        campaignKey: campaign.key,
        campaign: campaign.label,
        sourceName: p.creatorName,
        workspace: workspaceOf.get(p.sourceId) ?? "Me",
        postedAt: when(p),
        views: p.views,
        likes: m?.likes ?? null,
        comments: m?.comments ?? null,
        shares: m?.shares ?? null,
        followsGained: m?.followsGained ?? null,
        avgWatchPct: m?.avgWatchPct ?? null,
        earningsUsd: p.estimatedEarningsUsd,
        paidUsd: paid.get(p.id) ?? null,
      };
    });
}

/** Spend by kind; a provider clipfarm never calls is shown, but adds nothing. */
export function costLines(spend: RecordedSpend, eurPerUsd: number, computeUsdPerHour: number): CostLine[] {
  return [
    { label: "Transcripts (speech to text)", usd: round4(spend.transcriptsUsd), note: "Each paid transcript, as the service billed it." },
    { label: "Picks (OpenAI or Gemini)", usd: round4(spend.picksUsd), note: "Each round of AI picks." },
    { label: "Gemini (re-rank, thumbnails)", usd: round4(spend.geminiEur / eurPerUsd), note: "Every Gemini call, on the Google credit." },
    { label: "Server time", usd: round4((spend.jobSeconds / 3600) * computeUsdPerHour), note: "Hours of pipeline jobs at this server's hourly price." },
    { label: "Claude and ElevenLabs", usd: null, note: "clipfarm does not call them, so no spend is recorded." },
  ];
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

export function campaignMoney(posts: PostFacts[], payouts: Payout[]): CampaignMoney[] {
  const byPost = new Map(payouts.filter((p) => p.postId !== null).map((p) => [p.postId!, p]));
  return groupPosts(posts, "campaign").map((row) => {
    const mine = posts.filter((p) => p.campaignKey === row.key).map((p) => byPost.get(p.postId)).filter((p): p is Payout => !!p);
    return {
      key: row.key,
      label: row.label,
      posts: row.posts,
      views: row.views,
      viewsCounted: sumKnown(mine.map((p) => p.viewsCounted)),
      approved: mine.filter((p) => p.status === "approved" || p.status === "paid").length,
      rejected: mine.filter((p) => p.status === "rejected").length,
      earningsUsd: row.earningsUsd,
      paidUsd: row.paidUsd,
      perThousandUsd: row.perThousandUsd,
    };
  });
}

export function buildBoard(input: BoardInput): BusinessBoard {
  const { now, range } = input;
  const from = rangeStart(now, range);
  const inRange = (iso: string) => {
    const t = new Date(iso).getTime();
    return t >= from.getTime() && t <= now.getTime();
  };
  const posts = postFacts(input).filter((p) => inRange(p.postedAt));
  const clips = input.clips.filter((c) => inRange(c.createdAt));
  const paidPayout = new Set(input.payouts.filter((p) => p.status === "paid" && p.postId !== null).map((p) => p.postId));
  const funnel = funnelOf(
    clips,
    input.posts.filter((p) => !p.experiment).map((p) => ({ clipId: p.clipId, status: p.status, paid: !!p.whopPaidAt || paidPayout.has(p.id) })),
  );
  const totals = totalsOf(posts);
  const lines = costLines(input.spend, input.eurPerUsd, input.computeUsdPerHour);
  const costUsd = round4(sumKnown(lines.map((l) => l.usd)) ?? 0);
  const groups = Object.fromEntries(
    GROUPS.map((g) => [g.id, groupPosts(posts, g.id, g.id === "platform" ? (k) => PLATFORM_LABELS[k as Platform] ?? k : undefined)]),
  ) as Record<GroupBy, GroupRow[]>;
  const days: DayPoint[] = lastDays(now, RANGES.find((r) => r.id === range)!.days).map((date) => {
    const that = posts.filter((p) => dayOf(p.postedAt) === date);
    return { date, views: sumKnown(that.map((p) => p.views)), earningsUsd: round2(that.reduce((s, p) => s + p.earningsUsd, 0)), posts: that.length };
  });
  return {
    range,
    from: from.toISOString(),
    to: now.toISOString(),
    totals,
    funnel,
    money: {
      earningsUsd: totals.earningsUsd,
      paidUsd: totals.paidUsd,
      costUsd,
      costLines: lines,
      approvedClips: funnel.approved,
      costPerApprovedClipUsd: costPerApproved(costUsd, funnel.approved),
      profitUsd: round2(totals.earningsUsd - costUsd),
      perThousandUsd: perThousand(totals.earningsUsd, totals.views),
      byCampaign: campaignMoney(posts, input.payouts),
    },
    days,
    groups,
    bestClips: bestClips(posts),
    bestHooks: bestHooks(posts),
    bestTimes: bestTimes(posts),
    posts: posts.sort((a, b) => b.postedAt.localeCompare(a.postedAt)),
    digest: input.digest,
    demo: input.demo,
  };
}

// ---------------------------------------------------------------- health

const STEP_LABELS: Record<string, string> = {
  ingest: "Transcript",
  picks: "Picks",
  render: "Render",
  "live-segment": "Live segment",
  "render-clip": "New version",
  thumbnails: "Thumbnails",
  "hook-variants": "Hook variants",
};

export interface HealthInput {
  now: Date;
  jobs: Job[];
  posts: Post[];
  accounts: ChannelAccount[];
  payouts: Payout[];
  /** YouTube units used today per isolation group, with when they reset. */
  youtube: { groupName: string; used: number; resetsAt: string }[];
  /** The platforms whose stats API is connected, the calls made today and their last error. */
  stats: { platform: Platform; connected: boolean; callsToday: number; lastError: string | null }[];
  metrics: Map<number, PostMetrics>;
}

/** Which metrics a platform has actually given for any of our posts. */
function observedMetrics(platform: Platform, posts: Post[], metrics: Map<number, PostMetrics>): string[] {
  const seen = new Set<string>();
  for (const p of posts) {
    if (p.platform !== platform) continue;
    const m = metrics.get(p.id);
    if (!m) continue;
    for (const k of METRIC_KEYS) if (m[k] !== null && m[k] !== undefined) seen.add(k);
  }
  return METRIC_KEYS.filter((k) => seen.has(k));
}

const WARNING = /inauthentic|reused content|repetitive content|spam/i;

export function buildHealth(input: HealthInput): HealthBoard {
  const { now, jobs, posts } = input;
  const since = now.getTime() - 7 * DAY;
  const recent = jobs.filter((j) => new Date(j.createdAt).getTime() >= since);
  const failuresByStep = new Map<string, HealthBoard["failuresByStep"][number]>();
  for (const j of recent) {
    if (j.status !== "failed") continue;
    const step = STEP_LABELS[j.type] ?? j.type;
    const row = failuresByStep.get(step) ?? { step, failed: 0, lastError: null, lastAt: null };
    row.failed++;
    const at = j.finishedAt ?? j.updatedAt;
    if (!row.lastAt || at > row.lastAt) {
      row.lastAt = at;
      row.lastError = j.error;
    }
    failuresByStep.set(step, row);
  }

  const quotas: QuotaRow[] = input.youtube.map((y) => ({
    key: `youtube:${y.groupName}`,
    label: `${y.groupName} app`,
    platform: "youtube",
    unit: "API units",
    used: y.used,
    limit: YOUTUBE_DAILY_UNITS,
    left: quotaLeft(y.used, YOUTUBE_DAILY_UNITS),
    resetsAt: y.resetsAt,
  }));
  for (const a of input.accounts) {
    const limit = POST_LIMITS[a.platform];
    if (!limit || a.disabled) continue;
    const times = posts.filter((p) => p.accountId === a.id && p.status === "posted" && p.postedAt).map((p) => p.postedAt!);
    const used = usedInWindow(times, now, DAY);
    const oldest = times.filter((t) => new Date(t).getTime() > now.getTime() - DAY).sort()[0];
    quotas.push({
      key: `${a.platform}:${a.id}`,
      label: a.name,
      platform: a.platform,
      unit: "posts in 24 h",
      used,
      limit,
      left: quotaLeft(used, limit),
      resetsAt: oldest ? new Date(new Date(oldest).getTime() + DAY).toISOString() : null,
    });
  }

  const atRisk: RiskRow[] = [];
  for (const a of input.accounts) {
    if (a.pausedReason) atRisk.push({ key: `paused:${a.id}`, accountName: a.name, platform: a.platform, kind: "paused", reason: a.pausedReason, at: null, clipId: null });
    else if (a.health !== "healthy") {
      atRisk.push({ key: `health:${a.id}`, accountName: a.name, platform: a.platform, kind: "warning", reason: a.health === "banned" ? "Marked banned." : "Marked limited.", at: null, clipId: null });
    }
  }
  const monthAgo = now.getTime() - 30 * DAY;
  for (const p of posts) {
    for (const kind of ["strike", "claim", "removal"] as const) {
      const at = p.flags[kind];
      if (at && new Date(at).getTime() >= monthAgo) {
        atRisk.push({ key: `${kind}:${p.id}`, accountName: p.accountName, platform: p.platform, kind, reason: `A ${kind} on "${p.clipTitle}".`, at, clipId: p.clipId });
      }
    }
    const text = `${p.error ?? ""} ${p.note ?? ""}`;
    if (WARNING.test(text)) {
      atRisk.push({ key: `warning:${p.id}`, accountName: p.accountName, platform: p.platform, kind: "warning", reason: text.trim(), at: when(p), clipId: p.clipId });
    }
  }
  const postById = new Map(posts.map((p) => [p.id, p]));
  for (const r of input.payouts) {
    if (r.status !== "rejected") continue;
    const p = r.postId === null ? undefined : postById.get(r.postId);
    atRisk.push({
      key: `rejected:${r.url}`,
      accountName: p?.accountName ?? "Unknown account",
      platform: p?.platform ?? null,
      kind: "rejected",
      reason: r.reason ? `Rejected by the campaign: ${r.reason}` : "Rejected by the campaign (no reason given).",
      at: r.importedAt,
      clipId: p?.clipId ?? null,
    });
  }
  atRisk.sort((a, b) => (b.at ?? "9").localeCompare(a.at ?? "9"));

  const stats: StatsAvailability[] = PLATFORMS.map((platform) => {
    const s = input.stats.find((x) => x.platform === platform);
    const cap = STATS_CAPABILITIES[platform];
    const metrics = [...new Set([...observedMetrics(platform, posts, input.metrics), ...(s?.connected ? cap.metrics : [])])];
    return {
      platform,
      connected: !!s?.connected,
      metrics: METRIC_KEYS.filter((k) => metrics.includes(k)),
      callsToday: s?.callsToday ?? 0,
      callBudget: cap.callsPerDay,
      lastError: s?.lastError ?? null,
      note: s?.connected ? `Read from ${cap.api}.` : metrics.length ? "Read through the posting service." : "No stats source is connected.",
    };
  });

  return {
    runs: {
      total: recent.length,
      done: recent.filter((j) => j.status === "done").length,
      failed: recent.filter((j) => j.status === "failed").length,
      running: jobs.filter((j) => j.status === "running").length,
      queued: jobs.filter((j) => j.status === "queued").length,
    },
    failuresByStep: [...failuresByStep.values()].sort((a, b) => b.failed - a.failed || a.step.localeCompare(b.step)),
    queueLength: jobs.filter((j) => j.status === "queued" || j.status === "running").length,
    postingFailures: posts
      .filter((p) => p.status === "failed" && new Date(p.scheduledAt).getTime() >= since)
      .sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt))
      .slice(0, 20)
      .map((p) => ({ postId: p.id, clipId: p.clipId, clipTitle: p.clipTitle, platform: p.platform, accountName: p.accountName, error: p.error ?? "No reason given.", at: p.scheduledAt })),
    quotas,
    atRisk,
    stats,
  };
}

// ---------------------------------------------------------------- digest

/** The business half of the daily digest: what posted, what earned, what failed and what's next. */
export function digestLines(now: Date, posts: Post[], jobs: Job[], waitingReview: number): string[] {
  const start = new Date(`${dayOf(new Date(now.getTime() - DAY))}T00:00:00.000Z`).getTime();
  const end = start + DAY;
  const yesterday = (iso: string | null) => !!iso && new Date(iso).getTime() >= start && new Date(iso).getTime() < end;
  const posted = posts.filter((p) => p.status === "posted" && !p.experiment && yesterday(p.postedAt));
  const earned = round2(posted.reduce((s, p) => s + p.estimatedEarningsUsd, 0));
  const failedPosts = posts.filter((p) => p.status === "failed" && yesterday(p.scheduledAt)).length;
  const failedJobs = jobs.filter((j) => j.status === "failed" && yesterday(j.finishedAt ?? j.updatedAt)).length;
  const next = posts.filter((p) => p.status === "scheduled" && new Date(p.scheduledAt).getTime() >= now.getTime() && new Date(p.scheduledAt).getTime() < now.getTime() + DAY).length;
  const platforms = [...new Set(posted.map((p) => PLATFORM_LABELS[p.platform]))].join(", ");
  return [
    posted.length ? `Posted: ${posted.length} clip${posted.length === 1 ? "" : "s"} (${platforms})` : "Posted: nothing yesterday",
    `Earned so far on them: $${earned.toFixed(2)} (estimate)`,
    failedPosts + failedJobs ? `Failed: ${failedPosts} post${failedPosts === 1 ? "" : "s"}, ${failedJobs} pipeline job${failedJobs === 1 ? "" : "s"}` : "Failed: nothing",
    `Next: ${next} post${next === 1 ? "" : "s"} in the next 24 h, ${waitingReview} clip${waitingReview === 1 ? "" : "s"} waiting for review`,
  ];
}
