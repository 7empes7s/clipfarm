import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { ClipThumb, ClipThumbs } from "../../shared/google.js";
import type { ClipsRepo } from "../clips/repo.js";
import type { Db } from "../db/index.js";
import { NotFoundError } from "../errors.js";
import type { JobHandler, JobQueue } from "../jobs/queue.js";
import { grabFrame } from "../pipeline/render/render.js";
import { run } from "../tools/exec.js";
import { type GoogleAi, GoogleUnavailableError } from "./service.js";

export const THUMBS_JOB = "thumbnails";

/** The two sizes every option comes in: a 9:16 cover (Shorts, TikTok, Reels) and YouTube's 1280×720. */
export const COVER_SIZE = { width: 1080, height: 1920 };
export const WIDE_SIZE = { width: 1280, height: 720 };

/** How the two AI options differ, so the manager has a real choice. */
const STYLES = [
  { label: "Option A", how: "Put the text at the top in very large, bold, high-contrast letters. Make the colours punchier." },
  { label: "Option B", how: "Zoom in on the most dramatic part of the frame and put the text at the bottom in large, bold, outlined letters." },
];

export function thumbPrompt(hook: string, how: string): string {
  return [
    "Turn this frame from a video-game stream clip into a vertical 9:16 thumbnail that makes people tap.",
    "Keep what the frame shows: the same scene, the same people, the same game. Do not invent events that are not in it.",
    `Add exactly this text, spelled exactly like this, and no other text: "${hook}"`,
    how,
    "No logos, no watermarks, no borders.",
  ].join("\n");
}

interface ThumbRow {
  id: number;
  clip_id: number;
  label: string;
  ai: number;
  cover_path: string;
  wide_path: string;
  chosen: number;
}

const toThumb = (r: ThumbRow): ClipThumb => ({
  id: r.id,
  clipId: r.clip_id,
  label: r.label,
  ai: r.ai === 1,
  chosen: r.chosen === 1,
  coverUrl: `/api/thumbnails/${r.id}/cover`,
  wideUrl: `/api/thumbnails/${r.id}/wide`,
});

export class ThumbsRepo {
  constructor(
    private db: Db,
    private now: () => Date = () => new Date(),
  ) {}

  listForClip(clipId: number): ClipThumb[] {
    return (this.db.prepare("SELECT * FROM clip_thumbs WHERE clip_id = ? ORDER BY id").all(clipId) as ThumbRow[]).map(toThumb);
  }

  /** Puts a new set of options in place of the old one (whose files are removed). The first is not chosen: the manager picks. */
  replaceForClip(clipId: number, options: { label: string; ai: boolean; coverPath: string; widePath: string }[]): ClipThumb[] {
    const old = this.db.prepare("SELECT cover_path, wide_path FROM clip_thumbs WHERE clip_id = ?").all(clipId) as { cover_path: string; wide_path: string }[];
    const ts = this.now().toISOString();
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM clip_thumbs WHERE clip_id = ?").run(clipId);
      const insert = this.db.prepare("INSERT INTO clip_thumbs (clip_id, label, ai, cover_path, wide_path, created_at) VALUES (?, ?, ?, ?, ?, ?)");
      for (const o of options) insert.run(clipId, o.label, o.ai ? 1 : 0, o.coverPath, o.widePath, ts);
    })();
    const kept = new Set(options.flatMap((o) => [o.coverPath, o.widePath]));
    for (const f of old.flatMap((o) => [o.cover_path, o.wide_path])) if (!kept.has(f)) rmSync(f, { force: true });
    return this.listForClip(clipId);
  }

  private row(id: number): ThumbRow {
    const row = this.db.prepare("SELECT * FROM clip_thumbs WHERE id = ?").get(id) as ThumbRow | undefined;
    if (!row) throw new NotFoundError("That thumbnail was not found.");
    return row;
  }

  /** The manager's pick: one per clip. */
  choose(id: number): ClipThumb[] {
    const { clip_id: clipId } = this.row(id);
    this.db.prepare("UPDATE clip_thumbs SET chosen = (id = ?) WHERE clip_id = ?").run(id, clipId);
    return this.listForClip(clipId);
  }

  /** Server-side paths; never sent to the client. */
  files(id: number): { cover: string; wide: string } {
    const r = this.row(id);
    return { cover: r.cover_path, wide: r.wide_path };
  }
}

const QUIET = ["-hide_banner", "-loglevel", "error", "-y"];

/**
 * Any picture → the two exact sizes. The cover fills 1080×1920; the wide one shows the whole
 * picture in the middle of a blurred copy of itself, so nothing of a vertical picture is cut off.
 */
export async function writeSizes(image: string, coverOut: string, wideOut: string, signal?: AbortSignal): Promise<void> {
  const { width: cw, height: ch } = COVER_SIZE;
  const { width: ww, height: wh } = WIDE_SIZE;
  await run(
    "ffmpeg",
    [...QUIET, "-i", image, "-vf", `scale=${cw}:${ch}:force_original_aspect_ratio=increase,crop=${cw}:${ch}`, "-frames:v", "1", "-q:v", "3", coverOut],
    { signal },
  );
  await run(
    "ffmpeg",
    [
      ...QUIET, "-i", image,
      "-filter_complex",
      `[0:v]split[a][b];[a]scale=${ww}:${wh}:force_original_aspect_ratio=increase,crop=${ww}:${wh},boxblur=24[bg];` +
        `[b]scale=${ww}:${wh}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2`,
      "-frames:v", "1", "-q:v", "3", wideOut,
    ],
    { signal },
  );
}

export interface ThumbsDeps {
  clips: ClipsRepo;
  thumbs: ThumbsRepo;
  google: GoogleAi;
  /** Thumbnails are kept in <mediaDir>/thumbs. */
  mediaDir: string;
  /** False when the clip's source bans AI (a campaign rule): only the plain frame is made. Left out, AI is allowed. */
  aiAllowed?: (sourceId: number) => boolean;
}

/**
 * approved clip → thumbnail options. A frame of the clip and its hook go to Gemini image twice
 * (two styles); each picture is saved at both sizes. When Google is off, capped or failing, the
 * plain frame is the option instead, so the job never fails for Google's sake.
 */
export function thumbsHandler(deps: ThumbsDeps): JobHandler {
  return async ({ payload, tmpDir, signal, progress }) => {
    const { clipId, noAi } = payload as { clipId: number; noAi?: boolean };
    const clip = deps.clips.get(clipId);
    const frame = join(tmpDir, "frame.jpg");
    // A little in, past the hook card's fade: the reaction is what the clip opens on.
    await grabFrame(deps.clips.filePath(clipId), Math.min(1, clip.durationSec / 2), frame, { signal });
    const frameData = await readFile(frame);

    const dir = join(deps.mediaDir, "thumbs");
    await mkdir(dir, { recursive: true });
    const stamp = Date.now();
    const made: { label: string; ai: boolean; coverPath: string; widePath: string }[] = [];
    const save = async (image: string, n: number, label: string, ai: boolean) => {
      const cover = join(tmpDir, `cover-${n}.jpg`);
      const wide = join(tmpDir, `wide-${n}.jpg`);
      await writeSizes(image, cover, wide, signal);
      const coverPath = join(dir, `clip-${clipId}-${stamp}-${n}-cover.jpg`);
      const widePath = join(dir, `clip-${clipId}-${stamp}-${n}-wide.jpg`);
      await copyFile(cover, coverPath);
      await copyFile(wide, widePath);
      made.push({ label, ai, coverPath, widePath });
    };

    const useAi = deps.aiAllowed?.(clip.sourceId) ?? true;
    try {
      for (const [n, style] of useAi && !noAi ? STYLES.entries() : []) {
        progress(0.1 + 0.4 * n, `Making thumbnail ${n + 1} of ${STYLES.length}`);
        try {
          const res = await deps.google.image(
            "thumbnail",
            { prompt: thumbPrompt(clip.hook || clip.title, style.how), image: { mimeType: "image/jpeg", data: frameData }, aspectRatio: "9:16" },
            signal,
          );
          const picture = join(tmpDir, `ai-${n}.${res.mimeType.includes("png") ? "png" : "jpg"}`);
          await writeFile(picture, res.image);
          await save(picture, n, style.label, true);
        } catch (err) {
          signal.throwIfAborted();
          const why = err instanceof Error ? err.message : String(err);
          if (!(err instanceof GoogleUnavailableError)) console.warn(`[google] thumbnail for clip ${clipId} failed, using a frame of the clip: ${why}`);
          else console.log(`[google] thumbnail for clip ${clipId}: ${why} Using a frame of the clip.`);
          break;
        }
      }
      if (made.length === 0) await save(frame, 0, "Frame from the clip", false);
      deps.thumbs.replaceForClip(clipId, made);
    } catch (err) {
      for (const m of made) for (const f of [m.coverPath, m.widePath]) await rm(f, { force: true });
      throw err;
    }
  };
}

/** What the gallery's picker shows for a clip. */
export function clipThumbs(clipId: number, deps: { thumbs: ThumbsRepo; google: GoogleAi; queue: JobQueue }): ClipThumbs {
  return {
    thumbs: deps.thumbs.listForClip(clipId),
    making: makingFor(clipId, deps.queue),
    ai: deps.google.available() && deps.google.blocked() === null,
  };
}

function makingFor(clipId: number, queue: JobQueue): boolean {
  return queue.list(200).some((j) => j.type === THUMBS_JOB && j.clipId === clipId && (j.status === "queued" || j.status === "running"));
}

/** Queues the thumbnails of a clip, unless they are already being made. `noAi`: the clip's campaign bans AI, so a frame only. */
export function queueThumbs(clipId: number, queue: JobQueue, noAi = false): void {
  if (!makingFor(clipId, queue)) queue.enqueue(THUMBS_JOB, { clipId, noAi }, { clipId, maxAttempts: 2 });
}
