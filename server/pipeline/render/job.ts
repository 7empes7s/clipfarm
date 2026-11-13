import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClipQuality, Job } from "../../../shared/types.js";
import { DEFAULT_EFFECTS } from "../../../shared/types.js";
import { HttpError } from "../../errors.js";
import type { ClipsRepo } from "../../clips/repo.js";
import type { JobHandler } from "../../jobs/queue.js";
import type { PicksRepo } from "../../picks/repo.js";
import type { SourcesRepo } from "../../sources/repo.js";
import { probeVideo } from "../../tools/ffmpeg.js";
import type { VodsRepo } from "../../vods/repo.js";
import { reactionPeak } from "../polish/plan.js";
import { checkQuality } from "../polish/quality.js";
import { preparePolish } from "../polish/run.js";
import { buildAss, clipWords } from "./captions.js";
import { planLayout } from "./layout.js";
import { grabFrame, renderClip } from "./render.js";
import { type SectionDownloader, sectionFor } from "./section.js";

export const RENDER_JOB = "render";

export interface RenderDeps {
  sources: SourcesRepo;
  vods: VodsRepo;
  picks: PicksRepo;
  /** Each rendered pick becomes a clip waiting for review (and then posting). */
  clips: ClipsRepo;
  downloader: SectionDownloader;
  /** Final clips go to <mediaDir>/clips, creator frames to <mediaDir>/frames. Nothing else stays. */
  mediaDir: string;
  preset?: string;
}

/**
 * pick → 9:16 clip. Downloads only the picked section (plus padding) into the job's temp folder,
 * renders the layout with burned-in karaoke captions, the hook card and the other finishing touches,
 * checks the result, and keeps just the MP4 and a thumbnail in media/. The temp folder (section,
 * captions, measurements) is removed by the queue.
 */
export function renderHandler(deps: RenderDeps): JobHandler {
  return async ({ payload, tmpDir, signal, progress }) => {
    const { pickId } = payload as { pickId: number };
    const pick = deps.picks.get(pickId);
    if (pick.status === "dropped" || Object.values(pick.flags).some(Boolean)) {
      // Charter: a flagged pick (spoiler, cutscene, ending, leak, brief) never renders.
      throw new HttpError(409, `"${pick.title}" was left out (${pick.dropReason ?? "flagged"}), so it is not rendered.`);
    }
    deps.sources.assertCanUse(pick.sourceId);
    const source = deps.sources.get(pick.sourceId);
    const vod = deps.vods.detail(pick.vodId);
    deps.picks.setStatus(pickId, "rendering");
    const steps = pick.steps.filter((s) => s.step === "pick");
    const timed = async <T>(step: string, fn: () => Promise<T>): Promise<T> => {
      const t = Date.now();
      const out = await fn();
      steps.push({ step, ms: Date.now() - t });
      return out;
    };

    progress(0.05, "Downloading the clip's video");
    const section = sectionFor(pick.startSec, pick.endSec, vod.durationSec);
    const input = await timed("download", () => deps.downloader.downloadSection(vod.url, section, tmpDir, signal));

    progress(0.3, "Cutting and adding captions");
    const durationSec = pick.endSec - pick.startSec;
    const offsetSec = pick.startSec - section.startSec;
    const words = clipWords(vod.words, pick.startSec, pick.endSec);
    // The reaction peak: the same loudness and transcript score the picks used, inside this clip.
    const loudness = deps.vods.loudness(pick.vodId).slice(Math.floor(pick.startSec), Math.ceil(pick.endSec));
    const peakSec = reactionPeak(words, loudness, durationSec);
    let plannedLayout = pick.layout;
    let quality: ClipQuality | null = null;
    await timed("render", async () => {
      const info = await probeVideo(input, signal);
      const plan = planLayout(pick.layout, info.width, info.height, source.faceCam);
      plannedLayout = plan.layout;
      const polish = await preparePolish({
        input, offsetSec, durationSec, effects: DEFAULT_EFFECTS, hook: pick.hook, words, peakSec, hasAudio: info.hasAudio, tmpDir, signal,
      });
      const ass = buildAss(words, polish.hookCard ? pick.hook : "");
      await writeFile(join(tmpDir, "captions.ass"), ass);
      await renderClip({
        input,
        offsetSec,
        durationSec,
        plan,
        assFile: "captions.ass",
        cwd: tmpDir,
        output: join(tmpDir, "clip.mp4"),
        preset: deps.preset,
        polish,
        signal,
      });
      quality = await checkQuality(join(tmpDir, "clip.mp4"), { ass, effects: DEFAULT_EFFECTS, startSec: offsetSec, signal });
      await grabFrame(join(tmpDir, "clip.mp4"), Math.min(1, durationSec / 2), join(tmpDir, "thumb.jpg"), { signal });
    });

    progress(0.95, "Saving the clip");
    const clipsDir = join(deps.mediaDir, "clips");
    await mkdir(clipsDir, { recursive: true });
    const filePath = join(clipsDir, `pick-${pickId}.mp4`);
    const thumbPath = join(clipsDir, `pick-${pickId}.jpg`);
    // The section stays as the clip's master, so an edit in the gallery (trim, layout, captions) can
    // re-render without downloading again. The section and captions in tmpDir go with the job.
    const masterPath = join(clipsDir, `pick-${pickId}-master.mp4`);
    try {
      await copyFile(join(tmpDir, "clip.mp4"), filePath);
      await copyFile(join(tmpDir, "thumb.jpg"), thumbPath);
      await copyFile(input, masterPath);
    } catch (err) {
      for (const f of [filePath, thumbPath, masterPath]) await rm(f, { force: true });
      throw err;
    }
    const out = await probeVideo(filePath, signal);
    const clipDurationSec = Math.round(out.durationSec * 1000) / 1000;
    const clipId =
      pick.clipId ??
      deps.clips.create({
        sourceId: pick.sourceId,
        vodId: pick.vodId,
        title: pick.title,
        filePath,
        durationSec: clipDurationSec,
        hook: pick.hook,
        reason: pick.reason,
        score: pick.score,
        layout: plannedLayout,
        // Timed in master seconds, as the gallery's editor expects.
        captionWords: clipWords(vod.words, section.startSec, section.endSec),
        masterPath,
        masterDurationSec: section.endSec - section.startSec,
        startSec: offsetSec,
        endSec: offsetSec + durationSec,
        peakSec: peakSec === null ? null : offsetSec + peakSec,
        quality,
      }).id;
    // A pick rendered again keeps its clip; the check applies only while the clip still shows this file.
    if (pick.clipId && quality && deps.clips.filePath(clipId) === filePath) deps.clips.setQuality(clipId, quality);
    const saved = deps.picks.saveRender(pickId, {
      filePath,
      thumbPath,
      sizeBytes: (await stat(filePath)).size,
      durationSec: clipDurationSec,
      steps,
      clipId,
    });
    console.log(
      `[render] clip ${pickId} "${saved.title}": ${steps.map((s) => `${s.step} ${s.ms} ms`).join(", ")}, ` +
        `${(saved.sizeBytes! / 1e6).toFixed(1)} MB, cost $${saved.costUsd.toFixed(4)}`,
    );
  };
}

/** Marks the pick failed when its render job ends without success. */
export function onRenderFinished(picks: PicksRepo) {
  return (job: Job, payload: unknown): void => {
    if (job.type !== RENDER_JOB || job.status === "done") return;
    const { pickId } = payload as { pickId: number };
    // The pick may be gone: a picks re-run replaces unrendered picks (and queues their own renders).
    const pick = picks.find(pickId);
    if (pick && pick.status !== "dropped") picks.setStatus(pickId, "failed", job.error ?? job.message);
  };
}
