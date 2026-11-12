import type {
  AccountHealth,
  AccountRole,
  ChannelAccount,
  ChannelSettings,
  Permission,
  Platform,
  PostingAccount,
  PostingRules,
  PostingServiceName,
} from "../../shared/types.js";
import { ACCOUNT_HEALTHS, ACCOUNT_ROLES } from "../../shared/types.js";
import { NotFoundError, ValidationError } from "../errors.js";
import type { PostsRepo } from "../publish/repo.js";

interface Row {
  account_id: string;
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
}

/**
 * The accounts a permission may post to. Today: every account that is switched on, on the
 * platforms the permission allows. The role is stored so an "experiment" permission can later be
 * held to burner accounts here, in one place.
 */
export function accountsAllowedFor(permission: Permission, accounts: ChannelAccount[]): ChannelAccount[] {
  return accounts.filter((a) => a.enabled && !a.disabled && permission.allowedPlatforms.includes(a.platform));
}

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
  return {
    role: b.role as AccountRole,
    niche,
    maxPerDay: optional(b.maxPerDay, 1, 50, "Posts a day must be a whole number from 1 to 50, or empty."),
    minGapMinutes: optional(b.minGapMinutes, 0, 1440, "Minutes between posts must be a whole number from 0 to 1440, or empty."),
    enabled: b.enabled,
    health: b.health as AccountHealth,
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
      pace: { maxPerDay: r.max_per_day ?? shared.maxPerDay, minGapMinutes: r.min_gap_minutes ?? shared.minGapMinutes },
    };
  }

  /**
   * Takes the service's list of connected accounts: new ones are added as main, known ones keep
   * their settings, and ones the service no longer lists drop out of the list.
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
      db.prepare("UPDATE posting_accounts SET listed = 0").run();
      for (const a of listed) {
        upsert.run(a.id, service, a.platform, a.name, a.handle ?? null, a.avatarUrl ?? null, a.disabled ? 1 : 0, this.now().toISOString());
      }
    })();
    return this.list();
  }

  /** The accounts the posting service listed last time. */
  list(): ChannelAccount[] {
    const shared = this.posts.rules();
    const rows = this.posts.db.prepare("SELECT * FROM posting_accounts WHERE listed = 1 ORDER BY platform, role DESC, name, account_id").all() as Row[];
    return rows.map((r) => this.toAccount(r, shared));
  }

  update(id: string, s: ChannelSettings): ChannelAccount {
    const { changes } = this.posts.db
      .prepare("UPDATE posting_accounts SET role = ?, niche = ?, max_per_day = ?, min_gap_minutes = ?, enabled = ?, health = ? WHERE account_id = ? AND listed = 1")
      .run(s.role, s.niche, s.maxPerDay, s.minGapMinutes, s.enabled ? 1 : 0, s.health, id);
    if (changes === 0) throw new NotFoundError("That account was not found.");
    return this.list().find((a) => a.id === id)!;
  }
}
