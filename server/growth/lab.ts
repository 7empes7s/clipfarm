import {
  type CampaignComparison,
  type CampaignReport,
  type CampaignSummary,
  type Digest,
  type GrowthCampaign,
  type GrowthCampaignInput,
  type GrowthInfo,
  NO_METRICS,
} from "../../shared/growth.js";
import { dayOf } from "../../shared/metrics.js";
import type { ChannelAccount, Clip, Post } from "../../shared/types.js";
import type { ClipsRepo } from "../clips/repo.js";
import { HttpError, ValidationError } from "../errors.js";
import type { Publisher } from "../publish/publisher.js";
import type { PostsRepo } from "../publish/repo.js";
import type { SourcesRepo } from "../sources/repo.js";
import { buildDigest, digestDue } from "./digest.js";
import { chooseVariant, clipFits, slotsForDay, slotTime } from "./plan.js";
import type { PlatformStatsSource } from "./platformStats.js";
import type { PushSender, PushStore } from "./push.js";
import { awaitingMetric, buildReport, compareCampaigns, progressOf, recommendationFor, type ReportRow, toCsv, variantComparisons, viewsGainedOn } from "./report.js";
import type { GrowthRepo } from "./repo.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Posts are handed to the posting service at most this far ahead, so Pause and a strike act fast. */
export const HORIZON_MS = 30 * MINUTE;
/** A slot whose time passed by more than this is skipped, not posted late. */
export const GRACE_MS = 15 * MINUTE;
/** Clips tried for one slot before it waits for the next round. */
const MAX_TRIES = 5;
/** A platform's own API is asked about posts up to this age (the last kept point is 7 days). */
const STATS_MAX_AGE_MS = 9 * DAY;

export interface GrowthLabDeps {
  repo: GrowthRepo;
  posts: PostsRepo;
  clips: ClipsRepo;
  sources: SourcesRepo;
  publisher: Publisher;
  /** The stream a clip was cut from, for niche tests. */
  vodTitle?: (vodId: number) => string | null;
  /** Platform APIs asked directly, on top of the posting service. */
  platformStats?: PlatformStatsSource[];
  push?: { store: PushStore; sender: PushSender };
  /** What an hour of this server costs, for a clip's compute cost. */
  computeUsdPerHour?: number;
  now?: () => Date;
}

/**
 * The growth lab's runner: posts running campaigns' clips on time and evenly over the variants,
 * keeps the numbers, and turns them into reports, recommendations and the daily digest.
 * Every post still goes through the publisher, so no gate (permission, brief, routing, caps,
 * spacing, burner-only experiments) is skipped.
 */
export class GrowthLab {
  private now: () => Date;
  private running: Promise<void> = Promise.resolve();
  lastStatsError: string | null = null;

  constructor(private deps: GrowthLabDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  get repo(): GrowthRepo {
    return this.deps.repo;
  }

  create(input: GrowthCampaignInput): GrowthCampaign {
    return this.deps.repo.create(input);
  }

  /** Starts (or resumes) a campaign and schedules what is due right away. */
  async start(id: number): Promise<GrowthCampaign> {
    this.deps.repo.start(id);
    await this.tick();
    return this.deps.repo.get(id);
  }

  /** One round: finish, pause and schedule campaigns, then refresh recommendations. Rounds never overlap. */
  tick(): Promise<void> {
    const next = this.running.then(() => this.round());
    this.running = next.catch(() => undefined);
    return next;
  }

  private async round(): Promise<void> {
    const { repo } = this.deps;
    this.pauseOnStrikes();
    for (const c of repo.list()) {
      if (c.status !== "running") continue;
      if (c.endsAt && this.now().getTime() >= new Date(c.endsAt).getTime()) repo.finish(c.id);
      else await this.schedule(c);
    }
    this.proposeChanges();
  }

  /** A strike on one of a running campaign's posts pauses it until someone starts it again. */
  pauseOnStrikes(): void {
    const { repo } = this.deps;
    for (const c of repo.list()) {
      if (c.status !== "running") continue;
      const strike = repo.strikeSinceStart(c.id);
      if (strike) {
        repo.pause(c.id, `Paused on ${strike.at.slice(0, 10)}: a strike on "${strike.clipTitle}" (${strike.accountName}). Start it again when it is safe.`);
      }
    }
  }

  private async accounts(): Promise<ChannelAccount[]> {
    const known = this.deps.publisher.accounts.list();
    return known.length > 0 ? known : this.deps.publisher.syncAccounts();
  }

  private async schedule(campaign: GrowthCampaign): Promise<void> {
    const { repo, posts, clips, sources, publisher, vodTitle } = this.deps;
    const now = this.now();
    const from = new Date(Math.max(now.getTime() - GRACE_MS, new Date(campaign.startedAt!).getTime()));
    const until = Math.min(now.getTime() + HORIZON_MS, new Date(campaign.endsAt!).getTime() - 1);

    const all = posts.list();
    const byId = new Map(all.map((p) => [p.id, p]));
    const links = repo.links(campaign.id);
    const filled = new Set(links.map((l) => l.slot));
    // A post that failed fills its slot but is not a post of its variant.
    const counts = new Map<string, Map<string, number>>();
    const overall = new Map<string, number>();
    const uses = new Map<number, number>();
    const count = (accountId: string, variantKey: string, clipId: number) => {
      const mine = counts.get(accountId) ?? new Map<string, number>();
      mine.set(variantKey, (mine.get(variantKey) ?? 0) + 1);
      counts.set(accountId, mine);
      overall.set(variantKey, (overall.get(variantKey) ?? 0) + 1);
      uses.set(clipId, (uses.get(clipId) ?? 0) + 1);
    };
    for (const l of links) {
      const p = byId.get(l.postId);
      if (p && p.status !== "failed") count(p.accountId, l.variantKey, p.clipId);
    }
    const onAccount = new Set(all.filter((p) => p.status !== "failed").map((p) => `${p.accountId}#${p.clipId}`));

    let accounts: ChannelAccount[];
    try {
      accounts = await this.accounts();
    } catch (err) {
      repo.setNote(campaign.id, (err as Error).message);
      return;
    }
    const names = new Map(sources.list().map((s) => [s.id, s.creatorName]));
    const approved = clips
      .list()
      .filter((c) => c.status === "approved" && (campaign.sourceIds.length === 0 || campaign.sourceIds.includes(c.sourceId)));
    const facts = (c: Clip) => ({
      durationSec: c.durationSec,
      hook: c.hook,
      text: [c.title, c.hook, names.get(c.sourceId), c.vodId === null ? null : vodTitle?.(c.vodId)].join(" "),
    });
    const fallback = repo.defaults().postTimes;
    // The remark is only replaced by a round that tried a slot, so it stays readable in between.
    let tried = false;
    let note: string | null = null;

    for (const day of new Set([dayOf(from), dayOf(new Date(until))])) {
      for (const slot of slotsForDay(campaign, day)) {
        if (filled.has(slot.key)) continue;
        const account = accounts.find((a) => a.id === slot.accountId);
        // The account's own pace caps the day: a campaign never asks for more.
        if (!account || slot.index >= account.pace.maxPerDay) continue;
        const variant = chooseVariant(campaign.variants, counts.get(account.id) ?? new Map(), overall, campaign.assignment, slot.key);
        const at = slotTime(slot, campaign.variable, variant, campaign.times, fallback, campaign.postsPerDay);
        if (at.getTime() < from.getTime() || at.getTime() > until) continue;

        tried = true;
        const candidates = approved
          .filter((c) => !onAccount.has(`${account.id}#${c.id}`) && clipFits(campaign.variable, variant, facts(c)))
          .sort((a, b) => (uses.get(a.id) ?? 0) - (uses.get(b.id) ?? 0) || (b.score ?? 0) - (a.score ?? 0) || a.id - b.id);
        if (candidates.length === 0) {
          note = `No approved clip is left for "${variant.label}" on ${account.name}. Approve more clips and it carries on.`;
          continue;
        }
        const when = at.getTime() > now.getTime() ? at : null;
        for (const clip of candidates.slice(0, MAX_TRIES)) {
          try {
            const dry = await publisher.dryRun(clip.id, [account.id], when);
            const planned = dry.wouldPost[0];
            if (!planned) {
              note = dry.skipped[0]?.reason ?? null;
              break;
            }
            // The account's spacing moved the post to another day: its day is full, so the slot is left.
            if (dayOf(planned.scheduledAt) !== slot.day) {
              note = `${account.name} is full for ${slot.day} (its posts per day and spacing), so a post was left out.`;
              break;
            }
            const post = (await publisher.post(clip.id, [account.id], when)).posts[0];
            if (!post) break;
            repo.link(campaign.id, slot.key, post.id, variant.key);
            filled.add(slot.key);
            if (post.status === "failed") note = post.error;
            else {
              count(account.id, variant.key, clip.id);
              onAccount.add(`${account.id}#${clip.id}`);
            }
            break;
          } catch (err) {
            // A gate said no for this clip (permission, brief, routing, a daily cap): try the next one.
            if (!(err instanceof HttpError)) throw err;
            note = err.message;
          }
        }
      }
    }
    if (tried) repo.setNote(campaign.id, note);
  }

  /** A campaign's posts with their series, latest numbers and clip cost. */
  private rowsOf(campaign: GrowthCampaign, shared = this.shared()): ReportRow[] {
    return this.deps.repo.links(campaign.id).flatMap((l) => {
      const post = shared.posts.get(l.postId);
      return post ? [this.row(post, l.variantKey, shared)] : [];
    });
  }

  private shared() {
    const { posts, repo, computeUsdPerHour } = this.deps;
    return {
      posts: new Map(posts.list().map((p) => [p.id, p])),
      series: posts.series(),
      metrics: posts.metrics(),
      costs: repo.clipCosts(computeUsdPerHour ?? 0),
    };
  }

  private row(post: Post, variantKey: string, shared: ReturnType<GrowthLab["shared"]>): ReportRow {
    return {
      post,
      variantKey,
      series: shared.series.get(post.id) ?? [],
      metrics: shared.metrics.get(post.id) ?? NO_METRICS,
      clipCostUsd: shared.costs.get(post.clipId) ?? null,
    };
  }

  private platformsOf(rows: ReportRow[]) {
    return [...new Set(rows.map((r) => r.post.platform))];
  }

  /**
   * Offers a change of defaults for every finished campaign with a clear winner, once all its
   * posts have their success metric. A running campaign only shows its read so far: calling a
   * winner at the first lucky streak, before the planned posts are in, is how tests fool people.
   */
  proposeChanges(): void {
    const shared = this.shared();
    for (const c of this.deps.repo.list()) {
      if (c.status !== "finished") continue;
      const rows = this.rowsOf(c, shared);
      if (awaitingMetric(rows, c.metric, this.now()) > 0) continue;
      const proposed = recommendationFor(c, rows, this.platformsOf(rows));
      if (proposed) this.deps.repo.propose(c.id, proposed);
    }
  }

  report(id: number): CampaignReport {
    const campaign = this.deps.repo.get(id);
    return buildReport(campaign, this.rowsOf(campaign), this.now(), this.deps.repo.recommendationFor(id));
  }

  csv(id: number): string {
    const campaign = this.deps.repo.get(id);
    return toCsv(campaign, this.rowsOf(campaign));
  }

  compare(ids: number[]): CampaignComparison {
    if (new Set(ids).size < 2) throw new ValidationError("Pick two or more campaigns to compare.");
    const shared = this.shared();
    return compareCampaigns(
      [...new Set(ids)].map((id) => {
        const campaign = this.deps.repo.get(id);
        return { campaign, rows: this.rowsOf(campaign, shared) };
      }),
    );
  }

  summaries(): CampaignSummary[] {
    const shared = this.shared();
    const now = this.now();
    return this.deps.repo.list().map((campaign) => {
      const rows = this.rowsOf(campaign, shared);
      const views = rows.filter((r) => r.post.status === "posted" && r.post.views !== null).map((r) => r.post.views!);
      return {
        campaign,
        progress: progressOf(campaign, rows, now),
        totalViews: views.length ? views.reduce((s, v) => s + v, 0) : null,
        read: variantComparisons(campaign, rows).comparisons[0]?.text ?? null,
      };
    });
  }

  /** What the 09:00 digest says today. */
  digest(): Digest {
    const { repo } = this.deps;
    const shared = this.shared();
    const now = this.now();
    const everyPost = [...shared.posts.values()].filter((p) => p.status === "posted").map((p) => this.row(p, "", shared));
    return buildDigest({
      yesterday: viewsGainedOn(dayOf(new Date(now.getTime() - DAY)), everyPost),
      campaigns: repo
        .list()
        .filter((c) => c.status === "running")
        .map((c) => ({ name: c.name, progress: progressOf(c, this.rowsOf(c, shared), now) })),
      recommendation: repo.recommendations().find((r) => r.status === "open")?.text ?? null,
    });
  }

  info(): GrowthInfo {
    const { repo, push } = this.deps;
    return {
      campaigns: this.summaries(),
      recommendations: repo.recommendations(),
      defaults: repo.defaults(),
      digest: this.digest(),
      pushKey: push?.store.keys().publicKey ?? "",
    };
  }

  /** Sends the digest to every browser whose clock passed 09:00 today. Returns how many were sent. */
  async sendDigests(): Promise<number> {
    const { push } = this.deps;
    if (!push) return 0;
    const now = this.now();
    let sent = 0;
    let digest: Digest | null = null;
    for (const sub of push.store.list()) {
      const day = digestDue(now, sub.tz, sub.lastDigestDay);
      if (!day) continue;
      digest ??= this.digest();
      try {
        const result = await push.sender.send(sub, { title: digest.title, body: digest.lines.join("\n"), url: "/#campaigns" });
        if (result === "gone") push.store.unsubscribe(sub.endpoint);
        else {
          push.store.markSent(sub.endpoint, day);
          sent++;
        }
      } catch (err) {
        // Tried again at the next round; the endpoint (a private address) stays out of the log.
        console.error(`[digest] could not send: ${(err as Error).message}`);
      }
    }
    return sent;
  }

  /** Asks the platforms' own APIs about recent posts. Never throws: the error is kept to show. */
  async collectPlatformStats(): Promise<number> {
    const { posts, platformStats = [] } = this.deps;
    const since = this.now().getTime() - STATS_MAX_AGE_MS;
    let updated = 0;
    this.lastStatsError = null;
    for (const source of platformStats) {
      if (!source.ready()) continue;
      const mine = posts
        .list()
        .filter((p) => p.status === "posted" && p.platform === source.platform && p.url && new Date(p.postedAt ?? p.scheduledAt).getTime() >= since)
        .map((p) => ({ id: p.id, url: p.url! }));
      if (mine.length === 0) continue;
      try {
        for (const [postId, metrics] of await source.stats(mine)) {
          posts.addReading(postId, metrics);
          updated++;
        }
      } catch (err) {
        this.lastStatsError = (err as Error).message;
      }
    }
    return updated;
  }
}
