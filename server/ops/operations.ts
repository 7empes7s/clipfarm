import { readFileSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { freemem, totalmem } from "node:os";
import type { HealthBoard } from "../../shared/business.js";
import {
  type OpsAccountPosts,
  type OpsCampaign,
  type OpsCheck,
  type OpsDeploy,
  type OpsInfo,
  type OpsJob,
  type OpsLevel,
  type OpsSource,
  type OpsStatus,
  worstLevel,
} from "../../shared/ops.js";
import type { ProofInfo } from "../../shared/proof.js";
import { SUBMIT_WINDOW_MIN } from "../../shared/submitWindow.js";
import type { Job, KeyTestResult } from "../../shared/types.js";
import type { ClipsRepo } from "../clips/repo.js";
import { ValidationError } from "../errors.js";
import type { JobQueue } from "../jobs/queue.js";
import { RENDER_CLIP_JOB } from "../pipeline/rerender/render.js";
import type { Publisher } from "../publish/publisher.js";
import type { PostsRepo } from "../publish/repo.js";
import { requireActivePermission } from "../sources/permission.js";
import type { SourcesRepo } from "../sources/repo.js";
import type { WatchlistRepo } from "../sources/watchlist/repo.js";
import type { VodsRepo } from "../vods/repo.js";
import { readLiveVersion } from "./liveVersion.js";
import type { OpsState } from "./state.js";

/** A service clipfarm depends on (Postiz and its backend), checked with one cheap call. */
export interface ServiceProbe {
  id: string;
  label: string;
  check(): Promise<{ level: OpsLevel; detail: string }>;
}

/** A provider key as the Operations page sees it: set or not, and its last test. Never the key itself. */
export interface KeyState {
  id: string;
  label: string;
  configured: boolean;
  result: KeyTestResult | null;
}

export interface Resources {
  diskFreeBytes: number;
  diskTotalBytes: number;
  memAvailableBytes: number;
  memTotalBytes: number;
}

export interface OperationsDeps {
  state: OpsState;
  queue: JobQueue;
  vods: VodsRepo;
  clips: ClipsRepo;
  sources: SourcesRepo;
  posts: PostsRepo;
  publisher: Publisher;
  watchlist?: { repo: WatchlistRepo; checkNow: (id: number) => Promise<void> };
  proof?: { info(): ProofInfo };
  /** The business health page, for the YouTube quota per app. */
  health?: () => HealthBoard;
  keys: () => KeyState[];
  /** Tests every configured key once (the "Test keys now" button). */
  testKeys: () => Promise<void>;
  probes: ServiceProbe[];
  resources: () => Promise<Resources>;
  /** The file the box's auto-deploy writes (see ops/clipfarm/autodeploy.sh). */
  deployStatusFile?: string;
  now?: () => Date;
  /** How long a probe's answer is reused, so opening the page often does not hammer Postiz. */
  probeCacheMs?: number;
}

const STEP_LABELS: Record<string, string> = {
  ingest: "Transcript",
  picks: "Picks",
  render: "Cutting clips",
  "render-clip": "New version",
  "live-segment": "Live segment",
  thumbnails: "Thumbnails",
  "hook-variants": "Hook variants",
  formats: "Other formats",
  "engine-setup": "Engine setup",
  "demo-clips": "Demo clips",
  "demo-data": "Demo data",
};

const GB = 1024 ** 3;
const DAY = 86_400_000;

function gb(bytes: number): string {
  return `${(bytes / GB).toFixed(bytes < 10 * GB ? 1 : 0)} GB`;
}

/** Disk headroom: red under 5% or 2 GB free, amber under 15% or 5 GB. */
export function diskLevel(free: number, total: number): OpsLevel {
  if (total <= 0) return "off";
  const share = free / total;
  if (share < 0.05 || free < 2 * GB) return "down";
  if (share < 0.15 || free < 5 * GB) return "warn";
  return "ok";
}

/** Memory headroom: red under 10% available, amber under 20%. */
export function memoryLevel(available: number, total: number): OpsLevel {
  if (total <= 0) return "off";
  const share = available / total;
  if (share < 0.1) return "down";
  if (share < 0.2) return "warn";
  return "ok";
}

/** Disk of the data folder and the box's memory (MemAvailable from /proc/meminfo where there is one). */
export async function readResources(dataDir: string): Promise<Resources> {
  let diskFreeBytes = 0;
  let diskTotalBytes = 0;
  try {
    const s = await statfs(dataDir);
    diskFreeBytes = s.bavail * s.bsize;
    diskTotalBytes = s.blocks * s.bsize;
  } catch {
    // Not readable: shown as "not known".
  }
  let memAvailableBytes = freemem();
  try {
    const m = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync("/proc/meminfo", "utf8"));
    if (m) memAvailableBytes = Number(m[1]) * 1024;
  } catch {
    // Not Linux: free memory is the closest there is.
  }
  return { diskFreeBytes, diskTotalBytes, memAvailableBytes, memTotalBytes: totalmem() };
}

/**
 * Operations: the status of everything clipfarm runs on, and the controls to run it from the app
 * (the job queue, publishing, campaign submits, watched sources). Every control is logged with who
 * did it and when. Every post still goes through the publisher, so the permission record is
 * checked on Retry and Submit now exactly as on a first post.
 */
export class Operations {
  private now: () => Date;
  private probeCache: { at: number; checks: OpsCheck[] } | null = null;

  constructor(private deps: OperationsDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  workerPaused(): boolean {
    return this.deps.state.isOn("worker_paused");
  }

  publishingPaused(): boolean {
    return this.deps.state.isOn("publishing_paused");
  }

  async info(opts: { fresh?: boolean } = {}): Promise<OpsInfo> {
    const { state, queue } = this.deps;
    const worker = state.switchOf("worker_paused");
    const publishing = state.switchOf("publishing_paused");
    return {
      status: await this.status(opts.fresh === true),
      worker: { paused: worker.on, since: worker.since, seenAt: queue.workerSeenAt()?.toISOString() ?? null },
      jobs: this.jobs(),
      publishing: { paused: publishing.on, since: publishing.since, accounts: this.publishingList() },
      campaigns: this.campaigns(),
      sources: this.sourcesList(),
      activity: state.activity(),
    };
  }

  // ------------------------------------------------------------------ status

  private async status(fresh: boolean): Promise<OpsStatus> {
    const deploy = this.deploy();
    const services = [...this.ownServices(), ...(await this.probeServices(fresh))];
    const site = deploy.check;
    if (site) services.push(site);
    const resources = await this.resourceChecks();
    const keys = this.keyChecks();
    const proof = this.proofCheck();
    const deployLevel: OpsLevel = deploy.info.result === "live" || deploy.info.result === null ? "ok" : "warn";
    return {
      level: worstLevel([deployLevel, ...services.map((s) => s.level), ...resources.map((r) => r.level), ...keys.map((k) => k.level), proof.level]),
      deploy: deploy.info,
      services,
      resources,
      keys,
      proof,
      checkedAt: this.now().toISOString(),
    };
  }

  private deploy(): { info: OpsDeploy; check: OpsCheck | null } {
    const live = this.deps.deployStatusFile ? readLiveVersion(this.deps.deployStatusFile) : null;
    if (live?.result === "rolled back") this.deps.state.noteRollback({ sha: live.sha, at: live.at, reason: live.reason });
    const info: OpsDeploy = {
      sha: live?.sha ?? null,
      at: live?.at ?? null,
      result: live?.result ?? null,
      reason: live?.reason ?? "",
      lastRollback: this.deps.state.lastRollback(),
    };
    const check: OpsCheck | null = live
      ? { id: "site", label: "Public address", level: live.check.ok ? "ok" : "down", detail: live.check.ok ? "Answers" : live.check.problems.join(" ") || "Not answering" }
      : null;
    return { info, check };
  }

  private ownServices(): OpsCheck[] {
    const { queue } = this.deps;
    const running = queue.list(100).find((j) => j.status === "running");
    const seen = queue.workerSeenAt();
    const paused = this.deps.state.switchOf("worker_paused");
    const worker: OpsCheck = paused.on
      ? { id: "worker", label: "Job worker", level: "warn", detail: running ? `Paused: finishing ${this.stepOf(running)}, then waits` : "Paused: no new job starts" }
      : seen
        ? { id: "worker", label: "Job worker", level: "ok", detail: running ? `Working: ${this.stepOf(running)}` : "Idle, waiting for work" }
        : { id: "worker", label: "Job worker", level: "down", detail: "Not running: no worker has checked in for 30 s" };
    const upMin = Math.round(process.uptime() / 60);
    return [
      { id: "clipfarm", label: "clipfarm", level: "ok", detail: upMin < 120 ? `Up for ${upMin} min` : `Up for ${Math.round(upMin / 60)} h` },
      worker,
    ];
  }

  private async probeServices(fresh: boolean): Promise<OpsCheck[]> {
    const ttl = this.deps.probeCacheMs ?? 30_000;
    const t = this.now().getTime();
    if (!fresh && this.probeCache && t - this.probeCache.at < ttl) return this.probeCache.checks;
    const checks = await Promise.all(
      this.deps.probes.map(async (p): Promise<OpsCheck> => {
        try {
          return { id: p.id, label: p.label, ...(await p.check()) };
        } catch (err) {
          return { id: p.id, label: p.label, level: "down", detail: (err as Error).message };
        }
      }),
    );
    this.probeCache = { at: t, checks };
    return checks;
  }

  private async resourceChecks(): Promise<OpsCheck[]> {
    const r = await this.deps.resources();
    const pct = (a: number, b: number) => `${Math.round((a / b) * 100)}%`;
    return [
      {
        id: "disk",
        label: "Disk",
        level: diskLevel(r.diskFreeBytes, r.diskTotalBytes),
        detail: r.diskTotalBytes > 0 ? `${gb(r.diskFreeBytes)} free of ${gb(r.diskTotalBytes)} (${pct(r.diskFreeBytes, r.diskTotalBytes)})` : "Not known",
      },
      {
        id: "memory",
        label: "Memory",
        level: memoryLevel(r.memAvailableBytes, r.memTotalBytes),
        detail: r.memTotalBytes > 0 ? `${gb(r.memAvailableBytes)} free of ${gb(r.memTotalBytes)} (${pct(r.memAvailableBytes, r.memTotalBytes)})` : "Not known",
      },
    ];
  }

  private keyChecks(): OpsCheck[] {
    const checks: OpsCheck[] = this.deps.keys().map((k) => {
      if (!k.configured) return { id: `key:${k.id}`, label: k.label, level: "off", detail: "Not set" };
      if (!k.result) return { id: `key:${k.id}`, label: k.label, level: "warn", detail: "Not tested yet" };
      return { id: `key:${k.id}`, label: k.label, level: k.result.ok ? "ok" : "down", detail: k.result.ok ? "Working" : k.result.message };
    });
    for (const q of this.deps.health?.().quotas ?? []) {
      if (q.platform !== "youtube" || q.unit !== "API units") continue;
      const level: OpsLevel = q.left <= 0 ? "down" : q.left < q.limit * 0.2 ? "warn" : "ok";
      checks.push({ id: `quota:${q.key}`, label: `YouTube quota, ${q.label}`, level, detail: `${q.left.toLocaleString("en")} of ${q.limit.toLocaleString("en")} units left today` });
    }
    return checks;
  }

  private proofCheck(): OpsCheck {
    const base = { id: "proof", label: "Today's live proof" };
    if (!this.deps.proof) return { ...base, level: "off", detail: "Not set up" };
    const info = this.deps.proof.info();
    const today = this.now().toISOString().slice(0, 10);
    const day = info.days.find((d) => d.day === today);
    if (day?.status === "passed") return { ...base, level: "ok", detail: `Passed: ${day.clips} clips` };
    if (day?.status === "failed") return { ...base, level: "down", detail: `Failed: ${info.runs.flatMap((r) => r.problems.map((p) => p.text)).at(0) ?? "see the Dashboard's Proof card"}` };
    if (info.busy) return { ...base, level: "warn", detail: "Running now" };
    return { ...base, level: "warn", detail: info.nextAt ? `Not run yet today (next ${info.nextAt.slice(11, 16)} UTC)` : "Not run yet today" };
  }

  /** Tests every configured key now; their results show in the status block. */
  async testKeys(who: string): Promise<void> {
    await this.deps.testKeys();
    this.deps.state.log(who, "Tested keys", "Provider keys");
  }

  // ------------------------------------------------------------------ pipeline

  private stepOf(job: Job): string {
    return STEP_LABELS[job.type] ?? job.type;
  }

  private whatOf(job: Job): string | null {
    try {
      if (job.clipId !== null) return this.deps.clips.get(job.clipId).title;
      if (job.vodId !== null) {
        const vod = this.deps.vods.get(job.vodId);
        return vod.title ?? vod.url;
      }
    } catch {
      // Removed since: the job still shows, without a title.
    }
    return null;
  }

  private jobs(): OpsJob[] {
    const all = this.deps.queue.list(300);
    const since = this.now().getTime() - 3 * DAY;
    const running = all.filter((j) => j.status === "running");
    const queued = all.filter((j) => j.status === "queued").sort((a, b) => b.priority - a.priority || a.id - b.id);
    const failed = all.filter((j) => j.status === "failed" && new Date(j.finishedAt ?? j.updatedAt).getTime() >= since);
    return [...running, ...queued, ...failed].map((j, i, list) => ({
      id: j.id,
      type: j.type,
      step: this.stepOf(j),
      status: j.status,
      progress: j.progress,
      message: j.message,
      error: j.error,
      what: this.whatOf(j),
      createdAt: j.createdAt,
      startedAt: j.startedAt,
      priority: j.priority,
      canRetry: j.status === "failed" || j.status === "cancelled",
      canCancel: j.status === "queued" || j.status === "running",
      // Already first in line: nothing to move.
      canMoveTop: j.status === "queued" && list.findIndex((x) => x.status === "queued") !== i,
    }));
  }

  /** Retry a failed job: only while its creator still has an active permission record. */
  retryJob(id: number, who: string): Job {
    const { queue, sources, vods, clips } = this.deps;
    const job = queue.get(id);
    if (job.vodId !== null) sources.assertCanUse(vods.get(job.vodId).sourceId);
    if (job.clipId !== null) sources.assertCanUse(clips.get(job.clipId).sourceId);
    const retried = queue.retry(id);
    if (retried.type === RENDER_CLIP_JOB && retried.clipId !== null) clips.setStatus(retried.clipId, "rendering");
    this.deps.state.log(who, "Retried job", `${this.stepOf(job)} #${id}`, this.whatOf(job) ?? "");
    return retried;
  }

  cancelJob(id: number, who: string): Job {
    const job = this.deps.queue.cancel(id);
    this.deps.state.log(who, "Cancelled job", `${this.stepOf(job)} #${id}`, this.whatOf(job) ?? "");
    return job;
  }

  moveJobToTop(id: number, who: string): Job {
    const job = this.deps.queue.moveToTop(id);
    this.deps.state.log(who, "Moved job to top", `${this.stepOf(job)} #${id}`, this.whatOf(job) ?? "");
    return job;
  }

  setWorkerPaused(paused: boolean, who: string): void {
    this.deps.state.setSwitch("worker_paused", paused);
    this.deps.state.log(who, paused ? "Paused the worker" : "Resumed the worker", "Job worker");
    if (!paused) void this.deps.queue.kick();
  }

  // ------------------------------------------------------------------ publishing

  private publishingList(): OpsAccountPosts[] {
    const byAccount = new Map<string, OpsAccountPosts>();
    for (const { post, movable } of this.deps.posts.waitingAndFailed()) {
      if (post.status === "posted") continue;
      const key = `${post.platform}:${post.accountId}`;
      const group = byAccount.get(key) ?? { platform: post.platform, accountId: post.accountId, accountName: post.accountName, scheduled: [], failed: [] };
      const row = {
        id: post.id,
        clipId: post.clipId,
        clipTitle: post.clipTitle,
        platform: post.platform,
        accountId: post.accountId,
        accountName: post.accountName,
        status: post.status,
        scheduledAt: post.scheduledAt,
        error: post.error,
        note: post.note,
        movable,
      };
      if (post.status === "failed") group.failed.unshift(row);
      else group.scheduled.push(row);
      byAccount.set(key, group);
    }
    return [...byAccount.values()].sort((a, b) => a.platform.localeCompare(b.platform) || a.accountName.localeCompare(b.accountName));
  }

  /** Retry a failed post: through the publisher, so the permission record, brief and limits are checked again. */
  async retryPost(id: number, who: string) {
    const post = this.deps.posts.get(id);
    const outcome = await this.deps.publisher.retry(id);
    const fresh = outcome.posts[0];
    this.deps.state.log(who, "Retried post", `${post.clipTitle} on ${post.accountName}`, fresh ? (fresh.status === "failed" ? `Failed again: ${fresh.error ?? ""}` : "Sent") : (outcome.skipped[0]?.reason ?? ""));
    return outcome;
  }

  async reschedulePost(id: number, at: Date, who: string) {
    const result = await this.deps.publisher.reschedule(id, at);
    this.deps.state.log(who, "Rescheduled post", `${result.post.clipTitle} on ${result.post.accountName}`, `To ${result.post.scheduledAt}`);
    return result;
  }

  skipPost(id: number, who: string) {
    const { posts, publisher } = this.deps;
    const post = posts.get(id);
    if (post.status === "posted") throw new ValidationError("It has already gone out, so there is nothing to skip.");
    if (post.status === "scheduled" && !posts.movable(id)) {
      throw new ValidationError(`It is already queued in ${publisher.service.label}: remove it there.`);
    }
    const skipped = posts.skip(id, `Skipped in Operations by ${who}.`);
    this.deps.state.log(who, "Skipped post", `${post.clipTitle} on ${post.accountName}`, post.status === "failed" ? "Was failed" : `Was due ${post.scheduledAt}`);
    return skipped;
  }

  setPublishingPaused(paused: boolean, who: string): void {
    this.deps.state.setSwitch("publishing_paused", paused);
    this.deps.state.log(who, paused ? "Paused all publishing" : "Resumed publishing", "Publishing");
  }

  // ------------------------------------------------------------------ campaigns

  private campaigns(): OpsCampaign[] {
    const now = this.now();
    const posts = this.deps.posts.list();
    const out: OpsCampaign[] = [];
    for (const source of this.deps.sources.list()) {
      for (const perm of source.permissions) {
        if (perm.kind !== "whop-campaign") continue;
        const mine = posts.filter((p) => p.permissionId === perm.id);
        const ended = perm.expiresAt !== null && new Date(perm.expiresAt).getTime() < now.getTime() - 30 * DAY;
        if (mine.length === 0 && ended) continue;
        out.push({
          permissionId: perm.id,
          creatorName: source.creatorName,
          campaignUrl: perm.campaignUrl,
          windowMin: perm.rules?.submitWithinMin ?? SUBMIT_WINDOW_MIN,
          open: mine
            .filter((p) => p.status === "posted" && p.submit?.liveAt && !p.submit.missedAt && !p.whopSubmittedAt)
            .map((p) => ({ postId: p.id, clipTitle: p.clipTitle, platform: p.platform, accountName: p.accountName, url: p.url, dueBy: p.submit!.dueBy })),
          missed: mine.filter((p) => p.submit?.missedAt).length,
          lostUsd: Math.round(mine.reduce((s, p) => s + p.lostEarningsUsd, 0) * 100) / 100,
          payout: {
            submitted: mine.filter((p) => p.whopSubmittedAt).length,
            approved: mine.filter((p) => p.whopApprovedAt).length,
            paid: mine.filter((p) => p.whopPaidAt).length,
            rejected: mine.filter((p) => p.whopRejectedAt).length,
            estimatedUsd: Math.round(mine.reduce((s, p) => s + p.estimatedEarningsUsd, 0) * 100) / 100,
          },
        });
      }
    }
    return out;
  }

  /**
   * "Submit now" on a live campaign post: marks it sent to the campaign, only while its window is
   * open, its permission record is in force and it keeps the campaign's rules (see Publisher.markWhop).
   */
  submitNow(postId: number, who: string) {
    const { posts, sources, publisher } = this.deps;
    const post = posts.get(postId);
    if (post.experiment) throw new ValidationError("An experiment post is never submitted to a campaign.");
    if (!post.submit || post.status !== "posted" || !post.submit.liveAt) throw new ValidationError("Only a live campaign post can be submitted.");
    if (post.whopSubmittedAt) throw new ValidationError("It was already submitted.");
    if (post.submit.missedAt) throw new ValidationError("Its submit window has passed, so the campaign would not count it.");
    // The record it went out under must still be in force: no submit without a permission record.
    requireActivePermission(post.creatorName, [sources.permission(post.permissionId)], this.now(), post.platform);
    const marked = publisher.markWhop(postId, "submitted", true);
    this.deps.state.log(who, "Submitted to campaign", `${post.clipTitle} on ${post.accountName}`, post.campaignUrl ?? "");
    return marked;
  }

  // ------------------------------------------------------------------ sources

  private sourcesList(): OpsSource[] {
    return (this.deps.watchlist?.repo.list() ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      channels: c.channels.map((ch) => `${ch.platform}: ${ch.handle}`),
      live: c.live !== null,
      lastVodTitle: c.lastVod?.title ?? null,
      lastVodAt: c.lastVod?.publishedAt ?? null,
      permissionState: c.permissionState,
      autoIngest: c.autoIngest,
      paused: c.paused === true,
    }));
  }

  private watch() {
    if (!this.deps.watchlist) throw new ValidationError("The watchlist is not running here.");
    return this.deps.watchlist;
  }

  async checkSource(id: number, who: string): Promise<void> {
    const w = this.watch();
    const name = w.repo.get(id).name;
    await w.checkNow(id);
    this.deps.state.log(who, "Checked source", name);
  }

  setSourcePaused(id: number, paused: boolean, who: string): void {
    const w = this.watch();
    w.repo.setPaused(id, paused);
    this.deps.state.log(who, paused ? "Paused source" : "Resumed source", w.repo.get(id).name);
  }
}
