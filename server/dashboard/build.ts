import type {
  AccountCard,
  Clip,
  Dashboard,
  EarningsRow,
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
import { PERMISSION_KIND_LABELS } from "../../shared/types.js";
import { average, costPerApprovedClip, dayOf, etaSeconds, round2, secondsPerReview, towards, weekStart } from "../../shared/metrics.js";

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
}

const JOB_LABELS: Record<string, string> = {
  ingest: "Transcript",
  picks: "Picks",
  render: "Render",
  "render-clip": "New version",
  "demo-clips": "Demo clips",
  "demo-data": "Demo data",
};

/** The pipeline's job type for each stage of a VOD. */
const STAGE_JOBS: Record<StageName, string> = { transcript: "ingest", picks: "picks", render: "render" };

const STAGE_STATE: Record<Job["status"], StageState> = {
  queued: "waiting",
  running: "running",
  done: "done",
  failed: "failed",
  cancelled: "failed",
};

/** Targets from the charter's objectives. */
export const GOALS = { clipsPerHour: 10, minutesPerHour: 30, approvedShare: 0.5, secondsPerClip: 10 };

function secondsBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  return Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000));
}

/** When a post went (or goes) out. */
const postTime = (p: Post) => p.postedAt ?? p.scheduledAt;

export function vodProgress(vod: Vod, jobs: Job[], clips: Clip[], creatorName: string): VodProgress {
  const stages = (Object.keys(STAGE_JOBS) as StageName[]).map((stage) => {
    // Jobs come newest first: the latest try of each stage counts.
    const job = jobs.find((j) => j.vodId === vod.id && j.type === STAGE_JOBS[stage]);
    if (!job) return { stage, state: "waiting" as const, seconds: null, progress: 0 };
    return {
      stage,
      state: STAGE_STATE[job.status],
      seconds: job.status === "done" ? secondsBetween(job.startedAt, job.finishedAt) : null,
      progress: job.status === "done" ? 1 : job.progress,
    };
  });
  const mine = clips.filter((c) => c.vodId === vod.id);
  const approved = mine.filter((c) => c.status === "approved").length;
  return {
    vodId: vod.id,
    title: vod.title ?? vod.url,
    creatorName,
    durationSec: vod.durationSec,
    stages,
    clips: mine.length,
    approved,
    approvedShare: mine.length ? approved / mine.length : null,
    createdAt: vod.createdAt,
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
    if (p.status === "failed") continue;
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

  const creator = (sourceId: number) => sources.find((s) => s.id === sourceId)?.creatorName ?? "Unknown creator";
  const progress = vods.slice(0, 10).map((v) => vodProgress(v, jobs, clips, creator(v.sourceId)));
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
    running,
    vods: progress,
    goals: goals(progress, clips, input.decisionTimes),
    earnings: {
      rows,
      weekUsd: round2(rows.reduce((s, r) => s + r.weekUsd, 0)),
      totalUsd: round2(rows.reduce((s, r) => s + r.estimatedUsd, 0)),
    },
  };
}
