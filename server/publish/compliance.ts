import type { CampaignRules, Permission, Platform, Word } from "../../shared/types.js";
import { PLATFORM_LABELS } from "../../shared/types.js";

export interface ComplianceInput {
  rules: CampaignRules;
  allowedPlatforms: Platform[];
  platform: Platform;
  /** The caption exactly as it would go out (or went out). */
  caption: string;
  title: string;
  hook: string;
  /** What is said in the clip. */
  transcript: string;
  durationSec: number;
  /** Parts of the clip made by AI ("the chosen thumbnail"). */
  aiMade?: string[];
  /** The clip already went out under another campaign or permission. */
  postedElsewhere?: boolean;
  /** Other clips that went out today under this campaign. */
  clipsToday?: number;
}

export function says(text: string, term: string): boolean {
  const escaped = term.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`, "iu").test(text);
}

/**
 * Why a clip breaks its campaign's rules on one platform, each in plain words; empty when it keeps
 * them all. Checked before a clip posts under a Whop campaign and before it is marked sent to Whop.
 */
export function campaignProblems(i: ComplianceInput): string[] {
  const { rules } = i;
  const problems: string[] = [];
  if (!i.allowedPlatforms.includes(i.platform)) problems.push(`the campaign does not take ${PLATFORM_LABELS[i.platform]} posts`);
  const caption = i.caption.toLowerCase();
  for (const tag of rules.requiredTags) if (!says(i.caption, tag)) problems.push(`the caption is missing the required tag ${tag}`);
  for (const link of rules.requiredLinks) if (!caption.includes(link.toLowerCase())) problems.push(`the caption is missing the required link ${link}`);
  for (const text of rules.requiredText) if (!caption.includes(text.toLowerCase())) problems.push(`the caption must say “${text}”`);
  const sec = Math.round(i.durationSec * 10) / 10;
  if (rules.maxSec !== null && sec > rules.maxSec) problems.push(`the clip is ${sec} s long and the campaign takes ${rules.maxSec} s at most`);
  if (rules.minSec !== null && sec < rules.minSec) problems.push(`the clip is ${sec} s long and the campaign takes ${rules.minSec} s at least`);
  for (const word of rules.bannedWords) {
    if (says(`${i.title}\n${i.hook}`, word)) problems.push(`the title says “${word}”, which the campaign bans`);
    else if (says(i.transcript, word)) problems.push(`“${word}” is said in the clip, which the campaign bans`);
  }
  if (rules.aiBanned) for (const part of i.aiMade ?? []) problems.push(`${part} is made by AI, and the campaign bans AI content`);
  if (rules.originalOnly && i.postedElsewhere) problems.push("the clip already went out under another campaign, and this one takes original clips only");
  const max = rules.maxClipsPerDay ?? null;
  if (max !== null && (i.clipsToday ?? 0) >= max) problems.push(`${i.clipsToday} ${i.clipsToday === 1 ? "clip" : "clips"} went out under the campaign today, and it takes ${max} a day at most`);
  return problems;
}

/** What is said between a clip's cut points. */
export function clipTranscript(clip: { captionWords: Word[]; startSec: number; endSec: number }): string {
  return clip.captionWords
    .filter((w) => w.endSec > clip.startSec && w.startSec < clip.endSec)
    .map((w) => w.word)
    .join(" ");
}

/** "The clip breaks the campaign's rules (the caption is missing the required tag #ad; …)." */
export function problemsLine(problems: string[]): string {
  return `The clip breaks the campaign's rules (${problems.join("; ")}).`;
}

/** The do and don't lines the picker is given for a permission: its brief, plus the campaign's limits. */
export function pickerBrief(permission: Permission): string {
  const r = permission.rules;
  const lines = [permission.briefRules];
  if (r && (r.minSec !== null || r.maxSec !== null)) {
    lines.push(`Clip length: ${r.minSec !== null ? `at least ${r.minSec} s` : ""}${r.minSec !== null && r.maxSec !== null ? ", " : ""}${r.maxSec !== null ? `at most ${r.maxSec} s` : ""}.`);
  }
  if (r && r.bannedWords.length > 0) lines.push(`Never pick a moment about: ${r.bannedWords.join(", ")}.`);
  return lines.filter(Boolean).join("\n");
}
