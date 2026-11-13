import type { ScoreStep, ScoutFacts, ScoutScore } from "../../shared/scout.js";
import { PLATFORM_LABELS, PLATFORMS, type Platform } from "../../shared/types.js";

/** What a clip gets on each platform when we have too few posts of our own to say. */
export const DEFAULT_TYPICAL_VIEWS: Record<Platform, number> = { tiktok: 2500, youtube: 1500, instagram: 1200, x: 300 };
/** Our own posts on a platform are used once there are this many with a view count. */
export const MIN_OWN_POSTS = 5;
/** Where a page names no platform, the ones we post to. */
const ASSUMED_PLATFORMS: Platform[] = ["tiktok", "youtube", "instagram"];

export const NICHE_GTA = 1.5;
export const NICHE_GAMING = 1.2;
export const NICHE_OTHER = 0.7;
export const SOURCE_KNOWN = 1;
export const SOURCE_STREAMS = 0.7;
export const SOURCE_NONE = 0.3;
export const BUDGET_UNKNOWN = 0.5;
/** A budget left of this much or more counts as full when the page gives no total. */
export const BUDGET_FULL_USD = 1000;
export const RISK_NO_AI = 0.3;
export const RISK_AUDIENCE = 0.2;
export const RISK_LOCKED = 0.1;
export const RISK_MAX = 0.6;
export const COMPETITION_MAX = 0.4;
/** With this much budget left per clipper, or more, the others are no worry. */
export const COMPETITION_FREE_USD = 50;

const GTA = /\bgta\b|grand theft auto|rockstar|vice city|los santos/i;
const GAMING = /\bgam(?:e|es|ing|er|ers)\b|gameplay|\bstream(?:s|er|ers|ing)?\b|twitch|kick\.com|fortnite|minecraft|call of duty|warzone|valorant|esports/i;
const STREAMS = /\bstream(?:s|er|ers|ing)?\b|\bvods?\b|podcast|twitch|kick\.com|youtube\.com/i;
const NO_AI = /\bno\s+ai\b|\bai[- ]generated\b|\bwithout\s+ai\b|\bno\s+artificial\b/i;

export interface ScoreContext {
  /** Views of our own posts per platform (posts with a view count only). */
  ourViews: Partial<Record<Platform, number[]>>;
  /** Names of the creators in Sources and on the watchlist, whose streams we can already clip. */
  knownCreators: string[];
  /** Clips we post a day. */
  clipsPerDay: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function dollars(n: number): string {
  return `$${n.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function times(n: number): string {
  return `× ${n.toFixed(2)}`;
}

function round(n: number, places = 4): number {
  const p = 10 ** places;
  return Math.round(n * p) / p;
}

/**
 * Scores one campaign, with its working shown line by line:
 *
 *   score = expected earnings per clip × budget left × niche fit × source availability
 *           × (1 − rule risk − competition)
 *
 * Expected earnings per clip add up, over the campaign's platforms, the pay per 1,000 views times
 * our typical views there (capped at the most one clip can earn) times the chance a clip reaches
 * the views it needs to be paid at all.
 */
export function scoreCampaign(f: ScoutFacts, ctx: ScoreContext): ScoutScore {
  const steps: ScoreStep[] = [];
  const none = (why: string): ScoutScore => ({ score: 0, perDayUsd: 0, steps: [{ label: "Score", value: dollars(0), why }] });
  if (f.ended) return none(f.ended);
  if (f.ratePer1kUsd === null) return none("The page does not say what it pays per 1,000 views.");
  const rate = f.ratePer1kUsd;

  // Views a clip needs before it pays: the campaign's minimum, or enough to reach the least it pays out.
  const needed = Math.max(f.minViews ?? 0, f.payoutMinUsd !== null && rate > 0 ? (f.payoutMinUsd / rate) * 1000 : 0);
  const platforms = f.platforms.length > 0 ? f.platforms : ASSUMED_PLATFORMS;
  let perClip = 0;
  for (const p of PLATFORMS.filter((x) => platforms.includes(x))) {
    const own = ctx.ourViews[p] ?? [];
    const ours = own.length >= MIN_OWN_POSTS;
    const typical = ours ? median(own) : DEFAULT_TYPICAL_VIEWS[p];
    const chance = needed <= 0 ? 1 : ours ? own.filter((v) => v >= needed).length / own.length : typical / (typical + needed);
    const pay = Math.min((rate * typical) / 1000, f.payoutMaxUsd ?? Infinity);
    const earns = pay * chance;
    perClip += earns;
    const capped = f.payoutMaxUsd !== null && pay === f.payoutMaxUsd ? `, capped at ${dollars(f.payoutMaxUsd)} a clip` : "";
    steps.push({
      label: PLATFORM_LABELS[p],
      value: dollars(earns),
      why:
        `${dollars(rate)} per 1,000 views × ${Math.round(typical).toLocaleString("en")} views (${ours ? "the middle of our own posts" : "a starting guess until we have 5 posts there"})${capped}` +
        (needed > 0
          ? ` × ${Math.round(chance * 100)}% chance of reaching the ${Math.round(needed).toLocaleString("en")} views it takes to be paid`
          : ""),
    });
  }
  steps.push({
    label: "Expected earnings per clip",
    value: dollars(perClip),
    why: f.platforms.length > 0 ? "The platforms above, added up." : "The page names no platform, so the three we post to are counted.",
  });

  let budget: number;
  let budgetWhy: string;
  if (f.budgetLeftUsd !== null && f.budgetTotalUsd !== null && f.budgetTotalUsd > 0) {
    budget = Math.min(1, f.budgetLeftUsd / f.budgetTotalUsd);
    budgetWhy = `${dollars(f.budgetLeftUsd)} of ${dollars(f.budgetTotalUsd)} is still left.`;
  } else if (f.budgetLeftUsd !== null) {
    budget = Math.min(1, f.budgetLeftUsd / BUDGET_FULL_USD);
    budgetWhy = `${dollars(f.budgetLeftUsd)} is left (${dollars(BUDGET_FULL_USD)} or more counts as full).`;
  } else {
    budget = BUDGET_UNKNOWN;
    budgetWhy = "The page does not show how much budget is left.";
  }
  steps.push({ label: "Budget left", value: times(budget), why: budgetWhy });

  const words = [f.title, f.creatorName ?? "", f.agency ?? "", ...f.rules].join(" ");
  const niche = GTA.test(words) ? NICHE_GTA : GAMING.test(words) ? NICHE_GAMING : NICHE_OTHER;
  steps.push({
    label: "Fit with our channels",
    value: times(niche),
    why: niche === NICHE_GTA ? "It is about GTA, which is what our pages post." : niche === NICHE_GAMING ? "It is gaming or streamer content, close to our pages." : "It is not gaming content.",
  });

  const name = f.creatorName?.trim().toLowerCase();
  const known = name !== undefined && ctx.knownCreators.some((c) => c.trim().toLowerCase() === name);
  const source = known || f.channelUrls.length > 0 ? SOURCE_KNOWN : STREAMS.test(words) ? SOURCE_STREAMS : SOURCE_NONE;
  steps.push({
    label: "Streams we can clip",
    value: times(source),
    why: known
      ? `${f.creatorName} is already in our creators.`
      : f.channelUrls.length > 0
        ? "The page links the creator's channel."
        : source === SOURCE_STREAMS
          ? "It talks about streams, but links no channel."
          : "No long streams to clip were found.",
  });

  const risks: string[] = [];
  let risk = 0;
  if (f.rules.some((r) => NO_AI.test(r))) {
    risk += RISK_NO_AI;
    risks.push("it forbids AI content, and our picks and captions are made by AI");
  }
  if (f.audience.length > 0) {
    risk += RISK_AUDIENCE;
    risks.push(`it asks for a certain audience (“${f.audience[0]}”): check our account stats`);
  }
  if (f.lockedRequirements > 0) {
    risk += RISK_LOCKED;
    risks.push(`${f.lockedRequirements} ${f.lockedRequirements === 1 ? "requirement is" : "requirements are"} shown only after joining`);
  }
  risk = Math.min(RISK_MAX, risk);
  steps.push({
    label: "Rule risk",
    value: `− ${Math.round(risk * 100)}%`,
    why: risks.length > 0 ? `${risks.join("; ")}.`.replace(/^./, (c) => c.toUpperCase()) : "No strict rule was found on the page.",
  });

  let competition = 0;
  let competitionWhy = "The page does not say how many clippers joined.";
  if (f.clippers !== null && f.budgetLeftUsd !== null) {
    const each = f.clippers > 0 ? f.budgetLeftUsd / f.clippers : Infinity;
    competition = COMPETITION_MAX * (1 - Math.min(1, each / COMPETITION_FREE_USD));
    competitionWhy =
      f.clippers === 0
        ? "Nobody has joined yet."
        : `${f.clippers.toLocaleString("en")} clippers share ${dollars(f.budgetLeftUsd)}: ${dollars(each)} each (${dollars(COMPETITION_FREE_USD)} or more is no worry).`;
  }
  steps.push({ label: "Competition", value: `− ${Math.round(competition * 100)}%`, why: competitionWhy });

  const score = round(perClip * budget * niche * source * Math.max(0, 1 - risk - competition));
  const perDayUsd = round(score * ctx.clipsPerDay, 2);
  steps.push({ label: "Score", value: dollars(score), why: "Expected earnings per clip × budget left × fit × streams, less the rule risk and the competition." });
  steps.push({ label: "Estimate per day", value: dollars(perDayUsd), why: `The score × ${ctx.clipsPerDay} clips a day.` });
  return { score, perDayUsd, steps };
}
