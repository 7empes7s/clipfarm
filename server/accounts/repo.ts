import type {
  AccountHealth,
  AccountRole,
  ChannelAccount,
  ChannelSettings,
  PermissionKind,
  Platform,
  PostingAccount,
  PostingRules,
  PostingServiceName,
} from "../../shared/types.js";
import { ACCOUNT_HEALTHS, ACCOUNT_ROLES, BURNERS_GROUP_ID, MAIN_GROUP_ID, PERMISSION_KINDS } from "../../shared/types.js";
import { NotFoundError, ValidationError } from "../errors.js";
import type { PostsRepo } from "../publish/repo.js";

interface Row {
  account_id: string;
  service: PostingServiceName;
  /** NULL: the built-in group of the account's role. */
  group_id: number | null;
  platform: Platform;
  name: string;
  handle: string | null;
  avatar_url: string | null;
  disabled: number;
  role: AccountRole;
  niche: string;
  max_per_day: number | null;
  min_gap_minutes: number | null;
  enabled: number;
  health: AccountHealth;
  /** JSON list of permission kinds; NULL takes every kind, also ones added later. */
  takes: string | null;
  pinned_campaigns: string;
  paused_reason: string | null;
  workspace_id: number;
}

export { accountsAllowedFor } from "../../shared/routing.js";

// Words that say nothing about the topic of a channel.
const FILLER = new Set(["moments", "clips", "highlights", "shorts", "best", "daily", "funny", "the", "and", "of", "a"]);
const ROMAN: Record<string, string> = { ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9" };

function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).map((w) => ROMAN[w] ?? w);
}

/** True when every topic word of the niche ("GTA VI moments" → gta, 6) is in the clip's text. */
export function nicheMatches(niche: string, text: string): boolean {
  const have = new Set(words(text));
  return words(niche)
    .filter((w) => !FILLER.has(w))
    .every((w) => have.has(w));
}

export function parseChannelSettings(body: unknown): ChannelSettings {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!ACCOUNT_ROLES.includes(b.role as AccountRole)) throw new ValidationError("Pick a role: main or burner.");
  if (!ACCOUNT_HEALTHS.includes(b.health as AccountHealth)) throw new ValidationError("Pick a status: healthy, limited or banned.");
  if (typeof b.enabled !== "boolean") throw new ValidationError("Say whether the account is on or off.");
  const niche = typeof b.niche === "string" ? b.niche.trim() : "";
  if (niche.length > 60) throw new ValidationError("Keep the niche under 60 characters.");
  const optional = (v: unknown, min: number, max: number, message: string): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new ValidationError(message);
    return n;
  };
  if (!Array.isArray(b.takes) || !b.takes.every((k) => PERMISSION_KINDS.includes(k as PermissionKind))) {
    throw new ValidationError("Say which kinds of clips this account takes.");
  }
  if (b.takes.length === 0) throw new ValidationError("Tick at least one kind of clip, or switch the account off.");
  if (!Array.isArray(b.pinnedCampaignIds) || !b.pinnedCampaignIds.every((id) => Number.isInteger(id) && id > 0)) {
    throw new ValidationError("Say which campaigns are pinned to this account.");
  }
  const takes = PERMISSION_KINDS.filter((k) => (b.takes as unknown[]).includes(k));
  return {
    role: b.role as AccountRole,
    niche,
    maxPerDay: optional(b.maxPerDay, 1, 50, "Posts a day must be a whole number from 1 to 50, or empty."),
    minGapMinutes: optional(b.minGapMinutes, 0, 1440, "Minutes between posts must be a whole number from 0 to 1440, or empty."),
    enabled: b.enabled,
    health: b.health as AccountHealth,
    takes,
    // A pin only means something on an account that takes Whop campaigns.
    pinnedCampaignIds: takes.includes("whop-campaign") ? [...new Set(b.pinnedCampaignIds as number[])] : [],
  };
}

/** Our posting accounts: what the posting service lists, plus the settings we keep for each. */
export class AccountsRepo {
  constructor(
    private posts: PostsRepo,
    private now: () => Date = () => new Date(),
  ) {}

  private toAccount(r: Row, shared: PostingRules): ChannelAccount {
    return {
      id: r.account_id,
      platform: r.platform,
      name: r.name,
      disabled: r.disabled === 1,
      handle: r.handle,
      avatarUrl: r.avatar_url,
      role: r.role,
      niche: r.niche,
      maxPerDay: r.max_per_day,
      minGapMinutes: r.min_gap_minutes,
      enabled: r.enabled === 1,
      health: r.health,
      takes: r.takes === null ? [...PERMISSION_KINDS] : PERMISSION_KINDS.filter((k) => (JSON.parse(r.takes!) as string[]).includes(k)),
      pinnedCampaignIds: JSON.parse(r.pinned_campaigns) as number[],
      pace: { maxPerDay: r.max_per_day ?? shared.maxPerDay, minGapMinutes: r.min_gap_minutes ?? shared.minGapMinutes },
      pausedReason: r.paused_reason,
      groupId: r.group_id ?? (r.role === "burner" ? BURNERS_GROUP_ID : MAIN_GROUP_ID),
      direct: r.service === "direct",
      workspaceId: r.workspace_id ?? 1,
    };
  }

  /**
   * Takes the service's list of connected accounts: new ones are added as main, known ones keep
   * their settings, and ones the service no longer lists drop out of the list. Channels connected
   * in clipfarm itself are not the service's to list, so they stay.
   */
  sync(service: PostingServiceName, listed: PostingAccount[]): ChannelAccount[] {
    const db = this.posts.db;
    const upsert = db.prepare(
      `INSERT INTO posting_accounts (account_id, service, platform, name, handle, avatar_url, disabled, listed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(account_id) DO UPDATE SET service = excluded.service, platform = excluded.platform, name = excluded.name,
         handle = excluded.handle, avatar_url = excluded.avatar_url, disabled = excluded.disabled, listed = 1`,
    );
    db.transaction(() => {
      db.prepare("UPDATE posting_accounts SET listed = 0 WHERE service != 'direct'").run();
      for (const a of listed) {
        upsert.run(a.id, service, a.platform, a.name, a.handle ?? null, a.avatarUrl ?? null, a.disabled ? 1 : 0, this.now().toISOString());
      }
    })();
    return this.list();
  }

  /**
   * A channel connected in Settings, Accounts: added to the group it was connected in, with that
   * group's kind as its role. Connecting it again brings it back with its settings.
   */
  connectDirect(a: PostingAccount, group: { id: number; kind: AccountRole }, tokenExpiresAt: string | null): ChannelAccount {
    this.posts.db
      .prepare(
        `INSERT INTO posting_accounts (account_id, service, platform, name, handle, avatar_url, disabled, listed, role, group_id, token_expires_at, created_at)
         VALUES (?, 'direct', ?, ?, ?, ?, 0, 1, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET service = 'direct', name = excluded.name, handle = excluded.handle, avatar_url = excluded.avatar_url,
           disabled = 0, listed = 1, group_id = excluded.group_id, token_expires_at = excluded.token_expires_at`,
      )
      .run(a.id, a.platform, a.name, a.handle ?? null, a.avatarUrl ?? null, group.kind, group.id, tokenExpiresAt, this.now().toISOString());
    return this.list().find((x) => x.id === a.id)!;
  }

  /** When a connected channel's access token runs out; null when it does not, or is not known. */
  tokenExpiresAt(id: string): string | null {
    const row = this.posts.db.prepare("SELECT token_expires_at FROM posting_accounts WHERE account_id = ?").get(id) as { token_expires_at: string | null } | undefined;
    return row?.token_expires_at ?? null;
  }

  setTokenExpiresAt(id: string, at: string | null): void {
    this.posts.db.prepare("UPDATE posting_accounts SET token_expires_at = ? WHERE account_id = ?").run(at, id);
  }

  /** A connected channel whose sign-in was refused: shown as needing to be connected again. */
  markDisconnected(id: string): void {
    this.posts.db.prepare("UPDATE posting_accounts SET disabled = 1 WHERE account_id = ? AND service = 'direct'").run(id);
  }

  /** The accounts the posting service listed last time, and the channels connected here. */
  list(): ChannelAccount[] {
    const shared = this.posts.rules();
    const rows = this.posts.db.prepare("SELECT * FROM posting_accounts WHERE listed = 1 ORDER BY platform, role DESC, name, account_id").all() as Row[];
    return rows.map((r) => this.toAccount(r, shared));
  }

  /** Switching an account on again clears the reason it was paused. */
  update(id: string, s: ChannelSettings): ChannelAccount {
    const before = this.list().find((a) => a.id === id);
    if (before?.direct && before.role !== s.role) {
      throw new ValidationError(`${before.name} was connected in a group for ${before.role} accounts, so it stays a ${before.role} account.`);
    }
    // Every kind ticked is stored as "everything", so a kind added later is taken too.
    const takes = PERMISSION_KINDS.every((k) => s.takes.includes(k)) ? null : JSON.stringify(s.takes);
    const { changes } = this.posts.db
      .prepare(
        // A main account never shares a group with burners: a changed role lands in that role's built-in group.
        `UPDATE posting_accounts SET group_id = CASE WHEN role = ? THEN group_id ELSE NULL END, role = ?, niche = ?, max_per_day = ?,
           min_gap_minutes = ?, enabled = ?, health = ?, takes = ?,
           pinned_campaigns = ?, paused_reason = CASE WHEN ? = 1 THEN NULL ELSE paused_reason END WHERE account_id = ? AND listed = 1`,
      )
      .run(s.role, s.role, s.niche, s.maxPerDay, s.minGapMinutes, s.enabled ? 1 : 0, s.health, takes, JSON.stringify(s.pinnedCampaignIds), s.enabled ? 1 : 0, id);
    if (changes === 0) throw new NotFoundError("That account was not found.");
    return this.list().find((a) => a.id === id)!;
  }
}
