import {
  type AutoPlanRow,
  BUDGET_NOTICE_USED,
  type ScoutedCampaign,
  type ScoutFacts,
  type ScoutInfo,
  SUGGESTION_COUNT,
} from "../../shared/scout.js";
import { type ChannelAccount, type Permission, PLATFORMS, type Source } from "../../shared/types.js";
import type { Notifier } from "../live/notify.js";
import type { PostsRepo } from "../publish/repo.js";
import { campaignKey, isCampaignUrl } from "../sources/campaign/extract.js";
import type { SourcesRepo } from "../sources/repo.js";
import { type JoinedCampaign, planAuto } from "./auto.js";
import { agencyLinks, campaignLinks, extractScouted, pageTitle } from "./extract.js";
import type { PoliteFetcher } from "./polite.js";
import type { ScoutRepo, ScoutRow } from "./repo.js";
import { type ScoreContext, scoreCampaign } from "./score.js";

/** The scout runs once a day. */
export const SCOUT_EVERY_HOURS = 24;
/** Pages one run reads at most: ten minutes at one page every five seconds. The rest waits for the next day. */
export const SCOUT_MAX_PAGES = 120;
/** A new campaign is pushed as "worth joining" from this estimate per day. */
export const WORTH_JOINING_USD_PER_DAY = 1;
/** Agency pages one run reads at most. */
export const SCOUT_MAX_AGENCIES = 5;

export interface ScoutDeps {
  repo: ScoutRepo;
  sources: SourcesRepo;
  posts: PostsRepo;
  /** The posting accounts, with their own pace. */
  accounts: () => ChannelAccount[];
  /** The fetch layer: robots.txt and the rate limit are its job. */
  fetcher: PoliteFetcher;
  /** The public listing or discovery pages (a sitemap counts) the scout starts from. */
  startUrls: string[];
  /** Sends the daily push to the phones that turned notifications on. */
  notifier?: Notifier;
  /** Creators on the watchlist, whose streams we already follow. */
  watched?: () => string[];
  /** Who today's fastest GTA clips are from or about (trend radar); empty without fresh data. */
  trending?: () => string[];
  maxPages?: number;
  now?: () => Date;
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * The campaign scout: reads public Content Rewards campaign pages once a day, scores each one, keeps
 * the best for "Campaigns for you", and in auto mode shares the day's clips over the joined campaigns.
 * Joining stays the manager's tap: the scout never signs in anywhere.
 */
export class Scout {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private readonly now: () => Date;

  constructor(private deps: ScoutDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  get repo(): ScoutRepo {
    return this.deps.repo;
  }

  private context(sources: Source[]): ScoreContext {
    const ourViews: ScoreContext["ourViews"] = {};
    for (const p of this.deps.posts.list()) {
      if (p.views !== null) (ourViews[p.platform] ??= []).push(p.views);
    }
    return {
      ourViews,
      knownCreators: [...sources.map((s) => s.creatorName), ...(this.deps.watched?.() ?? [])],
      trending: this.deps.trending?.() ?? [],
      // One campaign's clips at the shared pace of one account.
      clipsPerDay: this.deps.posts.rules().maxPerDay,
    };
  }

  /** Clips a day the accounts that take campaign clips can carry: the busiest platform's posts a day. */
  slots(): number {
    const open = this.deps.accounts().filter((a) => a.enabled && !a.disabled && a.health !== "banned" && a.takes.includes("whop-campaign"));
    return Math.max(0, ...PLATFORMS.map((p) => open.filter((a) => a.platform === p).reduce((sum, a) => sum + a.pace.maxPerDay, 0)));
  }

  /** The campaigns the manager joined (Whop campaign records), each with its score and budget. */
  private joined(sources: Source[], rows: ScoutRow[], ctx: ScoreContext): JoinedCampaign[] {
    const now = this.now().getTime();
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return sources.flatMap((s) =>
      s.permissions
        .filter((p) => p.kind === "whop-campaign" && p.campaignUrl)
        .map((p): JoinedCampaign => {
          const seen = byKey.get(campaignKey(p.campaignUrl!))?.facts;
          // The terms the manager checked on the form come first; the page fills in the budget and the rest.
          const facts: ScoutFacts = {
            title: seen?.title ?? s.creatorName,
            creatorName: s.creatorName,
            agency: seen?.agency ?? null,
            channelUrls: s.channelUrls.length > 0 ? s.channelUrls : (seen?.channelUrls ?? []),
            ratePer1kUsd: p.cpmRateUsd ?? seen?.ratePer1kUsd ?? null,
            payoutMinUsd: seen?.payoutMinUsd ?? null,
            payoutMaxUsd: seen?.payoutMaxUsd ?? null,
            budgetUsedUsd: seen?.budgetUsedUsd ?? null,
            budgetTotalUsd: seen?.budgetTotalUsd ?? null,
            budgetLeftUsd: seen?.budgetLeftUsd ?? p.rules?.budgetLeftUsd ?? null,
            platforms: p.allowedPlatforms.length > 0 ? p.allowedPlatforms : (seen?.platforms ?? []),
            minViews: p.minViews ?? seen?.minViews ?? null,
            audience: seen?.audience ?? [],
            rules: p.briefRules ? p.briefRules.split("\n") : (seen?.rules ?? []),
            lockedRequirements: 0,
            clippers: seen?.clippers ?? null,
            expiresAt: p.expiresAt,
            ended: null,
          };
          const over = p.expiresAt !== null && new Date(p.expiresAt).getTime() <= now;
          return {
            permissionId: p.id,
            name: s.creatorName,
            score: scoreCampaign(facts, ctx).score,
            budgetLeftUsd: facts.budgetLeftUsd,
            budgetTotalUsd: facts.budgetTotalUsd,
            stopped: p.reviewReason ?? (over ? `It ended on ${p.expiresAt!.slice(0, 10)}.` : null) ?? seen?.ended ?? null,
          };
        }),
    );
  }

  private plan(sources: Source[], rows: ScoutRow[], ctx: ScoreContext): AutoPlanRow[] {
    return planAuto(this.joined(sources, rows, ctx), this.slots());
  }

  info(): ScoutInfo {
    const { repo } = this.deps;
    const sources = this.deps.sources.list();
    const rows = repo.list();
    const ctx = this.context(sources);
    const joinedKeys = new Set(
      sources.flatMap((s) => s.permissions.filter((p) => p.kind === "whop-campaign" && p.campaignUrl).map((p) => campaignKey(p.campaignUrl!))),
    );
    const suggestions = rows
      .filter((r) => r.status !== "hidden" && !joinedKeys.has(r.key))
      .map((r): ScoutedCampaign => ({ id: r.id, url: r.url, facts: r.facts, score: scoreCampaign(r.facts, ctx), status: r.status, firstSeenAt: r.firstSeenAt, readAt: r.readAt }))
      .filter((c) => c.score.score > 0)
      .sort((a, b) => b.score.score - a.score.score || a.id - b.id)
      .slice(0, SUGGESTION_COUNT);
    const last = repo.lastRun();
    return {
      suggestions,
      found: rows.length,
      running: this.running !== null,
      lastRunAt: last.at,
      lastError: last.error,
      auto: { on: repo.auto(), slots: this.slots(), plan: this.plan(sources, rows, ctx) },
    };
  }

  /**
   * Auto mode's say on a post: why this campaign takes no more clips today (it is paused, or its
   * share of the day is used), or null. A clip that already went out under it today may go on to
   * more accounts. With auto mode off, or for any other kind of permission, nothing is held back.
   */
  postBlock(permission: Permission, clipId: number): string | null {
    if (permission.kind !== "whop-campaign" || !this.deps.repo.auto()) return null;
    const sources = this.deps.sources.list();
    const row = this.plan(sources, this.deps.repo.list(), this.context(sources)).find((r) => r.permissionId === permission.id);
    if (!row) return null;
    const off = "Turn auto mode off in Settings to post anyway.";
    if (row.paused) return `Auto mode paused ${row.name}: ${row.paused} ${off}`;
    const today = this.deps.posts.clipsTodayUnder(permission.id);
    if (today.includes(clipId) || today.length < row.slots) return null;
    return `Auto mode gives ${row.name} ${row.slots} ${row.slots === 1 ? "clip" : "clips"} a day and ${today.length} went out today. Try tomorrow. ${off}`;
  }

  /** Reads the discovery pages and as many campaign pages as one run may; one run at a time. */
  run(): Promise<void> {
    this.running ??= this.scout().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async scout(): Promise<void> {
    const { repo, fetcher, startUrls } = this.deps;
    const maxPages = this.deps.maxPages ?? SCOUT_MAX_PAGES;
    const problems: string[] = [];
    let pages = 0;
    fetcher.newRun();
    const read = async (url: string) => {
      pages += 1;
      try {
        const page = await fetcher.fetchPage(url);
        if (page.status < 200 || page.status >= 300) problems.push(`${new URL(url).hostname} answered ${page.status}`);
        return page;
      } catch (err) {
        problems.push(err instanceof Error ? err.message : String(err));
        return null;
      }
    };
    const ok = (page: { status: number } | null) => page !== null && page.status >= 200 && page.status < 300;

    const listed: string[] = [];
    for (const start of startUrls) {
      const page = await read(start);
      if (ok(page)) listed.push(...campaignLinks(page!.text, start));
    }

    // Joined campaigns first (their budget steers auto mode), then today's suggestions, then
    // campaigns never read, then the rest, the one read longest ago first.
    const before = this.info();
    const known = repo.list();
    const knownKeys = new Set(known.map((r) => r.key));
    const joined = this.deps.sources
      .list()
      .flatMap((s) => s.permissions)
      .filter((p) => p.kind === "whop-campaign" && p.campaignUrl && isCampaignUrl(p.campaignUrl) && p.reviewReason === null)
      .map((p) => p.campaignUrl!);
    const queue: string[] = [];
    const queued = new Set<string>();
    const add = (url: string) => {
      const key = campaignKey(url);
      if (!queued.has(key)) queue.push(url);
      queued.add(key);
    };
    joined.forEach(add);
    before.suggestions.forEach((s) => add(s.url));
    listed.filter((url) => !knownKeys.has(campaignKey(url))).forEach(add);
    known.filter((r) => r.status !== "hidden").forEach((r) => add(r.url));

    const agencies = new Set<string>();
    const agencyOf = new Map<string, string>();
    let saved = 0;
    while (queue.length > 0 && pages < maxPages) {
      const url = queue.shift()!;
      const page = await read(url);
      if (page && (page.status === 404 || page.status === 410)) repo.remove(url);
      if (!ok(page)) continue;
      const facts = extractScouted(page!.text);
      facts.title ||= facts.creatorName ?? "Campaign";
      facts.agency = agencyOf.get(campaignKey(url)) ?? known.find((r) => r.key === campaignKey(url))?.facts.agency ?? null;
      repo.save(url, facts, this.now());
      saved += 1;
      // An agency's page lists its other campaigns: read it once, and name the agency on each.
      for (const agencyUrl of agencyLinks(page!.text, url)) {
        if (agencies.has(agencyUrl) || agencies.size >= SCOUT_MAX_AGENCIES || pages >= maxPages) continue;
        agencies.add(agencyUrl);
        const agencyPage = await read(agencyUrl);
        if (!ok(agencyPage)) continue;
        const theirs = campaignLinks(agencyPage!.text, agencyUrl);
        // A one-word page with no campaign on it is not an agency's.
        if (theirs.length === 0) continue;
        const name = pageTitle(agencyPage!.text) || new URL(agencyUrl).pathname.slice(1);
        for (const link of theirs) {
          agencyOf.set(campaignKey(link), name);
          add(link);
        }
        facts.agency = name;
        repo.save(url, facts, this.now());
      }
    }
    repo.markRun(this.now(), saved > 0 ? null : (problems[0] ?? "No campaign was found on the discovery pages."));
    await this.notify();
  }

  /** The daily push: new campaigns worth joining, and a joined campaign whose budget is nearly used. */
  private async notify(): Promise<void> {
    const { repo, notifier } = this.deps;
    if (!notifier) return;
    const info = this.info();
    const told = new Set(repo.list().filter((r) => r.notified).map((r) => r.id));
    const fresh = info.suggestions.filter((s) => !told.has(s.id) && s.score.perDayUsd >= WORTH_JOINING_USD_PER_DAY);
    const lines: string[] = [];
    if (fresh.length > 0) {
      const perDay = fresh.reduce((sum, s) => sum + s.score.perDayUsd, 0);
      lines.push(`${fresh.length} new ${fresh.length === 1 ? "campaign" : "campaigns"} worth joining (est. ${money(perDay)}/day)`);
    }
    const toldBudget = repo.budgetNotified();
    const low = info.auto.plan.filter((r) => r.budgetUsedPct !== null && r.budgetUsedPct >= BUDGET_NOTICE_USED * 100 && !toldBudget.includes(r.permissionId));
    for (const r of low) {
      const next = info.auto.on ? info.auto.plan.find((o) => o.permissionId !== r.permissionId && o.slots > 0) : undefined;
      lines.push(`${r.name} budget at ${r.budgetUsedPct}%${next ? `, switching effort to ${next.name}` : ""}`);
    }
    if (lines.length === 0) return;
    // Marked first: a notifier never throws, and the same news twice is worse than once missed.
    repo.markNotified(fresh.map((s) => s.id));
    repo.markBudgetNotified(low.map((r) => r.permissionId));
    await notifier.notify({ title: "clipfarm: campaigns", body: lines.join("\n"), url: "/#dashboard" });
  }

  /** Runs the scout when the last run is a day or more ago. */
  async runIfDue(): Promise<boolean> {
    const last = this.deps.repo.lastRun().at;
    if (last && this.now().getTime() - new Date(last).getTime() < SCOUT_EVERY_HOURS * 3600_000) return false;
    await this.run();
    return true;
  }

  /** Looks every `intervalMs` whether the daily run is due. */
  start(intervalMs: number): void {
    const tick = () => void this.runIfDue().catch((err: unknown) => console.error("Campaign scout failed:", err));
    tick();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
