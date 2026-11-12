import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FaceCam, Job } from "../../../shared/types.js";
import type { ClipsRepo, RenderInput } from "../../clips/repo.js";
import type { JobHandler } from "../../jobs/queue.js";
import type { SourcesRepo } from "../../sources/repo.js";
import { run } from "../../tools/exec.js";
import { probeDuration, probeVideoSize } from "../../tools/ffmpeg.js";
import { planRender } from "./plan.js";

export const RENDER_CLIP_JOB = "render-clip";

/** Cuts and lays out one clip from its master into `outPath` (1080×1920, captions burned in). */
export async function renderClip(
  input: RenderInput & { faceCam: FaceCam | null },
  outPath: string,
  tmpDir: string,
  signal?: AbortSignal,
): Promise<number> {
  const { width, height } = await probeVideoSize(input.masterPath, signal);
  const plan = planRender({ ...input, outPath, srcW: width, srcH: height });
  if (plan.ass) await writeFile(join(tmpDir, "captions.ass"), plan.ass);
  await run("ffmpeg", plan.args, { signal, cwd: tmpDir });
  return probeDuration(outPath, signal);
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
    const durationSec = await renderClip({ ...input, faceCam }, out, tmpDir, signal);
    progress(0.9, "Saving");
    await mkdir(deps.mediaDir, { recursive: true });
    const dest = join(deps.mediaDir, `clip-${clipId}-${Date.now()}.mp4`);
    try {
      await copyFile(out, dest);
      deps.clips.setRendered(clipId, dest, durationSec);
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
