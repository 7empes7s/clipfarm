import type { LiveNow, WatchedCreator, WatchPlatform, WatchPlatformStatus } from "../../../shared/types.js";
import { WATCH_PLATFORMS } from "../../../shared/types.js";
import type { JobQueue } from "../../jobs/queue.js";
import { INGEST_JOB } from "../../pipeline/ingest/ingest.js";
import type { VodsRepo } from "../../vods/repo.js";
import type { SourcesRepo } from "../repo.js";
import { Backoff } from "./backoff.js";
import { decideIngest, matchVod, sameBroadcast } from "./match.js";
import { PlatformError, type PlatformClient, type RemoteVod } from "./platforms/types.js";
import type { DetectedVodRecord, WatchlistRepo } from "./repo.js";

export interface PollerDeps {
  repo: WatchlistRepo;
  sources: SourcesRepo;
  vods: VodsRepo;
  queue: JobQueue;
  clients: PlatformClient[];
  /** VODs older than this are recorded but never queued. */
  lookbackHours?: number;
  /** First wait after a platform error; doubles on each error in a row. */
  backoffBaseMs?: number;
  now?: () => Date;
}

/**
 * Checks every watched channel for live streams and new VODs, and queues matching VODs of
 * creators with an active permission record and auto-ingest on, newest first. The job queue
 * runs them one at a time.
 */
export class WatchlistPoller {
  lastPollAt: Date | null = null;
  private backoffs = new Map<WatchPlatform, Backoff>();
  private running: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => Date;
  private readonly lookbackMs: number;

  constructor(private deps: PollerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.lookbackMs = (deps.lookbackHours ?? 48) * 3600_000;
    for (const c of deps.clients) this.backoffs.set(c.platform, new Backoff(deps.backoffBaseMs ?? 5 * 60_000));
  }

  start(intervalMs: number): void {
    const tick = () => this.pollAll().catch((err: unknown) => console.error("Watchlist check failed:", err));
    void tick();
    this.timer = setInterval(() => void tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): WatchPlatformStatus[] {
    return WATCH_PLATFORMS.map((platform) => {
      const client = this.deps.clients.find((c) => c.platform === platform);
      const backoff = this.backoffs.get(platform);
      const waiting = backoff?.until && !backoff.ready(this.now());
      return {
        platform,
        configured: !!client && client.missing === null,
        note: !client ? "Not set up." : (client.missing ?? (waiting ? `${backoff.lastError} Trying again later.` : null)),
        nextTryAt: waiting ? backoff.until!.toISOString() : null,
      };
    });
  }

  /** Checks every creator. Polls never overlap: a second call waits for the first. */
  pollAll(): Promise<void> {
    return this.serial(() => this.poll(this.deps.repo.list()));
  }

  pollCreator(id: number): Promise<void> {
    return this.serial(() => this.poll([this.deps.repo.get(id)]));
  }

  private serial(fn: () => Promise<void>): Promise<void> {
    const next = this.running.then(fn, fn);
    this.running = next.catch(() => undefined);
    return next;
  }

  private async poll(creators: WatchedCreator[]): Promise<void> {
    const seen: { creator: WatchedCreator; vod: DetectedVodRecord }[] = [];
    for (const creator of creators) {
      let live: LiveNow | null = null;
      for (const channel of creator.channels) {
        const client = this.deps.clients.find((c) => c.platform === channel.platform);
        const backoff = this.backoffs.get(channel.platform);
        if (!client || client.missing || !backoff?.ready(this.now())) continue;
        let vods: RemoteVod[];
        try {
          const result = await client.check(channel.handle);
          backoff.succeed();
          live ??= result.live;
          vods = result.vods;
        } catch (err) {
          if (!(err instanceof PlatformError)) throw err;
          // A missing channel is the entry's problem, not the platform's: skip it, keep polling.
          if (err.channelMissing) continue;
          backoff.fail(this.now(), err.message, err.retryAfterSec);
          continue;
        }
        for (const v of vods) seen.push({ creator, vod: this.deps.repo.upsertDetected(creator.id, v) });
      }
      this.deps.repo.setLive(creator.id, live);
    }

    seen.sort((a, b) => b.vod.publishedAt.localeCompare(a.vod.publishedAt));
    for (const { creator, vod } of seen) this.consider(creator, vod);
    this.lastPollAt = this.now();
  }

  private consider(creator: WatchedCreator, vod: DetectedVodRecord): void {
    if (vod.status === "queued") return;
    const already = this.deps.repo.queuedFor(creator.id).find((q) => sameBroadcast(q, vod));
    const decision = decideIngest({
      permission: creator.permissionState,
      autoIngest: creator.autoIngest,
      title: vod.title,
      match: matchVod(vod, creator.games),
      tooOld: this.now().getTime() - new Date(vod.publishedAt).getTime() > this.lookbackMs,
      duplicateOf: already?.platform ?? null,
    });
    if (!decision.queue) {
      this.deps.repo.markSkipped(vod.id, decision.reason);
      return;
    }
    // The same gate the "Add link" form uses, checked against the database right now.
    this.deps.sources.assertCanUse(creator.sourceId!);
    const added = this.deps.vods.list().find((v) => v.sourceId === creator.sourceId && v.url === vod.url);
    const target = added ?? this.deps.vods.create(creator.sourceId!, vod.url);
    if (!added) this.deps.queue.enqueue(INGEST_JOB, { vodId: target.id }, { vodId: target.id });
    this.deps.repo.markQueued(vod.id, target.id);
  }
}
