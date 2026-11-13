import type { EngineReport, WatchedCreator } from "../../shared/types.js";
import { LIVE_TARGET_LATENCY_SEC } from "../../shared/types.js";
import type { LaunchReadiness, ProofCheck, ProofDay, ProofMetrics, ProofProblem, ProofRun } from "../../shared/proof.js";
import { PROOF_CLIPS_PER_HOUR, PROOF_MIN_PER_HOUR } from "../../shared/proof.js";
import { mergeUses } from "../engine/runs.js";

export const EMPTY_METRICS: ProofMetrics = {
  vodSec: null,
  firstClipMin: null,
  allClipsMin: null,
  clips: 0,
  qualityChecked: 0,
  qualityPassed: 0,
  engine: "",
  costUsd: 0,
  ramPeakMb: null,
  firstLatencySec: null,
  worstLatencySec: null,
  segments: 0,
  dropped: 0,
};

/** GTA V and GTA RP as titles and categories name them ("GTA VI" matches none of these). */
export const GTA_PROOF_GAMES = ["GTA V", "GTA 5", "Grand Theft Auto V", "Grand Theft Auto 5", "GTA RP", "GTA Online", "NoPixel"];

/** "2h 5m", "41 min", "20 s". */
export function span(sec: number): string {
  const s = Math.round(sec);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

const minutes = (min: number) => (min < 1 ? "under 1 min" : `${Math.round(min)} min`);

/**
 * O1's targets for one video: 30 minutes and 10 clips per hour of video. A video shorter than an
 * hour gets the full 30 minutes (start-up time does not shrink with it) and at least one clip.
 */
export function vodTargets(vodSec: number): { budgetMin: number; wantClips: number } {
  const hours = vodSec / 3600;
  return { budgetMin: PROOF_MIN_PER_HOUR * Math.max(1, hours), wantClips: Math.max(1, Math.floor(PROOF_CLIPS_PER_HOUR * hours)) };
}

/** How many moments the proof asks the picker for: enough to meet the target after the rules leave some out. */
export function proofMaxPicks(vodSec: number | null, usual: number): number {
  return vodSec === null ? usual : Math.max(usual, Math.ceil(vodTargets(vodSec).wantClips * 1.3));
}

/** What a finished video run missed against O1; empty when it met both targets. */
export function judgeVod(m: ProofMetrics, detail: { slowestStep?: string; leftOut?: number; failedCuts?: number } = {}): ProofProblem[] {
  if (m.vodSec === null || m.allClipsMin === null) return [];
  const { budgetMin, wantClips } = vodTargets(m.vodSec);
  const problems: ProofProblem[] = [];
  if (m.allClipsMin > budgetMin) {
    problems.push({
      kind: "slow",
      text: `Too slow: ${minutes(m.allClipsMin)} for a ${span(m.vodSec)} video; the target is under ${minutes(budgetMin)}.${detail.slowestStep ? ` The slowest step was ${detail.slowestStep}.` : ""}`,
    });
  }
  if (m.clips < wantClips) {
    const why = [
      ...(detail.leftOut ? [`${detail.leftOut} picked ${detail.leftOut === 1 ? "moment was" : "moments were"} left out by the rules`] : []),
      ...(detail.failedCuts ? [`${detail.failedCuts} could not be cut`] : []),
    ];
    problems.push({
      kind: "few",
      text: `Too few clips: ${m.clips} from a ${span(m.vodSec)} video; the target is at least ${wantClips}. ${why.length ? `${why.join(", ")}.` : "The picking step found too few moments."}`,
    });
  }
  return problems;
}

const usd = (n: number) => (n > 0 && n < 0.01 ? "under $0.01" : `$${n.toFixed(2)}`);
const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;

/** A video run's numbers against their targets, for the Proof card and the ops command. */
export function vodChecks(m: ProofMetrics, reviewed: { approved: number; rejected: number }): ProofCheck[] {
  const t = m.vodSec === null ? null : vodTargets(m.vodSec);
  const swiped = reviewed.approved + reviewed.rejected;
  return [
    { label: "Video length", value: m.vodSec === null ? "Not known yet" : span(m.vodSec), target: "", ok: null },
    { label: "Clips", value: String(m.clips), target: t ? `at least ${t.wantClips}` : "10 per hour", ok: t && m.allClipsMin !== null ? m.clips >= t.wantClips : null },
    {
      label: "Time to all clips",
      value: m.allClipsMin === null ? "Not done yet" : minutes(m.allClipsMin),
      target: t ? `under ${minutes(t.budgetMin)}` : "30 min per hour",
      ok: t && m.allClipsMin !== null ? m.allClipsMin <= t.budgetMin : null,
    },
    { label: "Time to first clip", value: m.firstClipMin === null ? "None yet" : minutes(m.firstClipMin), target: "", ok: null },
    {
      label: "Quality check",
      value: m.qualityChecked === 0 ? "Not checked" : `${m.qualityPassed} of ${m.qualityChecked} passed`,
      target: "",
      ok: m.qualityChecked === 0 ? null : m.qualityPassed === m.qualityChecked,
    },
    {
      label: "Approved by you",
      value: swiped === 0 ? "No swipes yet" : `${reviewed.approved} of ${swiped}`,
      target: "half",
      ok: swiped === 0 ? null : reviewed.approved * 2 >= swiped,
    },
    { label: "Engine", value: m.engine || "Not known yet", target: "", ok: null },
    { label: "Cost", value: usd(m.costUsd), target: "", ok: null },
    { label: "Memory peak", value: m.ramPeakMb === null ? "Not read" : gb(m.ramPeakMb), target: "", ok: null },
  ];
}

/** What a finished drill missed: no LIVE clip, or one that took longer than the 15 minute target. */
export function judgeDrill(m: ProofMetrics, why = ""): ProofProblem[] {
  if (m.firstLatencySec === null) {
    return [{ kind: "failed", text: `No LIVE clip came out of the drill${why ? `: ${why}` : m.segments === 0 ? ": no segment was recorded." : ": the recorded segments gave no clip."}` }];
  }
  if ((m.worstLatencySec ?? 0) > LIVE_TARGET_LATENCY_SEC) {
    return [{ kind: "slow", text: `Too slow: a LIVE clip reached the Inbox ${span(m.worstLatencySec!)} after its moment; the target is under ${span(LIVE_TARGET_LATENCY_SEC)}.` }];
  }
  return [];
}

export function drillChecks(m: ProofMetrics): ProofCheck[] {
  const late = (sec: number | null) => (sec === null ? null : sec <= LIVE_TARGET_LATENCY_SEC);
  return [
    {
      label: "Moment to LIVE clip",
      value: m.firstLatencySec === null ? "No clip" : span(m.firstLatencySec),
      target: `under ${span(LIVE_TARGET_LATENCY_SEC)}`,
      ok: late(m.worstLatencySec),
    },
    { label: "Slowest LIVE clip", value: m.worstLatencySec === null ? "No clip" : span(m.worstLatencySec), target: "", ok: null },
    { label: "LIVE clips", value: String(m.clips), target: "at least 1", ok: m.clips >= 1 },
    { label: "Segments dropped", value: `${m.dropped} of ${m.segments}`, target: "none", ok: m.dropped === 0 },
    { label: "Memory peak", value: m.ramPeakMb === null ? "Not read" : gb(m.ramPeakMb), target: "", ok: null },
  ];
}

/** Which engine did the work, from the video's recorded engine jobs: "Local (Moonshine, Qwen)", "Cloud (…)". */
export function engineLabel(reports: EngineReport[], demo: boolean): string {
  const uses = mergeUses(reports).filter((u) => u.count > 0 && u.step !== "signals" && u.step !== "template");
  if (uses.length === 0) return demo ? "Stand-in (demo)" : "";
  const cloud = uses.filter((u) => u.step.startsWith("cloud"));
  const where = cloud.length === 0 ? "Local" : cloud.length === uses.length ? "Cloud" : "Local and cloud";
  return `${where} (${uses.map((u) => u.label).join(", ")})`;
}

/** MemTotal minus MemAvailable out of /proc/meminfo, in MB: what the whole server has in use. */
export function parseMemUsedMb(meminfo: string): number | null {
  const kb = (name: string) => {
    const m = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, "m").exec(meminfo);
    return m ? Number(m[1]) : null;
  };
  const total = kb("MemTotal");
  const free = kb("MemAvailable");
  return total === null || free === null ? null : Math.round((total - free) / 1024);
}

/** The server's own day of a time, as YYYY-MM-DD. */
export function localDay(at: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
}

/** Whether the daily proof should start now: it is past the hour, and the timer has not run today. */
export function dailyDue(now: Date, lastTimerAt: string | null, hour: number): boolean {
  return now.getHours() >= hour && (lastTimerAt === null || localDay(new Date(lastTimerAt)) !== localDay(now));
}

/** When the daily proof runs next. */
export function nextDailyAt(now: Date, lastTimerAt: string | null, hour: number): Date {
  if (dailyDue(now, lastTimerAt, hour)) return now;
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

/** The last 7 days of video proofs, oldest first; a day without a finished run is "none". */
export function proofDays(runs: ProofRun[], now: Date): ProofDay[] {
  const days: ProofDay[] = [];
  for (let back = 6; back >= 0; back--) {
    const at = new Date(now);
    at.setDate(at.getDate() - back);
    const day = localDay(at);
    const mine = runs.filter((r) => r.kind === "vod" && r.finishedAt !== null && r.status !== "skipped" && localDay(new Date(r.finishedAt)) === day);
    const measured = mine.filter((r) => r.metrics.vodSec !== null && r.metrics.allClipsMin !== null);
    const hours = measured.reduce((sum, r) => sum + Math.max(1, r.metrics.vodSec! / 3600), 0);
    const clips = mine.reduce((sum, r) => sum + r.metrics.clips, 0);
    days.push({
      day,
      status: mine.length === 0 ? "none" : mine.every((r) => r.status === "passed") ? "passed" : "failed",
      clips,
      clipsPerHour: hours > 0 ? Math.round((measured.reduce((sum, r) => sum + r.metrics.clips, 0) / hours) * 10) / 10 : null,
      minPerHour: hours > 0 ? Math.round((measured.reduce((sum, r) => sum + r.metrics.allClipsMin!, 0) / hours) * 10) / 10 : null,
      approved: mine.reduce((sum, r) => sum + r.approved, 0),
      rejected: mine.reduce((sum, r) => sum + r.rejected, 0),
    });
  }
  return days;
}

export interface KeyCheck {
  label: string;
  ok: boolean;
  message: string;
}

export interface ReadinessFacts {
  watchlist: Pick<WatchedCreator, "permissionState">[];
  /** The last test of every saved key; null when they were never tested. */
  keys: KeyCheck[] | null;
  /** The runs of the newest finished proof, and the newest finished drill. */
  proof: ProofRun[];
  drill: ProofRun | null;
  /** Why live mode would not record right now (disk, memory); null when it would. */
  guard: string | null;
  /** Whether notifications can be sent at all, and to how many phones. */
  push: { possible: boolean; subscribers: number };
}

/** "Launch ready: yes" only when nothing stands in the way of launch day; otherwise every reason, in plain words. */
export function launchReadiness(f: ReadinessFacts): LaunchReadiness {
  const reasons: string[] = [];
  if (f.watchlist.length === 0) reasons.push("The launch-day watchlist is empty, so nobody would be recorded.");
  else if (!f.watchlist.some((c) => c.permissionState === "active")) {
    reasons.push("Nobody on the watchlist has a permission record in force, so nobody would be recorded.");
  }
  if (f.keys === null) reasons.push("The keys have not been tested yet. The next proof tests them.");
  else for (const k of f.keys.filter((x) => !x.ok)) reasons.push(`The ${k.label} key fails: ${k.message}`);
  const proofFailed = f.proof.find((r) => r.status === "failed");
  if (f.proof.every((r) => r.status === "skipped")) reasons.push("No proof has finished yet.");
  else if (proofFailed) reasons.push(`The last proof failed on ${proofFailed.label || "its video"}: ${proofFailed.problems[0]?.text ?? "see the Proof card"}`);
  if (!f.drill) reasons.push("No live drill has run yet. Run one while an allowed creator is live.");
  else if (f.drill.status !== "passed") reasons.push(`The last live drill failed: ${f.drill.problems[0]?.text ?? f.drill.step}`);
  if (f.guard) reasons.push(f.guard);
  if (f.push.possible && f.push.subscribers === 0) reasons.push("No phone has notifications turned on, so alerts would reach nobody.");
  return { ready: reasons.length === 0, reasons };
}
