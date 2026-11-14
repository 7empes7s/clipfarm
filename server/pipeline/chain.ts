import type { Job } from "../../shared/types.js";
import type { JobQueue } from "../jobs/queue.js";
import type { PicksRepo } from "../picks/repo.js";
import type { VodsRepo } from "../vods/repo.js";
import { FORMATS_JOB } from "./formats/job.js";
import { INGEST_JOB, onIngestFinished } from "./ingest/ingest.js";
import { PICKS_JOB } from "./picks/job.js";
import { onRenderFinished, RENDER_JOB } from "./render/job.js";

/**
 * Links the pipeline steps: a finished ingest queues picking, finished picking queues one render
 * per kept pick (dropped picks are never queued). Failures mark the video or the clip failed.
 */
export function pipelineOnFinished(deps: {
  vods: VodsRepo;
  picks: PicksRepo;
  queue: () => JobQueue;
  /** Creator mode: the video is the user's own (or a client's), so it also gets square, wide and best-of outputs. */
  creatorMode?: (vodId: number) => boolean;
}) {
  const ingestFailed = onIngestFinished(deps.vods);
  const renderFailed = onRenderFinished(deps.picks);
  return (job: Job, payload: unknown): void => {
    ingestFailed(job);
    renderFailed(job, payload);
    if (job.status !== "done" || job.vodId === null) return;
    if (job.type === INGEST_JOB) {
      // A run that asked for its own number of clips (clipfarm-ops run --count) keeps it for picking.
      const { maxPicks } = (payload ?? {}) as { maxPicks?: number };
      deps.queue().enqueue(PICKS_JOB, { vodId: job.vodId, ...(maxPicks ? { maxPicks } : {}) }, { vodId: job.vodId });
    } else if (job.type === PICKS_JOB) {
      for (const p of deps.picks.listForVod(job.vodId)) {
        if (p.status === "picked") deps.queue().enqueue(RENDER_JOB, { pickId: p.id }, { vodId: job.vodId });
      }
      // After the shorts: they reach the Inbox first, the other formats follow.
      if (deps.creatorMode?.(job.vodId)) deps.queue().enqueue(FORMATS_JOB, { vodId: job.vodId }, { vodId: job.vodId, maxAttempts: 2 });
    }
  };
}
