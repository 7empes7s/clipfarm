import type { PostMetrics } from "../../shared/growth.js";
import type { DailyPoint, Platform, PostFlag, PostingAccount } from "../../shared/types.js";
import { PostingServiceError } from "./errors.js";
import type { AccountStats, PostingService, PostUpdate, PublishItem, PublishResult, TrackedPost, VideoFile } from "./types.js";

export const FAKE_ACCOUNTS: PostingAccount[] = [
  { id: "fake-youtube", platform: "youtube", name: "GTA VI Moments", disabled: false },
  { id: "fake-tiktok", platform: "tiktok", name: "gtavimoments", disabled: false },
  { id: "fake-tiktok-2", platform: "tiktok", name: "gtavi.daily", disabled: false },
  { id: "fake-instagram", platform: "instagram", name: "gtavi.moments", disabled: false },
  { id: "fake-x", platform: "x", name: "GTA VI Moments", disabled: false },
];

/** Stands in for Postiz / Upload-Post in tests and demos: no network, posts "succeed" at once. */
export class FakePostingService implements PostingService {
  readonly name = "fake";
  readonly label = "Test posting service";
  readonly isolates = true;
  dailyCaps: Partial<Record<Platform, number>> = {};
  /** Every call made, in order, so tests can check nothing was called. */
  calls: ("listAccounts" | "publish" | "refresh" | "accountStats")[] = [];
  published: PublishItem[] = [];
  /** The video of each publish call, in order. */
  videos: VideoFile[] = [];
  /** Views every posted post reports on refresh; null reports none. */
  views: number | null = 12_000;
  /** Views for single posts, by post id; the rest report `views`. */
  viewsFor = new Map<string, number>();
  failWith: string | null = null;
  /** What refresh reports per post id (a claim, a strike…), as a platform would. */
  flags = new Map<string, PostFlag[]>();
  /** A stand-in for platform analytics: what refresh reports for a post of this age. Left out: just `views`. */
  metricsFor: ((post: TrackedPost, ageHours: number) => Partial<PostMetrics> | null) | null = null;
  /** The fake's clock: the last day of account stats, and when a scheduled post goes out. */
  today: () => Date = () => new Date();
  private n = 0;
  private postedIds = new Set<string>();

  constructor(private accounts: PostingAccount[] = FAKE_ACCOUNTS) {}

  listAccounts(): Promise<PostingAccount[]> {
    this.calls.push("listAccounts");
    return Promise.resolve(this.accounts);
  }

  publish(video: VideoFile, items: PublishItem[]): Promise<PublishResult[]> {
    this.calls.push("publish");
    if (this.failWith) return Promise.reject(new PostingServiceError(this.failWith));
    this.videos.push(video);
    this.published.push(...items);
    return Promise.resolve(
      items.map((item) => {
        const id = `fake-post-${++this.n}`;
        const now = item.when === null;
        if (now) this.postedIds.add(id);
        return {
          accountId: item.account.id,
          externalId: id,
          status: now ? "posted" : "scheduled",
          url: now ? `https://example.com/${item.account.platform}/${id}` : null,
          error: null,
          postedAt: now ? this.today().toISOString() : null,
        };
      }),
    );
  }

  /** Steady made-up growth: followers up 40 a day from 1,000, views 2,000 + 150 a day. */
  accountStats(accounts: PostingAccount[], days: number): Promise<AccountStats[]> {
    this.calls.push("accountStats");
    if (this.failWith) return Promise.reject(new PostingServiceError(this.failWith));
    const d = this.today();
    const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const series = (f: (i: number) => number): DailyPoint[] =>
      Array.from({ length: days }, (_, i) => ({ date: new Date(today - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10), value: f(i) }));
    return Promise.resolve(
      accounts.map((a) => ({ accountId: a.id, followers: series((i) => 1000 + 40 * i), views: series((i) => 2000 + 150 * i) })),
    );
  }

  refresh(posts: TrackedPost[]): Promise<PostUpdate[]> {
    this.calls.push("refresh");
    return Promise.resolve(
      posts.map((p) => {
        const update: PostUpdate = { externalId: p.externalId, accountId: p.accountId };
        // A scheduled post goes out when its time comes, as on a real service.
        const due = new Date(p.scheduledAt);
        if (!this.postedIds.has(p.externalId) && due.getTime() <= this.today().getTime()) {
          this.postedIds.add(p.externalId);
          update.status = "posted";
          update.url = `https://example.com/${p.platform}/${p.externalId}`;
          update.postedAt = due.toISOString();
        }
        // Scheduled posts stay scheduled; posted ones report views.
        if (this.postedIds.has(p.externalId)) {
          const metrics = this.metricsFor?.(p, (this.today().getTime() - due.getTime()) / 3600_000);
          if (metrics) {
            update.metrics = metrics;
            if (typeof metrics.views === "number") update.views = metrics.views;
          } else {
            const views = this.viewsFor.get(p.externalId) ?? this.views;
            if (views !== null) update.views = views;
          }
        }
        const flags = this.flags.get(p.externalId);
        if (flags) update.flags = flags;
        return update;
      }),
    );
  }
}

/** When no posting service is set up: accounts are empty and posting explains what to do. */
export class NoPostingService implements PostingService {
  readonly name = "none";
  readonly label = "No posting service";
  readonly dailyCaps = {};

  listAccounts(): Promise<PostingAccount[]> {
    return Promise.resolve([]);
  }

  publish(): Promise<PublishResult[]> {
    return Promise.reject(
      new PostingServiceError(
        "No posting service is set up. Use Export to post by hand, or add Postiz or Upload-Post in Settings.",
      ),
    );
  }

  refresh(): Promise<PostUpdate[]> {
    return Promise.resolve([]);
  }
}
