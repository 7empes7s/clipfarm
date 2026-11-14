import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Brand } from "../../../shared/creator.js";
import type { OutputsRepo } from "../../creator/outputs.js";
import type { JobHandler } from "../../jobs/queue.js";
import type { PicksRepo } from "../../picks/repo.js";
import type { SourcesRepo } from "../../sources/repo.js";
import { probeVideo } from "../../tools/ffmpeg.js";
import type { VodsRepo } from "../../vods/repo.js";
import { clipWords } from "../render/captions.js";
import { grabFrame } from "../render/render.js";
import { type SectionDownloader, sectionFor } from "../render/section.js";
import { planFormats, suggestMeta, thumbnailAt } from "./plan.js";
import { type FormatInput, formatAss, renderFormat } from "./render.js";

export const FORMATS_JOB = "formats";

export interface FormatsDeps {
  sources: SourcesRepo;
  vods: VodsRepo;
  picks: PicksRepo;
  outputs: OutputsRepo;
  downloader: SectionDownloader;
  /** True when the video is sound only (a podcast episode): audiograms instead of square and wide cuts. */
  audioOnly: (url: string) => boolean;
  brand: (sourceId: number) => Brand;
  /** Outputs go to <mediaDir>/outputs. */
  mediaDir: string;
  preset?: string;
}

/**
 * Long video → other formats. After the picks of an own-content video, square and wide cuts of the
 * best picks (audiograms for sound-only videos) and a 3-8 min best-of, each with a suggested title,
 * description, chapters and thumbnail. One output failing does not stop the others.
 */
export function formatsHandler(deps: FormatsDeps): JobHandler {
  return async ({ payload, tmpDir, signal, progress }) => {
    const { vodId } = payload as { vodId: number };
    const vod = deps.vods.detail(vodId);
    deps.sources.assertCanUse(vod.sourceId);
    const kept = deps.picks.listForVod(vodId).filter((p) => p.status !== "dropped" && !Object.values(p.flags).some(Boolean));
    const plan = planFormats({
      picks: kept.map((p) => ({ startSec: p.startSec, endSec: p.endSec, score: p.score, title: p.title })),
      audioOnly: deps.audioOnly(vod.url),
    });
    const outputs = deps.outputs.replaceForVod(vodId, vod.sourceId, plan);
    const brand = deps.brand(vod.sourceId);
    const loudness = deps.vods.loudness(vodId);
    const dir = join(deps.mediaDir, "outputs");
    await mkdir(dir, { recursive: true });

    for (const [n, out] of outputs.entries()) {
      progress(0.05 + (0.9 * n) / outputs.length, `Making ${out.format} ${n + 1} of ${outputs.length}`);
      const work = join(tmpDir, `output-${out.id}`);
      await mkdir(work, { recursive: true });
      const filePath = join(dir, `output-${out.id}.mp4`);
      const thumbPath = join(dir, `output-${out.id}.jpg`);
      try {
        const inputs: FormatInput[] = [];
        for (const [i, r] of out.ranges.entries()) {
          const section = sectionFor(r.startSec, r.endSec, vod.durationSec);
          const piece = join(work, `piece-${i}`);
          await mkdir(piece, { recursive: true });
          const file = await deps.downloader.downloadSection(vod.url, section, piece, signal);
          inputs.push({ file, offsetSec: r.startSec - section.startSec, durationSec: r.endSec - r.startSec });
        }
        const info = await probeVideo(inputs[0]!.file, signal);
        // Captions on single-moment outputs; a best-of runs minutes and goes out without them.
        const single = out.ranges.length === 1 && out.format !== "best-of";
        if (single) await writeFile(join(work, "captions.ass"), formatAss(clipWords(vod.words, out.ranges[0]!.startSec, out.ranges[0]!.endSec), out.format, brand.color));
        await renderFormat({
          format: out.format,
          inputs,
          src: { w: info.width, h: info.height },
          assFile: single ? "captions.ass" : null,
          color: brand.color,
          output: join(work, "out.mp4"),
          cwd: work,
          preset: deps.preset,
          signal,
        });
        const first = out.ranges[0]!;
        await grabFrame(join(work, "out.mp4"), thumbnailAt(first, loudness) - first.startSec, join(work, "thumb.jpg"), { width: 720, signal });
        const made = await probeVideo(join(work, "out.mp4"), signal);
        await copyFile(join(work, "out.mp4"), filePath);
        await copyFile(join(work, "thumb.jpg"), thumbPath);
        const titles = out.ranges.map((r) => kept.find((p) => p.startSec === r.startSec && p.endSec === r.endSec)?.title ?? "");
        deps.outputs.finish(out.id, {
          filePath,
          thumbPath,
          durationSec: Math.round(made.durationSec * 10) / 10,
          ...suggestMeta({ format: out.format, ranges: out.ranges, titles, words: vod.words, vodTitle: vod.title, chapters: vod.chapters, brand }),
        });
      } catch (err) {
        signal.throwIfAborted();
        for (const f of [filePath, thumbPath]) await rm(f, { force: true });
        deps.outputs.fail(out.id, err instanceof Error ? err.message : String(err));
      } finally {
        // Each output's pieces go as soon as it is made, so a long best-of never piles up on disk.
        await rm(work, { recursive: true, force: true });
      }
    }
  };
}
