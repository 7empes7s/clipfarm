// The business dashboard: views, earnings and costs per clip, platform, account, campaign, source and
// workspace, plus the health of the pipeline. Pure maths, the same on the server and in the client.
// null is always "not available": a number nobody gave us is never shown as a 0.
import { median, round2 } from "./metrics.js";
import type { Platform } from "./types.js";

export const RANGES = [
  { id: "today", label: "Today", days: 1 },
  { id: "7d", label: "7 days", days: 7 },
  { id: "30d", label: "30 days", days: 30 },
] as const;
export type RangeId = (typeof RANGES)[number]["id"];

export const GROUPS = [
  { id: "platform", label: "Platform" },
  { id: "account", label: "Account" },
  { id: "campaign", label: "Campaign" },
  { id: "source", label: "Creator" },
  { id: "workspace", label: "Workspace" },
] as const;
export type GroupBy = (typeof GROUPS)[number]["id"];

/** One post with everything the dashboard adds up. Metrics are null when the platform did not say. */
export interface PostFacts {
  postId: number;
  clipId: number;
  clipTitle: string;
  hook: string;
  url: string | null;
  platform: Platform;
  accountId: string;
  accountName: string;
  campaignKey: string;
  campaign: string;
  sourceName: string;
  workspace: string;
  postedAt: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  followsGained: number | null;
  avgWatchPct: number | null;
  /** Estimated from views × the campaign's pay per 1,000. */
  earningsUsd: number;
  /** What the campaign actually paid (CSV import or the Paid tap); null while unknown. */
  paidUsd: number | null;
}

export interface Totals {
  posts: number;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  followsGained: number | null;
  avgWatchPct: number | null;
  earningsUsd: number;
  paidUsd: number | null;
  /** Estimated earnings per 1,000 views; null without views. */
  perThousandUsd: number | null;
}

export interface GroupRow extends Totals {
  key: string;
  label: string;
}

export interface Funnel {
  made: number;
  approved: number;
  posted: number;
  paid: number;
}

export interface CostLine {
  label: string;
  /** null: this cost is not recorded anywhere (shown as "not available"). */
  usd: number | null;
  note: string;
}

export interface CampaignMoney {
  key: string;
  label: string;
  posts: number;
  views: number | null;
  /** Views the campaign itself counted (from its CSV); null without an import. */
  viewsCounted: number | null;
  approved: number;
  rejected: number;
  earningsUsd: number;
  paidUsd: number | null;
  perThousandUsd: number | null;
}

export interface Money {
  earningsUsd: number;
  paidUsd: number | null;
  costUsd: number;
  costLines: CostLine[];
  approvedClips: number;
  /** Charter O5: what one approved clip costs; null before the first approval. */
  costPerApprovedClipUsd: number | null;
  profitUsd: number;
  perThousandUsd: number | null;
  byCampaign: CampaignMoney[];
}

export interface BestClip {
  clipId: number;
  title: string;
  hook: string;
  posts: number;
  views: number;
  earningsUsd: number;
}

export interface BestHook {
  hook: string;
  clipId: number;
  posts: number;
  medianViews: number;
}

export interface BestTime {
  /** Hour of the day, UTC. */
  hour: number;
  posts: number;
  medianViews: number;
}

export interface DayPoint {
  date: string;
  views: number | null;
  earningsUsd: number;
  posts: number;
}

export interface BusinessBoard {
  range: RangeId;
  from: string;
  to: string;
  totals: Totals;
  funnel: Funnel;
  money: Money;
  days: DayPoint[];
  groups: Record<GroupBy, GroupRow[]>;
  bestClips: BestClip[];
  bestHooks: BestHook[];
  bestTimes: BestTime[];
  posts: PostFacts[];
  digest: { title: string; lines: string[] };
  /** True while every number comes from demo data. */
  demo: boolean;
}

// ---------------------------------------------------------------- health

/** What one platform's stats API gives us, and whether it is connected. */
export interface StatsAvailability {
  platform: Platform;
  /** Connected and allowed to be asked. */
  connected: boolean;
  /** The metrics its API gives; everything else is "not available" for this platform. */
  metrics: string[];
  callsToday: number;
  callBudget: number;
  lastError: string | null;
  note: string;
}

export interface QuotaRow {
  key: string;
  label: string;
  platform: Platform;
  unit: string;
  used: number;
  limit: number;
  left: number;
  /** When the count starts again, when known. */
  resetsAt: string | null;
}

export interface RiskRow {
  key: string;
  accountName: string;
  platform: Platform | null;
  kind: "strike" | "claim" | "removal" | "paused" | "rejected" | "warning";
  reason: string;
  at: string | null;
  clipId: number | null;
}

export interface HealthBoard {
  runs: { total: number; done: number; failed: number; running: number; queued: number };
  failuresByStep: { step: string; failed: number; lastError: string | null; lastAt: string | null }[];
  queueLength: number;
  postingFailures: { postId: number; clipId: number; clipTitle: string; platform: Platform; accountName: string; error: string; at: string }[];
  quotas: QuotaRow[];
  atRisk: RiskRow[];
  stats: StatsAvailability[];
}

// ---------------------------------------------------------------- maths

/** The sum of the numbers we have; null when none is known, so "nobody said" never reads as 0. */
export function sumKnown(values: (number | null | undefined)[]): number | null {
  let total: number | null = null;
  for (const v of values) if (typeof v === "number" && Number.isFinite(v)) total = (total ?? 0) + v;
  return total;
}

/** The average of the numbers we have; null when none is known. */
export function averageKnown(values: (number | null | undefined)[]): number | null {
  const known = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return known.length ? known.reduce((s, v) => s + v, 0) / known.length : null;
}

/** Earnings per 1,000 views, to the cent; null without any views to divide by. */
export function perThousand(earningsUsd: number, views: number | null): number | null {
  if (views === null || views <= 0) return null;
  return round2((earningsUsd / views) * 1000);
}

/** Adds up a set of posts. */
export function totalsOf(posts: PostFacts[]): Totals {
  const views = sumKnown(posts.map((p) => p.views));
  const earningsUsd = round2(posts.reduce((s, p) => s + p.earningsUsd, 0));
  const paid = sumKnown(posts.map((p) => p.paidUsd));
  return {
    posts: posts.length,
    views,
    likes: sumKnown(posts.map((p) => p.likes)),
    comments: sumKnown(posts.map((p) => p.comments)),
    shares: sumKnown(posts.map((p) => p.shares)),
    followsGained: sumKnown(posts.map((p) => p.followsGained)),
    avgWatchPct: (() => {
      const a = averageKnown(posts.map((p) => p.avgWatchPct));
      return a === null ? null : Math.round(a * 10) / 10;
    })(),
    earningsUsd,
    paidUsd: paid === null ? null : round2(paid),
    perThousandUsd: perThousand(earningsUsd, views),
  };
}

const GROUP_KEY: Record<GroupBy, (p: PostFacts) => [string, string]> = {
  platform: (p) => [p.platform, p.platform],
  account: (p) => [p.accountId, p.accountName],
  campaign: (p) => [p.campaignKey, p.campaign],
  source: (p) => [p.sourceName, p.sourceName],
  workspace: (p) => [p.workspace, p.workspace],
};

/** One row per platform, account, campaign, creator or workspace; most views first. */
export function groupPosts(posts: PostFacts[], by: GroupBy, label: (key: string, fallback: string) => string = (_k, f) => f): GroupRow[] {
  const groups = new Map<string, { label: string; posts: PostFacts[] }>();
  for (const p of posts) {
    const [key, name] = GROUP_KEY[by](p);
    const g = groups.get(key) ?? { label: label(key, name), posts: [] };
    g.posts.push(p);
    groups.set(key, g);
  }
  return [...groups]
    .map(([key, g]) => ({ key, label: g.label, ...totalsOf(g.posts) }))
    .sort((a, b) => (b.views ?? -1) - (a.views ?? -1) || b.earningsUsd - a.earningsUsd || a.label.localeCompare(b.label));
}

/**
 * Clips made → approved → posted → paid. Each step counts clips (not posts) made in the range, so
 * a later step is never larger than an earlier one.
 */
export function funnelOf(
  clips: { id: number; status: string }[],
  posts: { clipId: number; status: string; paid: boolean }[],
): Funnel {
  const made = new Set(clips.map((c) => c.id));
  const approved = new Set(clips.filter((c) => c.status === "approved").map((c) => c.id));
  const posted = new Set(posts.filter((p) => p.status === "posted" && approved.has(p.clipId)).map((p) => p.clipId));
  const paid = new Set(posts.filter((p) => p.paid && posted.has(p.clipId)).map((p) => p.clipId));
  return { made: made.size, approved: approved.size, posted: posted.size, paid: paid.size };
}

/** Spend over approved clips, to 4 decimals; null before the first approval (never a fake $0). */
export function costPerApproved(costUsd: number, approvedClips: number): number | null {
  return approvedClips > 0 ? Math.round((costUsd / approvedClips) * 10000) / 10000 : null;
}

/** What is left of a quota: never below 0, and the limit when nothing was used. */
export function quotaLeft(used: number, limit: number): number {
  return Math.max(0, limit - Math.max(0, used));
}

/** How many posts went out within the last `windowMs` (a rolling quota such as Instagram's 50 per 24 h). */
export function usedInWindow(times: string[], now: Date, windowMs: number): number {
  const since = now.getTime() - windowMs;
  return times.filter((t) => {
    const at = new Date(t).getTime();
    return at > since && at <= now.getTime();
  }).length;
}

/** Whether another stats call fits today's budget. */
export function statsCallAllowed(callsToday: number, budget: number): boolean {
  return callsToday < budget;
}

/** Clips by views over all their posts; only clips with known views can be "best". */
export function bestClips(posts: PostFacts[], n = 5): BestClip[] {
  const byClip = new Map<number, BestClip>();
  for (const p of posts) {
    if (p.views === null) continue;
    const c = byClip.get(p.clipId) ?? { clipId: p.clipId, title: p.clipTitle, hook: p.hook, posts: 0, views: 0, earningsUsd: 0 };
    c.posts++;
    c.views += p.views;
    c.earningsUsd = round2(c.earningsUsd + p.earningsUsd);
    byClip.set(p.clipId, c);
  }
  return [...byClip.values()].sort((a, b) => b.views - a.views || a.clipId - b.clipId).slice(0, n);
}

/** Hooks by the median views of their posts. */
export function bestHooks(posts: PostFacts[], n = 5): BestHook[] {
  const byHook = new Map<string, { clipId: number; views: number[] }>();
  for (const p of posts) {
    const hook = p.hook.trim();
    if (!hook || p.views === null) continue;
    const h = byHook.get(hook) ?? { clipId: p.clipId, views: [] };
    h.views.push(p.views);
    byHook.set(hook, h);
  }
  return [...byHook]
    .map(([hook, h]) => ({ hook, clipId: h.clipId, posts: h.views.length, medianViews: median(h.views)! }))
    .sort((a, b) => b.medianViews - a.medianViews || a.hook.localeCompare(b.hook))
    .slice(0, n);
}

/** Hours of the day (UTC) by the median views of the posts that went out in them. */
export function bestTimes(posts: PostFacts[], n = 3): BestTime[] {
  const byHour = new Map<number, number[]>();
  for (const p of posts) {
    if (p.views === null) continue;
    const hour = new Date(p.postedAt).getUTCHours();
    byHour.set(hour, [...(byHour.get(hour) ?? []), p.views]);
  }
  return [...byHour]
    .map(([hour, views]) => ({ hour, posts: views.length, medianViews: median(views)! }))
    .sort((a, b) => b.medianViews - a.medianViews || a.hour - b.hour)
    .slice(0, n);
}

/** A CSV with a header row; null is an empty cell ("not available"), never a 0. */
export function toCsvTable(header: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    // A leading = + - @ would run as a formula in a spreadsheet.
    const safe = /^[=+\-@]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\n") + "\n";
}

// ---------------------------------------------------------------- campaign payouts (CSV import)

export const PAYOUT_STATUSES = ["pending", "approved", "rejected", "paid"] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export interface PayoutRow {
  url: string;
  viewsCounted: number | null;
  status: PayoutStatus;
  payoutUsd: number | null;
  reason: string;
}

/** Splits one CSV line, with quoted cells. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

const HEADER_NAMES: Record<keyof PayoutRow, string[]> = {
  url: ["url", "link", "post", "post url", "post link", "video", "video url", "submission"],
  viewsCounted: ["views", "views counted", "counted views", "approved views", "view count"],
  status: ["status", "state", "result"],
  payoutUsd: ["payout", "paid", "amount", "earnings", "payout usd", "amount usd", "earned"],
  reason: ["reason", "rejection reason", "note", "notes", "feedback"],
};

function parseStatus(raw: string): PayoutStatus {
  const s = raw.toLowerCase();
  if (/reject|denied|declin|fail/.test(s)) return "rejected";
  if (/paid|payout sent|complete/.test(s)) return "paid";
  if (/approv|accept/.test(s)) return "approved";
  return "pending";
}

function parseNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Reads a campaign's export (Content Rewards or any CSV with a header row): the post link, the views
 * the campaign counted, its status, the payout and the reason. Rows without a link are left out.
 */
export function parsePayoutCsv(text: string): { rows: PayoutRow[]; skipped: number } {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return { rows: [], skipped: 0 };
  const header = splitCsvLine(lines[0]!).map((h) => h.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim());
  const col = (field: keyof PayoutRow) => header.findIndex((h) => HEADER_NAMES[field].includes(h));
  const idx = { url: col("url"), views: col("viewsCounted"), status: col("status"), payout: col("payoutUsd"), reason: col("reason") };
  if (idx.url < 0) throw new Error("The file needs a column with the post link (named url, link or post).");
  const rows: PayoutRow[] = [];
  let skipped = 0;
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const url = cells[idx.url] ?? "";
    if (!/^https?:\/\//i.test(url)) {
      skipped++;
      continue;
    }
    const views = idx.views >= 0 ? parseNumber(cells[idx.views]) : null;
    rows.push({
      url,
      viewsCounted: views === null ? null : Math.round(views),
      status: idx.status >= 0 ? parseStatus(cells[idx.status] ?? "") : "pending",
      payoutUsd: idx.payout >= 0 ? parseNumber(cells[idx.payout]) : null,
      reason: idx.reason >= 0 ? (cells[idx.reason] ?? "") : "",
    });
  }
  return { rows, skipped };
}

/** A post link without "www.", query or trailing slash, so the same post matches however it was copied. */
export function postLinkKey(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m)\./, "");
    // YouTube's ?v= is the video itself.
    const v = host.endsWith("youtube.com") ? u.searchParams.get("v") : null;
    return `${host}${u.pathname.replace(/\/+$/, "")}${v ? `?v=${v}` : ""}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}
