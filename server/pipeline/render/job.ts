import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Job } from "../../../shared/types.js";
import { HttpError } from "../../errors.js";
import type { JobHandler } from "../../jobs/queue.js";
import type { PicksRepo } from "../../picks/repo.js";
import type { SourcesRepo } from "../../sources/repo.js";
import { probeVideo } from "../../tools/ffmpeg.js";
import type { VodsRepo } from "../../vods/repo.js";
import { buildAss, clipWords } from "./captions.js";
import { planLayout } from "./layout.js";
import { grabFrame, renderClip } from "./render.js";
import { type SectionDownloader, sectionFor } from "./section.js";

export const RENDER_JOB = "render";

export interface RenderDeps {
  sources: SourcesRepo;
  vods: VodsRepo;
  picks: PicksRepo;
  downloader: SectionDownloader;
  /** Final clips go to <mediaDir>/clips, creator frames to <mediaDir>/frames. Nothing else stays. */
  mediaDir: string;
  preset?: string;
}

/**
 * pick → 9:16 clip. Downloads only the picked section (plus padding) into the job's temp folder,
 * renders the layout with burned-in karaoke captions and the hook, and keeps just the MP4 and a
 * thumbnail in media/. The temp folder (section, captions) is removed by the queue.
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
    await timed("render", async () => {
      const info = await probeVideo(input, signal);
      const plan = planLayout(pick.layout, info.width, info.height, source.faceCam);
      await writeFile(join(tmpDir, "captions.ass"), buildAss(clipWords(vod.words, pick.startSec, pick.endSec), pick.hook));
      await renderClip({
        input,
        offsetSec: pick.startSec - section.startSec,
        durationSec,
        plan,
        assFile: "captions.ass",
        cwd: tmpDir,
        output: join(tmpDir, "clip.mp4"),
        preset: deps.preset,
        signal,
      });
      await grabFrame(join(tmpDir, "clip.mp4"), Math.min(1, durationSec / 2), join(tmpDir, "thumb.jpg"), { signal });
      if (!source.hasFrame) {
        // A frame of the creator's stream, to draw the face cam box on in the gallery.
        await grabFrame(input, pick.startSec - section.startSec, join(tmpDir, "frame.jpg"), { width: 960, signal });
      }
    });

    progress(0.95, "Saving the clip");
    const clipsDir = join(deps.mediaDir, "clips");
    await mkdir(clipsDir, { recursive: true });
    const filePath = join(clipsDir, `pick-${pickId}.mp4`);
    const thumbPath = join(clipsDir, `pick-${pickId}.jpg`);
    try {
      await copyFile(join(tmpDir, "clip.mp4"), filePath);
      await copyFile(join(tmpDir, "thumb.jpg"), thumbPath);
      if (!source.hasFrame) {
        const framesDir = join(deps.mediaDir, "frames");
        await mkdir(framesDir, { recursive: true });
        const framePath = join(framesDir, `source-${source.id}.jpg`);
        await copyFile(join(tmpDir, "frame.jpg"), framePath);
        deps.sources.setFramePath(source.id, framePath);
      }
    } catch (err) {
      await rm(filePath, { force: true });
      await rm(thumbPath, { force: true });
      throw err;
    }
    const out = await probeVideo(filePath, signal);
    const saved = deps.picks.saveRender(pickId, {
      filePath,
      thumbPath,
      sizeBytes: (await stat(filePath)).size,
      durationSec: Math.round(out.durationSec * 1000) / 1000,
      steps,
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
    const pick = picks.get(pickId);
    if (pick.status !== "dropped") picks.setStatus(pickId, "failed", job.error ?? job.message);
  };
}
