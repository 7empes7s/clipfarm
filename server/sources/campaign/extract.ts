import type { CampaignDraft, CampaignField, CampaignRules, Platform } from "../../../shared/types.js";
import { NO_CAMPAIGN_RULES, PLATFORMS } from "../../../shared/types.js";
import type { ChatClient } from "../../pipeline/picks/llm.js";
import { programOf } from "../../catalog/programs.js";
import { decodeEntities } from "../proof.js";

/** Program sites with public campaign pages we read. Discord servers have none: their rules are pasted. */
const CAMPAIGN_HOSTS = ["whop.com", "contentrewards.com", "reachclipping.com", "vyro.com", "clipping.net"];

function httpsHost(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** A campaign link we read pages from: https on a program's site (Whop, Content Rewards, Reach, Vyro, Clipping.net). */
export function isCampaignUrl(raw: string): boolean {
  const host = httpsHost(raw);
  return host !== null && CAMPAIGN_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** A campaign link that can be imported: a program's page, or a Discord payroll invite (whose rules are pasted). */
export function isImportUrl(raw: string): boolean {
  return httpsHost(raw) !== null && programOf(raw) !== null;
}

/** The same campaign whatever the query, hash, "www." or trailing slash on its link. */
export function campaignKey(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return raw.trim();
  }
}

/** What the fields below are read from: everything but `campaignUrl` and `existingSource`. */
export type CampaignFacts = Omit<CampaignDraft, "campaignUrl" | "existingSource" | "check">;

/** A page (HTML, or text pasted by hand) as its visible lines; a link keeps its address next to its words. */
export function pageLines(raw: string): string[] {
  const text = raw
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, "\n")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, words: string) =>
      /^https?:/i.test(href) && !words.includes(href) ? `${words} ${href} ` : words,
    )
    .replace(/<(?:br|hr|\/?(?:p|div|li|ul|ol|h[1-6]|tr|td|th|dt|dd|dl|section|article|header|footer|table|blockquote))\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(text)
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .split(/\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function amount(digits: string, suffix: string | undefined): number {
  const n = Number(digits.replace(/,/g, ""));
  const s = (suffix ?? "").toLowerCase();
  return n * (s === "k" ? 1_000 : s === "m" ? 1_000_000 : 1);
}

const MONEY = /\$\s?(\d[\d,]*(?:\.\d+)?)\s?([km])?\b/i;
const COUNT = /(\d[\d,]*(?:\.\d+)?)\s?([km])?\b/i;

export function money(s: string): number | null {
  const m = MONEY.exec(s);
  return m ? amount(m[1]!, m[2]) : null;
}

/** The value after a label: on the same line after a colon or dash ("Rate: $3"), else the line below a line that is only the label. */
function labelled(lines: string[], label: RegExp): string | null {
  const re = new RegExp(`^(?:${label.source})(?:\\s*[:\\-–]\\s*(.+)|\\s*:?)$`, "i");
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]!);
    if (!m) continue;
    const rest = m[1]?.trim();
    if (rest) return rest;
    if (lines[i + 1]) return lines[i + 1]!;
  }
  return null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The end of the day a text names ("November 30, 2026", "30 Nov 2026", "2026-11-30"); a bare 11/30 is not read. */
export function parseDay(s: string): string | null {
  let y: number, mo: number, d: number;
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s);
  const mdy = /\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i.exec(s);
  const dmy = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?\s+(\d{4})\b/i.exec(s);
  const month = (name: string) => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;
  if (iso) [y, mo, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (mdy && month(mdy[1]!)) [y, mo, d] = [Number(mdy[3]), month(mdy[1]!), Number(mdy[2])];
  else if (dmy && month(dmy[2]!)) [y, mo, d] = [Number(dmy[3]), month(dmy[2]!), Number(dmy[1])];
  else return null;
  const day = new Date(Date.UTC(y, mo - 1, d, 23, 59, 59));
  return day.getUTCMonth() === mo - 1 && day.getUTCDate() === d ? day.toISOString() : null;
}

const PLATFORM_NAMES: Record<Platform, RegExp> = {
  tiktok: /tik\s?tok/i,
  youtube: /youtube|\bshorts\b/i,
  instagram: /instagram|\breels\b|\binsta\b/i,
  x: /twitter|(?:^|[\s,/(])x(?=$|[\s,/).])/i,
};

function platformsIn(s: string): Platform[] {
  return PLATFORMS.filter((p) => PLATFORM_NAMES[p].test(s));
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

const CHANNEL_URL =
  /https?:\/\/(?:www\.)?(?:(?:twitch\.tv|kick\.com)\/[A-Za-z0-9_]{2,}|youtube\.com\/(?:@[\w.-]+|(?:channel|c|user)\/[\w.-]+))/gi;

const RATE =
  /\$\s?(\d[\d,]*(?:\.\d+)?)\s*(?:usd\s*)?(?:per|\/|for every|for each)\s*(1[,.]?000[,.]000|1\s?m\b|(?:a |one )?million|1[,.]?000|1\s?k\b|(?:a |one )?thousand)\s*(?:verified |qualified )?views/gi;

function rateOf(lines: string[]): number | null {
  const found = new Set<number>();
  for (const m of lines.join("\n").matchAll(RATE)) {
    const per = /m|000.000/i.test(m[2]!) ? 1_000 : 1;
    found.add(Math.round((amount(m[1]!, undefined) / per) * 10_000) / 10_000);
  }
  // Two different rates (say, one per platform) cannot be one number: left for the manager.
  if (found.size > 1) return null;
  if (found.size === 1) return [...found][0]!;
  const cpm = labelled(lines, /cpm/);
  return cpm ? money(cpm) : null;
}

function minViewsOf(lines: string[]): number | null {
  const label = labelled(lines, /min(?:imum)?\.?\s+views(?:\s+(?:per|to)\s+\w+)?/);
  const inText = /\b(?:minimum(?:\s+of)?|at least|min\.?)\s+(\d[\d,]*(?:\.\d+)?\s?[km]?)\s+(?:verified |qualified )?views\b/i.exec(lines.join("\n"));
  const m = COUNT.exec(label ?? inText?.[1] ?? "");
  return m ? amount(m[1]!, m[2]) : null;
}

function budgetLeftOf(lines: string[]): number | null {
  const label = labelled(lines, /budget\s+(?:left|remaining)|remaining(?:\s+budget)?|left\s+to\s+earn/);
  if (label && money(label) !== null) return money(label);
  const text = lines.join("\n");
  const left = /\$\s?(\d[\d,]*(?:\.\d+)?)\s?([km])?\s+(?:left|remaining)\b/i.exec(text);
  if (left) return amount(left[1]!, left[2]);
  const paid = /\$\s?(\d[\d,]*(?:\.\d+)?)\s?([km])?\s*(?:of|\/|out of)\s*\$\s?(\d[\d,]*(?:\.\d+)?)\s?([km])?\s*(?:paid(?:\s+out)?|used|spent|claimed)/i.exec(text);
  return paid ? Math.max(0, Math.round((amount(paid[3]!, paid[4]) - amount(paid[1]!, paid[2])) * 100) / 100) : null;
}

function platformsOf(lines: string[]): Platform[] {
  const re = /^(?:(?:allowed|accepted|supported)\s+)?platforms?\b|^where\s+to\s+post\b|^post(?:ing)?\s+(?:on|to)\b/i;
  const at = lines.findIndex((l) => re.test(l));
  if (at < 0) return [];
  const found = platformsIn(lines[at]!.replace(re, ""));
  // A list under the label: one platform per line.
  for (let i = at + 1; i < lines.length && lines[i]!.length <= 80 && platformsIn(lines[i]!).length > 0; i++) found.push(...platformsIn(lines[i]!));
  return PLATFORMS.filter((p) => found.includes(p));
}

function endOf(lines: string[]): string | null {
  const label = labelled(lines, /(?:campaign\s+)?(?:ends?(?:\s+on)?|end\s+date|deadline|closes(?:\s+on)?)/);
  const labelDay = label && parseDay(label);
  if (labelDay) return labelDay;
  for (const line of lines) {
    const m = /\b(?:ends?|ending|end date|deadline|closes|runs until|until|expires)\b(.*)$/i.exec(line);
    const day = m && parseDay(m[1]!);
    if (day) return day;
  }
  return null;
}

function creatorOf(lines: string[]): string | null {
  const v = labelled(lines, /creator|streamer|campaign by|hosted by/);
  const name = v?.replace(/https?:\/\/\S+/g, "").trim() ?? "";
  return name && name.length <= 60 && !/[.!?]$/.test(name) ? name : null;
}

function channelsOf(lines: string[]): string[] {
  const urls: string[] = [];
  const label = /^(?:channels?|streams?(?:\s+on)?|watch(?:\s+live)?|source(?:\s+content)?|creator|streamer)\b/i;
  lines.forEach((line, i) => {
    if (!label.test(line)) return;
    // The label's own line, then the lines under it for as long as they carry a channel link.
    for (let j = i; j < lines.length && j <= i + 4; j++) {
      const found = lines[j]!.match(CHANNEL_URL) ?? [];
      if (j > i && found.length === 0) break;
      urls.push(...found);
    }
  });
  return unique(urls);
}

const BAN_LINE = /^(?:no|don'?t|do not|never|avoid)\s+(.+)$/i;
const BAN_LABEL = /^(?:banned|prohibited|forbidden|not allowed|off[- ]limits)(?:\s+(?:content|words|topics))?\s*[:\-–]\s*(.+)$/i;
const MUST = /\b(?:must|required?|requires|include|add|use|tag|mention|credit)\b/i;

function banTerms(rest: string): string[] {
  return rest
    .split(/,|;|\/|\bor\b|\band\b/i)
    .map((t) =>
      t
        .trim()
        .replace(/^(?:show(?:ing)?|us(?:e|ing)|post(?:ing)?|includ(?:e|ing)|clip(?:ping)?|mention(?:ing)?|talk(?:ing)? about)\s+/i, "")
        .replace(/[.!]+$/, "")
        .toLowerCase(),
    )
    .filter((t) => t.length >= 2 && t.length <= 40 && t.split(" ").length <= 4 && /^[\p{L}\p{N} '&-]+$/u.test(t));
}

const NO_SUBMIT = /\bno (?:manual )?(?:submission|submit)s? (?:is |are )?(?:needed|required|necessary)\b|\b(?:submitted|tracked|counted) automatically\b|\bautomatic(?:ally)? (?:submission|tracking|tracked|submitted)\b|\bno need to submit\b/i;

/** "No AI content", "AI-generated clips are not allowed": the campaign bans AI-made content. */
export const AI_BAN =
  /\bno ai\b|\bai[- ](?:generated|made|content|voices?|edits?|edited|clips?|videos?)\b.{0,40}\b(?:not allowed|banned|prohibited|forbidden|not accepted|rejected)\b|\b(?:not allowed|banned|prohibited|forbidden)\b.{0,30}\bai[- ](?:generated|made|content|voices?|edits?)\b/i;

/** "Original content only", "No reuploads": clips must be the clipper's own. */
export const ORIGINAL_ONLY =
  /\boriginal\s+(?:content|clips?|videos?|edits?)\s+only\b|\bonly\s+original\b|\bmust\s+be\s+(?:your\s+own\s+)?original\b|\bno\s+(?:re-?uploads?|reposts?|reposted|stolen)\b/i;

const NUM = "(\\d[\\d,]*(?:\\.\\d+)?)\\s?([km])?";
/** "$5 cap per clip", "capped at $5 per clip", "Max payout: $1,000 per post". */
const CAP = new RegExp(
  `\\$\\s?${NUM}\\s*(?:max(?:imum)?|cap)\\b[^.\\n]{0,15}?\\b(?:per|a|each)\\s+(?:clip|post|video)|(?:cap(?:ped)?|max(?:imum)?(?:\\s+payout)?)\\s*(?:of|at|is|:)?\\s*\\$\\s?${NUM}\\s*(?:per|a|each)\\s+(?:clip|post|video)`,
  "i",
);
/** "Max 3 clips per day", "up to 5 posts a day". */
const PER_DAY = /\b(?:max(?:imum)?(?:\s+of)?|up\s+to|no\s+more\s+than|at\s+most|limit(?:\s+of)?)\s*(\d{1,3})\s*(?:clips?|posts?|videos?|submissions?)\s*(?:per|a|each)\s*day\b/i;
/** "Submit within 30 minutes of posting", "submitted within 24 hours". */
const SUBMIT_WITHIN = /\bsubmit(?:ted|ting)?\b[^.\n]{0,40}?\bwithin\s*(\d{1,3})\s*(minutes?|mins?|hours?|hrs?|h)\b/i;

function rulesOf(lines: string[]): { rules: CampaignRules; briefRules: string } {
  const rules: CampaignRules = { ...NO_CAMPAIGN_RULES, requiredTags: [], requiredLinks: [], requiredText: [], bannedWords: [] };
  const brief: string[] = [];
  for (const line of lines) {
    if (line.length > 300) continue;
    let ruled = false;
    // "No account? Sign up" is a question or a link, not a rule.
    const ban = /\?|https?:/i.test(line) ? null : (BAN_LABEL.exec(line) ?? BAN_LINE.exec(line));
    if (ban) {
      const terms = banTerms(ban[1]!);
      rules.bannedWords.push(...terms);
      ruled = terms.length > 0;
    } else if (MUST.test(line)) {
      const tags = (line.match(/(?<![\w/.])[#@][\p{L}\p{N}_]+(?:\.[\p{L}\p{N}_]+)*/gu) ?? []) as string[];
      const links = /\blink\b|\bcaption\b|\bdescription\b|\bbio\b/i.test(line) ? (line.match(/https?:\/\/[^\s)"']+/g) ?? []).map((l) => l.replace(/[.,;:!?]+$/, "")) : [];
      const says = /\b(?:caption|description|title|say|write|text)\b/i.test(line)
        ? [...line.matchAll(/"([^"]{2,120})"/g)].map((m) => m[1]!.trim()).filter((t) => !/^[#@]\S+$/.test(t) && !/^https?:/i.test(t))
        : [];
      rules.requiredTags.push(...tags);
      rules.requiredLinks.push(...links);
      rules.requiredText.push(...says);
      ruled = tags.length + links.length + says.length > 0 || /^(?:must|always|only)\b/i.test(line);
    }
    if (/\b(?:clips?|videos?|length|duration|long)\b/i.test(line)) {
      const sec = "\\s*(?:s\\b|sec\\b|secs\\b|seconds?\\b)";
      const range = new RegExp(`(\\d{1,3})\\s*(?:-|–|to)\\s*(\\d{1,3})${sec}`, "i").exec(line);
      const max = new RegExp(`(?:under|max(?:imum)?(?: of)?|up to|no longer than|at most|less than|shorter than)\\s*(\\d{1,3})${sec}`, "i").exec(line);
      const min = new RegExp(`(?:at least|min(?:imum)?(?: of)?|longer than|more than|over)\\s*(\\d{1,3})${sec}`, "i").exec(line);
      if (range && Number(range[1]) < Number(range[2])) [rules.minSec, rules.maxSec] = [Number(range[1]), Number(range[2])];
      else if (max) rules.maxSec = Number(max[1]);
      else if (min) rules.minSec = Number(min[1]);
      ruled ||= Boolean(range || max || min);
    }
    // Clips the program tracks by itself need no submit by hand (the default for Whop / Content Rewards is that they do).
    if (NO_SUBMIT.test(line)) rules.manualSubmit = false;
    if (AI_BAN.test(line)) {
      rules.aiBanned = true;
      ruled = true;
    }
    if (ORIGINAL_ONLY.test(line)) {
      rules.originalOnly = true;
      ruled = true;
    }
    const cap = CAP.exec(line);
    if (cap) {
      rules.payoutCapUsd = cap[1] ? amount(cap[1], cap[2]) : amount(cap[3]!, cap[4]);
      ruled = true;
    }
    const perDay = PER_DAY.exec(line);
    if (perDay) {
      rules.maxClipsPerDay = Number(perDay[1]);
      ruled = true;
    }
    const within = SUBMIT_WITHIN.exec(line);
    if (within) {
      rules.submitWithinMin = Number(within[1]) * (/^h/i.test(within[2]!) ? 60 : 1);
      ruled = true;
    }
    if (ruled) brief.push(line);
  }
  rules.requiredTags = unique(rules.requiredTags);
  rules.requiredLinks = unique(rules.requiredLinks);
  rules.requiredText = unique(rules.requiredText);
  rules.bannedWords = unique(rules.bannedWords);
  return { rules, briefRules: unique(brief).join("\n").slice(0, 2000) };
}

function endedOf(lines: string[], budgetLeftUsd: number | null): string | null {
  const text = lines.join("\n");
  if (
    /\bcampaign\s+(?:has\s+|is\s+(?:now\s+)?)?(?:ended|closed|finished|expired|completed)\b|\bcampaign\s+is\s+(?:now\s+)?over\b/i.test(text) ||
    /\bno longer accepting (?:submissions|clips)\b/i.test(text) ||
    lines.some((l) => /^(?:status\s*[:\-–]?\s*)?(?:ended|closed|completed|expired|finished)$/i.test(l))
  ) {
    return "The campaign page says it has ended.";
  }
  if (budgetLeftUsd === 0 || /\bbudget\s+(?:is\s+|has\s+been\s+)?(?:fully\s+)?(?:used(?:\s+up)?|exhausted|spent|depleted|paid out)\b|\bout of budget\b|\bno budget (?:left|remaining)\b/i.test(text)) {
    return "The campaign page says its budget is used up.";
  }
  return null;
}

/** Reads a campaign page by its own words and labels. What it does not say stays empty. */
export function extractCampaign(raw: string): CampaignFacts {
  const lines = pageLines(raw);
  const { rules, briefRules } = rulesOf(lines);
  rules.budgetLeftUsd = budgetLeftOf(lines);
  return {
    creatorName: creatorOf(lines),
    channelUrls: channelsOf(lines),
    cpmRateUsd: rateOf(lines),
    minViews: minViewsOf(lines),
    allowedPlatforms: platformsOf(lines),
    expiresAt: endOf(lines),
    briefRules,
    rules,
    ended: endedOf(lines, rules.budgetLeftUsd),
  };
}

/** The fields that came back empty: the form marks each "check this". */
export function fieldsToCheck(f: CampaignFacts): CampaignField[] {
  const empty: Record<CampaignField, boolean> = {
    creatorName: !f.creatorName,
    channelUrls: f.channelUrls.length === 0,
    cpmRateUsd: f.cpmRateUsd === null,
    minViews: f.minViews === null,
    budgetLeftUsd: f.rules.budgetLeftUsd === null,
    allowedPlatforms: f.allowedPlatforms.length === 0,
    requiredTags: f.rules.requiredTags.length === 0,
    requiredLinks: f.rules.requiredLinks.length === 0,
    requiredText: f.rules.requiredText.length === 0,
    bannedWords: f.rules.bannedWords.length === 0,
    clipLength: f.rules.minSec === null && f.rules.maxSec === null,
    expiresAt: f.expiresAt === null,
  };
  return (Object.keys(empty) as CampaignField[]).filter((k) => empty[k]);
}

const nullable = (type: string) => ({ type: [type, "null"] });
const strings = { type: "array", items: { type: "string" } };

export const CAMPAIGN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "creator_name",
    "channel_urls",
    "usd_per_1000_views",
    "minimum_views",
    "budget_left_usd",
    "platforms",
    "required_tags",
    "required_links",
    "required_caption_text",
    "banned_words",
    "min_seconds",
    "max_seconds",
    "end_date",
    "ai_banned",
    "original_only",
    "payout_cap_usd",
    "max_clips_per_day",
    "submit_within_minutes",
  ],
  properties: {
    creator_name: nullable("string"),
    channel_urls: strings,
    usd_per_1000_views: nullable("number"),
    minimum_views: nullable("number"),
    budget_left_usd: nullable("number"),
    platforms: { type: "array", items: { type: "string", enum: [...PLATFORMS] } },
    required_tags: strings,
    required_links: strings,
    required_caption_text: strings,
    banned_words: strings,
    min_seconds: nullable("number"),
    max_seconds: nullable("number"),
    end_date: nullable("string"),
    ai_banned: { type: "boolean" },
    original_only: { type: "boolean" },
    payout_cap_usd: nullable("number"),
    max_clips_per_day: nullable("number"),
    submit_within_minutes: nullable("number"),
  },
} as const;

const SYSTEM = `You read the text of one public clipping-campaign page (Whop Content Rewards) and fill in its fields.
Use only what the page says, in the page's own words and numbers. When the page does not say a field, answer null or an empty list. Never guess and never fill in a typical value.
- usd_per_1000_views: the pay per 1,000 views in US dollars. minimum_views: the views a post needs before it pays.
- budget_left_usd: the budget still left, only when the page states it.
- platforms: where clips may be posted. required_tags: hashtags and @mentions a caption must carry. required_links: links a caption must carry. required_caption_text: other words a caption must say.
- banned_words: single words or short topics the campaign forbids. min_seconds / max_seconds: the clip length it takes.
- end_date: the campaign's last day as YYYY-MM-DD. channel_urls: the creator's Twitch, Kick or YouTube channel links.
- ai_banned: true only when the page forbids AI-made content. original_only: true only when it takes original clips only (no reuploads).
- payout_cap_usd: the most one clip or post can earn. max_clips_per_day: the most clips one clipper may post a day.
- submit_within_minutes: how soon after posting a clip must be submitted, in minutes.`;

function has(text: string, value: string): boolean {
  return text.includes(value.trim().toLowerCase().replace(/\s+/g, " "));
}

/** Whether the page shows this number, written plain, with commas, with cents or as 5k / 2m. */
function hasNumber(text: string, n: number): boolean {
  const forms = [String(n), n.toLocaleString("en-US"), n.toFixed(2), n.toLocaleString("en-US", { minimumFractionDigits: 2 })];
  if (n >= 1_000 && n % 100 === 0) forms.push(`${n / 1_000}k`, `${n / 1_000} k`);
  if (n >= 1_000_000 && n % 100_000 === 0) forms.push(`${n / 1_000_000}m`, `${n / 1_000_000} m`);
  return forms.some((f) => new RegExp(`(?<![\\d.,])${f.replace(/[.]/g, "\\.")}(?![\\d]|[.,]\\d)`).test(text));
}

/**
 * Checks a model's answer against the schema and against the page: a value that the page does not
 * show (a number, a tag, a name, a date) is dropped, so a model that guesses fills nothing.
 */
export function parseChatCampaign(content: string, pageWords: string): Partial<CampaignFacts> & { rules: Partial<CampaignRules> } {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(content) as Record<string, unknown>;
  } catch {
    throw new Error("The model did not answer in JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("The model's answer is not a campaign.");
  const text = pageWords.toLowerCase().replace(/\s+/g, " ");
  const num = (v: unknown, max: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max && hasNumber(text, v) ? v : null);
  const list = (v: unknown, ok: (s: string) => boolean = () => true) =>
    unique((Array.isArray(v) ? v : []).filter((s): s is string => typeof s === "string" && s.trim().length > 0 && s.length <= 200).map((s) => s.trim())).filter(
      (s) => has(text, s) && ok(s),
    );
  const name = typeof body.creator_name === "string" && body.creator_name.trim().length <= 60 && has(text, body.creator_name) ? body.creator_name.trim() : null;
  const day = typeof body.end_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.end_date) ? parseDay(body.end_date) : null;
  // The date is on the page when its year and its day number both are.
  const dayShown = day !== null && has(text, day.slice(0, 4)) && new RegExp(`(?<!\\d)0?${Number(day.slice(8, 10))}(?!\\d)`).test(text);
  return {
    creatorName: name || null,
    channelUrls: list(body.channel_urls, (s) => new RegExp(`^${CHANNEL_URL.source}`, "i").test(s)),
    cpmRateUsd: num(body.usd_per_1000_views, 1_000),
    minViews: num(body.minimum_views, 1e9),
    allowedPlatforms: PLATFORMS.filter((p) => Array.isArray(body.platforms) && body.platforms.includes(p) && PLATFORM_NAMES[p].test(text)),
    expiresAt: dayShown ? day : null,
    rules: {
      requiredTags: list(body.required_tags, (s) => /^[#@][^\s#@]+$/.test(s)),
      requiredLinks: list(body.required_links, (s) => /^https?:\/\/\S+$/i.test(s)),
      requiredText: list(body.required_caption_text),
      bannedWords: list(body.banned_words).map((s) => s.toLowerCase()),
      minSec: num(body.min_seconds, 600),
      maxSec: num(body.max_seconds, 600),
      budgetLeftUsd: num(body.budget_left_usd, 1e9),
      // Read from the page's own words only (rulesOf), never guessed by the model.
      manualSubmit: true,
      // A yes only counts when the page talks about it at all.
      aiBanned: body.ai_banned === true && /\bai\b|artificial/.test(text),
      originalOnly: body.original_only === true && /original|re-?upload|repost/.test(text),
      payoutCapUsd: num(body.payout_cap_usd, 1e6),
      maxClipsPerDay: num(body.max_clips_per_day, 1_000),
      submitWithinMin:
        typeof body.submit_within_minutes === "number" && body.submit_within_minutes > 0 && body.submit_within_minutes <= 10_080 && /submit/.test(text) &&
        (hasNumber(text, body.submit_within_minutes) || hasNumber(text, body.submit_within_minutes / 60))
          ? body.submit_within_minutes
          : null,
    },
  };
}

const MAX_PROMPT_CHARS = 12_000;

/** Fills the fields the page's own labels left empty from a chat model's reading of the same text. */
export async function fillWithChat(facts: CampaignFacts, raw: string, chat: ChatClient, signal?: AbortSignal): Promise<CampaignFacts> {
  const words = pageLines(raw).join("\n");
  const res = await chat.complete({ system: SYSTEM, user: words.slice(0, MAX_PROMPT_CHARS), schemaName: "campaign", schema: CAMPAIGN_SCHEMA }, signal);
  const said = parseChatCampaign(res.content, words);
  const orList = <T>(mine: T[], theirs: T[] | undefined) => (mine.length > 0 ? mine : (theirs ?? []));
  const rules: CampaignRules = {
    requiredTags: orList(facts.rules.requiredTags, said.rules.requiredTags),
    requiredLinks: orList(facts.rules.requiredLinks, said.rules.requiredLinks),
    requiredText: orList(facts.rules.requiredText, said.rules.requiredText),
    bannedWords: orList(facts.rules.bannedWords, said.rules.bannedWords),
    minSec: facts.rules.minSec ?? said.rules.minSec ?? null,
    maxSec: facts.rules.maxSec ?? said.rules.maxSec ?? null,
    budgetLeftUsd: facts.rules.budgetLeftUsd ?? said.rules.budgetLeftUsd ?? null,
    manualSubmit: facts.rules.manualSubmit,
    aiBanned: facts.rules.aiBanned || said.rules.aiBanned || undefined,
    originalOnly: facts.rules.originalOnly || said.rules.originalOnly || undefined,
    payoutCapUsd: facts.rules.payoutCapUsd ?? said.rules.payoutCapUsd ?? null,
    maxClipsPerDay: facts.rules.maxClipsPerDay ?? said.rules.maxClipsPerDay ?? null,
    submitWithinMin: facts.rules.submitWithinMin ?? said.rules.submitWithinMin ?? null,
    program: facts.rules.program,
  };
  return {
    ...facts,
    creatorName: facts.creatorName ?? said.creatorName ?? null,
    channelUrls: orList(facts.channelUrls, said.channelUrls),
    cpmRateUsd: facts.cpmRateUsd ?? said.cpmRateUsd ?? null,
    minViews: facts.minViews ?? said.minViews ?? null,
    allowedPlatforms: orList(facts.allowedPlatforms, said.allowedPlatforms),
    expiresAt: facts.expiresAt ?? said.expiresAt ?? null,
    rules,
  };
}
