import type { ScoutFacts } from "../../shared/scout.js";
import { PLATFORMS, type Platform } from "../../shared/types.js";
import { extractCampaign, money, pageLines } from "../sources/campaign/extract.js";
import { decodeEntities, isPublicWebUrl } from "../sources/proof.js";

const CAMPAIGN_HOST = "contentrewards.com";

/** Where the scout starts: the site's public sitemap, which lists every open campaign page, and its clipping listing. */
export const DEFAULT_SCOUT_URLS = [`https://${CAMPAIGN_HOST}/sitemap.xml`, `https://${CAMPAIGN_HOST}/c/discover/clipping`];
const CAMPAIGN_LINK = /(https?:\/\/(?:www\.)?contentrewards\.com)?\/c\/campaigns\/([A-Za-z0-9][A-Za-z0-9_-]{2,80})(?![A-Za-z0-9_-])/g;

function bareHost(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, "");
}

/**
 * Every Content Rewards campaign page a listing, sitemap or agency page points to, as full links.
 * A link without a host only counts on contentrewards.com itself.
 */
export function campaignLinks(raw: string, baseUrl: string): string[] {
  const onSite = bareHost(new URL(baseUrl)) === CAMPAIGN_HOST;
  const found = new Set<string>();
  for (const m of raw.matchAll(CAMPAIGN_LINK)) {
    if (m[1] || onSite) found.add(`https://${CAMPAIGN_HOST}/c/campaigns/${m[2]}`);
  }
  return [...found];
}

/** Sites a campaign page links to that are never an agency's page: the platforms themselves and chat or link pages. */
const NOT_AGENCY_HOSTS = [
  "tiktok.com",
  "youtube.com",
  "youtu.be",
  "instagram.com",
  "x.com",
  "twitter.com",
  "twitch.tv",
  "kick.com",
  "facebook.com",
  "discord.gg",
  "discord.com",
  "t.me",
  "whop.com",
  "linktr.ee",
  "google.com",
  "apple.com",
];
/** One-word pages on contentrewards.com that are the site's own, not an agency's. */
const SITE_PAGES = new Set(
  "about articles blog book-a-demo c careers confirmation contact discover faq help home login logout onboarding partners pricing privacy refer session-profile signup support terms".split(" "),
);

/**
 * The agency pages a campaign page links to: a one-word page on contentrewards.com
 * (contentrewards.com/clipsmart) or on an agency's own site (reachclipping.com/TJR).
 */
export function agencyLinks(raw: string, baseUrl: string): string[] {
  const found = new Set<string>();
  for (const m of raw.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"'#?]+)["']/gi)) {
    let u: URL;
    try {
      u = new URL(decodeEntities(m[1]!), baseUrl);
    } catch {
      continue;
    }
    const host = bareHost(u);
    const parts = u.pathname.split("/").filter(Boolean);
    if (u.protocol !== "https:" || !isPublicWebUrl(u.toString()) || parts.length !== 1 || !/^[\w-]{2,40}$/.test(parts[0]!)) continue;
    if (NOT_AGENCY_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) continue;
    if (host === CAMPAIGN_HOST && SITE_PAGES.has(parts[0]!.toLowerCase())) continue;
    found.add(`https://${host}/${parts[0]}`);
  }
  return [...found];
}

/** The page's name: its first heading, else its title. */
export function pageTitle(raw: string): string {
  const m = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(raw) ?? /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(raw);
  return m ? decodeEntities(m[1]!.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 120) : "";
}

/** Every value after a label: on the same line after a colon or dash, else the line below a line that is only the label. */
function values(lines: string[], label: RegExp): string[] {
  const re = new RegExp(`^(?:${label.source})(?:\\s*[:\\-–]\\s*(.+)|\\s*:?)$`, "i");
  const out: string[] = [];
  lines.forEach((line, i) => {
    const m = re.exec(line);
    const value = m && (m[1]?.trim() || lines[i + 1]);
    if (value) out.push(value);
  });
  return out;
}

function amounts(lines: string[], label: RegExp): number[] {
  return values(lines, label)
    .map(money)
    .filter((n): n is number => n !== null);
}

const PLATFORM_HEADING: Record<Platform, RegExp> = {
  tiktok: /^tik\s?tok$/i,
  youtube: /^youtube(?:\s+shorts)?$/i,
  instagram: /^instagram(?:\s+reels)?$/i,
  x: /^(?:x|twitter)$/i,
};

function count(s: string): number {
  return Number(s.replace(/,/g, ""));
}

/**
 * Reads a public campaign page the way the campaign import does (pay, minimum views, platforms,
 * creator, rules, end date), plus what only matters when choosing: payout limits, budget used and
 * total, audience requirements and how many clippers joined.
 */
export function extractScouted(raw: string): ScoutFacts {
  const base = extractCampaign(raw);
  const lines = pageLines(raw);

  // One rate per platform: the lowest is what every clip is sure to earn.
  const rates = amounts(lines, /per\s+1k(?:\s+views)?/);
  const payoutMins = amounts(lines, /min(?:imum)?\.?\s+payout/);
  const payoutMaxes = amounts(lines, /max(?:imum)?\.?\s+payout/);

  let used: number | null = null;
  let total: number | null = null;
  let left = base.rules.budgetLeftUsd;
  const budget = values(lines, /(?:total\s+|campaign\s+)?budget/)[0];
  const both = budget ? /(\$\s?[\d,.]+\s?[km]?)\s*(?:\/|of|out of)\s*(\$\s?[\d,.]+\s?[km]?)/i.exec(budget) : null;
  if (both) [used, total] = [money(both[1]!), money(both[2]!)];
  else if (budget) total = money(budget);
  if (total !== null && used !== null) left = Math.max(0, total - used);
  else if (total !== null && left !== null) used = Math.max(0, total - left);

  const headings = PLATFORMS.filter((p) => lines.some((l) => PLATFORM_HEADING[p].test(l)));
  const audience = lines.filter(
    (l) =>
      l.length <= 200 &&
      ((/\d\s?%/.test(l) && /\b(?:audience|viewers|followers|traffic)\b/i.test(l)) ||
        /\baudience\b.*\b(?:must|only|required|requirement)\b|\b(?:must|only|required)\b.*\baudience\b/i.test(l)),
  );
  const text = lines.join("\n");
  const locked = /\b(\d+)\s+requirements?\b[^\n]*\b(?:locked|once you join|after you join|after joining)\b|\bjoin to (?:unlock|see) (\d+) requirements?\b/i.exec(text);
  const joined =
    values(lines, /clippers(?:\s+joined)?|participants|creators\s+joined/)[0] ??
    /\b(\d[\d,]*)\s+(?:clippers|participants)\b|\b(\d[\d,]*)\s+creators\s+(?:joined|clipping)\b/i.exec(text)?.slice(1).find(Boolean);
  const clippers = joined && /^\d[\d,]*\b/.test(joined) ? count(/^\d[\d,]*/.exec(joined)![0]) : null;

  return {
    title: pageTitle(raw),
    creatorName: base.creatorName,
    agency: null,
    channelUrls: base.channelUrls,
    ratePer1kUsd: rates.length > 0 ? Math.min(...rates) : base.cpmRateUsd,
    payoutMinUsd: payoutMins.length > 0 ? Math.max(...payoutMins) : null,
    payoutMaxUsd: payoutMaxes.length > 0 ? Math.min(...payoutMaxes) : null,
    budgetUsedUsd: used,
    budgetTotalUsd: total,
    budgetLeftUsd: left,
    platforms: base.allowedPlatforms.length > 0 ? base.allowedPlatforms : headings,
    minViews: base.minViews,
    audience: [...new Set(audience)],
    rules: base.briefRules.split("\n").filter(Boolean),
    lockedRequirements: locked ? Number(locked[1] ?? locked[2]) : 0,
    clippers,
    expiresAt: base.expiresAt,
    ended: base.ended ?? (left === 0 ? "The campaign page says its budget is used up." : null),
  };
}
