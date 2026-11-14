import type { GrowthDefaults } from "../../../shared/growth.js";
import { applyPreferences } from "../../growth/preferences.js";
import type { Reranker } from "../../google/rerank.js";
import type { JobHandler } from "../../jobs/queue.js";
import type { PicksRepo } from "../../picks/repo.js";
import type { SourcesRepo } from "../../sources/repo.js";
import { applyTrendBoost, type TrendBoost, trendHints } from "../../trends/boost.js";
import type { VodsRepo } from "../../vods/repo.js";
import { pickerBrief } from "../../publish/compliance.js";
import { applyChatBoost } from "../chat/spikes.js";
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
  /** Gemini watches the best picks and blends what it sees into their scores; left out, picks rank as the picker left them. */
  rerank?: Reranker;
  /** What is trending today (the trend radar); left out or null, picks rank on their own score. */
  trends?: () => TrendBoost | null;
  /** The defaults learned from test campaigns (preferred length, favoured words); left out, picks rank as proposed. */
  preferences?: () => GrowthDefaults;
}

/**
 * transcript → ranked picks. The picker proposes; the charter gate (flags, brief bans, sentence
 * boundaries, 15-60 s) decides. Dropped picks are kept with their reason and never render.
 */
export function picksHandler(deps: PicksDeps): JobHandler {
  return async ({ payload, tmpDir, signal, progress }) => {
    const { vodId, maxPicks = deps.maxPicks } = payload as { vodId: number; maxPicks?: number };
    const vod = deps.vods.detail(vodId);
    const permission = deps.sources.assertCanUse(vod.sourceId);
    const source = deps.sources.get(vod.sourceId);

    const trends = deps.trends?.() ?? null;
    const chat = deps.vods.chat(vodId);
    progress(0.1, "Finding highlights");
    const started = Date.now();
    const result = await deps.picker.pick(
      {
        title: vod.title,
        durationSec: vod.durationSec ?? vod.words.at(-1)?.endSec ?? 0,
        chapters: vod.chapters,
        words: vod.words,
        signals: { loudness: deps.vods.loudness(vodId), chat },
        creatorName: source.creatorName,
        briefRules: pickerBrief(permission),
        bannedContent: source.bannedContent,
        maxPicks,
        trendHints: trendHints(trends),
        run: { vodId },
      },
      signal,
    );
    const ms = Date.now() - started;

    let proposed = result.picks;
    let costUsd = result.costUsd;
    if (deps.rerank && proposed.length > 0) {
      progress(0.5, "Watching the best moments");
      try {
        const seen = await deps.rerank(proposed, { vodUrl: vod.url, durationSec: vod.durationSec, creatorName: source.creatorName, tmpDir, signal });
        proposed = seen.picks;
        costUsd += seen.costUsd;
      } catch (err) {
        // Cancelled: stop. Anything else must not cost the picks already made.
        signal.throwIfAborted();
        console.warn(`[picks] vod ${vodId}: the video check failed, keeping the local picks: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    progress(0.9, "Checking picks");
    const reviewed = reviewPicks(
      // Chat spikes weigh in after the picker and Gemini have scored, so every picker gets them.
      applyTrendBoost(applyChatBoost(deps.preferences ? applyPreferences(proposed, deps.preferences()) : proposed, chat), vod.words, trends),
      toSentences(vod.words),
      vod.words,
      [...bannedTerms(permission.briefRules, source.bannedContent), ...(permission.rules?.bannedWords ?? [])],
      maxPicks,
      permission.rules ?? undefined,
    );
    const kept = reviewed.filter((p) => !p.dropReason).length;
    // Cost per clip (O5): the VOD's transcript and picking spend shared over the clips kept.
    const perClipUsd = kept > 0 ? ((vod.transcriptCostUsd ?? 0) + costUsd) / kept : 0;
    const steps = [{ step: "pick", ms: Math.round(ms / Math.max(1, kept)) }];
    deps.picks.replaceForVod(
      vodId,
      vod.sourceId,
      reviewed.map((p) => ({
        ...p,
        layout: source.faceCam ? "stacked" : p.layout,
        costUsd: p.dropReason ? 0 : Math.round(perClipUsd * 1e6) / 1e6,
        steps: p.dropReason ? [] : steps,
      })),
    );
    console.log(
      `[picks] vod ${vodId}: ${kept} kept, ${reviewed.length - kept} left out, picker ${deps.picker.name} ${ms} ms, $${costUsd.toFixed(4)}`,
    );
  };
}
