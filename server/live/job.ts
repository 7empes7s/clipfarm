import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Job, Pick } from "../../shared/types.js";
import { HttpError } from "../errors.js";
import type { JobHandler, JobQueue } from "../jobs/queue.js";
import type { PicksRepo } from "../picks/repo.js";
import { bannedTerms, reviewPicks } from "../pipeline/picks/review.js";
import { toSentences } from "../pipeline/picks/sentences.js";
import { measureLoudness } from "../pipeline/picks/signals.js";
import type { Picker } from "../pipeline/picks/types.js";
import { RENDER_JOB } from "../pipeline/render/job.js";
import type { Section } from "../pipeline/render/section.js";
import type { Transcriber } from "../pipeline/transcript/types.js";
import type { SourcesRepo } from "../sources/repo.js";
import { run } from "../tools/exec.js";
import { extractAudio, probeDuration } from "../tools/ffmpeg.js";
import type { VodsRepo } from "../vods/repo.js";
import type { Notifier } from "./notify.js";
import { coveringSegment, livePriority, sectionWithin, type SegmentTimes } from "./plan.js";
import type { LiveRepo, Segment } from "./repo.js";

export const LIVE_SEGMENT_JOB = "live-segment";

export interface LiveSegmentDeps {
  repo: LiveRepo;
  sources: SourcesRepo;
  vods: VodsRepo;
  picks: PicksRepo;
  transcriber: Transcriber;
  picker: Picker;
  queue: () => JobQueue;
  /** Clips made per segment: only the top moments, so they are in the Inbox fast. */
  maxPicks?: number;
  /** How much of the stream before this segment the picker also reads, for context. */
  contextSec?: number;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Segments with their video still on disk, as time ranges of the recording. */
function onDisk(segments: Segment[]): (Segment & SegmentTimes & { filePath: string })[] {
  return segments.filter(
    (s): s is Segment & SegmentTimes & { filePath: string } => s.durationSec !== null && s.filePath !== null && s.deletedAt === null,
  );
}

/**
 * One recorded segment → transcript → picks → render jobs, while the stream goes on. The words
 * join the stream's running transcript, the picker reads this segment with the last few for
 * context, and the charter gate decides as for a VOD. Only moments that are whole in a recorded
 * segment and were not picked before are kept; each is queued to render at once, ahead of VOD work.
 */
export function liveSegmentHandler(deps: LiveSegmentDeps): JobHandler {
  const maxPicks = deps.maxPicks ?? 3;
  const contextSec = deps.contextSec ?? 1200;
  return async ({ payload, tmpDir, signal, progress }) => {
    const seg = deps.repo.segment((payload as { segmentId: number }).segmentId);
    const capture = deps.repo.capture(seg.captureId);
    if (seg.durationSec === null || !seg.filePath || seg.deletedAt || !existsSync(seg.filePath)) {
      throw new HttpError(410, "This live segment's video is no longer on the server.");
    }
    // Checked again here: the permission may have expired since the recording began.
    const permission = deps.sources.assertCanUse(capture.sourceId);
    const source = deps.sources.get(capture.sourceId);
    deps.repo.setSegmentStatus(seg.id, "queued");

    progress(0.05, "Preparing audio");
    const audio = join(tmpDir, "speech.mp3");
    await extractAudio(seg.filePath, audio, { signal });
    const audioSec = await probeDuration(audio, signal);
    const loudness = await measureLoudness(audio, signal);

    progress(0.15, "Transcribing");
    const transcript = await deps.transcriber.transcribe(audio, {
      durationSec: audioSec,
      tmpDir,
      signal,
      onProgress: (f) => progress(0.15 + f * 0.55, "Transcribing"),
    });
    const endSec = seg.startSec + seg.durationSec;
    deps.vods.mergeLive(
      capture.vodId,
      { startSec: seg.startSec, endSec },
      transcript.words.map((w) => ({ word: w.word, startSec: round(w.startSec + seg.startSec), endSec: round(w.endSec + seg.startSec) })),
      loudness,
      deps.transcriber.name,
      transcript.costUsd,
    );

    progress(0.75, "Finding highlights");
    const vod = deps.vods.detail(capture.vodId);
    const fromSec = Math.max(0, seg.startSec - contextSec);
    const words = vod.words.filter((w) => w.startSec >= fromSec && w.startSec < endSec);
    const started = Date.now();
    const result = await deps.picker.pick(
      {
        title: vod.title,
        durationSec: endSec - fromSec,
        chapters: [],
        // The picker sees a window of the stream that starts at 0.
        words: words.map((w) => ({ word: w.word, startSec: round(w.startSec - fromSec), endSec: round(w.endSec - fromSec) })),
        signals: { loudness: deps.vods.loudness(capture.vodId).slice(Math.floor(fromSec), Math.ceil(endSec)), chat: null },
        creatorName: source.creatorName,
        briefRules: permission.briefRules,
        bannedContent: source.bannedContent,
        // It may also name moments in the context, which were picked before: ask for more than are kept.
        maxPicks: maxPicks * 3,
      },
      signal,
    );
    const ms = Date.now() - started;

    progress(0.9, "Checking picks");
    const before = deps.picks.listForVod(capture.vodId);
    const stored = onDisk(deps.repo.segments(capture.id));
    const fresh = result.picks
      .map((p) => ({ ...p, startSec: p.startSec + fromSec, endSec: p.endSec + fromSec }))
      // Not what an earlier segment already covered, and not the same moment twice.
      .filter((p) => p.endSec > seg.startSec && !before.some((b) => p.startSec < b.endSec && b.startSec < p.endSec));
    const reviewed = reviewPicks(fresh, toSentences(words), words, bannedTerms(permission.briefRules, source.bannedContent), maxPicks)
      // A moment that runs past what is recorded so far comes back with the next segment, whole.
      .filter((p) => p.dropReason || coveringSegment(stored, p.startSec, p.endSec));
    const kept = reviewed.filter((p) => !p.dropReason).length;
    const costUsd = kept > 0 ? (transcript.costUsd + result.costUsd) / kept : 0;
    const steps = [{ step: "pick", ms: Math.round(ms / Math.max(1, kept)) }];
    const added = deps.picks.add(
      capture.vodId,
      capture.sourceId,
      reviewed.map((p) => ({
        ...p,
        layout: source.faceCam ? "stacked" : p.layout,
        costUsd: p.dropReason ? 0 : Math.round(costUsd * 1e6) / 1e6,
        steps: p.dropReason ? [] : steps,
      })),
    );
    deps.repo.setSegmentStatus(seg.id, "done", `${kept} ${kept === 1 ? "clip" : "clips"}`);
    console.log(`[live] stream ${capture.vodId} segment ${seg.idx}: ${kept} kept, ${reviewed.length - kept} left out, picker ${deps.picker.name} ${ms} ms`);
    // Last, so a failure above never leaves render jobs behind: the top moments are cut at once.
    for (const p of added) {
      if (p.status === "picked") {
        deps.queue().enqueue(RENDER_JOB, { pickId: p.id }, { vodId: capture.vodId, priority: livePriority(capture.rank, "clip") });
      }
    }
  };
}

export interface LiveCut {
  /** The cut section; it starts at `section.startSec`. */
  input: string;
  section: Section;
  live: { streamSec: number; momentAt: string };
}

/** ffmpeg arguments to cut a section out of a recorded segment, frame-exact (so captions stay in time). */
export function cutArgs(input: string, offsetSec: number, durationSec: number, output: string, preset = "veryfast"): string[] {
  return [
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", offsetSec.toFixed(3), "-i", input, "-t", durationSec.toFixed(3),
    "-c:v", "libx264", "-preset", preset, "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k",
    "-movflags", "+faststart",
    output,
  ];
}

/**
 * For the renderer: a LIVE pick's video comes from the recorded segment that holds the moment
 * whole (the overlap sees to it that one does), not from a download. Null for a pick of a VOD.
 */
export function liveCutter(repo: LiveRepo, preset?: string) {
  return async (pick: Pick, tmpDir: string, signal?: AbortSignal): Promise<LiveCut | null> => {
    const capture = repo.captureByVod(pick.vodId);
    if (!capture) return null;
    const seg = coveringSegment(onDisk(repo.segments(capture.id)), pick.startSec, pick.endSec);
    if (!seg || !existsSync(seg.filePath)) {
      throw new HttpError(410, "The recording of this moment is no longer on the server, so the clip cannot be cut.");
    }
    const section = sectionWithin(seg, pick.startSec, pick.endSec);
    const input = join(tmpDir, "section.mp4");
    await run("ffmpeg", cutArgs(seg.filePath, section.startSec - seg.startSec, section.endSec - section.startSec, input, preset), { signal });
    return {
      input,
      section,
      live: {
        streamSec: round(capture.streamOffsetSec + pick.startSec),
        // The moment is over at the pick's last second, counted from when this segment began recording.
        momentAt: new Date(new Date(seg.startedAt).getTime() + (pick.endSec - seg.startSec) * 1000).toISOString(),
      },
    };
  };
}

/** After a job ends: keeps a segment's status true, and tells the manager about a stream's first LIVE clip. */
export function liveOnFinished(deps: { repo: LiveRepo; picks: PicksRepo; sources: SourcesRepo; notifier: Notifier; now?: () => Date }) {
  return (job: Job, payload: unknown): void => {
    if (job.type === LIVE_SEGMENT_JOB && job.status !== "done") {
      const seg = deps.repo.segmentByJob(job.id);
      if (seg) deps.repo.setSegmentStatus(seg.id, job.status === "failed" ? "failed" : "skipped", job.error ?? job.message);
    }
    if (job.type !== RENDER_JOB || job.status !== "done") return;
    const pick = deps.picks.find((payload as { pickId: number }).pickId);
    const capture = pick && deps.repo.captureByVod(pick.vodId);
    if (!pick || !capture || !deps.repo.markFirstClip(capture.id, (deps.now ?? (() => new Date()))())) return;
    void deps.notifier.notify({
      title: `First LIVE clip: ${deps.sources.get(capture.sourceId).creatorName}`,
      body: `"${pick.title}" is waiting in the Inbox.`,
      url: "/#inbox",
    });
  };
}
