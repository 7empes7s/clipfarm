import type {
  AccountChoice,
  ChannelAccount,
  Clip,
  ExportPack,
  Permission,
  PlannedPost,
  Platform,
  Post,
  PostingInfo,
  PostingRules,
  PostOutcome,
  SkippedAccount,
  Source,
  Stats,
  StatsRow,
  WhopStep,
} from "../../shared/types.js";
import { PERMISSION_KIND_LABELS, PLATFORM_LABELS, PLATFORMS } from "../../shared/types.js";
import { noAccountReason, routingBlock, routingBlockText } from "../../shared/routing.js";
import { AccountsRepo, nicheMatches } from "../accounts/repo.js";
import type { ClipsRepo } from "../clips/repo.js";
import { ValidationError } from "../errors.js";
import { isActive, isExperimentOnly, PermissionError, requireActivePermission } from "../sources/permission.js";
import type { SourcesRepo } from "../sources/repo.js";
import { buildCaption } from "./caption.js";
import { campaignProblems, clipTranscript, problemsLine } from "./compliance.js";
import { assertCanPost } from "./gate.js";
import type { PostsRepo } from "./repo.js";
import { nextFreeSlot } from "./spacing.js";
import type { PostingService, PublishItem } from "./types.js";

/** Platform limits in plain words, shown next to the post button. */
export const PLATFORM_NOTES = [
  "TikTok and YouTube keep posts made through an API private until the posting app passes their review (Postiz's own app or ours). Check that the first post is public.",
  "Instagram posting needs a Business or Creator account linked to a Facebook page.",
  "X allows 280 characters, so long titles are shortened; credit, links and hashtags stay.",
];

export function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "clip"
  );
}

export function parseRules(body: unknown): PostingRules {
  const b = (body ?? {}) as Record<string, unknown>;
  const maxPerDay = Number(b.maxPerDay);
  const minGapMinutes = Number(b.minGapMinutes);
  if (!Number.isInteger(maxPerDay) || maxPerDay < 1 || maxPerDay > 50) {
    throw new ValidationError("Posts per account per day must be a whole number from 1 to 50.");
  }
  if (!Number.isInteger(minGapMinutes) || minGapMinutes < 0 || minGapMinutes > 1440) {
    throw new ValidationError("Minutes between posts must be a whole number from 0 to 1440.");
  }
  return { maxPerDay, minGapMinutes };
}

export interface PublisherDeps {
  sources: SourcesRepo;
  clips: ClipsRepo;
  posts: PostsRepo;
  service: PostingService;
  /** Our settings per posting account; made over the posts database when left out. */
  accounts?: AccountsRepo;
  /** The stream a clip was cut from, to match it to an account's niche. */
  vodTitle?: (vodId: number) => string | null;
  now?: () => Date;
}

/** Why a picked account gets no post, or null when it can take one. */
function skipReason(a: ChannelAccount): string | null {
  if (!a.enabled && a.pausedReason) return `${a.name} is paused after a strike, so nothing was sent to it.`;
  if (!a.enabled) return `${a.name} is switched off in Posting accounts, so nothing was sent to it.`;
  if (a.health === "banned") return `${a.name} is marked banned, so it was skipped.`;
  return null;
}

export class Publisher {
  private now: () => Date;
  private synced = false;
  readonly accounts: AccountsRepo;
  lastRefreshError: string | null = null;

  constructor(private deps: PublisherDeps) {
    this.now = deps.now ?? (() => new Date());
    this.accounts = deps.accounts ?? new AccountsRepo(deps.posts, this.now);
  }

  get service(): PostingService {
    return this.deps.service;
  }

  /** Reads the connected accounts from the posting service into our list. */
  async syncAccounts(): Promise<ChannelAccount[]> {
    const { service } = this.deps;
    const accounts = this.accounts.sync(service.name, await service.listAccounts());
    this.synced = true;
    return accounts;
  }

  private caption(clip: Clip, source: Source, permission: Permission, platform: Platform): string {
    return buildCaption({
      title: clip.title,
      creatorName: source.creatorName,
      channelUrl: source.channelUrls[0] ?? null,
      briefRules: permission.briefRules,
      rules: permission.rules,
      platform,
    });
  }

  /** The compliance check: why this clip, with this caption, breaks the campaign's rules on a platform. Empty for records without rules. */
  private rulesBroken(clip: Clip, permission: Permission, platform: Platform, caption: string): string[] {
    if (permission.kind !== "whop-campaign" || !permission.rules) return [];
    return campaignProblems({
      rules: permission.rules,
      allowedPlatforms: permission.allowedPlatforms,
      platform,
      caption,
      title: clip.title,
      hook: clip.hook,
      transcript: clipTranscript(clip),
      durationSec: clip.durationSec,
    });
  }

  /**
   * A Whop step tapped on a post. A post is only marked sent when it keeps the rules its campaign
   * has now: one that breaks them would be rejected there, and the reason is said instead.
   */
  markWhop(postId: number, step: WhopStep, on: boolean): Post {
    const { posts, clips, sources } = this.deps;
    const post = posts.get(postId);
    if (on && step === "submitted" && !post.experiment) {
      const problems = this.rulesBroken(clips.get(post.clipId), sources.permission(post.permissionId), post.platform, post.caption);
      if (problems.length > 0) throw new ValidationError(`Not marked as sent. ${problemsLine(problems)}`);
    }
    return posts.setWhopStep(postId, step, on);
  }

  /** Our list of accounts, read from the service once per server start (and on every sync). */
  private async knownAccounts(): Promise<ChannelAccount[]> {
    return this.synced ? this.accounts.list() : this.syncAccounts();
  }

  /**
   * The picker for a clip: every account, whether it can take the clip, and which are ticked to
   * start with (main accounts whose niche fits the clip). An experiment clip is offered burner
   * accounts only: main accounts are not in its list at all.
   */
  async choices(clipId: number): Promise<AccountChoice[]> {
    const { clips, sources, service, vodTitle } = this.deps;
    const clip = clips.get(clipId);
    const source = sources.get(clip.sourceId);
    const now = this.now();
    const experiment = isExperimentOnly(source.permissions, now);
    const accounts = await this.knownAccounts();
    const active = source.permissions.filter((p) => isActive(p, now));
    // Why routing keeps the clip off an account: the kind or pin when the brief is not the reason.
    const routed = (account: ChannelAccount): string | null => {
      const blocks = active.map((p) => ({ p, block: routingBlock(p, account, accounts) }));
      if (blocks.some((b) => b.block === null)) return null;
      const specific = blocks.find((b) => b.block !== "brief");
      if (!specific) return "Not in the brief";
      const text = routingBlockText(specific.block!, specific.p);
      return specific.block === "pinned" ? "This campaign is pinned to another account" : text.charAt(0).toUpperCase() + text.slice(1);
    };
    // The campaign's own rules, on the caption this account would get.
    const broken = (account: ChannelAccount): string | null => {
      const routes = active.filter((p) => routingBlock(p, account, accounts) === null);
      const permission = routes.find((p) => p.kind !== "experiment") ?? routes[0];
      const problems = permission ? this.rulesBroken(clip, permission, account.platform, this.caption(clip, source, permission, account.platform)) : [];
      return problems.length > 0 ? problemsLine(problems) : null;
    };
    const text = [clip.title, clip.hook, source.creatorName, clip.vodId === null ? null : vodTitle?.(clip.vodId)].join(" ");
    // An experiment clip is offered burner accounts only: main accounts are not in its list at all.
    return accounts.filter((a) => !experiment || a.role === "burner").map((account) => {
      const blocked = account.disabled
        ? `Disconnected in ${service.label}`
        : !account.enabled
          ? account.pausedReason
            ? "Paused after a strike"
            : "Switched off"
          : account.health === "banned"
            ? "Marked banned, so it is skipped"
            : (routed(account) ?? broken(account));
      return {
        account,
        canPost: blocked === null,
        suggested: blocked === null && (experiment || account.role === "main") && nicheMatches(account.niche, text),
        note: blocked ?? (account.health === "limited" ? "Marked limited" : null),
      };
    });
  }

  async info(): Promise<PostingInfo> {
    const { service, posts } = this.deps;
    let accounts: ChannelAccount[] = [];
    let accountsError: string | null = null;
    try {
      accounts = await this.syncAccounts();
    } catch (err) {
      accountsError = (err as Error).message;
    }
    const usedToday: Partial<Record<Platform, number>> = {};
    for (const p of Object.keys(service.dailyCaps) as Platform[]) usedToday[p] = posts.countToday(service.name, p);
    return {
      service: service.name,
      label: service.label,
      accounts,
      accountsError,
      dailyCaps: service.dailyCaps,
      usedToday,
      rules: posts.rules(),
      notes: PLATFORM_NOTES,
    };
  }

  /**
   * Posts an approved clip on the chosen accounts, now or at `when`. Every check (approval,
   * permission, brief, routing, the permission's end date, daily caps) runs before the service is asked
   * to post; posts on a busy account are moved to its next free slot. Accounts that are switched
   * off, marked banned or that do not take the clip's permission kind are left out and named in `skipped`.
   */
  async post(clipId: number, accountIds: string[], when: Date | null): Promise<PostOutcome> {
    const { clips, posts, service } = this.deps;
    const { clip, planned, skipped } = await this.plan(clipId, accountIds, when);
    const results = await service.publish(
      { path: clips.filePath(clip.id), fileName: `${slug(clip.title)}.mp4` },
      planned.map((p) => p.item),
    );
    const made = planned.map(({ item, permission, at }) => {
      const r = results.find((x) => x.accountId === item.account.id);
      return posts.insert({
        clipId: clip.id,
        permissionId: permission.id,
        platform: item.account.platform,
        accountId: item.account.id,
        accountName: item.account.name,
        service: service.name,
        externalId: r?.externalId ?? null,
        status: r?.status ?? "failed",
        url: r?.url ?? null,
        error: r ? r.error : `${service.label} did not answer for this account.`,
        caption: item.caption,
        scheduledAt: at.toISOString(),
        postedAt: r?.postedAt ?? null,
      });
    });
    return { posts: made, skipped };
  }

  /**
   * What post() would send, after the same checks, without asking the service to post and without
   * storing anything: the end-to-end test's proof that a clip can be queued.
   */
  async dryRun(clipId: number, accountIds: string[], when: Date | null): Promise<{ wouldPost: PlannedPost[]; skipped: SkippedAccount[] }> {
    const { planned, skipped } = await this.plan(clipId, accountIds, when);
    const wouldPost = planned.map(({ item, permission, at }) => ({
      accountId: item.account.id,
      accountName: item.account.name,
      platform: item.account.platform,
      permissionId: permission.id,
      caption: item.caption,
      scheduledAt: at.toISOString(),
    }));
    return { wouldPost, skipped };
  }

  private async plan(clipId: number, accountIds: string[], when: Date | null) {
    const { clips, sources, posts, service } = this.deps;
    if (accountIds.length === 0) throw new ValidationError("Pick at least one account.");
    if (new Set(accountIds).size !== accountIds.length) throw new ValidationError("Each account can be picked once.");
    const now = this.now();
    if (when && when.getTime() < now.getTime() - 60_000) throw new ValidationError("Pick a time in the future.");

    const clip = clips.get(clipId);
    const source = sources.get(clip.sourceId);
    // First pass without platforms: refuses missing or expired records before any service call.
    assertCanPost({ clipStatus: clip.status, creatorName: source.creatorName, permissions: source.permissions, targets: [], now });

    const known = await this.knownAccounts();
    if (isExperimentOnly(source.permissions, now) && !known.some((a) => a.role === "burner" && a.enabled && !a.disabled)) {
      throw new PermissionError(
        `${source.creatorName} is an experiment, which posts only to burner accounts, and no burner account is switched on. Mark an account as Burner in Dashboard, Accounts first.`,
      );
    }
    const picked = accountIds.map((id) => {
      const account = known.find((a) => a.id === id);
      if (!account) throw new ValidationError("One of the accounts is no longer connected. Reload and pick again.");
      if (account.disabled) throw new ValidationError(`${account.name} is disconnected in ${service.label}. Reconnect it there first.`);
      return account;
    });
    const skipped: SkippedAccount[] = [];
    const chosen = picked.filter((account) => {
      const reason = skipReason(account);
      if (reason) skipped.push({ accountId: account.id, accountName: account.name, reason });
      return reason === null;
    });
    if (chosen.length === 0) throw new ValidationError(`${skipped.map((s) => s.reason).join(" ")} Nothing was posted.`);
    assertCanPost({
      clipStatus: clip.status,
      creatorName: source.creatorName,
      permissions: source.permissions,
      targets: chosen,
      now,
    });
    // Routing: a clip only goes to accounts that take its permission kind (and its pin, if any).
    // A real permission wins over an experiment, so a burner posts under the experiment only when nothing else covers it.
    const routedAt = (account: ChannelAccount, at: Date) => {
      const routes = source.permissions.filter((p) => isActive(p, at) && routingBlock(p, account, known) === null);
      return routes.find((p) => p.kind !== "experiment") ?? routes[0];
    };
    const routingReason = (account: ChannelAccount, at: Date): string => {
      const p = requireActivePermission(source.creatorName, source.permissions, at, account.platform, account.role);
      return `${account.name} ${routingBlockText(routingBlock(p, account, known) ?? "kind", p)}, so nothing was sent to it.`;
    };
    const routed = chosen.filter((account) => {
      if (routedAt(account, now)) return true;
      skipped.push({ accountId: account.id, accountName: account.name, reason: routingReason(account, now) });
      return false;
    });
    if (routed.length === 0) {
      const gap = noAccountReason(source.permissions, known, now);
      throw new ValidationError(`${gap ?? skipped.map((s) => s.reason).join(" ")} Nothing was posted.`);
    }
    // Compliance: a clip that breaks its campaign's rules does not go out under that campaign.
    const allowed = routed.filter((account) => {
      const permission = routedAt(account, now)!;
      const problems = this.rulesBroken(clip, permission, account.platform, this.caption(clip, source, permission, account.platform));
      if (problems.length > 0) skipped.push({ accountId: account.id, accountName: account.name, reason: `${account.name} was left out. ${problemsLine(problems)}` });
      return problems.length === 0;
    });
    if (allowed.length === 0) throw new ValidationError(`${skipped.map((s) => s.reason).join(" ")} Nothing was posted.`);

    for (const platform of PLATFORMS) {
      const cap = service.dailyCaps[platform];
      const wanted = allowed.filter((a) => a.platform === platform).length;
      if (cap === undefined || wanted === 0) continue;
      const used = posts.countToday(service.name, platform);
      if (used + wanted > cap) {
        throw new ValidationError(
          `${service.label} allows ${cap} ${PLATFORM_LABELS[platform]} post${cap === 1 ? "" : "s"} a day and ${used} already went out today. Try tomorrow, or use Export to post by hand.`,
        );
      }
    }

    const wantedAt = when ?? now;
    // Where this clip already is, or is about to be: each account keeps its distance from the others.
    const clipTimes = posts.clipTimes(clip.id);
    const planned = allowed.map((account) => {
      const elsewhere = clipTimes.filter((c) => c.accountId !== account.id).map((c) => c.at);
      const at = nextFreeSlot(posts.takenTimes(account.id), wantedAt, account.pace, elsewhere);
      clipTimes.push({ accountId: account.id, at });
      // The covering permission must still be in force when the post goes out.
      const permission = routedAt(account, at);
      if (!permission) throw new ValidationError(`${routingReason(account, at)} Nothing was posted.`);
      const item: PublishItem = {
        account,
        title: clip.title,
        caption: this.caption(clip, source, permission, account.platform),
        when: when === null && at.getTime() === now.getTime() ? null : at,
        paidPromotion: permission.kind === "whop-campaign",
      };
      return { item, permission, at };
    });

    return { clip, planned, skipped };
  }

  /** Reads post status, links and views from the service. Errors are kept to show, never thrown. */
  async refresh(): Promise<number> {
    const { posts, service } = this.deps;
    const tracked = posts.tracked(service.name);
    if (tracked.length === 0) return 0;
    try {
      const updates = await service.refresh(tracked);
      for (const u of updates) posts.apply(service.name, u);
      this.lastRefreshError = null;
      return updates.length;
    } catch (err) {
      this.lastRefreshError = (err as Error).message;
      return 0;
    }
  }

  /**
   * MP4 + caption to post by hand; held to the same permission and brief as posting on a main
   * account, so an experiment clip is never exported.
   */
  exportPack(clipId: number, platform: Platform): ExportPack {
    const { clips, sources } = this.deps;
    const clip = clips.get(clipId);
    const source = sources.get(clip.sourceId);
    const [covering] = assertCanPost({
      clipStatus: clip.status,
      creatorName: source.creatorName,
      permissions: source.permissions,
      targets: [{ platform, role: "main" }],
      now: this.now(),
    });
    const permission = covering!;
    const caption = this.caption(clip, source, permission, platform);
    const problems = this.rulesBroken(clip, permission, platform, caption);
    if (problems.length > 0) throw new ValidationError(problemsLine(problems));
    return {
      clipId: clip.id,
      platform,
      fileName: `${slug(clip.title)}.mp4`,
      videoUrl: `/api/clips/${clip.id}/video?download=1`,
      caption,
      permission: {
        kind: permission.kind,
        campaignUrl: permission.campaignUrl,
        proofUrl: permission.proofUrl,
        proofQuote: permission.proofQuote,
      },
    };
  }

  stats(): Stats {
    const { posts, clips, sources } = this.deps;
    const all = posts.list().filter((p) => p.status !== "failed");
    const group = (keyOf: (p: Post) => string, labelOf: (p: Post) => string): StatsRow[] => {
      const rows = new Map<string, StatsRow>();
      for (const p of all) {
        const key = keyOf(p);
        const row = rows.get(key) ?? { key, label: labelOf(p), posts: 0, views: 0, estimatedEarningsUsd: 0 };
        row.posts++;
        row.views += p.views ?? 0;
        row.estimatedEarningsUsd = Math.round((row.estimatedEarningsUsd + p.estimatedEarningsUsd) * 100) / 100;
        rows.set(key, row);
      }
      return [...rows.values()].sort((a, b) => a.label.localeCompare(b.label));
    };
    const campaignLabel = (p: Post) => {
      if (p.campaignUrl) return `${p.creatorName} · ${new URL(p.campaignUrl).hostname.replace(/^www\./, "")}`;
      const perm = sources.get(p.sourceId).permissions.find((x) => x.id === p.permissionId);
      return `${p.creatorName} · ${perm ? PERMISSION_KIND_LABELS[perm.kind] : "campaign"}`;
    };
    const approvedClips = clips.countApproved();
    return {
      posts: all.length,
      views: all.reduce((s, p) => s + (p.views ?? 0), 0),
      estimatedEarningsUsd: Math.round(all.reduce((s, p) => s + p.estimatedEarningsUsd, 0) * 100) / 100,
      approvedClips,
      costPerApprovedClipUsd: approvedClips ? Math.round((posts.spendUsd() / approvedClips) * 10000) / 10000 : null,
      byCampaign: group((p) => String(p.permissionId), campaignLabel),
      byPlatform: group((p) => p.platform, (p) => PLATFORM_LABELS[p.platform]),
    };
  }
}
