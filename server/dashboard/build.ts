import type {
  EngineReport,
  AccountCard,
  Clip,
  Dashboard,
  EarningsRow,
  ExperimentReport,
  ExperimentRow,
  Goal,
  Job,
  Post,
  RunningJob,
  Source,
  StageName,
  StageState,
  Vod,
  VodProgress,
} from "../../shared/types.js";
import { vodEngineLines } from "../engine/runs.js";
import { PERMISSION_KIND_LABELS, PLATFORM_LABELS } from "../../shared/types.js";
import type { CampaignSummary, Recommendation } from "../../shared/growth.js";
import { average, costPerApprovedClip, dayOf, etaSeconds, lastDays, round2, secondsPerReview, towards, weekStart } from "../../shared/metrics.js";

export interface DashboardInput {
  now: Date;
  clips: Clip[];
  posts: Post[];
  vods: Vod[];
  jobs: Job[];
  sources: Source[];
  accounts: AccountCard[];
  /** When each approve or reject (not undone) was made. */
  decisionTimes: string[];
  /** From the growth lab, so the dashboard and the Campaigns tab show the same numbers. */
  growth?: { campaigns: CampaignSummary[]; recommendations: Recommendation[] };
  /** Which engine handled a video's transcript and picks; left out, the cards say nothing about it. */
  engineReports?: (vodId: number) => EngineReport[];
}

const JOB_LABELS: Record<string, string> = {
  ingest: "Transcript",
  picks: "Picks",
  render: "Render",
  "live-segment": "Live segment",
  "render-clip": "New version",
  thumbnails: "Thumbnails",
  "demo-clips": "Demo clips",
  "demo-data": "Demo data",
  "engine-setup": "Engine setup",
};

/** The pipeline's job type for each stage of a VOD. */
const STAGE_JOBS: Record<StageName, string> = { transcript: "ingest", picks: "picks", render: "render" };

/** Targets from the charter's objectives. */
export const GOALS = { clipsPerHour: 10, minutesPerHour: 30, approvedShare: 0.5, secondsPerClip: 10 };

function secondsBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  return Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000));
}

/** When a post went (or goes) out. */
const postTime = (p: Post) => p.postedAt ?? p.scheduledAt;

/** One stage from its jobs: the latest try of a single job, or all clips' render jobs together. */
function stageOf(stage: StageName, jobs: Job[]): VodProgress["stages"][number] {
  if (jobs.length === 0) return { stage, state: "waiting", seconds: null, progress: 0 };
  const done = jobs.filter((j) => j.status === "done");
  const pending = jobs.filter((j) => j.status === "queued" || j.status === "running");
  let state: StageState;
  if (pending.length > 0) state = done.length > 0 || pending.some((j) => j.status === "running") ? "running" : "waiting";
  else state = done.length > 0 ? "done" : "failed";
  const times = done.map((j) => secondsBetween(j.startedAt, j.finishedAt));
  return {
    stage,
    state,
    seconds: state === "done" && times.every((t) => t !== null) ? times.reduce((a, t) => a! + t!, 0) : null,
    progress: (done.length + pending.reduce((sum, j) => sum + (j.status === "running" ? j.progress : 0), 0)) / jobs.length,
  };
}

export function vodProgress(vod: Vod, jobs: Job[], clips: Clip[], creatorName: string, engines: string[] = []): VodProgress {
  // Jobs come newest first. Transcript and picks: the latest try counts. Render: one job per pick,
  // so every render job queued after the latest picks run counts.
  const mine = jobs.filter((j) => j.vodId === vod.id);
  const latest = (type: string) => mine.find((j) => j.type === type);
  const picksJob = latest(STAGE_JOBS.picks);
  const renders = mine.filter((j) => j.type === STAGE_JOBS.render && (!picksJob || j.id > picksJob.id));
  // A stream recorded live has one job per segment that both transcribes and picks (its time is
  // counted once, under transcript); skipped segments do not count.
  const segments = mine.filter((j) => j.type === "live-segment" && j.status !== "cancelled");
  const live = stageOf("transcript", segments);
  const stages = segments.length
    ? [live, { ...live, stage: "picks" as const, seconds: live.seconds === null ? null : 0 }, stageOf("render", renders)]
    : [
        stageOf("transcript", [latest(STAGE_JOBS.transcript)].filter((j): j is Job => !!j)),
        stageOf("picks", picksJob ? [picksJob] : []),
        stageOf("render", renders),
      ];
  const made = clips.filter((c) => c.vodId === vod.id);
  const approved = made.filter((c) => c.status === "approved").length;
  return {
    vodId: vod.id,
    title: vod.title ?? vod.url,
    creatorName,
    durationSec: vod.durationSec,
    stages,
    clips: made.length,
    approved,
    approvedShare: made.length ? approved / made.length : null,
    createdAt: vod.createdAt,
    engines,
  };
}

export function goals(vods: VodProgress[], clips: Clip[], decisionTimes: string[]): Goal[] {
  const timed = vods.filter((v) => v.durationSec && v.durationSec > 0);
  const clipsPerHour = average(timed.filter((v) => v.clips > 0).map((v) => (v.clips * 3600) / v.durationSec!));
  const finished = timed.filter((v) => v.stages.every((s) => s.state === "done" && s.seconds !== null));
  const minutesPerHour = average(
    finished.map((v) => v.stages.reduce((sum, s) => sum + s.seconds!, 0) / 60 / (v.durationSec! / 3600)),
  );
  const fromVods = clips.filter((c) => c.vodId !== null);
  const pool = fromVods.length ? fromVods : clips;
  const approvedShare = pool.length ? pool.filter((c) => c.status === "approved").length / pool.length : null;
  const perClip = secondsPerReview(decisionTimes);
  const one = (n: number | null, unit: string) => (n === null ? "No data yet" : `${Math.round(n * 10) / 10} ${unit}`);
  return [
    {
      id: "clips-per-hour",
      objective: "O1",
      label: "Clips per hour of stream",
      now: one(clipsPerHour, "clips"),
      target: `${GOALS.clipsPerHour} or more`,
      value: towards(clipsPerHour, GOALS.clipsPerHour),
    },
    {
      id: "minutes-per-hour",
      objective: "O1",
      label: "Minutes per hour of stream",
      now: one(minutesPerHour, "min"),
      target: `under ${GOALS.minutesPerHour} min`,
      value: towards(minutesPerHour, GOALS.minutesPerHour, true),
    },
    {
      id: "approved-share",
      objective: "O1",
      label: "Clips approved",
      now: approvedShare === null ? "No data yet" : `${Math.round(approvedShare * 100)} %`,
      target: `${GOALS.approvedShare * 100} % or more`,
      value: towards(approvedShare, GOALS.approvedShare),
    },
    {
      id: "seconds-per-clip",
      objective: "O2",
      label: "Review time per clip",
      now: one(perClip, "s"),
      target: `under ${GOALS.secondsPerClip} s`,
      value: towards(perClip, GOALS.secondsPerClip, true),
    },
  ];
}

/** Earnings per campaign and platform: views, posts over the minimum, estimated pay, Whop status. */
export function earningsRows(posts: Post[], sources: Source[], now: Date): EarningsRow[] {
  const since = weekStart(now).getTime();
  const perms = new Map(sources.flatMap((s) => s.permissions.map((p) => [p.id, p] as const)));
  const rows = new Map<string, EarningsRow>();
  for (const p of posts) {
    // Experiment posts earn nothing and are never sent to Whop.
    if (p.status === "failed" || p.experiment) continue;
    const perm = perms.get(p.permissionId);
    const key = `${p.permissionId}:${p.platform}`;
    const campaign = p.campaignUrl
      ? `${p.creatorName} · ${new URL(p.campaignUrl).hostname.replace(/^www\./, "")}`
      : `${p.creatorName} · ${perm ? PERMISSION_KIND_LABELS[perm.kind] : "campaign"}`;
    const minViews = perm?.minViews ?? null;
    const row = rows.get(key) ?? {
      key,
      campaign,
      platform: p.platform,
      posts: 0,
      views: 0,
      minViews,
      overMinimum: 0,
      estimatedUsd: 0,
      weekUsd: 0,
      submitted: 0,
    };
    row.posts++;
    row.views += p.views ?? 0;
    if (p.views !== null && p.views > 0 && p.views >= (minViews ?? 0)) row.overMinimum++;
    row.estimatedUsd = round2(row.estimatedUsd + p.estimatedEarningsUsd);
    if (new Date(postTime(p)).getTime() >= since) row.weekUsd = round2(row.weekUsd + p.estimatedEarningsUsd);
    if (p.whopSubmittedAt) row.submitted++;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.estimatedUsd - a.estimatedUsd || a.campaign.localeCompare(b.campaign));
}

/**
 * What the platforms did to the experiment posts: totals, then per burner account and per creator.
 * Time to first claim is how long the earliest-claimed post was out before its claim.
 */
export function experimentReport(posts: Post[], accounts: AccountCard[]): ExperimentReport {
  const blank = (key: string, label: string): ExperimentRow => ({
    key,
    label,
    posts: 0,
    views: 0,
    claims: 0,
    removals: 0,
    strikes: 0,
    firstClaimSec: null,
    pausedReason: null,
  });
  const total = blank("all", "All experiment posts");
  const byAccount = new Map<string, ExperimentRow>();
  const byCreator = new Map<string, ExperimentRow>();
  const firstClaimAt = new Map<ExperimentRow, string>();
  const row = (rows: Map<string, ExperimentRow>, key: string, label: string) => {
    if (!rows.has(key)) rows.set(key, blank(key, label));
    return rows.get(key)!;
  };
  for (const p of posts) {
    if (!p.experiment || p.status === "failed") continue;
    const groups = [
      total,
      row(byAccount, p.accountId, `${p.accountName} · ${PLATFORM_LABELS[p.platform]}`),
      row(byCreator, String(p.sourceId), p.creatorName),
    ];
    for (const r of groups) {
      r.posts++;
      r.views += p.views ?? 0;
      if (p.flags.claim) r.claims++;
      if (p.flags.removal) r.removals++;
      if (p.flags.strike) r.strikes++;
      if (p.flags.claim && (!firstClaimAt.has(r) || p.flags.claim < firstClaimAt.get(r)!)) {
        firstClaimAt.set(r, p.flags.claim);
        r.firstClaimSec = secondsBetween(postTime(p), p.flags.claim);
      }
    }
  }
  for (const r of byAccount.values()) r.pausedReason = accounts.find((a) => a.accountId === r.key)?.account?.pausedReason ?? null;
  const sorted = (rows: Map<string, ExperimentRow>) => [...rows.values()].sort((a, b) => b.posts - a.posts || a.label.localeCompare(b.label));
  return { total, byAccount: sorted(byAccount), byCreator: sorted(byCreator) };
}

export function buildDashboard(input: DashboardInput): Dashboard {
  const { now, clips, posts, vods, jobs, sources, accounts } = input;
  const today = dayOf(now);
  const since = weekStart(now).getTime();
  const live = posts.filter((p) => p.status !== "failed");
  const postedToday = live.filter((p) => p.status === "posted" && dayOf(postTime(p)) === today);

  const accountViewsToday = accounts.flatMap((a) => a.viewsPerDay.filter((d) => d.date === today));
  const viewsTodayFrom = accountViewsToday.length > 0 ? "accounts" : "posts";
  const viewsToday =
    viewsTodayFrom === "accounts"
      ? accountViewsToday.reduce((s, d) => s + d.value, 0)
      : postedToday.reduce((s, p) => s + (p.views ?? 0), 0);

  const approvedClips = clips.filter((c) => c.status === "approved").length;
  const spend = vods.reduce((s, v) => s + (v.transcriptCostUsd ?? 0), 0);
  const costWeek = vods.filter((v) => new Date(v.createdAt).getTime() >= since).reduce((s, v) => s + (v.transcriptCostUsd ?? 0), 0);

  const vodTitle = (id: number | null) => {
    const v = vods.find((x) => x.id === id);
    return v ? (v.title ?? v.url) : null;
  };
  const running: RunningJob[] = jobs
    .filter((j) => j.status === "running" || j.status === "queued")
    .reverse()
    .map((j) => {
      const kind = JOB_LABELS[j.type] ?? "Job";
      const name = vodTitle(j.vodId) ?? clips.find((c) => c.id === j.clipId)?.title;
      return {
        jobId: j.id,
        label: name ? `${kind}: ${name}` : kind,
        progress: j.progress,
        message: j.status === "queued" ? "Waiting for the job before it" : j.message,
        etaSec: j.status === "running" ? etaSeconds(j.progress, j.startedAt, now) : null,
      };
    });

  // A week of daily numbers for the sparklines.
  const days = lastDays(now, 7);
  const perDay = (value: (day: string) => number) => days.map((date) => ({ date, value: round2(value(date)) }));
  const sent = live.filter((p) => p.status === "posted");
  const accountDays = accounts.flatMap((a) => a.viewsPerDay);
  const trends = {
    views: perDay((day) =>
      viewsTodayFrom === "accounts"
        ? accountDays.filter((d) => d.date === day).reduce((s, d) => s + d.value, 0)
        : sent.filter((p) => dayOf(postTime(p)) === day).reduce((s, p) => s + (p.views ?? 0), 0),
    ),
    clips: perDay((day) => clips.filter((c) => dayOf(c.createdAt) === day).length),
    earnings: perDay((day) => sent.filter((p) => !p.experiment && dayOf(postTime(p)) === day).reduce((s, p) => s + p.estimatedEarningsUsd, 0)),
  };

  const creator = (sourceId: number) => sources.find((s) => s.id === sourceId)?.creatorName ?? "Unknown creator";
  const progress = vods.slice(0, 10).map((v) => vodProgress(v, jobs, clips, creator(v.sourceId), vodEngineLines(input.engineReports?.(v.id) ?? [])));
  const rows = earningsRows(posts, sources, now);

  return {
    empty: clips.length === 0 && vods.length === 0 && posts.length === 0,
    demoLoaded: accounts.some((a) => a.demo),
    today: {
      waiting: clips.filter((c) => c.status === "pending").length,
      approved: clips.filter((c) => c.status === "approved" && c.postCount === 0).length,
      postedToday: postedToday.length,
      viewsToday,
      viewsTodayFrom,
      earningsWeekUsd: round2(rows.reduce((s, r) => s + r.weekUsd, 0)),
      costWeekUsd: Math.round(costWeek * 10000) / 10000,
      costPerApprovedClipUsd: costPerApprovedClip(spend, approvedClips),
    },
    trends,
    running,
    vods: progress,
    goals: goals(progress, clips, input.decisionTimes),
    earnings: {
      rows,
      weekUsd: round2(rows.reduce((s, r) => s + r.weekUsd, 0)),
      totalUsd: round2(rows.reduce((s, r) => s + r.estimatedUsd, 0)),
    },
    experiment: experimentReport(posts, accounts),
    growth: {
      campaigns: (input.growth?.campaigns ?? []).filter((c) => c.campaign.status === "running" || c.campaign.status === "paused"),
      recommendations: (input.growth?.recommendations ?? []).filter((r) => r.status === "open"),
    },
  };
}
