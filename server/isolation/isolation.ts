import type {
  AccountRole,
  ChannelAccount,
  DirectPlatform,
  IsolationGroup,
  IsolationInfo,
  ProxyCheck,
} from "../../shared/types.js";
import {
  ACCOUNT_ROLES,
  APP_KEY_LABELS,
  BURNERS_GROUP_ID,
  DIRECT_PLATFORMS,
  MAIN_GROUP_ID,
  PLATFORM_LABELS,
  YOUTUBE_DAILY_UNITS,
  YOUTUBE_UPLOAD_UNITS,
} from "../../shared/types.js";
import type { Db } from "../db/index.js";
import { NotFoundError, ValidationError } from "../errors.js";
import type { Settings } from "../settings/store.js";
import { type Fetch, networkReason, readExit, type Transport } from "./net.js";
import { maskIp, nextPacificMidnight, pacificDay, parseProxyUrl, type ProxyAddress } from "./rules.js";

export interface Group {
  id: number;
  name: string;
  kind: AccountRole;
}

/** The last proxy test as kept on the server: the exit address in full. */
interface StoredCheck {
  ok: boolean;
  message: string;
  exitIp: string | null;
  country: string | null;
  at: string;
}

export interface AppKeys {
  id: string;
  secret: string;
}

export interface IsolationDeps {
  db: Db;
  settings: Settings;
  transport: Transport;
  /** Answers { ip, country } for whoever asks: how a proxy's exit is told from this server's own address. */
  ipEchoUrl: string;
  /** The app's public address: the start of every OAuth redirect URI. */
  publicUrl: string;
  now?: () => Date;
}

const NO_PROXY = "No proxy is set. Burner accounts cannot post until one is added and tested.";
/** A proxy test older than this is run again before a post goes out. */
const CHECK_TTL_MS = 24 * 3600_000;
const KIND_WORDS: Record<AccountRole, string> = { main: "main accounts", burner: "burner accounts" };

export function directPlatform(raw: unknown): DirectPlatform {
  if (!DIRECT_PLATFORMS.includes(raw as DirectPlatform)) throw new ValidationError("Pick YouTube, TikTok or Instagram.");
  return raw as DirectPlatform;
}

/**
 * Isolation groups: each has its own developer app per platform and its own way out to the
 * internet, so a flag on a burner cannot be traced to a main channel through a shared app or a
 * shared address. Keys and proxy addresses live in the secrets file and never leave this class
 * except to the connection that needs them.
 */
export class Isolation {
  private db: Db;
  private settings: Settings;
  private now: () => Date;

  constructor(private deps: IsolationDeps) {
    this.db = deps.db;
    this.settings = deps.settings;
    this.now = deps.now ?? (() => new Date());
  }

  list(): Group[] {
    return this.db.prepare("SELECT id, name, kind FROM isolation_groups ORDER BY id").all() as Group[];
  }

  get(id: number): Group {
    const group = this.db.prepare("SELECT id, name, kind FROM isolation_groups WHERE id = ?").get(id) as Group | undefined;
    if (!group) throw new NotFoundError("That group was not found.");
    return group;
  }

  create(body: unknown): Group {
    const b = (body ?? {}) as { name?: unknown; kind?: unknown };
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (name.length < 1 || name.length > 40) throw new ValidationError("Give the group a name of up to 40 characters.");
    if (!ACCOUNT_ROLES.includes(b.kind as AccountRole)) throw new ValidationError("Say who the group is for: main accounts or burner accounts.");
    if (this.list().some((g) => g.name.toLowerCase() === name.toLowerCase())) throw new ValidationError(`There is already a group called “${name}”.`);
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO isolation_groups (name, kind, created_at) VALUES (?, ?, ?)")
      .run(name, b.kind, this.now().toISOString());
    return this.get(Number(lastInsertRowid));
  }

  remove(id: number): void {
    const group = this.get(id);
    if (id === MAIN_GROUP_ID || id === BURNERS_GROUP_ID) throw new ValidationError(`“${group.name}” is a built-in group and stays.`);
    const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM posting_accounts WHERE group_id = ? AND listed = 1").get(id) as { n: number };
    if (n > 0) throw new ValidationError(`“${group.name}” still has accounts in it. Move them to another group first.`);
    this.db.transaction(() => {
      this.db.prepare("UPDATE posting_accounts SET group_id = NULL WHERE group_id = ?").run(id);
      this.db.prepare("DELETE FROM isolation_groups WHERE id = ?").run(id);
    })();
    this.settings.dropSecrets(`group.${id}.`);
  }

  /** Refuses to mix kinds: a main account never shares a group (its apps, its address) with burners. */
  assertCanJoin(account: { name: string; role: AccountRole }, group: Group): void {
    if (account.role === group.kind) return;
    const never = account.role === "main" ? "A main account never shares a group with burners." : "A burner never shares a group with main accounts.";
    throw new ValidationError(`${account.name} is a ${account.role} account, and “${group.name}” is a group for ${KIND_WORDS[group.kind]}. ${never}`);
  }

  /** Moves an account linked in the posting service to another group of its own kind. */
  moveAccount(account: ChannelAccount, groupId: unknown): void {
    const group = this.get(Number(groupId));
    this.assertCanJoin(account, group);
    if (account.direct && account.groupId !== group.id) {
      throw new ValidationError(
        `${account.name} was connected with the apps of “${this.get(account.groupId).name}”. To move it, connect it again from “${group.name}”.`,
      );
    }
    this.db.prepare("UPDATE posting_accounts SET group_id = ? WHERE account_id = ?").run(group.id, account.id);
  }

  redirectUri(platform: DirectPlatform): string {
    return `${this.deps.publicUrl.replace(/\/+$/, "")}/oauth/${platform}/callback`;
  }

  app(groupId: number, platform: DirectPlatform): AppKeys | null {
    const id = this.settings.secret(`group.${groupId}.${platform}.id`);
    const secret = this.settings.secret(`group.${groupId}.${platform}.secret`);
    return id && secret ? { id, secret } : null;
  }

  /** Saves an app's keys. The messages never repeat what was pasted. */
  setApp(groupId: number, platform: DirectPlatform, body: unknown): void {
    this.get(groupId);
    const b = (body ?? {}) as { id?: unknown; secret?: unknown };
    const labels = APP_KEY_LABELS[platform];
    const read = (raw: unknown, label: string): string => {
      const value = typeof raw === "string" ? raw.trim() : "";
      if (!value) throw new ValidationError(`${label}: paste it first.`);
      if (value.length > 500 || /[\s\p{Cc}]/u.test(value)) throw new ValidationError(`${label}: it has a space or line break in it, or is too long. Copy it again.`);
      return value;
    };
    const id = read(b.id, labels.id);
    const secret = read(b.secret, labels.secret);
    this.settings.setSecret(`group.${groupId}.${platform}.id`, id);
    this.settings.setSecret(`group.${groupId}.${platform}.secret`, secret);
  }

  removeApp(groupId: number, platform: DirectPlatform): void {
    this.get(groupId);
    this.settings.dropSecrets(`group.${groupId}.${platform}.`);
  }

  proxy(groupId: number): ProxyAddress | null {
    const url = this.settings.secret(`group.${groupId}.proxy`);
    return url ? parseProxyUrl(url) : null;
  }

  /** Saves (or with null, removes) a group's proxy. A new address has to pass its test again. */
  setProxy(groupId: number, raw: unknown): void {
    this.get(groupId);
    this.settings.setSecret(`group.${groupId}.proxy`, raw === null ? null : parseProxyUrl(raw).url);
    this.saveCheck(groupId, null);
  }

  private stored(groupId: number): StoredCheck | null {
    const row = this.db.prepare("SELECT proxy_check FROM isolation_groups WHERE id = ?").get(groupId) as { proxy_check: string | null } | undefined;
    return row?.proxy_check ? (JSON.parse(row.proxy_check) as StoredCheck) : null;
  }

  private saveCheck(groupId: number, check: StoredCheck | null): void {
    this.db.prepare("UPDATE isolation_groups SET proxy_check = ? WHERE id = ?").run(check ? JSON.stringify(check) : null, groupId);
  }

  private ownIp(): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'server_ip'").get() as { value: string } | undefined;
    return row?.value ?? null;
  }

  /**
   * The Test button, and the daily re-check: one call to the IP-echo address through the proxy and
   * one straight out. The proxy passes only when it leaves from another address than this server.
   */
  async check(groupId: number): Promise<ProxyCheck> {
    this.get(groupId);
    const proxy = this.proxy(groupId);
    if (!proxy) throw new ValidationError("Add a proxy first.");
    const at = this.now().toISOString();
    const done = (check: Omit<StoredCheck, "at">): ProxyCheck => {
      this.saveCheck(groupId, { ...check, at });
      return { ...check, exitIp: maskIp(check.exitIp), at };
    };
    const failed = (message: string) => done({ ok: false, message: this.settings.scrub(message), exitIp: null, country: null });
    let exit;
    try {
      exit = await readExit(this.deps.transport(proxy.url), this.deps.ipEchoUrl);
    } catch (err) {
      return failed(`The proxy did not let the call through (${networkReason(err)}). Check its address, user name and password.`);
    }
    let own;
    try {
      own = await readExit(this.deps.transport(null), this.deps.ipEchoUrl);
    } catch (err) {
      return failed(`This server's own address could not be read (${networkReason(err)}), so the proxy cannot be compared with it. Try again.`);
    }
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('server_ip', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(own.ip);
    if (exit.ip === own.ip) {
      return done({
        ok: false,
        message: `The proxy sends traffic out from this server's own address (${maskIp(own.ip)}), so it hides nothing. Use another proxy.`,
        exitIp: exit.ip,
        country: exit.country,
      });
    }
    return done({
      ok: true,
      message: `Works: traffic leaves from ${maskIp(exit.ip)}${exit.country ? ` (${exit.country})` : ""}.`,
      exitIp: exit.ip,
      country: exit.country,
    });
  }

  /** Why this group's accounts cannot post, from the last test. Null when they can. */
  problem(group: Group): string | null {
    if (!this.proxy(group.id)) return group.kind === "burner" ? NO_PROXY : null;
    const check = this.stored(group.id);
    if (!check) return "The proxy has not been tested yet. Tap Test.";
    return check.ok ? null : check.message;
  }

  /** The same, after testing the proxy again when the last test is missing or a day old. */
  async freshProblem(group: Group): Promise<string | null> {
    if (this.proxy(group.id)) {
      const check = this.stored(group.id);
      if (!check || this.now().getTime() - new Date(check.at).getTime() >= CHECK_TTL_MS) await this.check(group.id);
    }
    return this.problem(group);
  }

  /** Tests again every proxy whose last test is a day old (the daily timer). */
  async recheckStale(): Promise<void> {
    for (const group of this.list()) await this.freshProblem(group).catch(() => undefined);
  }

  /**
   * The way out for this group's calls. A burner group never gets the server's own connection:
   * without a proxy that passed its test, there is no way out at all.
   */
  fetchFor(group: Group): Fetch {
    const proxy = this.proxy(group.id);
    const problem = this.problem(group);
    if (problem) throw new ValidationError(problem);
    return this.deps.transport(proxy ? proxy.url : null);
  }

  /** The address this group's calls leave from, in full: its proxy's exit, or the server's own. */
  exitIp(group: Group): string | null {
    return this.proxy(group.id) ? (this.stored(group.id)?.exitIp ?? null) : this.ownIp();
  }

  quotaUsed(groupId: number, day: string): number {
    const row = this.db.prepare("SELECT units FROM youtube_quota WHERE group_id = ? AND day = ?").get(groupId, day) as { units: number } | undefined;
    return row?.units ?? 0;
  }

  /** Counts YouTube units a group's app just spent. */
  spendQuota(groupId: number, units: number): void {
    this.db
      .prepare("INSERT INTO youtube_quota (group_id, day, units) VALUES (?, ?, ?) ON CONFLICT(group_id, day) DO UPDATE SET units = units + excluded.units")
      .run(groupId, pacificDay(this.now()), units);
  }

  /** YouTube said the day's quota is gone: nothing more is tried before the reset. */
  fillQuota(groupId: number): void {
    this.db
      .prepare("INSERT INTO youtube_quota (group_id, day, units) VALUES (?, ?, ?) ON CONFLICT(group_id, day) DO UPDATE SET units = excluded.units")
      .run(groupId, pacificDay(this.now()), YOUTUBE_DAILY_UNITS);
  }

  /** True when another upload no longer fits in today's units. */
  quotaFull(groupId: number): boolean {
    return this.quotaUsed(groupId, pacificDay(this.now())) + YOUTUBE_UPLOAD_UNITS > YOUTUBE_DAILY_UNITS;
  }

  /** When YouTube's quota day ends: midnight Pacific time. */
  quotaReset(): Date {
    return nextPacificMidnight(this.now());
  }

  /**
   * The earliest time at or after `at` when one more upload fits in the group's YouTube units:
   * what was spent that Pacific day, plus the uploads already waiting for it across the group's
   * channels (`reserved` counts the ones being planned right now, per group and day).
   */
  uploadSlot(groupId: number, at: Date, reserved: Map<string, number> = new Map()): Date {
    const waiting = (
      this.db
        .prepare("SELECT scheduled_at FROM posts WHERE service = 'direct' AND platform = 'youtube' AND group_id = ? AND status = 'scheduled' AND external_id IS NULL")
        .all(groupId) as { scheduled_at: string }[]
    ).map((r) => pacificDay(new Date(r.scheduled_at)));
    let t = at;
    for (;;) {
      const day = pacificDay(t);
      const planned = waiting.filter((d) => d === day).length + (reserved.get(`${groupId}:${day}`) ?? 0);
      if (this.quotaUsed(groupId, day) + (planned + 1) * YOUTUBE_UPLOAD_UNITS <= YOUTUBE_DAILY_UNITS) return t;
      t = nextPacificMidnight(t);
    }
  }

  /** Notes an upload planned for `at`, so the next one planned in the same go sees it. */
  reserveUpload(reserved: Map<string, number>, groupId: number, at: Date): void {
    const key = `${groupId}:${pacificDay(at)}`;
    reserved.set(key, (reserved.get(key) ?? 0) + 1);
  }

  /** What Settings, Accounts shows. No key, token, proxy sign-in or full address is in here. */
  info(accounts: ChannelAccount[], extra: Pick<IsolationInfo, "lastConnect" | "demo">): IsolationInfo {
    const groups: IsolationGroup[] = this.list().map((group) => {
      const proxy = this.proxy(group.id);
      const check = this.stored(group.id);
      return {
        ...group,
        builtIn: group.id === MAIN_GROUP_ID || group.id === BURNERS_GROUP_ID,
        apps: DIRECT_PLATFORMS.map((platform) => {
          const id = this.app(group.id, platform)?.id ?? null;
          return { platform, set: id !== null, idEnding: id && id.length >= 12 ? id.slice(-4) : null, redirectUri: this.redirectUri(platform) };
        }),
        proxy: {
          set: proxy !== null,
          address: proxy?.address ?? null,
          signIn: proxy?.signIn ?? false,
          check: check && { ...check, exitIp: maskIp(check.exitIp) },
        },
        blocked: this.problem(group),
        youtubeQuota: {
          used: this.quotaUsed(group.id, pacificDay(this.now())),
          limit: YOUTUBE_DAILY_UNITS,
          fullUntil: this.quotaFull(group.id) ? this.quotaReset().toISOString() : null,
        },
        accounts: accounts
          .filter((a) => a.groupId === group.id)
          .map((a) => ({ id: a.id, name: a.name, platform: a.platform, direct: a.direct, disabled: a.disabled }))
          .sort((a, b) => a.name.localeCompare(b.name) || PLATFORM_LABELS[a.platform].localeCompare(PLATFORM_LABELS[b.platform])),
      };
    });
    return { groups, ...extra };
  }
}
