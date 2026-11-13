import type { JobHandler } from "../../jobs/queue.js";
import type { PicksRepo } from "../../picks/repo.js";
import type { SourcesRepo } from "../../sources/repo.js";
import type { VodsRepo } from "../../vods/repo.js";
import { bannedTerms, reviewPicks } from "./review.js";
import { toSentences } from "./sentences.js";
import type { Picker } from "./types.js";

export const PICKS_JOB = "picks";

export interface PicksDeps {
  sources: SourcesRepo;
  vods: VodsRepo;
  picks: PicksRepo;
  picker: Picker;
  maxPicks: number;
}

/**
 * transcript → ranked picks. The picker proposes; the charter gate (flags, brief bans, sentence
 * boundaries, 15-60 s) decides. Dropped picks are kept with their reason and never render.
 */
export function picksHandler(deps: PicksDeps): JobHandler {
  return async ({ payload, signal, progress }) => {
    const { vodId, maxPicks = deps.maxPicks } = payload as { vodId: number; maxPicks?: number };
    const vod = deps.vods.detail(vodId);
    const permission = deps.sources.assertCanUse(vod.sourceId);
    const source = deps.sources.get(vod.sourceId);

    progress(0.1, "Finding highlights");
    const started = Date.now();
    const result = await deps.picker.pick(
      {
        title: vod.title,
        durationSec: vod.durationSec ?? vod.words.at(-1)?.endSec ?? 0,
        chapters: vod.chapters,
        words: vod.words,
        signals: { loudness: deps.vods.loudness(vodId), chat: null },
        creatorName: source.creatorName,
        briefRules: permission.briefRules,
        bannedContent: source.bannedContent,
        maxPicks,
        run: { vodId },
      },
      signal,
    );
    const ms = Date.now() - started;

    progress(0.9, "Checking picks");
    const reviewed = reviewPicks(
      result.picks,
      toSentences(vod.words),
      vod.words,
      bannedTerms(permission.briefRules, source.bannedContent),
      maxPicks,
    );
    const kept = reviewed.filter((p) => !p.dropReason).length;
    // Cost per clip (O5): the VOD's transcript and picking spend shared over the clips kept.
    const costUsd = kept > 0 ? ((vod.transcriptCostUsd ?? 0) + result.costUsd) / kept : 0;
    const steps = [{ step: "pick", ms: Math.round(ms / Math.max(1, kept)) }];
    deps.picks.replaceForVod(
      vodId,
      vod.sourceId,
      reviewed.map((p) => ({
        ...p,
        layout: source.faceCam ? "stacked" : p.layout,
        costUsd: p.dropReason ? 0 : Math.round(costUsd * 1e6) / 1e6,
        steps: p.dropReason ? [] : steps,
      })),
    );
    console.log(
      `[picks] vod ${vodId}: ${kept} kept, ${reviewed.length - kept} left out, picker ${deps.picker.name} ${ms} ms, $${result.costUsd.toFixed(4)}`,
    );
  };
}
