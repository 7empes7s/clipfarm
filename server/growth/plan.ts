import {
  ASSIGNMENTS,
  type Assignment,
  type GrowthCampaignInput,
  SUCCESS_METRICS,
  type SuccessMetric,
  TEST_VARIABLES,
  type TestVariable,
  type Variant,
} from "../../shared/growth.js";
import { nicheMatches } from "../accounts/repo.js";
import { ValidationError } from "../errors.js";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** n times spread over the waking day (09:00 to 21:00 UTC): 1 → 15:00, 3 → 09:00, 15:00, 21:00. */
export function defaultTimes(n: number): string[] {
  if (n <= 1) return ["15:00"];
  return Array.from({ length: n }, (_, i) => {
    const min = Math.round((9 * 60 + (i * 12 * 60) / (n - 1)) / 5) * 5;
    return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
  });
}

function text(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function wholeNumber(v: unknown, min: number, max: number, message: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ValidationError(message);
  return n;
}

function times(v: unknown): string[] {
  const list = Array.isArray(v) ? v.map((t) => text(t, 5)).filter(Boolean) : [];
  if (!list.every((t) => TIME.test(t))) throw new ValidationError("Write times like 09:00 or 18:30.");
  return [...new Set(list)].sort();
}

function parseVariant(raw: unknown, i: number, variable: TestVariable): Variant {
  const b = (raw ?? {}) as Record<string, unknown>;
  const key = String.fromCharCode(65 + i);
  const seconds = (v: unknown) => (v === null || v === undefined || v === "" ? null : wholeNumber(v, 1, 600, "Clip lengths are whole seconds from 1 to 600."));
  const variant: Variant = {
    key,
    label: text(b.label, 40) || `Variant ${key}`,
    minSec: variable === "length" ? seconds(b.minSec) : null,
    maxSec: variable === "length" ? seconds(b.maxSec) : null,
    words: variable === "hook" || variable === "niche" ? (Array.isArray(b.words) ? b.words.map((w) => text(w, 40)).filter(Boolean) : []) : [],
    times: variable === "time" ? times(b.times) : [],
  };
  const name = `"${variant.label}"`;
  if (variable === "length") {
    if (variant.minSec === null && variant.maxSec === null) throw new ValidationError(`Give ${name} a shortest or longest clip length.`);
    if (variant.minSec !== null && variant.maxSec !== null && variant.minSec > variant.maxSec) {
      throw new ValidationError(`${name}: the shortest length is over the longest.`);
    }
  } else if (variable === "time") {
    if (variant.times.length === 0) throw new ValidationError(`Give ${name} at least one posting time.`);
  } else if (variant.words.length === 0) {
    throw new ValidationError(`Give ${name} at least one word to look for.`);
  }
  return variant;
}

/** Checks a campaign as typed in the form; every refusal is a plain sentence. */
export function parseCampaign(body: unknown): GrowthCampaignInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = text(b.name, 80);
  if (!name) throw new ValidationError("Give the campaign a name.");
  if (!TEST_VARIABLES.includes(b.variable as TestVariable)) throw new ValidationError("Pick what the campaign tests.");
  const variable = b.variable as TestVariable;
  if (!Array.isArray(b.variants) || b.variants.length < 2 || b.variants.length > 4) throw new ValidationError("A test needs 2 to 4 variants.");
  const variants = b.variants.map((v, i) => parseVariant(v, i, variable));
  if (new Set(variants.map((v) => v.label.toLowerCase())).size !== variants.length) throw new ValidationError("Give each variant its own name.");
  const accountIds = Array.isArray(b.accountIds) ? [...new Set(b.accountIds.filter((a): a is string => typeof a === "string" && a !== ""))] : [];
  if (accountIds.length === 0) throw new ValidationError("Pick at least one account to post from.");
  const sourceIds = Array.isArray(b.sourceIds) ? [...new Set(b.sourceIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))] : [];
  const postsPerDay = wholeNumber(b.postsPerDay, 1, 12, "Posts per account per day must be a whole number from 1 to 12.");
  const postTimes = variable === "time" ? [] : times(b.times);
  if (postTimes.length > 0 && postTimes.length !== postsPerDay) {
    throw new ValidationError(`Give one time for each post of the day (${postsPerDay}), or leave the times empty.`);
  }
  return {
    name,
    hypothesis: text(b.hypothesis, 300),
    sourceIds,
    accountIds,
    postsPerDay,
    times: postTimes,
    durationDays: wholeNumber(b.durationDays, 1, 60, "A campaign runs for 1 to 60 days."),
    variable,
    variants,
    assignment: ASSIGNMENTS.includes(b.assignment as Assignment) ? (b.assignment as Assignment) : "alternate",
    metric: SUCCESS_METRICS.includes(b.metric as SuccessMetric) ? (b.metric as SuccessMetric) : "vph24",
  };
}

/** One post a campaign owes: an account's nth post of a day. */
export interface Slot {
  key: string;
  day: string;
  accountId: string;
  index: number;
}

export function slotsForDay(campaign: Pick<GrowthCampaignInput, "accountIds" | "postsPerDay">, day: string): Slot[] {
  return campaign.accountIds.flatMap((accountId) =>
    Array.from({ length: campaign.postsPerDay }, (_, index) => ({ key: `${day}#${accountId}#${index}`, day, accountId, index })),
  );
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * The variant of the next post, so every variant gets the same number of posts: the one this
 * account has posted least, then the one the campaign has posted least. Among those still level,
 * "alternate" takes them in order and "random" draws one (the same draw every time for a slot),
 * so randomised posts stay evenly spread too.
 */
export function chooseVariant(
  variants: Variant[],
  onAccount: Map<string, number>,
  overall: Map<string, number>,
  assignment: Assignment,
  slotKey: string,
): Variant {
  const least = <T,>(xs: T[], n: (x: T) => number) => {
    const min = Math.min(...xs.map(n));
    return xs.filter((x) => n(x) === min);
  };
  const level = least(
    least(variants, (v) => onAccount.get(v.key) ?? 0),
    (v) => overall.get(v.key) ?? 0,
  );
  return assignment === "random" ? level[hash(slotKey) % level.length]! : level[0]!;
}

/** When a slot's post goes out: the variant's own time in a posting-time test, else the campaign's (or default) times. */
export function slotTime(slot: Slot, variable: TestVariable, variant: Variant, campaignTimes: string[], fallbackTimes: string[], postsPerDay: number): Date {
  const list =
    variable === "time"
      ? variant.times
      : campaignTimes.length > 0
        ? campaignTimes
        : fallbackTimes.length === postsPerDay
          ? fallbackTimes
          : defaultTimes(postsPerDay);
  return new Date(`${slot.day}T${list[slot.index % list.length]}:00.000Z`);
}

export interface ClipFacts {
  durationSec: number;
  hook: string;
  /** Title, hook, creator and stream title together. */
  text: string;
}

/** Whether a clip belongs to a variant. In a posting-time test every clip fits every variant. */
export function clipFits(variable: TestVariable, variant: Variant, clip: ClipFacts): boolean {
  if (variable === "length") {
    return (variant.minSec === null || clip.durationSec >= variant.minSec) && (variant.maxSec === null || clip.durationSec <= variant.maxSec);
  }
  if (variable === "hook") return variant.words.some((w) => clip.hook.toLowerCase().includes(w.toLowerCase()));
  if (variable === "niche") return variant.words.some((w) => nicheMatches(w, clip.text));
  return true;
}
