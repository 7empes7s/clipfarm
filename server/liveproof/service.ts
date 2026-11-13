import { readFileSync } from "node:fs";
import type { Clip, EngineReport, Job, LiveNow, Source, WatchedCreator, WatchPlatform } from "../../shared/types.js";
import { WATCH_PLATFORMS } from "../../shared/types.js";
import type { ProofAskedBy, ProofInfo, ProofMetrics, ProofProblem, ProofRun } from "../../shared/proof.js";
import { channelUrl, normalizeHandle } from "../../shared/watchlist.js";
import type { ClipsRepo } from "../clips/repo.js";
import { HttpError, ValidationError } from "../errors.js";
import type { JobQueue } from "../jobs/queue.js";
import type { LiveManager } from "../live/manager.js";
import type { Notifier } from "../live/notify.js";
import { beforeLaunch, LAUNCH_GAME } from "../live/plan.js";
import type { LiveRepo } from "../live/repo.js";
import type { PicksRepo } from "../picks/repo.js";
import { INGEST_JOB } from "../pipeline/ingest/ingest.js";
import { PICKS_JOB } from "../pipeline/picks/job.js";
import { RENDER_JOB } from "../pipeline/render/job.js";
import type { SourcesRepo } from "../sources/repo.js";
import { matchVod, mentionsGame, mentionsLeak } from "../sources/watchlist/match.js";
import type { PlatformClient, RemoteVod } from "../sources/watchlist/platforms/types.js";
import type { WatchlistRepo } from "../sources/watchlist/repo.js";
import type { VodsRepo } from "../vods/repo.js";
import {
  dailyDue,
  drillChecks,
  EMPTY_METRICS,
  engineLabel,
  GTA_PROOF_GAMES,
  judgeDrill,
  judgeVod,
  type KeyCheck,
  launchReadiness,
  nextDailyAt,
  parseMemUsedMb,
  proofDays,
  proofMaxPicks,
  span,
  vodChecks,
  vodTargets,
} from "./plan.js";
import type { ProofRepo, StoredRun } from "./repo.js";

export function withScheme(link: string): string {
  return /^https?:\/\//i.test(link) ? link : `https://${link}`;
}

/** The platform and handle of a channel link, when it is on Twitch, Kick or YouTube. */
export function channelOf(link: string): { platform: WatchPlatform; handle: string } | null {
  for (const platform of WATCH_PLATFORMS) {
    const handle = normalizeHandle(platform, withScheme(link));
    if (handle) return { platform, handle };
  }
  return null;
}

/** One spelling per channel, so "kick.com/tjr" and "https://kick.com/TJR/" are the same source. */
export function channelKey(link: string): string {
  const channel = channelOf(link);
  return (channel ? channelUrl(channel) : withScheme(link)).toLowerCase().replace(/\/+$/, "");
}

export interface ProofDeps {
  repo: ProofRepo;
  sources: SourcesRepo;
  vods: VodsRepo;
  picks: PicksRepo;
  clips: ClipsRepo;
  queue: JobQueue;
  watchlist: WatchlistRepo;
  live: LiveManager;
  liveRepo: LiveRepo;
  clients: PlatformClient[];
  notifier: Notifier;
  /** Tests every saved key; the result decides "Launch ready". */
  testKeys: () => Promise<KeyCheck[]>;
  engineReports: (vodId: number) => EngineReport[];
  /** The campaign channel whose latest video is proved every day. */
  campaignChannel: string;
  /** Moments asked of the picker on an ordinary run. */
  maxPicks: number;
  /** Most moments a proof asks for, whatever the video's length; null: as many as the target needs. */
  capPicks?: number | null;
  /** A video longer than this is passed over while a shorter one is there. */
  maxVodHours: number;
  /** The hour of the server's day the proof runs by itself; null: only on demand. */
  dailyHour: number | null;
  computeUsdPerHour: number;
  /** Outside services are stand-ins (CLIPFARM_FAKES=1). */
  demo: boolean;
  /** Memory the whole server has in use, in MB. */
  memUsedMb?: () => number | null;
  pollMs?: number;
  now?: () => Date;
}

const STEP_NAMES: Record<string, string> = { [INGEST_JOB]: "download and transcript", [PICKS_JOB]: "picking", [RENDER_JOB]: "cutting" };
const ALERT_TITLE: Record<ProofProblem["kind"], string> = { failed: "Proof failed", slow: "Proof too slow", few: "Proof: too few clips" };
const DRILL_DRAIN_MIN = 20;

function readMemUsedMb(): number | null {
  try {
    return parseMemUsedMb(readFileSync("/proc/meminfo", "utf8"));
  } catch {
    return null;
  }
}

/** A stop that is not a failure: there was nothing to run on. */
class Skip extends Error {}

/**
 * The daily live proof and the launch drill. Runs are asked for by anyone (the timer, the
 * Dashboard, clipfarm-ops) as rows in `proof_runs`; the process that runs the job queue works
 * through them, one at a time, on the real pipeline. Nothing here posts: the clips wait in the Inbox.
 */
export class ProofRunner {
  private readonly now: () => Date;
  private readonly pollMs: number;
  private readonly memUsedMb: () => number | null;
  private working: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private deps: ProofDeps) {
    this.now = deps.now ?? (() => new Date());
    this.pollMs = deps.pollMs ?? 2000;
    this.memUsedMb = deps.memUsedMb ?? readMemUsedMb;
  }

  /** Asks for a proof: the campaign channel's latest video, then a GTA V / GTA RP video. */
  request(askedBy: ProofAskedBy): StoredRun[] {
    this.assertFree();
    const at = this.now();
    return [this.deps.repo.add("vod", "campaign", askedBy, at), this.deps.repo.add("vod", "gta", askedBy, at)];
  }

  /** Asks for a launch drill: `minutes` of live mode on an allowed creator who is live now. */
  requestDrill(askedBy: ProofAskedBy, options: { minutes?: number; who?: string } = {}): StoredRun {
    this.assertFree();
    return this.deps.repo.add("drill", "drill", askedBy, this.now(), options);
  }

  private assertFree(): void {
    if (this.deps.repo.open().length > 0) throw new HttpError(409, "A proof is already running. Wait for it to finish.");
  }

  /** Runs left open by a restart are closed as failed. Only the process that works the queue calls this. */
  recover(): void {
    for (const run of this.deps.repo.open().filter((r) => r.status === "running")) {
      this.finish(run.id, "failed", [{ kind: "failed", text: "The server restarted during the proof." }], "Stopped by a restart");
    }
  }

  /** Looks every few seconds for runs to work through, and starts the daily proof when it is due. */
  start(everyMs = 5000): void {
    this.stopped = false;
    this.recover();
    this.timer ??= setInterval(() => this.tick(), everyMs);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick(): void {
    const { dailyHour, repo } = this.deps;
    if (dailyHour !== null && dailyDue(this.now(), repo.timerAt(), dailyHour)) {
      repo.saveTimerAt(this.now());
      if (repo.open().length === 0) this.request("timer");
    }
    void this.work();
  }

  /** Works through every waiting run, one at a time. Resolves when none is left. */
  work(): Promise<void> {
    this.working ??= this.drain().finally(() => (this.working = null));
    return this.working;
  }

  private async drain(): Promise<void> {
    let keysTested = false;
    for (;;) {
      const next = this.deps.repo.open().find((r) => r.status === "waiting");
      if (!next || this.stopped || !this.deps.repo.claim(next.id, this.now())) return;
      try {
        if (!keysTested) {
          // Once per round: "Launch ready" goes red when a saved key stopped working.
          this.deps.repo.saveKeys(await this.deps.testKeys());
          keysTested = true;
        }
        if (next.kind === "drill") await this.runDrill(next);
        else await this.runVod(next);
      } catch (err) {
        if (err instanceof Skip) this.deps.repo.finish(next.id, "skipped", err.message, [], this.now());
        else this.finish(next.id, "failed", [{ kind: "failed", text: err instanceof Error ? err.message : String(err) }], "Failed");
      }
    }
  }

  private finish(id: number, status: "passed" | "failed", problems: ProofProblem[], step: string): void {
    this.deps.repo.finish(id, status, step, problems, this.now());
    const run = this.deps.repo.get(id);
    for (const p of problems) {
      void this.deps.notifier.notify({
        title: `${run.kind === "drill" ? "Launch drill" : ALERT_TITLE[p.kind]}: ${run.label || (run.target === "gta" ? "GTA video" : "campaign video")}`,
        body: p.text,
        url: "/#dashboard",
      });
    }
  }

  private wait(): Promise<void> {
    return new Promise((r) => setTimeout(r, this.pollMs));
  }

  private client(platform: WatchPlatform): PlatformClient | null {
    const client = this.deps.clients.find((c) => c.platform === platform);
    return client && !client.missing ? client : null;
  }

  /** The newest finished video that is not in clipfarm yet, is no leak, and passes `wanted`. */
  private pickVod(vods: RemoteVod[], wanted: (v: RemoteVod) => boolean): RemoteVod | null {
    const known = new Set(this.deps.vods.list().map((v) => v.url));
    const launch = this.deps.liveRepo.launch();
    const fresh = vods.filter(
      (v) =>
        !known.has(v.url) &&
        !mentionsLeak(v.title) &&
        // Before launch time a GTA VI video is a leak (charter: no leaks).
        !(beforeLaunch(launch, this.now()) && (mentionsGame(v.title, LAUNCH_GAME) || (v.category !== null && mentionsGame(v.category, LAUNCH_GAME)))) &&
        wanted(v),
    );
    const short = fresh.find((v) => v.durationSec === null || v.durationSec <= this.deps.maxVodHours * 3600);
    return short ?? [...fresh].sort((a, b) => (a.durationSec ?? 0) - (b.durationSec ?? 0))[0] ?? null;
  }

  private async campaignTarget(): Promise<{ source: Source; vod: RemoteVod }> {
    const key = channelKey(this.deps.campaignChannel);
    const channel = channelOf(this.deps.campaignChannel);
    const source = this.deps.sources.list().find((s) => s.channelUrls.some((u) => channelKey(u) === key));
    if (!source || !channel) throw new Skip(`No source has the channel ${this.deps.campaignChannel}. Add its campaign in Sources.`);
    this.deps.sources.assertCanUse(source.id);
    const client = this.client(channel.platform);
    if (!client) throw new Skip(`There is no ${channel.platform} connection, so the latest video cannot be found.`);
    const vod = this.pickVod((await client.check(channel.handle)).vods, () => true);
    if (!vod) throw new Skip(`${source.creatorName} has no new video since the last one clipfarm clipped.`);
    return { source, vod };
  }

  private async gtaTarget(): Promise<{ source: Source; vod: RemoteVod }> {
    const allowed = this.deps.sources
      .list()
      .filter((s) => s.permissionState === "active" && s.permissions.some((p) => p.kind === "public-allowance"));
    if (allowed.length === 0) throw new Skip("No creator with a public clipping allowance is in Sources yet. Add one from the suggested list.");
    // A few channels at most: every look is a call to the platform.
    for (const source of allowed.slice(0, 8)) {
      for (const link of source.channelUrls) {
        const channel = channelOf(link);
        const client = channel && this.client(channel.platform);
        if (!channel || !client) continue;
        let vods: RemoteVod[];
        try {
          vods = (await client.check(channel.handle)).vods;
        } catch {
          continue;
        }
        const vod = this.pickVod(vods, (v) => matchVod(v, GTA_PROOF_GAMES).matched);
        if (vod) return { source, vod };
      }
    }
    throw new Skip("No creator with a public clipping allowance has a new GTA V or GTA RP video.");
  }

  private jobsOf(vodId: number): Job[] {
    return this.deps.queue.list(2000).filter((j) => j.vodId === vodId).reverse();
  }

  private clipsOf(vodId: number): Clip[] {
    return this.deps.clips.list().filter((c) => c.vodId === vodId);
  }

  private vodMetrics(run: StoredRun, vodId: number, ramPeakMb: number | null, done: boolean): ProofMetrics {
    const clips = this.clipsOf(vodId);
    const started = new Date(run.startedAt!).getTime();
    const made = clips.map((c) => new Date(c.createdAt).getTime());
    const min = (t: number) => Math.max(0, Math.round(((t - started) / 60_000) * 10) / 10);
    const checked = clips.filter((c) => c.quality !== null);
    const vod = this.deps.vods.get(vodId);
    const picked = this.deps.picks.listForVod(vodId).reduce((sum, p) => sum + p.costUsd, 0);
    const hours = (this.now().getTime() - started) / 3600_000;
    return {
      ...EMPTY_METRICS,
      vodSec: vod.durationSec,
      firstClipMin: made.length ? min(Math.min(...made)) : null,
      allClipsMin: done && made.length ? min(Math.max(...made)) : null,
      clips: clips.length,
      qualityChecked: checked.length,
      qualityPassed: checked.filter((c) => c.quality!.issues.length === 0).length,
      engine: engineLabel(this.deps.engineReports(vodId), this.deps.demo),
      // What the outside services charged (shared out over the picks), plus the server's own time.
      costUsd: Math.round((Math.max(picked, vod.transcriptCostUsd ?? 0) + hours * this.deps.computeUsdPerHour) * 10000) / 10000,
      ramPeakMb,
    };
  }

  private async runVod(run: StoredRun): Promise<void> {
    const { repo, queue } = this.deps;
    repo.update(run.id, { step: "Looking for the video" });
    const { source, vod: remote } = run.target === "campaign" ? await this.campaignTarget() : await this.gtaTarget();
    // Server-side gate: nothing is ingested without a permission record in force.
    this.deps.sources.assertCanUse(source.id);
    const vod = this.deps.vods.create(source.id, remote.url);
    const label = `${source.creatorName}: ${remote.title || "latest video"}`;
    repo.update(run.id, { label, url: remote.url, vodId: vod.id, step: "Waiting for its turn" });
    queue.enqueue(INGEST_JOB, { vodId: vod.id, maxPicks: Math.min(proofMaxPicks(remote.durationSec, this.deps.maxPicks), this.deps.capPicks ?? Infinity) }, { vodId: vod.id });

    const started = new Date(repo.get(run.id).startedAt!).getTime();
    const current = () => repo.get(run.id);
    let ramPeakMb: number | null = null;
    let quiet = 0;
    // Two quiet looks in a row: the next step is queued in the same instant the one before it ends.
    while (quiet < 2) {
      if (this.stopped) throw new Skip("Stopped before it finished.");
      const used = this.memUsedMb();
      if (used !== null) ramPeakMb = Math.max(ramPeakMb ?? 0, used);
      const jobs = this.jobsOf(vod.id);
      const active = jobs.find((j) => j.status === "running") ?? jobs.find((j) => j.status === "queued");
      quiet = active ? 0 : quiet + 1;
      if (active) {
        const step = active.status === "running" ? `${active.message || STEP_NAMES[active.type] || active.type} ${Math.round(active.progress * 100)}%` : "Waiting for its turn";
        repo.update(run.id, { step, metrics: this.vodMetrics(current(), vod.id, ramPeakMb, false) });
      }
      // Four times the target, and never under two hours: after that it is a failure, not a wait.
      const known = this.deps.vods.get(vod.id).durationSec ?? remote.durationSec;
      const limitMin = Math.max(120, 4 * vodTargets(known ?? 3600).budgetMin);
      if (active && this.now().getTime() - started > limitMin * 60_000) {
        const metrics = this.vodMetrics(current(), vod.id, ramPeakMb, false);
        repo.update(run.id, { metrics });
        const text = `Still not done after ${span(limitMin * 60)}; it stopped at the ${STEP_NAMES[active.type] ?? active.type} step. The jobs carry on.`;
        this.finish(run.id, "failed", [{ kind: "slow", text }], "Gave up waiting");
        return;
      }
      if (quiet < 2) await this.wait();
    }

    const jobs = this.jobsOf(vod.id);
    const metrics = this.vodMetrics(current(), vod.id, ramPeakMb, true);
    repo.update(run.id, { metrics });
    const stopped = jobs.find((j) => j.type !== RENDER_JOB && j.status !== "done");
    const failedCuts = jobs.filter((j) => j.type === RENDER_JOB && j.status !== "done");
    const leftOut = this.deps.picks.listForVod(vod.id).filter((p) => p.status === "dropped").length;
    let problems: ProofProblem[];
    if (stopped) {
      problems = [{ kind: "failed", text: `The ${STEP_NAMES[stopped.type] ?? stopped.type} step ${stopped.status === "failed" ? "failed" : "was cancelled"}: ${stopped.error ?? stopped.message}` }];
    } else if (metrics.clips === 0) {
      const why = failedCuts.length
        ? `The cutting step failed: ${failedCuts[0]!.error ?? failedCuts[0]!.message}`
        : `The picking step kept no moment${leftOut ? ` (${leftOut} left out by the rules)` : ""}.`;
      problems = [{ kind: "failed", text: `No clip came out. ${why}` }];
    } else {
      const spent = new Map<string, number>();
      for (const j of jobs) {
        if (j.startedAt && j.finishedAt) spent.set(j.type, (spent.get(j.type) ?? 0) + new Date(j.finishedAt).getTime() - new Date(j.startedAt).getTime());
      }
      const slowest = [...spent].sort((a, b) => b[1] - a[1])[0];
      problems = judgeVod(metrics, {
        slowestStep: slowest ? `${STEP_NAMES[slowest[0]] ?? slowest[0]} (${span(slowest[1] / 1000)})` : undefined,
        leftOut,
        failedCuts: failedCuts.length,
      });
    }
    this.finish(run.id, problems.length ? "failed" : "passed", problems, problems.length ? "Missed the target" : "Met the target");
  }

  /** The watched creator a drill records: the one asked for, else the first allowed one who is live (Kick first). */
  private async drillTarget(who: string | undefined): Promise<{ creator: WatchedCreator; live: LiveNow }> {
    const all = this.deps.watchlist.list();
    const named = (c: WatchedCreator) =>
      !who ||
      c.name.toLowerCase() === who.trim().toLowerCase() ||
      (/^\d+$/.test(who) && c.sourceId === Number(who)) ||
      c.channels.some((ch) => channelKey(channelUrl(ch)) === channelKey(who));
    const allowed = all.filter((c) => c.sourceId !== null && c.permissionState === "active" && named(c));
    if (allowed.length === 0) {
      throw new Skip(who ? `${who} is not on the watchlist with a permission record in force.` : "Nobody on the watchlist has a permission record in force, so there is no stream to drill on.");
    }
    const order: WatchPlatform[] = ["kick", "twitch", "youtube"];
    const channels = allowed
      .flatMap((creator) => creator.channels.map((channel) => ({ creator, channel })))
      .sort((a, b) => order.indexOf(a.channel.platform) - order.indexOf(b.channel.platform));
    // A few channels at most: every look is a call to the platform.
    for (const { creator, channel } of channels.slice(0, 12)) {
      const client = this.client(channel.platform);
      if (!client) continue;
      const live = await client.check(channel.handle).then(
        (c) => c.live,
        () => null,
      );
      if (live) return { creator, live };
    }
    throw new Skip(who ? `${who} is not live right now.` : "No allowed creator is live right now. Try again when one is.");
  }

  private async runDrill(run: StoredRun): Promise<void> {
    const { repo, live, liveRepo } = this.deps;
    const minutes = run.options.minutes ?? 15;
    repo.update(run.id, { step: "Looking for a live stream" });
    const target = await this.drillTarget(run.options.who);
    const label = `${target.creator.name}: ${target.live.title || "live stream"}`;
    repo.update(run.id, { label, url: target.live.url });
    let capture;
    try {
      capture = await live.startDrill(target.creator.id, target.live);
    } catch (err) {
      if (err instanceof ValidationError) throw new Skip(`${target.creator.name} is live but cannot be recorded: ${err.message}`);
      throw err;
    }
    repo.update(run.id, { vodId: capture.vodId });

    let ramPeakMb: number | null = null;
    let lostRecordings = 0;
    const started = this.now().getTime();
    const sample = () => {
      const used = this.memUsedMb();
      if (used !== null) ramPeakMb = Math.max(ramPeakMb ?? 0, used);
    };
    const metrics = (): ProofMetrics => {
      const segs = liveRepo.segments(capture.id);
      const recorded = segs.filter((s) => s.durationSec !== null);
      const clips = this.clipsOf(capture.vodId)
        .filter((c) => c.live)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return {
        ...EMPTY_METRICS,
        clips: clips.length,
        ramPeakMb,
        firstLatencySec: clips[0]?.live?.latencySec ?? null,
        worstLatencySec: clips.length ? Math.max(...clips.map((c) => c.live!.latencySec)) : null,
        segments: recorded.length + lostRecordings,
        dropped: lostRecordings + recorded.filter((s) => s.status === "skipped" || s.status === "failed").length,
      };
    };
    try {
      while (this.now().getTime() - started < minutes * 60_000 && liveRepo.findCapture(capture.id)?.status === "recording") {
        if (this.stopped) throw new Skip("Stopped before it finished.");
        // The server's own timer rolls the segments; a drill run by clipfarm-ops alone does it here.
        if (!live.started) live.roll();
        sample();
        const m = metrics();
        const passed = (this.now().getTime() - started) / 60_000;
        repo.update(run.id, { step: `Recording: ${Math.floor(passed)} of ${minutes} min, ${m.segments} recorded, ${m.clips} LIVE ${m.clips === 1 ? "clip" : "clips"}`, metrics: m });
        await this.wait();
      }
      // Recordings that broke off while the drill was still recording are dropped segments.
      lostRecordings = liveRepo.segments(capture.id).filter((s) => s.status === "failed" && s.durationSec === null).length;
    } finally {
      await live.endDrill();
    }
    await live.settled();

    // What was recorded is still worked through: the clip of the last moment may be minutes away.
    const drainFrom = this.now().getTime();
    let quiet = 0;
    while (quiet < 2 && this.now().getTime() - drainFrom < DRILL_DRAIN_MIN * 60_000) {
      if (this.stopped) throw new Skip("Stopped before it finished.");
      sample();
      quiet = this.jobsOf(capture.vodId).some((j) => j.status === "queued" || j.status === "running") ? 0 : quiet + 1;
      repo.update(run.id, { step: "Cutting the LIVE clips", metrics: metrics() });
      if (quiet < 2) await this.wait();
    }
    const m = metrics();
    repo.update(run.id, { metrics: m });
    const ended = liveRepo.findCapture(capture.id)?.endReason;
    const failedJob = this.jobsOf(capture.vodId).find((j) => j.status === "failed");
    const why = failedJob ? `the ${failedJob.type === RENDER_JOB ? "cutting" : "transcript and picking"} step failed: ${failedJob.error ?? failedJob.message}` : m.segments === 0 && ended ? ended : "";
    const problems = judgeDrill(m, why);
    this.finish(run.id, problems.length ? "failed" : "passed", problems, problems.length ? "Missed the target" : "Met the target");
  }

  stored(id: number): StoredRun {
    return this.deps.repo.get(id);
  }

  /** A stored run with its clips, the manager's swipes and its numbers against the targets. */
  view(run: StoredRun, clips: Clip[] = this.deps.clips.list()): ProofRun {
    const mine = run.vodId === null ? [] : clips.filter((c) => c.vodId === run.vodId).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const approved = mine.filter((c) => c.status === "approved").length;
    const rejected = mine.filter((c) => c.status === "rejected").length;
    const { options: _options, ...rest } = run;
    return {
      ...rest,
      checks: run.kind === "drill" ? drillChecks(run.metrics, run.finishedAt !== null) : vodChecks(run.metrics, { approved, rejected }),
      clipIds: mine.map((c) => c.id),
      approved,
      rejected,
    };
  }

  /** What the Proof card shows. */
  info(): ProofInfo {
    const { repo, dailyHour } = this.deps;
    const now = this.now();
    const clips = this.deps.clips.list();
    const all = repo.list().map((r) => this.view(r, clips));
    const vodRuns = all.filter((r) => r.kind === "vod");
    const batch = (at: string | undefined) => vodRuns.filter((r) => r.requestedAt === at).reverse();
    const finished = (r: ProofRun) => r.status === "passed" || r.status === "failed";
    const live = this.deps.live.info();
    return {
      busy: repo.open().length > 0,
      runs: batch(vodRuns[0]?.requestedAt),
      days: proofDays(vodRuns, now),
      drill: all.find((r) => r.kind === "drill") ?? null,
      launch: launchReadiness({
        watchlist: this.deps.watchlist.list(),
        keys: repo.keys(),
        // The newest proof that got as far as a video.
        proof: batch(vodRuns.find(finished)?.requestedAt),
        drill: all.find((r) => r.kind === "drill" && finished(r)) ?? null,
        guard: live.guard,
        push: { possible: live.push.publicKey !== null, subscribers: live.push.subscribers },
      }),
      nextAt: dailyHour === null ? null : nextDailyAt(now, repo.timerAt(), dailyHour).toISOString(),
    };
  }
}
