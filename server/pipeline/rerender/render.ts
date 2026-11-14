import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClipQuality, FaceCam, Job } from "../../../shared/types.js";
import type { ClipsRepo, RenderInput } from "../../clips/repo.js";
import type { JobHandler } from "../../jobs/queue.js";
import type { SourcesRepo } from "../../sources/repo.js";
import { run } from "../../tools/exec.js";
import { probeVideo } from "../../tools/ffmpeg.js";
import { checkQuality } from "../polish/quality.js";
import { preparePolish } from "../polish/run.js";
import { wordsInWindow } from "../../clips/edit.js";
import { reactionPeak } from "../polish/plan.js";
import { editedLength, editedWords, keptSegments, toEditedTime } from "../../../shared/studio.js";
import { planConcat, planRender } from "./plan.js";

export const RENDER_CLIP_JOB = "render-clip";

/**
 * Cuts and lays out one clip from its master into `outPath` (1080×1920, captions burned in, with the
 * finishing touches the clip has turned on), then checks the result. A Studio edit list that leaves
 * more than one piece is first joined into one file in `tmpDir`, then rendered like any clip.
 */
export async function renderClip(
  input: RenderInput & { faceCam: FaceCam | null },
  outPath: string,
  tmpDir: string,
  signal?: AbortSignal,
): Promise<{ durationSec: number; quality: ClipQuality }> {
  const segments = keptSegments(input.startSec, input.endSec, input.cuts ?? []);
  if (segments.length === 0) throw new Error("The edit cuts out the whole clip.");
  if (segments.length === 1) return renderWindow({ ...input, ...segments[0]! }, outPath, tmpDir, signal);
  const master = await probeVideo(input.masterPath, signal);
  const joined = join(tmpDir, "edited.mp4");
  await run("ffmpeg", planConcat({ masterPath: input.masterPath, outPath: joined, hasAudio: master.hasAudio, segments }).args, { signal });
  const peak = input.peakSec === null ? null : toEditedTime(input.peakSec, segments);
  const out = await renderWindow(
    { ...input, masterPath: joined, startSec: 0, endSec: editedLength(segments), captionWords: editedWords(input.captionWords, segments), peakSec: peak },
    outPath,
    tmpDir,
    signal,
  );
  // A fix is in seconds of the joined file, not the master: the Studio is the place to change this clip.
  return { ...out, quality: { ...out.quality, fix: null } };
}

async function renderWindow(
  input: RenderInput & { faceCam: FaceCam | null },
  outPath: string,
  tmpDir: string,
  signal?: AbortSignal,
): Promise<{ durationSec: number; quality: ClipQuality }> {
  const master = await probeVideo(input.masterPath, signal);
  const durationSec = input.endSec - input.startSec;
  const words = wordsInWindow(input.captionWords, input.startSec, input.endSec).map((w) => ({
    ...w,
    startSec: w.startSec - input.startSec,
    endSec: w.endSec - input.startSec,
  }));
  // The measured peak when it is still inside the cut, else the transcript's own peak.
  const measured = input.peakSec !== null && input.peakSec >= input.startSec && input.peakSec < input.endSec;
  const polish = await preparePolish({
    input: input.masterPath,
    offsetSec: input.startSec,
    durationSec,
    effects: input.effects,
    hook: input.hook,
    words,
    peakSec: measured ? input.peakSec! - input.startSec : reactionPeak(words, null, durationSec),
    hasAudio: master.hasAudio,
    tmpDir,
    signal,
  });
  const plan = planRender({ ...input, outPath, srcW: master.width, srcH: master.height, polish, look: input.look ?? undefined });
  if (plan.ass) await writeFile(join(tmpDir, "captions.ass"), plan.ass);
  await run("ffmpeg", plan.args, { signal, cwd: tmpDir });
  const quality = await checkQuality(outPath, {
    ass: plan.ass, effects: input.effects, startSec: input.startSec, signal,
    text: { words, title: input.title ?? "", hook: input.hook, fixes: input.captionFixes },
  });
  return { durationSec: (await probeVideo(outPath, signal)).durationSec, quality };
}

/**
 * Makes the new version of an edited clip (one job at a time, like all heavy work). It is rendered in
 * the job's temp folder, then copied into the media folder; the clip goes back to the inbox.
 */
export function renderClipHandler(deps: { clips: ClipsRepo; sources: SourcesRepo; mediaDir: string }): JobHandler {
  return async ({ payload, tmpDir, signal, progress }) => {
    const { clipId } = payload as { clipId: number };
    const input = deps.clips.renderInput(clipId);
    const { faceCam } = deps.sources.get(input.sourceId);
    progress(0.1, "Cutting the new version");
    const out = join(tmpDir, "clip.mp4");
    const { durationSec, quality } = await renderClip({ ...input, faceCam }, out, tmpDir, signal);
    progress(0.9, "Saving");
    await mkdir(deps.mediaDir, { recursive: true });
    const dest = join(deps.mediaDir, `clip-${clipId}-${Date.now()}.mp4`);
    try {
      await copyFile(out, dest);
      deps.clips.setRendered(clipId, dest, durationSec, quality);
    } catch (err) {
      await rm(dest, { force: true });
      throw err;
    }
  };
}

/** A render that ends without success puts the clip back in the inbox with its previous video. */
export function onRenderFinished(clips: ClipsRepo) {
  return (job: Job): void => {
    if (job.type === RENDER_CLIP_JOB && job.clipId !== null && job.status !== "done" && clips.get(job.clipId).status === "rendering") {
      clips.setStatus(job.clipId, "pending");
    }
  };
}
