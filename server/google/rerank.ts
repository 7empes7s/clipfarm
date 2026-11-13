import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { MOMENT_TYPE_LABELS, MOMENT_TYPES, type MomentType } from "../../shared/google.js";
import type { RawPick } from "../pipeline/picks/types.js";
import type { Section, SectionDownloader } from "../pipeline/render/section.js";
import { run } from "../tools/exec.js";
import { GoogleAi, GoogleUnavailableError } from "./service.js";

/** The proxy Gemini watches: small and short, so a pick costs a fraction of a cent. */
export const PROXY_MAX_SEC = 40;
export const PROXY_MAX_HEIGHT = 360;
/** Seconds shown before the pick, and the most the video may move a cut. */
export const PROXY_LEAD_SEC = 3;

/** The part of the VOD shown for a pick: 3 s before it, 40 s at most, inside the video. */
export function proxyWindow(pick: { startSec: number; endSec: number }, vodDurationSec: number | null): Section {
  const startSec = Math.max(0, pick.startSec - PROXY_LEAD_SEC);
  const endSec = Math.min(startSec + PROXY_MAX_SEC, pick.endSec + PROXY_LEAD_SEC, vodDurationSec ?? Infinity);
  return { startSec, endSec };
}

/** ffmpeg arguments for the proxy: 360p at most, 1 frame a second, quiet mono sound, 40 s at most. */
export function proxyArgs(input: string, durationSec: number, output: string): string[] {
  return [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", input,
    "-t", Math.min(PROXY_MAX_SEC, durationSec).toFixed(3),
    "-vf", `scale=-2:'min(${PROXY_MAX_HEIGHT},ih)',fps=1`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-ac", "1", "-ar", "16000", "-b:a", "24k",
    "-movflags", "+faststart",
    output,
  ];
}

/** Makes the proxy for one window of a VOD and returns its bytes. Nothing it writes outlives the call. */
export type ProxyMaker = (vodUrl: string, window: Section, tmpDir: string, signal?: AbortSignal) => Promise<Buffer>;

/** Downloads just the window and shrinks it with ffmpeg, in a folder of its own that is removed either way. */
export function proxyMaker(downloader: SectionDownloader): ProxyMaker {
  return async (vodUrl, window, tmpDir, signal) => {
    const dir = await mkdtemp(join(tmpDir, "proxy-"));
    try {
      const section = await downloader.downloadSection(vodUrl, window, dir, signal);
      const proxy = join(dir, "proxy.mp4");
      await run("ffmpeg", proxyArgs(section, window.endSec - window.startSec, proxy), { signal });
      return await readFile(proxy);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

const bool = { type: "boolean" };
export const VISUAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["visual_intensity", "moment_type", "opens_on_payoff", "best_start", "best_end", "flags"],
  properties: {
    visual_intensity: { type: "integer", minimum: 0, maximum: 10 },
    moment_type: { type: "string", enum: [...MOMENT_TYPES] },
    opens_on_payoff: bool,
    best_start: { type: "number" },
    best_end: { type: "number" },
    flags: {
      type: "object",
      additionalProperties: false,
      required: ["spoiler", "leak", "cutscene"],
      properties: { spoiler: bool, leak: bool, cutscene: bool },
    },
  },
} as const;

const SYSTEM = `You watch a short, low-resolution video of a moment from a streamer's video-game stream. It is a candidate for a vertical clip (TikTok, Shorts, Reels).
Judge only what is seen and heard:
- visual_intensity: 0-10. How much happens on screen: crashes, chases, explosions, stunts, the streamer's face reacting. 0 is a still menu or someone just talking, 10 cannot be looked away from.
- moment_type: the one that fits best of: ${MOMENT_TYPES.join(", ")}.
- opens_on_payoff: true when the clip, as cut, starts ON the action or the reaction, false when it starts on setup.
- best_start, best_end: where the clip should start and end, in seconds from the start of this video. Move them by 3 seconds at most from the cut you are given; keep them when the cut is already right.
- flags: spoiler (a story twist, reveal or character death is shown), leak (unreleased or leaked footage), cutscene (mostly an unplayed story cutscene). True only when the video clearly shows it.
Answer in JSON.`;

export interface VisualRead {
  intensity: number;
  momentType: MomentType;
  opensOnPayoff: boolean;
  /** Seconds from the start of the proxy. */
  bestStartSec: number;
  bestEndSec: number;
  flags: { spoiler: boolean; leak: boolean; cutscene: boolean };
}

/** Checks Gemini's answer against the schema by hand. Anything off is no answer at all (null). */
export function parseVisual(content: string): VisualRead | null {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { visual_intensity: intensity, moment_type: type, opens_on_payoff: payoff, best_start: start, best_end: end } = body;
  const flags = body.flags as Record<string, unknown> | null;
  if (!Number.isInteger(intensity) || (intensity as number) < 0 || (intensity as number) > 10) return null;
  if (!MOMENT_TYPES.includes(type as MomentType) || typeof payoff !== "boolean") return null;
  if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (!flags || typeof flags !== "object") return null;
  if ((["spoiler", "leak", "cutscene"] as const).some((k) => typeof flags[k] !== "boolean")) return null;
  return {
    intensity: intensity as number,
    momentType: type as MomentType,
    opensOnPayoff: payoff,
    bestStartSec: start,
    bestEndSec: end,
    flags: { spoiler: flags.spoiler === true, leak: flags.leak === true, cutscene: flags.cutscene === true },
  };
}

/**
 * Blends what the video showed into a pick: the score moves towards the visual intensity by
 * `weight` (0-1), the reason says so, the cut moves by 3 s at most, and flags are only ever added.
 */
export function blendVisual(pick: RawPick, seen: VisualRead, weight: number, window: Section): RawPick {
  const startSec = window.startSec + seen.bestStartSec;
  const endSec = window.startSec + seen.bestEndSec;
  const moved = endSec > startSec && Math.abs(startSec - pick.startSec) <= PROXY_LEAD_SEC && Math.abs(endSec - pick.endSec) <= PROXY_LEAD_SEC;
  return {
    ...pick,
    ...(moved ? { startSec, endSec } : {}),
    score: Math.max(0, Math.min(100, Math.round(pick.score * (1 - weight) + seen.intensity * 10 * weight))),
    reason: `${pick.reason} +visual: ${MOMENT_TYPE_LABELS[seen.momentType].toLowerCase()}, ${seen.intensity}/10${seen.opensOnPayoff ? ", opens on the payoff" : ""}`,
    flags: {
      ...pick.flags,
      spoiler: pick.flags.spoiler || seen.flags.spoiler,
      leak: pick.flags.leak || seen.flags.leak,
      cutscene: pick.flags.cutscene || seen.flags.cutscene,
    },
  };
}

export interface RerankContext {
  vodUrl: string;
  durationSec: number | null;
  creatorName: string;
  tmpDir: string;
  signal?: AbortSignal;
}

export type Reranker = (picks: RawPick[], ctx: RerankContext) => Promise<{ picks: RawPick[]; costUsd: number }>;

/**
 * Gemini Flash watches a proxy of each of the best local picks and its read is blended into their
 * scores. It can only add to the local picks: when Google is off, capped, failing or answers
 * outside the schema, the picks it did not (rightly) see come back exactly as they went in.
 */
export function videoReranker(deps: { google: GoogleAi; proxy: ProxyMaker }): Reranker {
  return async (picks, ctx) => {
    const settings = deps.google.settings();
    if (!settings.rerank || !deps.google.available()) return { picks, costUsd: 0 };
    const out = [...picks];
    // Flagged picks are thrown away anyway: no point paying to watch them.
    const best = out
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => !Object.values(p.flags).some(Boolean))
      .sort((a, b) => b.p.score - a.p.score)
      .slice(0, settings.topN);
    let costUsd = 0;
    let watched = 0;
    let unusable = 0;
    let stopped: string | null = null;
    for (const { p, i } of best) {
      // Asked before the download, so a reached cap costs no bandwidth either.
      stopped = deps.google.blocked();
      if (stopped) break;
      const window = proxyWindow(p, ctx.durationSec);
      try {
        const video = await deps.proxy(ctx.vodUrl, window, ctx.tmpDir, ctx.signal);
        const res = await deps.google.json(
          "rerank",
          {
            system: SYSTEM,
            text: [
              `Streamer: ${ctx.creatorName}`,
              `Hook on screen: ${p.hook}`,
              `The clip as cut runs from ${(p.startSec - window.startSec).toFixed(1)} s to ${(p.endSec - window.startSec).toFixed(1)} s of this video.`,
            ].join("\n"),
            schema: VISUAL_SCHEMA,
            media: { mimeType: "video/mp4", data: video },
          },
          ctx.signal,
        );
        costUsd += res.costUsd;
        const seen = parseVisual(res.text);
        if (!seen) {
          unusable += 1;
          continue;
        }
        out[i] = blendVisual(p, seen, settings.weight / 100, window);
        watched += 1;
      } catch (err) {
        // Cancelled by the user: stop the job. Anything else: the local picks stand.
        ctx.signal?.throwIfAborted();
        stopped = err instanceof Error ? err.message : String(err);
        if (!(err instanceof GoogleUnavailableError)) console.warn(`[google] the video check failed, keeping the local picks: ${stopped}`);
        break;
      }
    }
    console.log(
      `[google] video check: watched ${watched} of ${best.length} picks` +
        `${unusable > 0 ? `, ${unusable} answer${unusable === 1 ? "" : "s"} not usable` : ""}${stopped ? `; stopped: ${stopped}` : ""}`,
    );
    return { picks: out, costUsd: Math.round(costUsd * 1e6) / 1e6 };
  };
}
