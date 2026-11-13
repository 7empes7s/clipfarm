import { mkdir, readdir, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LiveCreatorStatus, LiveInfo, LiveNow, WatchedCreator } from "../../shared/types.js";
import { ValidationError } from "../errors.js";
import type { JobQueue } from "../jobs/queue.js";
import { Backoff } from "../sources/watchlist/backoff.js";
import type { WatchlistRepo } from "../sources/watchlist/repo.js";
import type { SourcesRepo } from "../sources/repo.js";
import { probeDuration } from "../tools/ffmpeg.js";
import type { VodsRepo } from "../vods/repo.js";
import type { LiveCapturer } from "./capturer.js";
import { LIVE_SEGMENT_JOB } from "./job.js";
import type { Notifier } from "./notify.js";
import {
  beforeLaunch,
  type CaptureDecision,
  decideCapture,
  DEFAULT_GUARD,
  type GuardLimits,
  guardReason,
  isArmed,
  launchStatusLine,
  livePriority,
  overBacklog,
  segmentDue,
  segmentExpired,
  SKIP_REASON,
} from "./plan.js";
import type { Capture, LiveRepo } from "./repo.js";
import type { SystemProbe } from "./system.js";

export interface LiveManagerDeps {
  repo: LiveRepo;
  watchlist: WatchlistRepo;
  sources: SourcesRepo;
  vods: VodsRepo;
  queue: JobQueue;
  capturer: LiveCapturer;
  system: SystemProbe;
  notifier: Notifier;
  /** Segments are kept under <mediaDir>/live until they are too old. */
  mediaDir: string;
  /** A new segment starts every `segmentSec` and runs `overlapSec` longer, so neighbours overlap. */
  segmentSec?: number;
  overlapSec?: number;
  /** Segment video older than this is deleted, unless a clip is still to be cut from it. */
  keepHours?: number;
  /** Most live segments that may wait for the one heavy job; beyond it the oldest is skipped. */
  maxBacklog?: number;
  /** Most streams recorded at once (each is two light recorders during an overlap); the biggest creators go first. */
  maxStreams?: number;
  guard?: GuardLimits;
  now?: () => Date;
}

/** A recording that came back this much shorter than asked means the stream ended. */
const ENDED_SHARE = 0.9;

/**
 * Live mode: records every permitted, switched-on creator who is live with their games, in
 * rolling segments, and queues each finished segment ahead of stream/VOD work. Recording is a
 * plain copy of the stream (no encoding), so it runs beside the one heavy job; everything heavy
 * (transcript, picks, cutting) goes through the queue.
 */
export class LiveManager {
  private readonly now: () => Date;
  private readonly stepSec: number;
  private readonly overlapSec: number;
  private readonly keepHours: number;
  private readonly maxBacklog: number;
  private readonly maxStreams: number;
  private readonly limits: GuardLimits;
  /** Why each creator is not being recorded, from the last look. */
  private reasons = new Map<number, string>();
  private guard: string | null = null;
  private backoffs = new Map<number, Backoff>();
  private stops = new Map<number, AbortController>();
  private recordings = new Set<Promise<void>>();
  private syncing: Promise<void> = Promise.resolve();
  private timers: NodeJS.Timeout[] = [];
  /** The creator a launch drill is recording, with the stream it found live. */
  private drill: { creatorId: number; live: LiveNow } | null = null;

  constructor(private deps: LiveManagerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.stepSec = deps.segmentSec ?? 600;
    this.overlapSec = deps.overlapSec ?? 60;
    this.keepHours = deps.keepHours ?? 3;
    this.maxBacklog = deps.maxBacklog ?? 2;
    this.maxStreams = deps.maxStreams ?? 4;
    this.limits = deps.guard ?? DEFAULT_GUARD;
  }

  /** Closes what a restart cut off, then keeps looking: segments roll every few seconds, switches every minute. */
  async start(rollMs = 5000, syncMs = 60_000): Promise<void> {
    await this.recover();
    const look = () => this.sync().catch((err: unknown) => console.error("Live mode check failed:", err));
    void look();
    this.timers = [setInterval(() => this.roll(), rollMs), setInterval(() => void look(), syncMs)];
    for (const t of this.timers) t.unref();
  }

  /** True between start() and stop(): segments roll by themselves. */
  get started(): boolean {
    return this.timers.length > 0;
  }

  /** Stops every recorder. Recordings stay "recording" in the database and are closed by the next start. */
  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const stop of this.stops.values()) stop.abort();
  }

  /** Resolves when no recorder is running and no look is under way. */
  async settled(): Promise<void> {
    await this.syncing;
    while (this.recordings.size > 0) await Promise.all(this.recordings);
  }

  private async recover(): Promise<void> {
    for (const seg of this.deps.repo.interruptedSegments()) {
      this.deps.repo.setSegmentStatus(seg.id, "failed", "The server restarted while this was recording.");
      await this.removePartial(seg.captureId, seg.idx);
    }
    for (const capture of this.deps.repo.activeCaptures()) await this.end(capture, "The server restarted.", false);
  }

  private dir(captureId: number): string {
    return join(this.deps.mediaDir, "live", `capture-${captureId}`);
  }

  private async removePartial(captureId: number, idx: number): Promise<void> {
    const dir = this.dir(captureId);
    const files = await readdir(dir).catch(() => [] as string[]);
    for (const f of files.filter((f) => f.startsWith(`segment-${idx}.`))) await rm(join(dir, f), { force: true });
    await rmdir(dir).catch(() => undefined);
  }

  private async probe(): Promise<string | null> {
    await mkdir(this.deps.mediaDir, { recursive: true });
    return guardReason(
      { freeDiskBytes: await this.deps.system.freeDiskBytes(this.deps.mediaDir), memAvailableBytes: await this.deps.system.memAvailableBytes() },
      this.limits,
    );
  }

  /** The stream a creator is live with: what the watchlist saw, or what the drill found a moment ago. */
  private liveOf(creator: WatchedCreator): LiveNow | null {
    return creator.live ?? (this.drill?.creatorId === creator.id ? this.drill.live : null);
  }

  private decide(creator: WatchedCreator, live: { title: string; game: string | null } | null): CaptureDecision {
    const launch = this.deps.repo.launch();
    return decideCapture({
      drill: this.drill?.creatorId === creator.id,
      armed: isArmed(launch, this.now()),
      beforeLaunch: beforeLaunch(launch, this.now()),
      creatorOn: !launch.off.includes(creator.id),
      permission: creator.permissionState,
      live,
      games: creator.games,
    });
  }

  /**
   * Looks at the watchlist and the switches: starts recording who should be recorded, stops who
   * should not, deletes old segments and starts any segment that is due. Looks never overlap.
   */
  sync(): Promise<void> {
    const next = this.syncing.then(() => this.look());
    this.syncing = next.catch(() => undefined);
    return next;
  }

  private async look(): Promise<void> {
    const creators = this.deps.watchlist.list();
    this.guard = await this.probe();
    for (const capture of this.deps.repo.activeCaptures()) {
      const creator = creators.find((c) => c.id === capture.creatorId);
      if (!creator) {
        await this.end(capture, "Removed from the watchlist.", true);
        continue;
      }
      // The watchlist's "live" can blink on a platform error; the recorder itself notices a real
      // end. Until then the stream is taken to be what it was when recording began.
      const decision = this.decide(creator, creator.live ?? { title: capture.title, game: capture.game });
      if (!decision.capture) await this.end(capture, decision.reason, true);
    }
    for (const [rank, creator] of creators.entries()) {
      if (this.deps.repo.lastCapture(creator.id)?.status === "recording") {
        this.reasons.delete(creator.id);
        continue;
      }
      const live = this.liveOf(creator);
      const decision = this.decide(creator, live);
      const backoff = this.backoffs.get(creator.id);
      if (!decision.capture) this.reasons.set(creator.id, decision.reason);
      else if (this.guard) this.reasons.set(creator.id, this.guard);
      else if (backoff && !backoff.ready(this.now())) this.reasons.set(creator.id, `${backoff.lastError} Trying again soon.`);
      else if (this.deps.repo.activeCaptures().length >= this.maxStreams) {
        // The watchlist is in order of size, so the biggest creators got the places.
        this.reasons.set(creator.id, `Waiting: ${this.maxStreams} streams are being recorded, the most this server takes at once`);
      } else this.begin(creator, rank, live!);
    }
    await this.cleanup();
    this.roll();
  }

  private begin(creator: WatchedCreator, rank: number, live: LiveNow): void {
    try {
      // The same gate as "Add link" and the watchlist's auto-ingest, checked against the database now.
      this.deps.sources.assertCanUse(creator.sourceId!);
    } catch (err) {
      this.reasons.set(creator.id, (err as Error).message);
      return;
    }
    const now = this.now();
    const vod = this.deps.vods.create(creator.sourceId!, live.url);
    this.deps.vods.saveMeta(vod.id, { title: `LIVE: ${live.title || creator.name}`, durationSec: null, chapters: [] });
    this.deps.vods.setStatus(vod.id, "downloading");
    const last = this.deps.repo.lastCapture(creator.id);
    this.deps.repo.createCapture({
      creatorId: creator.id,
      sourceId: creator.sourceId!,
      vodId: vod.id,
      platform: live.platform,
      handle: creator.channels.find((c) => c.platform === live.platform)?.handle ?? "",
      url: live.url,
      title: live.title,
      game: live.game,
      rank,
      streamOffsetSec: live.startedAt ? Math.max(0, (now.getTime() - new Date(live.startedAt).getTime()) / 1000) : 0,
      startedAt: now.toISOString(),
    });
    this.reasons.delete(creator.id);
    // Not again for a recording that picks up shortly after the last one stopped (a blip, a restart).
    if (!last?.endedAt || now.getTime() - new Date(last.endedAt).getTime() > 3600_000) {
      void this.deps.notifier.notify({
        title: `Live mode started: ${creator.name}`,
        body: `Recording ${live.game ?? "the stream"} now. The first clips land in the Inbox in about 15 minutes.`,
        url: "/#dashboard",
      });
    }
  }

  /** Starts the next segment of every recording whose turn has come. */
  roll(): void {
    for (const capture of this.deps.repo.activeCaptures()) {
      const lastStart = this.deps.repo.segments(capture.id).at(-1)?.startSec ?? null;
      const elapsedSec = (this.now().getTime() - new Date(capture.startedAt).getTime()) / 1000;
      if (!segmentDue(lastStart, elapsedSec, this.stepSec)) continue;
      const recording: Promise<void> = this.record(capture, elapsedSec)
        .catch((err: unknown) => console.error("Live recording failed:", err))
        .finally(() => this.recordings.delete(recording));
      this.recordings.add(recording);
    }
  }

  private async record(capture: Capture, elapsedSec: number): Promise<void> {
    const { repo } = this.deps;
    // The row is written before anything is awaited, so the next roll sees this segment as started.
    const seg = repo.addSegment(capture.id, elapsedSec, this.now());
    const stop = this.stops.get(capture.id) ?? new AbortController();
    this.stops.set(capture.id, stop);
    const dir = this.dir(capture.id);
    let file: string;
    let durationSec: number;
    try {
      await mkdir(dir, { recursive: true });
      const full = guardReason({ freeDiskBytes: await this.deps.system.freeDiskBytes(dir) }, this.limits);
      if (full) {
        repo.setSegmentStatus(seg.id, "failed", full);
        await this.end(capture, full, true);
        return;
      }
      file = await this.deps.capturer.record(
        { platform: capture.platform, handle: capture.handle, url: capture.url },
        { durationSec: this.stepSec + this.overlapSec, dir, name: `segment-${seg.idx}`, signal: stop.signal },
      );
      durationSec = await probeDuration(file);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      repo.setSegmentStatus(seg.id, "failed", message);
      await this.removePartial(capture.id, seg.idx);
      // Stopped on purpose (a switch, the server shutting down): the reason is already recorded.
      if (stop.signal.aborted) {
        await this.forgetIfEmpty(capture.id);
        return;
      }
      const backoff = this.backoffs.get(capture.creatorId) ?? new Backoff(5 * 60_000);
      this.backoffs.set(capture.creatorId, backoff);
      backoff.fail(this.now(), `The stream could not be recorded (${message})`);
      await this.end(capture, backoff.lastError!, false);
      return;
    }
    this.backoffs.get(capture.creatorId)?.succeed();
    repo.segmentRecorded(seg.id, file, durationSec);
    const job = this.deps.queue.enqueue(
      LIVE_SEGMENT_JOB,
      { segmentId: seg.id },
      { vodId: capture.vodId, priority: livePriority(capture.rank, "segment"), maxAttempts: 2 },
    );
    repo.setSegmentJob(seg.id, job.id);
    // Falling behind: give up the oldest waiting segment instead of letting them pile up.
    for (const waiting of overBacklog(this.deps.queue.queued(LIVE_SEGMENT_JOB), this.maxBacklog)) {
      this.deps.queue.skip(waiting.id, SKIP_REASON);
    }
    if (durationSec < (this.stepSec + this.overlapSec) * ENDED_SHARE) await this.end(capture, "The stream ended.", false);
  }

  /** Closes a recording. `stopRecorders` also cuts off the segments being recorded right now. */
  private async end(capture: Capture, reason: string, stopRecorders: boolean): Promise<void> {
    const { repo } = this.deps;
    if (repo.findCapture(capture.id)?.status !== "recording") return;
    repo.endCapture(capture.id, reason, this.now());
    this.reasons.set(capture.creatorId, reason);
    if (stopRecorders) this.stops.get(capture.id)?.abort();
    this.stops.delete(capture.id);
    await this.forgetIfEmpty(capture.id);
  }

  /** A closed recording that never got a segment leaves no empty stream behind in the lists. */
  private async forgetIfEmpty(captureId: number): Promise<void> {
    const { repo } = this.deps;
    if (repo.findCapture(captureId)?.status !== "ended") return;
    if (!repo.segments(captureId).every((s) => s.durationSec === null && s.status !== "recording")) return;
    repo.removeCapture(captureId);
    await rm(this.dir(captureId), { recursive: true, force: true });
  }

  /** Deletes segment video that is too old, unless a clip is still to be cut from it. */
  private async cleanup(): Promise<void> {
    for (const seg of this.deps.repo.storedSegments()) {
      if (!segmentExpired(seg, this.now(), this.keepHours)) continue;
      await rm(seg.filePath, { force: true });
      this.deps.repo.segmentDeleted(seg.id, this.now());
      // The folder goes with its last segment.
      await rmdir(dirname(seg.filePath)).catch(() => undefined);
    }
  }

  /**
   * The launch drill: records this creator's live stream now, whatever the switches say. The
   * permission gate and the leak rules still decide. Throws with the reason when it cannot record.
   */
  async startDrill(creatorId: number, live: LiveNow): Promise<Capture> {
    this.drill = { creatorId, live };
    this.backoffs.delete(creatorId);
    await this.sync();
    const capture = this.deps.repo.lastCapture(creatorId);
    if (capture?.status === "recording") return capture;
    this.drill = null;
    throw new ValidationError(this.reasons.get(creatorId) ?? "The stream could not be recorded.");
  }

  /** Ends the drill's recording; segments already recorded are still worked through. */
  async endDrill(): Promise<void> {
    const drill = this.drill;
    this.drill = null;
    if (!drill) return;
    await this.syncing;
    const capture = this.deps.repo.lastCapture(drill.creatorId);
    if (capture) await this.end(capture, "The launch drill is over.", true);
  }

  async arm(armed: boolean): Promise<void> {
    this.deps.repo.saveLaunch({ ...this.deps.repo.launch(), manual: { armed, at: this.now().toISOString() } });
    await this.sync();
  }

  async setLaunchAt(raw: unknown): Promise<void> {
    const at = typeof raw === "string" ? new Date(raw) : null;
    if (!at || Number.isNaN(at.getTime())) throw new ValidationError("Pick the launch date and time.");
    this.deps.repo.saveLaunch({ ...this.deps.repo.launch(), launchAt: at.toISOString() });
    await this.sync();
  }

  async setCreator(creatorId: number, on: boolean): Promise<void> {
    this.deps.watchlist.get(creatorId);
    const launch = this.deps.repo.launch();
    const off = launch.off.filter((id) => id !== creatorId);
    this.deps.repo.saveLaunch({ ...launch, off: on ? off : [...off, creatorId] });
    await this.sync();
  }

  info(): LiveInfo {
    const { repo } = this.deps;
    const launch = repo.launch();
    const now = this.now();
    const all = this.deps.watchlist.list();
    const creators: LiveCreatorStatus[] = [];
    for (const c of all) {
      const capture = repo.lastCapture(c.id);
      const recording = capture?.status === "recording";
      if (c.permissionState === "none" && !recording) continue;
      // Counts are of the stream being recorded, or the one that just ended while they are still live.
      const counted = capture && (recording || c.live) ? repo.counts(capture) : { segments: 0, skipped: 0, clips: 0 };
      const decision = this.decide(c, c.live);
      creators.push({
        creatorId: c.id,
        name: c.name,
        on: !launch.off.includes(c.id),
        permissionState: c.permissionState,
        live: c.live,
        recording,
        reason: recording ? null : decision.capture ? (this.reasons.get(c.id) ?? "Starting") : decision.reason,
        ...counted,
      });
    }
    return {
      launchAt: launch.launchAt,
      beforeLaunch: beforeLaunch(launch, now),
      armed: isArmed(launch, now),
      statusLine: launchStatusLine(launch, now),
      creators,
      needPermission: all.length - creators.length,
      guard: this.guard,
      push: { publicKey: this.deps.notifier.publicKey, subscribers: repo.pushSubscriptions().length },
    };
  }
}
