import type { AccountCard, AccountsInfo, DailyPoint, Platform, Post, PostingAccount, PostingRules } from "../../shared/types.js";
import { average, dayOf, growth, mergeSeries } from "../../shared/metrics.js";
import type { Db } from "../db/index.js";
import { NotFoundError } from "../errors.js";
import type { PostsRepo } from "../publish/repo.js";
import type { AccountStats, PostingService } from "../publish/types.js";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** After a failed read, wait this long before asking the service again. */
const RETRY_AFTER_MS = 15 * 60_000;

export interface AccountStatsRow {
  accountId: string;
  platform: Platform;
  name: string;
  followers: DailyPoint[];
  views: DailyPoint[];
  manualFollowers: DailyPoint[];
  fetchedAt: string | null;
  demo: boolean;
}

interface DbRow {
  account_id: string;
  platform: Platform;
  name: string;
  followers: string;
  views: string;
  manual_followers: string;
  fetched_at: string | null;
  demo: number;
}

function toRow(r: DbRow): AccountStatsRow {
  return {
    accountId: r.account_id,
    platform: r.platform,
    name: r.name,
    followers: JSON.parse(r.followers) as DailyPoint[],
    views: JSON.parse(r.views) as DailyPoint[],
    manualFollowers: JSON.parse(r.manual_followers) as DailyPoint[],
    fetchedAt: r.fetched_at,
    demo: r.demo === 1,
  };
}

/** True when nothing was read yet or the last read is at least `intervalMs` old. */
export function isDue(lastAt: string | null, now: Date, intervalMs: number): boolean {
  return lastAt === null || now.getTime() - new Date(lastAt).getTime() >= intervalMs;
}

/**
 * The cache/limit guard: which accounts to ask the service about now. Only accounts whose stats are
 * older than the interval, stalest first, and at most `max` of them (each can cost an API call).
 */
export function dueAccounts(
  accounts: PostingAccount[],
  fetchedAt: Map<string, string | null>,
  now: Date,
  intervalMs: number,
  max: number,
): PostingAccount[] {
  return accounts
    .filter((a) => !a.disabled && isDue(fetchedAt.get(a.id) ?? null, now, intervalMs))
    .sort((a, b) => (fetchedAt.get(a.id) ?? "").localeCompare(fetchedAt.get(b.id) ?? ""))
    .slice(0, Math.max(0, max));
}

/** One account's card: the service's stats (or what was typed in by hand) plus our own posts on it. */
export function toCard(
  account: { accountId: string; platform: Platform; name: string },
  stats: AccountStatsRow | null,
  posts: Post[],
  rules: PostingRules,
  now: Date,
): AccountCard {
  const fromService = stats?.followers ?? [];
  const manual = stats?.manualFollowers ?? [];
  const followersSource = fromService.length > 0 ? "service" : manual.length > 0 ? "manual" : "none";
  const since = dayOf(new Date(now.getTime() - 29 * DAY));
  const followersSeries = (fromService.length > 0 ? fromService : manual).filter((p) => p.date >= since);
  const viewsPerDay = (stats?.views ?? []).filter((p) => p.date >= since);

  const mine = posts.filter((p) => p.accountId === account.accountId && p.status !== "failed");
  const withViews = mine.filter((p): p is Post & { views: number } => p.views !== null);
  const avg = average(withViews.map((p) => p.views));
  const weekAgo = now.getTime() - 7 * DAY;
  return {
    accountId: account.accountId,
    platform: account.platform,
    name: account.name,
    followers: followersSeries.at(-1)?.value ?? (fromService.length > 0 ? fromService : manual).at(-1)?.value ?? null,
    followersSeries,
    followersGrowth: growth(followersSeries),
    followersSource,
    viewsPerDay,
    viewsSource: viewsPerDay.length > 0 ? "service" : "none",
    posts: mine.length,
    avgViewsPerPost: avg === null ? null : Math.round(avg),
    topClips: [...withViews]
      .sort((a, b) => b.views - a.views)
      .slice(0, 5)
      .map((p) => ({ clipId: p.clipId, title: p.clipTitle, views: p.views, url: p.url })),
    postsLast7Days: mine.filter((p) => {
      const t = new Date(p.scheduledAt).getTime();
      return t > weekAgo && t <= now.getTime();
    }).length,
    plannedLast7Days: rules.maxPerDay * 7,
    updatedAt: stats?.fetchedAt ?? null,
    demo: stats?.demo ?? false,
  };
}

export interface AccountStatsOptions {
  now?: () => Date;
  /** Hours between reads of the same account. */
  refreshHours?: number;
  /** Days of history asked for. */
  days?: number;
}

/**
 * Account stats from the posting service, cached in SQLite. Reads go through the guard above, so
 * the dashboard can ask as often as it likes: the service is called at most every `refreshHours`.
 */
export class AccountStatsStore {
  private now: () => Date;
  readonly refreshHours: number;
  private days: number;
  private retryAt = 0;
  private reading: Promise<number> | null = null;
  lastError: string | null = null;

  constructor(
    private db: Db,
    private service: PostingService,
    private posts: PostsRepo,
    opts: AccountStatsOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.refreshHours = opts.refreshHours ?? 6;
    this.days = opts.days ?? 30;
  }

  rows(): AccountStatsRow[] {
    return (this.db.prepare("SELECT * FROM account_stats ORDER BY demo, platform, name").all() as DbRow[]).map(toRow);
  }

  private row(accountId: string): AccountStatsRow | null {
    const r = this.db.prepare("SELECT * FROM account_stats WHERE account_id = ?").get(accountId) as DbRow | undefined;
    return r ? toRow(r) : null;
  }

  /** Adds or renames an account row without touching its stats. */
  upsertAccount(a: { accountId: string; platform: Platform; name: string; demo?: boolean }): void {
    this.db
      .prepare(
        `INSERT INTO account_stats (account_id, platform, name, demo) VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET platform = excluded.platform, name = excluded.name`,
      )
      .run(a.accountId, a.platform, a.name, a.demo ? 1 : 0);
  }

  /** Stores what the service said, merged into the history already kept. */
  saveStats(s: AccountStats, fetchedAt: string): void {
    const row = this.row(s.accountId);
    if (!row) return;
    this.db
      .prepare("UPDATE account_stats SET followers = ?, views = ?, fetched_at = ? WHERE account_id = ?")
      .run(JSON.stringify(mergeSeries(row.followers, s.followers)), JSON.stringify(mergeSeries(row.views, s.views)), fetchedAt, s.accountId);
  }

  /** Follower count typed in by hand, for accounts the service has no numbers for. */
  setManualFollowers(accountId: string, followers: number): AccountStatsRow {
    let row = this.row(accountId);
    if (!row) {
      const post = this.posts.list().find((p) => p.accountId === accountId);
      if (!post) throw new NotFoundError("That account was not found.");
      this.upsertAccount({ accountId, platform: post.platform, name: post.accountName });
      row = this.row(accountId)!;
    }
    const merged = mergeSeries(row.manualFollowers, [{ date: dayOf(this.now()), value: followers }]);
    this.db.prepare("UPDATE account_stats SET manual_followers = ? WHERE account_id = ?").run(JSON.stringify(merged), accountId);
    return this.row(accountId)!;
  }

  /**
   * Reads stats for accounts that are due. Never throws: the error is kept for the dashboard.
   * Returns how many accounts were updated.
   */
  refresh(): Promise<number> {
    // Two dashboards opened at once share one read instead of calling the service twice.
    this.reading ??= this.read().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  private async read(): Promise<number> {
    const { service } = this;
    if (!service.accountStats) return 0;
    const now = this.now();
    if (now.getTime() < this.retryAt) return 0;
    const interval = this.refreshHours * HOUR;
    try {
      // Listing accounts costs a call too, so it follows the same interval.
      const listedAt = this.setting("accounts_listed_at");
      let accounts: PostingAccount[];
      if (isDue(listedAt, now, interval)) {
        accounts = await service.listAccounts();
        for (const a of accounts) this.upsertAccount({ accountId: a.id, platform: a.platform, name: a.name });
        this.setSetting("accounts_listed_at", now.toISOString());
      } else {
        accounts = this.rows()
          .filter((r) => !r.demo)
          .map((r) => ({ id: r.accountId, platform: r.platform, name: r.name, disabled: false }));
      }
      const fetched = new Map(this.rows().map((r) => [r.accountId, r.fetchedAt]));
      const due = dueAccounts(accounts, fetched, now, interval, service.maxStatsAccountsPerRead ?? accounts.length);
      if (due.length === 0) return 0;
      const stats = await service.accountStats(due, this.days);
      for (const s of stats) this.saveStats(s, now.toISOString());
      // Accounts the service sent nothing for still count as read, so they are not asked again at once.
      const answered = new Set(stats.map((s) => s.accountId));
      for (const a of due) {
        if (!answered.has(a.id)) this.db.prepare("UPDATE account_stats SET fetched_at = ? WHERE account_id = ?").run(now.toISOString(), a.id);
      }
      this.lastError = null;
      return stats.length;
    } catch (err) {
      this.lastError = (err as Error).message;
      this.retryAt = now.getTime() + RETRY_AFTER_MS;
      return 0;
    }
  }

  /** Cards from the cache only; no service call. */
  info(rules: PostingRules): AccountsInfo {
    const now = this.now();
    const posts = this.posts.list();
    const rows = this.rows();
    const seen = new Set(rows.map((r) => r.accountId));
    const cards = rows.map((r) => toCard(r, r, posts, rules, now));
    // Accounts we posted to that the service no longer lists keep a card.
    for (const p of posts) {
      if (seen.has(p.accountId)) continue;
      seen.add(p.accountId);
      cards.push(toCard({ accountId: p.accountId, platform: p.platform, name: p.accountName }, null, posts, rules, now));
    }
    return { service: this.service.name, label: this.service.label, cards, error: this.lastError, refreshHours: this.refreshHours };
  }

  private setting(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  private setSetting(key: string, value: string): void {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
}
