import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Job } from "../../shared/types.js";
import type { ClipsRepo } from "../clips/repo.js";
import type { JobHandler } from "../jobs/queue.js";
import { renderClip } from "../pipeline/rerender/render.js";
import type { SourcesRepo } from "../sources/repo.js";
import { HOOK_VARIANTS_JOB, type HookLab } from "./lab.js";

/**
 * Renders a hook test's variants: the clip's own cut, layout and captions with another hook on
 * screen. One job renders them one after the other, in the job's temp folder.
 */
export function hookVariantsHandler(deps: { lab: HookLab; clips: ClipsRepo; sources: SourcesRepo; mediaDir: string }): JobHandler {
  return async ({ payload, tmpDir, signal, progress }) => {
    const { testId } = payload as { testId: number };
    const todo = deps.lab.variantsToRender(testId);
    for (const [i, v] of todo.entries()) {
      progress(i / todo.length, `Making hook ${v.label}`);
      const input = deps.clips.renderInput(v.clipId);
      const { faceCam } = deps.sources.get(input.sourceId);
      const out = join(tmpDir, `variant-${v.id}.mp4`);
      await renderClip({ ...input, hook: v.hook, faceCam }, out, tmpDir, signal);
      await mkdir(deps.mediaDir, { recursive: true });
      const dest = join(deps.mediaDir, `clip-${v.clipId}-hook-${v.id}.mp4`);
      try {
        await copyFile(out, dest);
        deps.lab.setVariantFile(v.id, dest);
      } catch (err) {
        await rm(dest, { force: true });
        throw err;
      }
    }
  };
}

/** Rendered: send the variants now, not at the next timer. Failed for good: the test stops. */
export function onHookVariantsFinished(lab: HookLab) {
  return (job: Job, payload: unknown): void => {
    if (job.type !== HOOK_VARIANTS_JOB) return;
    if (job.status === "done") void lab.tick().catch((err: Error) => console.error(`[hook lab] ${err.message}`));
    else lab.renderFailed((payload as { testId: number }).testId, job.error);
  };
}
