import { type BusinessBoard, GROUPS, type GroupBy, type HealthBoard, type RangeId, toCsvTable } from "../../shared/business.js";
import { dayOf } from "../../shared/metrics.js";
import { type Job, PLATFORM_LABELS } from "../../shared/types.js";
import type { ClipsRepo } from "../clips/repo.js";
import { NotFoundError } from "../errors.js";
import type { GrowthLab } from "../growth/lab.js";
import type { Isolation } from "../isolation/isolation.js";
import { pacificDay } from "../isolation/rules.js";
import type { Publisher } from "../publish/publisher.js";
import type { PostsRepo } from "../publish/repo.js";
import type { SourcesRepo } from "../sources/repo.js";
import { buildBoard, buildHealth, digestLines, rangeStart } from "./build.js";
import type { BusinessRepo } from "./repo.js";

export interface BusinessDeps {
  repo: BusinessRepo;
  clips: ClipsRepo;
  posts: PostsRepo;
  sources: SourcesRepo;
  /** The newest jobs of the queue. */
  jobs: () => Job[];
  publisher: Publisher;
  isolation: Isolation;
  growth: GrowthLab;
  eurPerUsd: number;
  computeUsdPerHour: number;
  /** True in demo mode: every number is made up, and the page says so. */
  demo: boolean;
  now?: () => Date;
}

/** The tables a CSV can be downloaded for. */
export const EXPORT_TABLES = ["posts", ...GROUPS.map((g) => g.id), "campaigns", "costs", "health"] as const;
export type ExportTable = (typeof EXPORT_TABLES)[number];

/** Gathers the stored numbers into the business dashboard and its health page. Reads only: no API call. */
export class BusinessService {
  private now: () => Date;

  constructor(private deps: BusinessDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  get repo(): BusinessRepo {
    return this.deps.repo;
  }

  /** The business half of the daily digest (the growth lab sends it with its own lines). */
  digestLines(): string[] {
    const { posts, jobs, clips } = this.deps;
    return digestLines(this.now(), posts.list(), jobs(), clips.list().filter((c) => c.status === "pending").length);
  }

  board(range: RangeId): BusinessBoard {
    const { repo, clips, posts, sources, growth } = this.deps;
    const now = this.now();
    return buildBoard({
      now,
      range,
      clips: clips.list(),
      posts: posts.list(),
      sources: sources.list(),
      metrics: posts.metrics(),
      payouts: repo.payouts(),
      spend: repo.spend(rangeStart(now, range).toISOString(), new Date(now.getTime() + 1).toISOString()),
      eurPerUsd: this.deps.eurPerUsd,
      computeUsdPerHour: this.deps.computeUsdPerHour,
      digest: growth.digest(),
      demo: this.deps.demo,
    });
  }

  health(): HealthBoard {
    const { repo, posts, jobs, publisher, isolation, growth } = this.deps;
    const now = this.now();
    const calls = growth.repo.statsCalls(dayOf(now));
    return buildHealth({
      now,
      jobs: jobs(),
      posts: posts.list(),
      accounts: publisher.accounts.list(),
      payouts: repo.payouts(),
      youtube: isolation.list().map((g) => ({ groupName: g.name, used: isolation.quotaUsed(g.id, pacificDay(now)), resetsAt: isolation.quotaReset().toISOString() })),
      stats: growth.statsSources.map((s) => ({
        platform: s.platform,
        connected: s.ready(),
        callsToday: calls[s.platform] ?? 0,
        lastError: growth.statsErrors.get(s.platform) ?? null,
      })),
      metrics: posts.metrics(),
    });
  }

  csv(table: string, range: RangeId): string {
    if (!(EXPORT_TABLES as readonly string[]).includes(table)) throw new NotFoundError("No such table.");
    const t = table as ExportTable;
    if (t === "health") {
      const h = this.health();
      return toCsvTable(
        ["kind", "name", "count", "detail"],
        [
          ...h.failuresByStep.map((f) => ["failed step", f.step, f.failed, f.lastError]),
          ...h.postingFailures.map((f) => ["failed post", `${f.clipTitle} (${f.accountName})`, 1, f.error]),
          ...h.quotas.map((q) => ["quota left", `${PLATFORM_LABELS[q.platform]} ${q.label}`, q.left, `${q.used} of ${q.limit} ${q.unit}`]),
          ...h.atRisk.map((r) => [`at risk: ${r.kind}`, r.accountName, 1, r.reason]),
        ],
      );
    }
    const b = this.board(range);
    if (t === "posts") {
      return toCsvTable(
        ["post_id", "clip_id", "clip", "hook", "platform", "account", "campaign", "creator", "workspace", "posted_at", "views", "likes", "comments", "shares", "follows_gained", "avg_watch_pct", "earnings_usd", "paid_usd", "url"],
        b.posts.map((p) => [p.postId, p.clipId, p.clipTitle, p.hook, p.platform, p.accountName, p.campaign, p.sourceName, p.workspace, p.postedAt, p.views, p.likes, p.comments, p.shares, p.followsGained, p.avgWatchPct, p.earningsUsd, p.paidUsd, p.url]),
      );
    }
    if (t === "campaigns") {
      return toCsvTable(
        ["campaign", "posts", "views", "views_counted", "approved", "rejected", "earnings_usd", "paid_usd", "per_1000_views_usd"],
        b.money.byCampaign.map((c) => [c.label, c.posts, c.views, c.viewsCounted, c.approved, c.rejected, c.earningsUsd, c.paidUsd, c.perThousandUsd]),
      );
    }
    if (t === "costs") {
      return toCsvTable(
        ["cost", "usd", "note"],
        [...b.money.costLines.map((l) => [l.label, l.usd, l.note]), ["Total", b.money.costUsd, ""], ["Approved clips", b.money.approvedClips, ""], ["Cost per approved clip", b.money.costPerApprovedClipUsd, ""], ["Profit", b.money.profitUsd, "estimated earnings less cost"]],
      );
    }
    const rows = b.groups[t as GroupBy];
    return toCsvTable(
      [t, "posts", "views", "likes", "comments", "shares", "follows_gained", "avg_watch_pct", "earnings_usd", "paid_usd", "per_1000_views_usd"],
      rows.map((r) => [r.label, r.posts, r.views, r.likes, r.comments, r.shares, r.followsGained, r.avgWatchPct, r.earningsUsd, r.paidUsd, r.perThousandUsd]),
    );
  }
}
