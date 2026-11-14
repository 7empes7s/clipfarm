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
import { needsManualSubmit, nextSubmitTime, type Snooze, snoozeEnd, type SubmitHours, type SubmitWindowInfo } from "../../shared/submitWindow.js";
import { AccountsRepo, nicheMatches } from "../accounts/repo.js";
import type { ClipsRepo } from "../clips/repo.js";
import { ValidationError } from "../errors.js";
import type { Isolation } from "../isolation/isolation.js";
import { isActive, isAttested, isExperimentOnly, PermissionError, requireActivePermission } from "../sources/permission.js";
import type { SourcesRepo } from "../sources/repo.js";
import { buildCaption } from "./caption.js";
import { type DirectPoster, QUOTA_NOTE } from "./direct/direct.js";
import { campaignProblems, clipTranscript, problemsLine } from "./compliance.js";
import { assertCanPost } from "./gate.js";
import type { PostsRepo } from "./repo.js";
import { nextFreeSlot, nextSubmitSlot } from "./spacing.js";
import type { PostingService, PublishItem, PublishResult } from "./types.js";

/** Platform limits in plain words, shown next to the post button. */
export const PLATFORM_NOTES = [
  "TikTok and YouTube keep posts made through an API private until the posting app passes their review (Postiz's own app or ours). Check that the first post is public.",
  "Instagram posting needs a Business or Creator account linked to a Facebook page.",
  "X allows 280 characters, so long titles are shortened; credit, links and hashtags stay.",
];

const HOURS_NOTE = "Waits for your submit hours, so you can submit it within 30 minutes of going live.";
const BUSY_NOTE = "Waits until you are back, so you can submit it within 30 minutes of going live.";

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
  /**
   * Isolation groups: burners post only through a group with a working proxy, and channels connected
   * here upload with their group's app. The server always passes it; left out (tests of other rules),
   * there are no groups and every account posts through the service.
   */
  isolation?: Isolation;
  /**
   * The submit window: campaign clips that have to be submitted by hand go out only when the manager
   * can submit, and wait here until then. The server always turns it on; left out (tests of other
   * rules), every post goes out by spacing alone.
   */
  submitWindow?: boolean;
  /** The stream a clip was cut from, to match it to an account's niche. */
  vodTitle?: (vodId: number) => string | null;
  /** The brand template's hashtags for a posting account (Studio templates); none when left out. */
  brandTags?: (accountId: string) => string[];
  /** Auto mode: why a campaign takes no more clips today (its share is used, it is paused), or null. */
  campaignLimit?: (permission: Permission, clipId: number) => string | null;
  now?: () => Date;
}

/** Another hook on the same cut (the hook lab): its own title, on-screen hook and rendered video. */
export interface PostVariant {
  title: string;
  hook: string;
  filePath: string;
}

/** The words a post goes out with: the clip's own, or a hook variant's. */
type Copy = Pick<PostVariant, "title" | "hook">;

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
  private direct: DirectPoster | null = null;

  constructor(private deps: PublisherDeps) {
    this.now = deps.now ?? (() => new Date());
    this.accounts = deps.accounts ?? new AccountsRepo(deps.posts, this.now);
  }

  get service(): PostingService {
    return this.deps.service;
  }

  /** Uploads for channels connected in clipfarm itself (it needs our account list, so it is made after us). */
  useDirect(direct: DirectPoster): void {
    this.direct = direct;
  }

  /** Why the way this account posts would tie it to others, whatever its group's proxy says. */
  private routeBlock(account: ChannelAccount): string | null {
    const { isolation, service } = this.deps;
    if (!isolation) return null;
    if (account.direct) return this.direct ? this.direct.problem(account, isolation.get(account.groupId)) : "Direct uploads are not set up on this server.";
    if (account.role === "burner" && !service.isolates) {
      return `It is a burner linked in ${service.label}, which posts from this server's own address with one shared app. Connect it in Settings, Accounts instead.`;
    }
    return null;
  }

  /** The proxy only matters to accounts that use it: burners, and channels that upload through their group. */
  private usesGroup(account: ChannelAccount): boolean {
    return this.deps.isolation !== undefined && (account.role === "burner" || account.direct);
  }

  /** Why isolation keeps this account from posting, from the last proxy test. */
  private isolationBlock(account: ChannelAccount): string | null {
    const route = this.routeBlock(account);
    if (route || !this.usesGroup(account)) return route;
    return this.deps.isolation!.problem(this.deps.isolation!.get(account.groupId));
  }

  /** The same before a post goes out: a proxy test that is a day old is run again first. */
  private async isolationBlockNow(account: ChannelAccount): Promise<string | null> {
    const route = this.routeBlock(account);
    if (route || !this.usesGroup(account)) return route;
    return this.deps.isolation!.freshProblem(this.deps.isolation!.get(account.groupId));
  }

  /** Reads the connected accounts from the posting service into our list. */
  async syncAccounts(): Promise<ChannelAccount[]> {
    const { service } = this.deps;
    const accounts = this.accounts.sync(service.name, await service.listAccounts());
    this.synced = true;
    return accounts;
  }

  private caption(copy: Copy, source: Source, permission: Permission, platform: Platform, accountId?: string): string {
    return buildCaption({
      brandTags: accountId ? (this.deps.brandTags?.(accountId) ?? []) : [],
      title: copy.title,
      creatorName: source.creatorName,
      channelUrl: source.channelUrls[0] ?? null,
      briefRules: permission.briefRules,
      rules: permission.rules,
      platform,
    });
  }

  /**
   * The compliance check: why this clip, with the title, hook and caption it goes out with, breaks
   * the campaign's rules on a platform. Empty for records without rules.
   */
  private rulesBroken(clip: Clip, copy: Copy, permission: Permission, platform: Platform, caption: string): string[] {
    if (permission.kind !== "whop-campaign" || !permission.rules) return [];
    return campaignProblems({
      rules: permission.rules,
      allowedPlatforms: permission.allowedPlatforms,
      platform,
      caption,
      title: copy.title,
      hook: copy.hook,
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
      const clip = clips.get(post.clipId);
      // A hook variant is checked on the title and hook it was posted with, not the clip's own.
      const problems = this.rulesBroken(clip, posts.variantOf(postId) ?? clip, sources.permission(post.permissionId), post.platform, post.caption);
      if (problems.length > 0) throw new ValidationError(`Not marked as sent. ${problemsLine(problems)}`);
    }
    return posts.setWhopStep(postId, step, on);
  }

  /** Our list of accounts, read from the service once per server start (and on every sync). */
  async knownAccounts(): Promise<ChannelAccount[]> {
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
    const unattested = active.length > 0 && !active.some(isAttested);
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
      const problems = permission ? this.rulesBroken(clip, clip, permission, account.platform, this.caption(clip, source, permission, account.platform)) : [];
      return problems.length > 0 ? problemsLine(problems) : null;
    };
    const text = [clip.title, clip.hook, source.creatorName, clip.vodId === null ? null : vodTitle?.(clip.vodId)].join(" ");
    // An experiment clip is offered burner accounts only: main accounts are not in its list at all.
    return accounts.filter((a) => !experiment || a.role === "burner").map((account) => {
      const blocked = account.disabled
        ? account.direct
          ? "Its sign-in ran out: connect it again in Settings, Accounts"
          : `Disconnected in ${service.label}`
        : !account.enabled
          ? account.pausedReason
            ? "Paused after a strike"
            : "Switched off"
          : account.health === "banned"
            ? "Marked banned, so it is skipped"
            : unattested
              ? "Confirm the videos are yours first (tick “I own these videos” in Creator)"
              : (routed(account) ?? broken(account) ?? this.isolationBlock(account));
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
   * A `variant` posts the same cut under another title and hook; every check stays the same, and
   * the campaign's rules are checked on the variant's words.
   */
  async post(clipId: number, accountIds: string[], when: Date | null, variant?: PostVariant): Promise<PostOutcome> {
    const { clips, posts, service, isolation } = this.deps;
    const { clip, planned, skipped } = await this.plan(clipId, accountIds, when, variant);
    // Channels connected here are uploaded by clipfarm, through their group; the rest go to the service.
    // A campaign post for later stays here until it is due, so "I'm busy" can still move it.
    const viaService = planned.filter((p) => !p.account.direct && !p.held);
    const results =
      viaService.length > 0
        ? await service.publish(
            { path: variant?.filePath ?? clips.filePath(clip.id), fileName: `${slug(variant?.title ?? clip.title)}.mp4` },
            viaService.map((p) => p.item),
          )
        : [];
    const made: Post[] = [];
    for (const { item, account, permission, at, note, held } of planned) {
      const groupId = isolation ? account.groupId : null;
      const needsSubmit = this.needsSubmit(permission);
      if (held) {
        made.push(posts.insert({
          clipId: clip.id,
          permissionId: permission.id,
          platform: item.account.platform,
          accountId: item.account.id,
          accountName: item.account.name,
          service: service.name,
          externalId: null,
          status: "scheduled",
          url: null,
          error: null,
          caption: item.caption,
          scheduledAt: at.toISOString(),
          postedAt: null,
          groupId,
          note,
          variant: variant && { title: variant.title, hook: variant.hook },
          variantFile: variant && variant.filePath !== clips.filePath(clip.id) ? variant.filePath : null,
          needsSubmit,
          held: true,
        }));
        continue;
      }
      if (account.direct) {
        const waiting = posts.insert({
          clipId: clip.id,
          permissionId: permission.id,
          platform: item.account.platform,
          accountId: item.account.id,
          accountName: item.account.name,
          service: "direct",
          externalId: null,
          status: "scheduled",
          url: null,
          error: null,
          caption: item.caption,
          scheduledAt: at.toISOString(),
          postedAt: null,
          groupId,
          note,
          variant: variant && { title: variant.title, hook: variant.hook },
          // Kept with the post: it may go out later (a set time, a busy account, a full quota).
          variantFile: variant && variant.filePath !== clips.filePath(clip.id) ? variant.filePath : null,
          needsSubmit,
        });
        // "Post now" uploads at once; a later time is picked up by the timer when it is due.
        made.push(item.when === null && this.direct ? await this.direct.send(waiting.id) : waiting);
        continue;
      }
      const r = results.find((x) => x.accountId === item.account.id);
      made.push(posts.insert({
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
        groupId,
        note,
        variant: variant && { title: variant.title, hook: variant.hook },
        needsSubmit,
      }));
    }
    return { posts: made, skipped };
  }

  private needsSubmit(permission: Permission): boolean {
    return this.deps.submitWindow === true && needsManualSubmit(permission);
  }

  /** The earliest time at or after `t` when a clip that needs a manual submit may go live. */
  private submitTime(): (t: Date) => Date {
    const hours = this.deps.posts.submitHours();
    const snooze = this.deps.posts.snoozeUntil();
    return (t) => nextSubmitTime(t, hours, snooze);
  }

  /** Why a campaign post waits, when the manager's hours or snooze moved it. */
  private waitNote(wanted: Date, at: Date): string | null {
    const snooze = this.deps.posts.snoozeUntil();
    if (snooze && wanted.getTime() < snooze.getTime()) return BUSY_NOTE;
    return nextSubmitTime(wanted, this.deps.posts.submitHours()).getTime() !== wanted.getTime() && at.getTime() !== wanted.getTime() ? HOURS_NOTE : null;
  }

  /**
   * Moves the campaign posts that wait in clipfarm and can no longer go out at their time (the
   * manager is busy, the submit hours changed, the server was away) to the next time that fits,
   * soonest first, each keeping its account's spacing.
   */
  reslot(): void {
    const { posts } = this.deps;
    const now = this.now();
    const allowed = this.submitTime();
    const accounts = this.accounts.list();
    const waiting = posts.waitingSubmit();
    waiting.forEach((p, i) => {
      const t = new Date(Math.max(p.at.getTime(), now.getTime()));
      // Due and free to go: it is sent, not moved.
      if (p.at.getTime() <= now.getTime() && allowed(now).getTime() === now.getTime()) return;
      // The posts after it in the line are placed after it, so they do not hold it back.
      const later = waiting.slice(i).map((w) => w.id);
      const pace = accounts.find((a) => a.id === p.accountId)?.pace ?? posts.rules();
      const elsewhere = posts.clipTimes(p.clipId, later).filter((c) => c.accountId !== p.accountId).map((c) => c.at);
      const at = nextSubmitSlot(posts.takenTimes(p.accountId, later), t, pace, elsewhere, allowed);
      if (at.getTime() !== p.at.getTime()) posts.postpone(p.id, at, this.waitNote(p.at, at) ?? HOURS_NOTE);
    });
  }

  /** Hands the held campaign posts whose time has come to the posting service. Returns how many went out. */
  async sendDueHeld(): Promise<number> {
    const { posts, clips, sources, service } = this.deps;
    this.reslot();
    let sent = 0;
    for (const id of posts.dueHeld()) {
      const post = posts.get(id);
      const failed = (error: string) => posts.handOver(id, { externalId: null, status: "failed", url: null, error, postedAt: null });
      try {
        const account = (await this.knownAccounts()).find((a) => a.id === post.accountId);
        if (!account || account.disabled) {
          failed(`${post.accountName} is no longer connected, so this post was not sent.`);
          continue;
        }
        const off = skipReason(account);
        if (off) {
          failed(off);
          continue;
        }
        // The permission may have run out or been put on hold while the post waited: checked again now.
        const permission = sources.permission(post.permissionId);
        requireActivePermission(post.creatorName, [permission], this.now(), account.platform, account.role);
        const variant = posts.variantOf(id);
        const [r] = await service.publish(
          { path: posts.variantFile(id) ?? clips.filePath(post.clipId), fileName: `${slug(variant?.title ?? post.clipTitle)}.mp4` },
          [{ account, title: variant?.title ?? post.clipTitle, caption: post.caption, when: null, paidPromotion: permission.kind === "whop-campaign" }],
        );
        if (!r) failed(`${service.label} did not answer for this account.`);
        else {
          posts.handOver(id, r);
          if (r.status !== "failed") sent++;
        }
      } catch (err) {
        failed((err as Error).message);
      }
    }
    return sent;
  }

  /** Asks the service about campaign posts it was handed but has not confirmed: their submit window may be running. */
  async confirmSubmits(): Promise<void> {
    const { posts, service } = this.deps;
    const waiting = posts.unconfirmedSubmit(service.name);
    if (waiting.length === 0) return;
    try {
      for (const u of await service.refresh(waiting)) posts.apply(service.name, u);
    } catch (err) {
      this.lastRefreshError = (err as Error).message;
    }
  }

  submitInfo(): SubmitWindowInfo {
    const { posts } = this.deps;
    const waiting = posts.waitingSubmit();
    return {
      hours: posts.submitHours(),
      snoozeUntil: posts.snoozeUntil()?.toISOString() ?? null,
      waiting: waiting.length,
      nextAt: waiting[0]?.at.toISOString() ?? null,
      open: posts.awaitingSubmit().length,
    };
  }

  saveSubmitHours(hours: SubmitHours): SubmitWindowInfo {
    this.deps.posts.saveSubmitHours(hours);
    this.reslot();
    return this.submitInfo();
  }

  /** "I'm busy": campaign posts due before the snooze ends move to after it. null ends the snooze. */
  snooze(choice: Snooze | null): SubmitWindowInfo {
    const { posts } = this.deps;
    posts.setSnooze(choice && snoozeEnd(this.now(), choice, posts.submitHours().timeZone));
    this.reslot();
    return this.submitInfo();
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

  /**
   * Go-live's test post: the clip uploaded as a private YouTube video, which only the channel's
   * owner can see. It is never public and never stored as a post (no stats, no Whop submit), but
   * it passes the same permission gate, campaign rules and isolation check as a real post. The
   * clip does not have to be approved: approving and posting in public stay the manager's taps.
   */
  async privateTest(clipId: number, accountId: string): Promise<PublishResult> {
    const { clips, sources, service } = this.deps;
    // Only Postiz passes "private" on to YouTube (and the stand-in sends nothing anywhere).
    if (service.name !== "postiz" && service.name !== "fake") throw new ValidationError(`A private test post goes only through Postiz, not ${service.label}.`);
    const clip = clips.get(clipId);
    const source = sources.get(clip.sourceId);
    const account = (await this.knownAccounts()).find((a) => a.id === accountId);
    if (!account) throw new ValidationError("That account is not connected.");
    if (account.platform !== "youtube" || account.direct) throw new ValidationError(`${account.name}: a private test post goes only to a YouTube channel linked in ${service.label}.`);
    if (account.disabled) throw new ValidationError(`${account.name} is disconnected in ${service.label}. Reconnect it there first.`);
    const permission = requireActivePermission(source.creatorName, source.permissions, this.now(), account.platform, account.role);
    const caption = this.caption(clip, source, permission, account.platform);
    const problems = this.rulesBroken(clip, clip, permission, account.platform, caption);
    if (problems.length > 0) throw new ValidationError(problemsLine(problems));
    const blocked = await this.isolationBlockNow(account);
    if (blocked) throw new ValidationError(`${account.name} cannot post: ${blocked}`);
    const [result] = await service.publish({ path: clips.filePath(clip.id), fileName: `${slug(clip.title)}.mp4` }, [
      { account, title: clip.title, caption, when: null, paidPromotion: permission.kind === "whop-campaign", privacy: "private" },
    ]);
    if (!result) throw new ValidationError(`${service.label} did not answer for ${account.name}.`);
    return result;
  }

  private async plan(clipId: number, accountIds: string[], when: Date | null, variant?: Copy) {
    const { clips, sources, posts, service } = this.deps;
    if (accountIds.length === 0) throw new ValidationError("Pick at least one account.");
    if (new Set(accountIds).size !== accountIds.length) throw new ValidationError("Each account can be picked once.");
    const now = this.now();
    if (when && when.getTime() < now.getTime() - 60_000) throw new ValidationError("Pick a time in the future.");

    const clip = clips.get(clipId);
    const copy: Copy = variant ?? clip;
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
      if (account.disabled && account.direct) throw new ValidationError(`${account.name}'s sign-in ran out. Connect it again in Settings, Accounts.`);
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
      const routes = source.permissions.filter((p) => isActive(p, at) && isAttested(p) && routingBlock(p, account, known) === null);
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
      const problems = this.rulesBroken(clip, copy, permission, account.platform, this.caption(copy, source, permission, account.platform));
      const why = problems.length > 0 ? problemsLine(problems) : (this.deps.campaignLimit?.(permission, clip.id) ?? null);
      if (why) skipped.push({ accountId: account.id, accountName: account.name, reason: `${account.name} was left out. ${why}` });
      return why === null;
    });
    if (allowed.length === 0) throw new ValidationError(`${skipped.map((s) => s.reason).join(" ")} Nothing was posted.`);
    // Isolation: a burner posts only through a group whose proxy works, and never through a shared app.
    const cleared: ChannelAccount[] = [];
    for (const account of allowed) {
      const why = await this.isolationBlockNow(account);
      if (why) skipped.push({ accountId: account.id, accountName: account.name, reason: `${account.name} cannot post: ${why}` });
      else cleared.push(account);
    }
    if (cleared.length === 0) throw new ValidationError(`${skipped.map((s) => s.reason).join(" ")} Nothing was posted.`);

    for (const platform of PLATFORMS) {
      const cap = service.dailyCaps[platform];
      const wanted = cleared.filter((a) => a.platform === platform && !a.direct).length;
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
    const { isolation } = this.deps;
    // YouTube uploads being planned in this go, per group and Pacific day.
    const reserved = new Map<string, number>();
    const canSubmitAt = this.submitTime();
    const planned = cleared.map((account) => {
      const elsewhere = clipTimes.filter((c) => c.accountId !== account.id).map((c) => c.at);
      const taken = posts.takenTimes(account.id);
      // A campaign clip that has to be submitted by hand goes out only when the manager can do it.
      const needsSubmit = this.needsSubmit(routedAt(account, now)!);
      const slot = (from: Date) => (needsSubmit ? nextSubmitSlot(taken, from, account.pace, elsewhere, canSubmitAt) : nextFreeSlot(taken, from, account.pace, elsewhere));
      let at = slot(wantedAt);
      let note: string | null = needsSubmit ? this.waitNote(wantedAt, at) : null;
      // A direct YouTube upload costs the group's app 1,600 of its daily units: when the day is
      // full, the post waits for the reset instead of failing.
      if (isolation && account.direct && account.platform === "youtube") {
        for (let open = isolation.uploadSlot(account.groupId, at, reserved); open.getTime() !== at.getTime(); open = isolation.uploadSlot(account.groupId, at, reserved)) {
          at = slot(open);
          note = QUOTA_NOTE;
        }
        isolation.reserveUpload(reserved, account.groupId, at);
      }
      clipTimes.push({ accountId: account.id, at });
      // The covering permission must still be in force when the post goes out.
      const permission = routedAt(account, at);
      if (!permission) throw new ValidationError(`${routingReason(account, at)} Nothing was posted.`);
      const item: PublishItem = {
        account,
        title: copy.title,
        caption: this.caption(copy, source, permission, account.platform, account.id),
        when: when === null && at.getTime() === now.getTime() ? null : at,
        paidPromotion: permission.kind === "whop-campaign",
      };
      // Kept here until it is due when it goes out later through the posting service.
      const held = needsSubmit && !account.direct && item.when !== null;
      return { item, account, permission, at, note, held };
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
    const problems = this.rulesBroken(clip, clip, permission, platform, caption);
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
      missedWindows: all.filter((p) => p.submit?.missedAt).length,
      lostEarningsUsd: Math.round(all.reduce((s, p) => s + p.lostEarningsUsd, 0) * 100) / 100,
      byCampaign: group((p) => String(p.permissionId), campaignLabel),
      byPlatform: group((p) => p.platform, (p) => PLATFORM_LABELS[p.platform]),
    };
  }
}
