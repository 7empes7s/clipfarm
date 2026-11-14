import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import type { ChannelAccount, DirectPlatform, IsolationInfo, Post } from "../../../shared/types.js";
import { DIRECT_PLATFORMS, PLATFORM_LABELS } from "../../../shared/types.js";
import type { AccountsRepo } from "../../accounts/repo.js";
import type { ClipsRepo } from "../../clips/repo.js";
import { HttpError, ValidationError } from "../../errors.js";
import type { Group, Isolation } from "../../isolation/isolation.js";
import { maskIp } from "../../isolation/rules.js";
import type { Settings } from "../../settings/store.js";
import { requireActivePermission } from "../../sources/permission.js";
import type { SourcesRepo } from "../../sources/repo.js";
import type { PostsRepo } from "../repo.js";
import { type Ctx, type Endpoints, PLATFORM_CLIENTS, type PlatformClient, QuotaExceeded, SignInRefused, type Tokens } from "./platforms.js";

export interface DirectDeps {
  isolation: Isolation;
  accounts: AccountsRepo;
  posts: PostsRepo;
  clips: ClipsRepo;
  sources: SourcesRepo;
  settings: Settings;
  endpoints: Endpoints;
  /** Moves a channel connected from the client portal into that client's workspace. */
  assignWorkspace?: (accountId: string, workspaceId: number) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

/** A started sign-in is good for this long. */
const STATE_TTL_MS = 10 * 60_000;
export const QUOTA_NOTE = "YouTube quota full until midnight Pacific time, so it goes out then.";

/**
 * Uploads from clipfarm itself, for channels connected in Settings, Accounts. Every call (the
 * sign-in's code trade, token renewals, the upload) goes out through the channel's group: its
 * developer app and its proxy. Posting services cannot do that: one address, one app for everyone.
 */
export class DirectPoster {
  /** How the last "Connect channel" ended, for the screen the browser lands on. */
  lastConnect: IsolationInfo["lastConnect"] = null;
  private states = new Map<string, { groupId: number; platform: DirectPlatform; expires: number; workspaceId?: number }>();
  private running = false;
  /** Posts being uploaded right now: "Post now" and the timer never send the same one twice. */
  private sending = new Set<number>();
  private now: () => Date;

  constructor(private deps: DirectDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private ctx(group: Group, platform: DirectPlatform): Ctx {
    const { isolation } = this.deps;
    const app = isolation.app(group.id, platform);
    if (!app) throw new ValidationError(`Paste the ${PLATFORM_CLIENTS[platform].label} app keys of “${group.name}” first.`);
    return {
      // Throws for a burner group without a proxy that passed its test: there is no other way out.
      fetch: isolation.fetchFor(group),
      endpoints: this.deps.endpoints,
      app,
      redirectUri: isolation.redirectUri(platform),
      now: this.now,
      sleep: this.deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      spend: (units) => isolation.spendQuota(group.id, units),
    };
  }

  /** What stops a connected channel from posting besides its group's proxy: the group's app keys. */
  problem(account: ChannelAccount, group: Group): string | null {
    if (!DIRECT_PLATFORMS.includes(account.platform as DirectPlatform)) return `clipfarm cannot upload to ${PLATFORM_LABELS[account.platform]} itself.`;
    const client = PLATFORM_CLIENTS[account.platform as DirectPlatform];
    return this.deps.isolation.app(group.id, account.platform as DirectPlatform) ? null : `“${group.name}” has no ${client.label} app keys. Paste them in Settings, Accounts.`;
  }

  /** "Connect channel": the platform's sign-in page for this group's app, coming back to our callback. */
  async connectUrl(groupId: number, platform: DirectPlatform, opts: { workspaceId?: number } = {}): Promise<string> {
    const { isolation } = this.deps;
    const group = isolation.get(groupId);
    if (!isolation.app(group.id, platform)) throw new ValidationError(`Paste the ${PLATFORM_CLIENTS[platform].label} app keys of “${group.name}” first.`);
    const problem = await isolation.freshProblem(group);
    if (problem) throw new ValidationError(`“${group.name}” cannot connect a channel yet: ${problem}`);
    const t = this.now().getTime();
    for (const [key, s] of this.states) if (s.expires < t) this.states.delete(key);
    const state = randomBytes(24).toString("base64url");
    this.states.set(state, { groupId, platform, expires: t + STATE_TTL_MS, workspaceId: opts.workspaceId });
    return PLATFORM_CLIENTS[platform].authorizeUrl(this.ctx(group, platform), state);
  }

  /** The workspace a pending sign-in was started for (the client portal's "Connect"); null for the team's own. */
  workspaceOfState(state: unknown): number | null {
    return (typeof state === "string" ? this.states.get(state)?.workspaceId : undefined) ?? null;
  }

  /**
   * The platform sent the browser back with a code. This address is open to the internet (the
   * platforms cannot sign in to Cloudflare Access), so the only thing that counts is a `state` we
   * handed out minutes ago, used once. The code is traded through the group's own way out.
   */
  async callback(platform: DirectPlatform, code: unknown, state: unknown): Promise<boolean> {
    const { isolation, accounts, settings } = this.deps;
    const started = typeof state === "string" ? this.states.get(state) : undefined;
    // A made-up state changes nothing, not even the note on the screen.
    if (!started || started.platform !== platform) return false;
    this.states.delete(state as string);
    const done = (ok: boolean, message: string) => {
      this.lastConnect = { ok, message: settings.scrub(message), at: this.now().toISOString() };
      return ok;
    };
    if (started.expires < this.now().getTime() || typeof code !== "string" || !code) {
      return done(false, "That sign-in was not finished in time. Tap Connect channel again.");
    }
    try {
      const group = isolation.get(started.groupId);
      const problem = await isolation.freshProblem(group);
      if (problem) return done(false, `“${group.name}” cannot connect a channel yet: ${problem}`);
      const channels = await PLATFORM_CLIENTS[platform].connect(this.ctx(group, platform), code);
      const known = accounts.list();
      const found = channels.map((c) => ({ ...c, accountId: `direct-${platform}-${c.id}` }));
      // Checked for every channel before any is saved: a main channel never lands among burners.
      for (const c of found) {
        const existing = known.find((a) => a.id === c.accountId);
        if (existing) isolation.assertCanJoin(existing, group);
      }
      for (const c of found) {
        accounts.connectDirect({ id: c.accountId, platform, name: c.name, handle: c.handle, avatarUrl: c.avatarUrl, disabled: false }, group, c.tokens.expiresAt);
        this.saveTokens(c.accountId, c.tokens);
        // Connected from the client portal: the channel posts that client's clips only.
        if (started.workspaceId !== undefined) this.deps.assignWorkspace?.(c.accountId, started.workspaceId);
      }
      const names = found.map((c) => c.name).join(", ");
      return done(true, `${names} ${found.length === 1 ? "is" : "are"} connected to “${group.name}”.`);
    } catch (err) {
      if (err instanceof HttpError) return done(false, err.message);
      console.error(settings.scrub(String((err as Error)?.stack ?? err)));
      return done(false, "Something went wrong while connecting the channel. Check the server log.");
    }
  }

  private saveTokens(accountId: string, tokens: Tokens): void {
    const { settings, accounts } = this.deps;
    settings.setSecret(`account.${accountId}.access`, tokens.access);
    settings.setSecret(`account.${accountId}.refresh`, tokens.refresh);
    accounts.setTokenExpiresAt(accountId, tokens.expiresAt);
  }

  /** The channel's access token, renewed first (through the same way out) when it is about to run out. */
  private async access(ctx: Ctx, client: PlatformClient, account: ChannelAccount): Promise<string> {
    const { settings, accounts } = this.deps;
    const access = settings.secret(`account.${account.id}.access`);
    if (!access) throw new SignInRefused(`${account.name} has to be connected again in Settings, Accounts.`);
    const tokens: Tokens = { access, refresh: settings.secret(`account.${account.id}.refresh`) ?? null, expiresAt: accounts.tokenExpiresAt(account.id) };
    if (!tokens.expiresAt || new Date(tokens.expiresAt).getTime() - this.now().getTime() > client.renewBeforeMs) return access;
    const renewed = await client.renew(ctx, tokens);
    this.saveTokens(account.id, renewed);
    return renewed.access;
  }

  private waitForQuota(postId: number, group: Group): Post {
    const { isolation, posts } = this.deps;
    return posts.postpone(postId, isolation.uploadSlot(group.id, isolation.quotaReset()), QUOTA_NOTE);
  }

  /** Uploads one waiting post now. Never throws: the post ends posted, failed with the reason, or waiting for quota. */
  async send(postId: number): Promise<Post> {
    const waiting = this.deps.posts.get(postId);
    if (this.sending.has(postId) || waiting.status !== "scheduled") return waiting;
    this.sending.add(postId);
    try {
      return await this.upload(waiting);
    } finally {
      this.sending.delete(postId);
    }
  }

  private async upload(post: Post): Promise<Post> {
    const { isolation, accounts, posts, clips, sources, settings } = this.deps;
    const postId = post.id;
    const failed = (error: string) => posts.settle(postId, { status: "failed", error: settings.scrub(error) });
    const account = accounts.list().find((a) => a.id === post.accountId);
    if (!account?.direct) return failed(`${post.accountName} is no longer connected in Settings, Accounts.`);
    // Switched off since it was queued (by hand, or by a strike): what waits does not go out.
    if (!account.enabled) return failed(`${account.name} is switched off, so this post was not sent.`);
    try {
      // The permission may have run out or been put on hold while the post waited: checked again now.
      const permission = sources.permission(post.permissionId);
      requireActivePermission(sources.get(permission.sourceId).creatorName, [permission], this.now(), account.platform, account.role);
      const group = isolation.get(account.groupId);
      const blocked = (await isolation.freshProblem(group)) ?? this.problem(account, group);
      if (blocked) return failed(`${account.name} cannot post: ${blocked}`);
      const platform = account.platform as DirectPlatform;
      if (platform === "youtube" && isolation.quotaFull(group.id)) return this.waitForQuota(postId, group);
      const client = PLATFORM_CLIENTS[platform];
      const ctx = this.ctx(group, platform);
      // A hook variant goes out with its own video and title, never the clip's in their place.
      const variantFile = posts.variantFile(postId);
      if (variantFile && !existsSync(variantFile)) return failed("The video of this hook variant is gone, so this post was not sent.");
      try {
        const access = await this.access(ctx, client, account);
        const sent = await client.upload(ctx, { id: account.id.slice(`direct-${platform}-`.length), handle: account.handle }, access, {
          path: variantFile ?? clips.filePath(post.clipId),
          title: posts.variantOf(postId)?.title ?? post.clipTitle,
          caption: post.caption,
          paidPromotion: permission.kind === "whop-campaign",
        });
        const exitIp = isolation.exitIp(group);
        console.log(
          `Posted clip ${post.clipId} on ${account.name} (${PLATFORM_LABELS[platform]}) through group “${group.name}”, leaving from ${maskIp(exitIp) ?? "an address not yet read"}.`,
        );
        return posts.settle(postId, { status: "posted", externalId: sent.externalId, url: sent.url, error: null, exitIp });
      } catch (err) {
        if (err instanceof QuotaExceeded) {
          isolation.fillQuota(group.id);
          return this.waitForQuota(postId, group);
        }
        if (err instanceof SignInRefused) accounts.markDisconnected(account.id);
        throw err;
      }
    } catch (err) {
      if (err instanceof HttpError) return failed(err.message);
      console.error(settings.scrub(String((err as Error)?.stack ?? err)));
      return failed("Something went wrong while uploading. Check the server log.");
    }
  }

  /** Sends every waiting direct post whose time has come, one at a time. Returns how many went out. */
  async runDue(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      let sent = 0;
      for (const id of this.deps.posts.dueDirect()) {
        if ((await this.send(id)).status === "posted") sent++;
      }
      return sent;
    } finally {
      this.running = false;
    }
  }
}
