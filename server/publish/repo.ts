import type { Db } from "../db/index.js";
import type {
  Platform,
  Post,
  PostFlag,
  PostingRules,
  PostingServiceName,
  PostStatus,
  WhopStep,
} from "../../shared/types.js";
import { WHOP_FEE, WHOP_HOLD_DAYS, WHOP_STEPS } from "../../shared/types.js";
import type { PostMetrics, StatPoint } from "../../shared/growth.js";
import { DEFAULT_SUBMIT_HOURS, SUBMIT_WINDOW_MIN, type SubmitHours } from "../../shared/submitWindow.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { maskIp } from "../isolation/rules.js";
import { mergeMetrics, offsetFor, parseMetrics } from "../growth/series.js";
import { estimateEarnings } from "./earnings.js";
import type { Booking } from "./planner.js";
import type { PostUpdate, TrackedPost } from "./types.js";

export const DEFAULT_RULES: PostingRules = { maxPerDay: 3, minGapMinutes: 90 };

interface PostRow {
  id: number;
  clip_id: number;
  clip_title: string;
  source_id: number;
  creator_name: string;
  permission_id: number;
  campaign_url: string | null;
  proof_url: string | null;
  cpm_rate_usd: number | null;
  min_views: number | null;
  platform: Platform;
  account_id: string;
  account_name: string;
  service: PostingServiceName;
  external_id: string | null;
  status: PostStatus;
  url: string | null;
  error: string | null;
  caption: string;
  scheduled_at: string;
  posted_at: string | null;
  views: number | null;
  views_updated_at: string | null;
  views_source: "service" | "manual" | null;
  whop_submitted_at: string | null;
  whop_approved_at: string | null;
  whop_paid_at: string | null;
  whop_rejected_at: string | null;
  whop_reject_reason: string | null;
  claim_at: string | null;
  removal_at: string | null;
  strike_at: string | null;
  kind: string;
  group_name: string | null;
  exit_ip: string | null;
  note: string | null;
  needs_submit: number;
  submit_missed_at: string | null;
}

const FLAG_COLUMNS: Record<PostFlag, string> = { claim: "claim_at", removal: "removal_at", strike: "strike_at" };

const SELECT = `
  SELECT p.*, c.title AS clip_title, c.source_id, s.creator_name, m.campaign_url, m.proof_url, m.cpm_rate_usd, m.min_views, m.kind,
    g.name AS group_name
  FROM posts p
  JOIN clips c ON c.id = p.clip_id
  JOIN sources s ON s.id = c.source_id
  JOIN permissions m ON m.id = p.permission_id
  LEFT JOIN isolation_groups g ON g.id = p.group_id`;

function toPost(r: PostRow): Post {
  // A campaign post that was not submitted in time earns nothing: what it would have made is shown as lost.
  const earned = estimateEarnings(r.views, r.cpm_rate_usd, r.min_views, r.kind === "whop-campaign" ? WHOP_FEE : 0);
  const missed = r.needs_submit === 1 && r.submit_missed_at !== null;
  // The window opens when the post is really out, not when it was handed to the posting service.
  const liveAt = r.status === "posted" ? (r.posted_at ?? r.scheduled_at) : null;
  return {
    id: r.id,
    clipId: r.clip_id,
    clipTitle: r.clip_title,
    sourceId: r.source_id,
    creatorName: r.creator_name,
    platform: r.platform,
    accountId: r.account_id,
    accountName: r.account_name,
    service: r.service,
    status: r.status,
    url: r.url,
    error: r.error,
    caption: r.caption,
    scheduledAt: r.scheduled_at,
    postedAt: r.posted_at,
    permissionId: r.permission_id,
    campaignUrl: r.campaign_url,
    proofUrl: r.proof_url,
    views: r.views,
    viewsUpdatedAt: r.views_updated_at,
    viewsSource: r.views_source,
    whopSubmittedAt: r.whop_submitted_at,
    whopApprovedAt: r.whop_approved_at,
    whopPaidAt: r.whop_paid_at,
    whopRejectedAt: r.whop_rejected_at,
    whopRejectReason: r.whop_reject_reason,
    whopPayoutAt: r.whop_approved_at ? new Date(new Date(r.whop_approved_at).getTime() + WHOP_HOLD_DAYS * 86_400_000).toISOString() : null,
    experiment: r.kind === "experiment",
    flags: { claim: r.claim_at, removal: r.removal_at, strike: r.strike_at },
    groupName: r.group_name,
    // The full address stays on the server: the screen gets its network.
    exitIp: maskIp(r.exit_ip),
    note: r.note,
    estimatedEarningsUsd: missed ? 0 : earned,
    submit:
      r.needs_submit === 1
        ? { liveAt, dueBy: liveAt && new Date(new Date(liveAt).getTime() + SUBMIT_WINDOW_MIN * 60_000).toISOString(), missedAt: r.submit_missed_at }
        : null,
    lostEarningsUsd: missed ? earned : 0,
  };
}

export interface NewPost {
  clipId: number;
  permissionId: number;
  platform: Platform;
  accountId: string;
  accountName: string;
  service: PostingServiceName;
  externalId: string | null;
  status: PostStatus;
  url: string | null;
  error: string | null;
  caption: string;
  scheduledAt: string;
  postedAt: string | null;
  /** The account's isolation group, the address the post left from, and a note on a waiting post. */
  groupId?: number | null;
  exitIp?: string | null;
  note?: string | null;
  /** The title and hook it goes out with, when they are not the clip's own (a hook variant). */
  variant?: { title: string; hook: string };
  /** The variant's own video, kept with an upload that clipfarm sends itself (now or later). */
  variantFile?: string | null;
  /** A campaign post that has to be submitted by hand within 30 minutes of going live. */
  needsSubmit?: boolean;
  /** Kept in clipfarm and handed to the posting service when it is due (so it can still be moved). */
  held?: boolean;
}

/** A campaign post that waits in clipfarm for its time. */
export interface WaitingSubmit {
  id: number;
  clipId: number;
  accountId: string;
  at: Date;
}

/** A live post that is still to be submitted, and which pushes it already got. */
export interface AwaitingSubmit {
  post: Post;
  notified: boolean;
  reminded: boolean;
}

export class PostsRepo {
  /** The submit hours until the manager saves their own. */
  submitDefaults: SubmitHours = DEFAULT_SUBMIT_HOURS;

  constructor(
    readonly db: Db,
    private now: () => Date = () => new Date(),
  ) {}

  insert(p: NewPost): Post {
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO posts (clip_id, permission_id, platform, account_id, account_name, service, external_id, status,
           url, error, caption, scheduled_at, posted_at, created_at, group_id, exit_ip, note, variant_title, variant_hook, variant_file,
           needs_submit, held)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.clipId,
        p.permissionId,
        p.platform,
        p.accountId,
        p.accountName,
        p.service,
        p.externalId,
        p.status,
        p.url,
        p.error,
        p.caption,
        p.scheduledAt,
        p.postedAt,
        this.now().toISOString(),
        p.groupId ?? null,
        p.exitIp ?? null,
        p.note ?? null,
        p.variant?.title ?? null,
        p.variant?.hook ?? null,
        p.variantFile ?? null,
        p.needsSubmit ? 1 : 0,
        p.held ? 1 : 0,
      );
    return this.get(Number(lastInsertRowid));
  }

  /** Posts clipfarm uploads itself that are due: waiting, and their time has come. */
  dueDirect(): number[] {
    return (
      this.db
        .prepare("SELECT id FROM posts WHERE service = 'direct' AND status = 'scheduled' AND external_id IS NULL AND scheduled_at <= ? ORDER BY scheduled_at, id")
        .all(this.now().toISOString()) as { id: number }[]
    ).map((r) => r.id);
  }

  /** Posts held back for the posting service that are due: waiting, and their time has come. */
  dueHeld(): number[] {
    return (
      this.db
        .prepare("SELECT id FROM posts WHERE held = 1 AND status = 'scheduled' AND external_id IS NULL AND scheduled_at <= ? ORDER BY scheduled_at, id")
        .all(this.now().toISOString()) as { id: number }[]
    ).map((r) => r.id);
  }

  /** Campaign posts that wait in clipfarm for their time (held for the service, or our own uploads), soonest first. */
  waitingSubmit(): WaitingSubmit[] {
    return (
      this.db
        .prepare(
          "SELECT id, clip_id, account_id, scheduled_at FROM posts WHERE needs_submit = 1 AND status = 'scheduled' AND external_id IS NULL ORDER BY scheduled_at, id",
        )
        .all() as { id: number; clip_id: number; account_id: string; scheduled_at: string }[]
    ).map((r) => ({ id: r.id, clipId: r.clip_id, accountId: r.account_id, at: new Date(r.scheduled_at) }));
  }

  /** Live campaign posts that are neither submitted nor marked missed yet. */
  awaitingSubmit(): AwaitingSubmit[] {
    return (
      this.db
        .prepare(
          `${SELECT} WHERE p.needs_submit = 1 AND p.status = 'posted' AND p.whop_submitted_at IS NULL AND p.submit_missed_at IS NULL ORDER BY p.id`,
        )
        .all() as (PostRow & { submit_notified_at: string | null; submit_reminded_at: string | null })[]
    ).map((r) => ({ post: toPost(r), notified: r.submit_notified_at !== null, reminded: r.submit_reminded_at !== null }));
  }

  /**
   * Campaign posts handed to the service in the last half hour that it has not confirmed yet
   * (Postiz posts in the background): worth asking about now, since their submit window is running.
   */
  unconfirmedSubmit(service: PostingServiceName): TrackedPost[] {
    const now = this.now().getTime();
    return this.db
      .prepare(
        `SELECT external_id AS externalId, account_id AS accountId, platform, scheduled_at AS scheduledAt FROM posts
         WHERE needs_submit = 1 AND service = ? AND status = 'scheduled' AND external_id IS NOT NULL AND scheduled_at <= ? AND scheduled_at > ?
         ORDER BY id`,
      )
      .all(service, new Date(now).toISOString(), new Date(now - SUBMIT_WINDOW_MIN * 60_000).toISOString()) as TrackedPost[];
  }

  /** Records that a push went out for a post's submit window, or that the window passed. */
  markSubmit(id: number, what: "notified" | "reminded" | "missed"): void {
    const at = this.now().toISOString();
    // A reminder counts as the first push too: a post first seen late gets one, not both.
    const sets = what === "reminded" ? "submit_reminded_at = ?, submit_notified_at = COALESCE(submit_notified_at, ?)" : `submit_${what}_at = ?`;
    this.db.prepare(`UPDATE posts SET ${sets} WHERE id = ?`).run(...(what === "reminded" ? [at, at] : [at]), id);
  }

  /** How handing a held post to the posting service ended: from here on it is the service's post. */
  handOver(id: number, r: { externalId: string | null; status: PostStatus; url: string | null; error: string | null; postedAt: string | null }): Post {
    this.db
      .prepare("UPDATE posts SET held = 0, note = NULL, external_id = ?, status = ?, url = ?, error = ?, posted_at = ? WHERE id = ?")
      .run(r.externalId, r.status, r.url, r.error, r.postedAt, id);
    return this.get(id);
  }

  /** How a direct upload ended. */
  settle(id: number, r: { status: PostStatus; externalId?: string | null; url?: string | null; error: string | null; exitIp?: string | null }): Post {
    this.db
      .prepare("UPDATE posts SET status = ?, external_id = ?, url = ?, error = ?, exit_ip = ?, note = NULL, posted_at = ? WHERE id = ?")
      .run(r.status, r.externalId ?? null, r.url ?? null, r.error, r.exitIp ?? null, r.status === "posted" ? this.now().toISOString() : null, id);
    return this.get(id);
  }

  /** Moves a post that waits in clipfarm to a later time, with the reason. */
  postpone(id: number, at: Date, note: string | null): Post {
    this.db.prepare("UPDATE posts SET scheduled_at = ?, note = ? WHERE id = ?").run(at.toISOString(), note, id);
    return this.get(id);
  }

  /** The hook variant a post went out as; null when it went out with the clip's own title and hook. */
  variantOf(id: number): { title: string; hook: string } | null {
    const row = this.db.prepare("SELECT variant_title AS title, variant_hook AS hook FROM posts WHERE id = ?").get(id) as
      | { title: string | null; hook: string | null }
      | undefined;
    return row?.title != null && row.hook != null ? { title: row.title, hook: row.hook } : null;
  }

  /** The variant video a post uploads; null when it uploads the clip's own. */
  variantFile(id: number): string | null {
    return (this.db.prepare("SELECT variant_file FROM posts WHERE id = ?").pluck().get(id) as string | null | undefined) ?? null;
  }

  /** Whether an upload that has not gone out yet still needs this variant video. */
  waitsForFile(file: string): boolean {
    return this.db.prepare("SELECT 1 FROM posts WHERE variant_file = ? AND status = 'scheduled' AND external_id IS NULL").get(file) !== undefined;
  }

  get(id: number): Post {
    const row = this.db.prepare(`${SELECT} WHERE p.id = ?`).get(id) as PostRow | undefined;
    if (!row) throw new NotFoundError("That post was not found.");
    return toPost(row);
  }

  list(): Post[] {
    return (this.db.prepare(`${SELECT} ORDER BY p.scheduled_at DESC, p.id DESC`).all() as PostRow[]).map(toPost);
  }

  /** Posts the service can still tell us about, least recently updated first. */
  tracked(service: PostingServiceName): TrackedPost[] {
    return this.db
      .prepare(
        `SELECT external_id AS externalId, account_id AS accountId, platform, scheduled_at AS scheduledAt FROM posts
         WHERE service = ? AND external_id IS NOT NULL AND status != 'failed'
         ORDER BY views_updated_at IS NOT NULL, views_updated_at, id`,
      )
      .all(service) as TrackedPost[];
  }

  apply(service: PostingServiceName, u: PostUpdate): void {
    const sets: string[] = [];
    const args: unknown[] = [];
    const set = (col: string, v: unknown) => {
      sets.push(`${col} = ?`);
      args.push(v);
    };
    if (u.status !== undefined) set("status", u.status);
    if (u.url !== undefined && u.url !== null) set("url", u.url);
    if (u.error !== undefined) set("error", u.error);
    if (u.postedAt !== undefined && u.postedAt !== null) set("posted_at", u.postedAt);
    if (u.views !== undefined && u.views !== null) {
      set("views", u.views);
      set("views_source", "service");
      set("views_updated_at", this.now().toISOString());
    }
    const where = "WHERE service = ? AND external_id = ? AND account_id = ?";
    if (sets.length > 0) this.db.prepare(`UPDATE posts SET ${sets.join(", ")} ${where}`).run(...args, service, u.externalId, u.accountId);
    const row = this.db.prepare(`SELECT id FROM posts ${where}`).get(service, u.externalId, u.accountId) as { id: number } | undefined;
    if (!row) return;
    if (u.metrics || (u.views !== undefined && u.views !== null)) this.addReading(row.id, u.metrics ?? {});
    if (u.flags?.length) for (const flag of u.flags) this.setFlag(row.id, flag, true);
  }

  /**
   * Keeps what a platform said about a post: the latest numbers on the post, and a point in its
   * time series when the post is at one of the kept ages (1 h, 6 h, 24 h, 72 h, 7 d). A point is
   * written once and never changed. Numbers the platform did not give stay null.
   */
  addReading(postId: number, fresh: Partial<PostMetrics>): void {
    const row = this.db.prepare("SELECT status, posted_at, scheduled_at, views, metrics FROM posts WHERE id = ?").get(postId) as
      | { status: PostStatus; posted_at: string | null; scheduled_at: string; views: number | null; metrics: string | null }
      | undefined;
    if (!row) return;
    const now = this.now();
    if (typeof fresh.views === "number" && fresh.views !== row.views) {
      this.db.prepare("UPDATE posts SET views = ?, views_source = 'service', views_updated_at = ? WHERE id = ?").run(fresh.views, now.toISOString(), postId);
    }
    // Views live in their own column (they can also be typed in by hand).
    const metrics = { ...mergeMetrics(parseMetrics(row.metrics), fresh), views: fresh.views ?? row.views };
    this.db.prepare("UPDATE posts SET metrics = ? WHERE id = ?").run(JSON.stringify(metrics), postId);
    if (row.status !== "posted") return;
    const ageHours = (now.getTime() - new Date(row.posted_at ?? row.scheduled_at).getTime()) / 3600_000;
    const offset = offsetFor(ageHours);
    if (!offset) return;
    this.db
      .prepare("INSERT OR IGNORE INTO post_stats (post_id, offset_key, age_hours, at, metrics) VALUES (?, ?, ?, ?, ?)")
      .run(postId, offset, ageHours, now.toISOString(), JSON.stringify(metrics));
  }

  /** The latest numbers of every post that has any. */
  metrics(): Map<number, PostMetrics> {
    const rows = this.db.prepare("SELECT id, views, metrics FROM posts WHERE metrics IS NOT NULL OR views IS NOT NULL").all() as {
      id: number;
      views: number | null;
      metrics: string | null;
    }[];
    return new Map(rows.map((r) => [r.id, { ...parseMetrics(r.metrics), views: r.views }]));
  }

  /** Each post's kept points, oldest age first. */
  series(): Map<number, StatPoint[]> {
    const rows = this.db.prepare("SELECT * FROM post_stats ORDER BY post_id, age_hours").all() as {
      post_id: number;
      offset_key: StatPoint["offset"];
      age_hours: number;
      at: string;
      metrics: string;
    }[];
    const out = new Map<number, StatPoint[]>();
    for (const r of rows) {
      const point = { ...parseMetrics(r.metrics), offset: r.offset_key, ageHours: r.age_hours, at: r.at };
      out.set(r.post_id, [...(out.get(r.post_id) ?? []), point]);
    }
    return out;
  }

  /**
   * Records (or takes back) a claim, removal or strike on a post that went out. The first time it
   * was recorded is kept. A strike switches a burner account off, with the reason, until someone
   * switches it on again; taking the strike back does not switch it on.
   */
  setFlag(id: number, flag: PostFlag, on: boolean): Post {
    const post = this.get(id);
    if (post.status !== "posted") throw new ValidationError("Only a post that went out can get a claim, removal or strike.");
    if (on === (post.flags[flag] !== null)) return post;
    const at = this.now().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE posts SET ${FLAG_COLUMNS[flag]} = ? WHERE id = ?`).run(on ? at : null, id);
      if (flag === "strike" && on) {
        this.db
          .prepare("UPDATE posting_accounts SET enabled = 0, paused_reason = ? WHERE account_id = ? AND role = 'burner' AND enabled = 1")
          .run(`Paused on ${at.slice(0, 10)}: a strike on "${post.clipTitle}". Switch it on again in its settings when it is safe.`, post.accountId);
      }
    })();
    return this.get(id);
  }

  /** Posts that went out in the last two days or are still due: what the platforms' limits count (`except`: post ids left out). */
  bookings(except: number[] = []): Booking[] {
    const since = new Date(this.now().getTime() - 2 * 86_400_000).toISOString();
    return (
      this.db
        .prepare("SELECT id, account_id, platform, service, group_id, scheduled_at FROM posts WHERE status != 'failed' AND scheduled_at >= ?")
        .all(since) as { id: number; account_id: string; platform: Platform; service: PostingServiceName; group_id: number | null; scheduled_at: string }[]
    )
      .filter((r) => !except.includes(r.id))
      .map((r) => ({
        accountId: r.account_id,
        platform: r.platform,
        app: r.service === "direct" ? `group:${r.group_id}` : `service:${r.service}`,
        at: new Date(r.scheduled_at),
      }));
  }

  /** A post that still waits in clipfarm (held for the service, or our own upload), so its time can be changed. */
  movable(id: number): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM posts WHERE id = ? AND status = 'scheduled' AND external_id IS NULL AND (held = 1 OR service = 'direct')")
        .get(id) !== undefined
    );
  }

  /** The calendar's posts from `from` to `to`, soonest first, leaving out failed posts that were tried again. */
  between(from: Date, to: Date): { post: Post; movable: boolean }[] {
    return (
      this.db
        .prepare(
          `${SELECT.replace("SELECT p.*,", "SELECT p.*, (p.status = 'scheduled' AND p.external_id IS NULL AND (p.held = 1 OR p.service = 'direct')) AS movable,")}
           WHERE p.scheduled_at >= ? AND p.scheduled_at < ? AND p.retried_by IS NULL AND p.skipped_at IS NULL ORDER BY p.scheduled_at, p.id`,
        )
        .all(from.toISOString(), to.toISOString()) as (PostRow & { movable: number })[]
    ).map((r) => ({ post: toPost(r), movable: r.movable === 1 }));
  }

  /** The post a failed post was tried again as, or null. */
  /**
   * Operations' publishing list: posts that still wait to go out, and failed posts of the last
   * `failedDays` days that were neither tried again nor skipped. Soonest first.
   */
  waitingAndFailed(failedDays = 14): { post: Post; movable: boolean }[] {
    const since = new Date(this.now().getTime() - failedDays * 86_400_000).toISOString();
    return (
      this.db
        .prepare(
          `${SELECT.replace("SELECT p.*,", "SELECT p.*, (p.status = 'scheduled' AND p.external_id IS NULL AND (p.held = 1 OR p.service = 'direct')) AS movable,")}
           WHERE p.retried_by IS NULL AND p.skipped_at IS NULL AND (p.status = 'scheduled' OR (p.status = 'failed' AND p.scheduled_at >= ?))
           ORDER BY p.scheduled_at, p.id`,
        )
        .all(since) as (PostRow & { movable: number })[]
    ).map((r) => ({ post: toPost(r), movable: r.movable === 1 }));
  }

  /** "Skip": the post never goes out (a waiting one) or leaves the failed list (a failed one); the reason stays on it. */
  skip(id: number, reason: string): Post {
    this.db.prepare("UPDATE posts SET status = 'failed', held = 0, error = ?, skipped_at = ? WHERE id = ?").run(reason, this.now().toISOString(), id);
    return this.get(id);
  }

  retriedBy(id: number): number | null {
    return (this.db.prepare("SELECT retried_by FROM posts WHERE id = ?").pluck().get(id) as number | null | undefined) ?? null;
  }

  markRetried(id: number, by: number): void {
    this.db.prepare("UPDATE posts SET retried_by = ? WHERE id = ?").run(by, id);
  }

  /** The slot planner's settings: whether the TikTok posting app passed TikTok's audit. */
  plannerSettings(): { tiktokAudited: boolean } {
    const value = this.db.prepare("SELECT value FROM settings WHERE key = 'planner'").pluck().get() as string | undefined;
    return { tiktokAudited: false, ...(value ? (JSON.parse(value) as { tiktokAudited?: boolean }) : {}) };
  }

  savePlannerSettings(s: { tiktokAudited: boolean }): { tiktokAudited: boolean } {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES ('planner', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify({ tiktokAudited: s.tiktokAudited }));
    return this.plannerSettings();
  }

  /**
   * The campaign turned a submitted post down, with its reason (tapped by hand, or null to take it
   * back). A rejected post is not approved or paid; approving it again clears the rejection.
   */
  setWhopRejected(id: number, reason: string | null): Post {
    const post = this.get(id);
    if (post.experiment) throw new ValidationError("Experiment posts are never sent to Whop.");
    if (reason !== null && !post.whopSubmittedAt) throw new ValidationError("Mark it sent to Whop first.");
    if (reason === null) this.db.prepare("UPDATE posts SET whop_rejected_at = NULL, whop_reject_reason = NULL WHERE id = ?").run(id);
    else {
      this.db
        .prepare("UPDATE posts SET whop_rejected_at = COALESCE(whop_rejected_at, ?), whop_reject_reason = ?, whop_approved_at = NULL, whop_paid_at = NULL WHERE id = ?")
        .run(this.now().toISOString(), reason, id);
    }
    return this.get(id);
  }

  /** Times of the account's posts that went out or are still due (`except`: post ids left out). */
  takenTimes(accountId: string, except: number[] = []): Date[] {
    return (
      this.db.prepare("SELECT id, scheduled_at FROM posts WHERE account_id = ? AND status != 'failed'").all(accountId) as { id: number; scheduled_at: string }[]
    )
      .filter((r) => !except.includes(r.id))
      .map((r) => new Date(r.scheduled_at));
  }

  /** When this clip went out or is due, per account: two accounts never carry it at the same time. */
  clipTimes(clipId: number, except: number[] = []): { accountId: string; at: Date }[] {
    return (
      this.db.prepare("SELECT id, account_id, scheduled_at FROM posts WHERE clip_id = ? AND status != 'failed'").all(clipId) as {
        id: number;
        account_id: string;
        scheduled_at: string;
      }[]
    )
      .filter((r) => !except.includes(r.id))
      .map((r) => ({ accountId: r.account_id, at: new Date(r.scheduled_at) }));
  }

  /** Posts sent through the service today (UTC) on a platform. */
  countToday(service: PostingServiceName, platform: Platform): number {
    const day = this.now().toISOString().slice(0, 10);
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM posts WHERE service = ? AND platform = ? AND status != 'failed' AND substr(created_at, 1, 10) = ?")
        .get(service, platform, day) as { n: number }
    ).n;
  }

  /** The clips that went out today (UTC) under one permission record. */
  clipsTodayUnder(permissionId: number): number[] {
    const day = this.now().toISOString().slice(0, 10);
    return (
      this.db
        .prepare("SELECT DISTINCT clip_id FROM posts WHERE permission_id = ? AND status != 'failed' AND substr(created_at, 1, 10) = ?")
        .all(permissionId, day) as { clip_id: number }[]
    ).map((r) => r.clip_id);
  }

  setManualViews(id: number, views: number): Post {
    this.get(id);
    this.db
      .prepare("UPDATE posts SET views = ?, views_source = 'manual', views_updated_at = ? WHERE id = ?")
      .run(views, this.now().toISOString(), id);
    this.addReading(id, {});
    return this.get(id);
  }

  /**
   * The Whop steps, tapped by hand in order (Whop has no clipper API): sent, approved, paid.
   * Taking a step back takes the later ones back with it; the first time a step was tapped is kept.
   */
  setWhopStep(id: number, step: WhopStep, on: boolean): Post {
    const post = this.get(id);
    if (post.experiment) throw new ValidationError("Experiment posts are never sent to Whop.");
    const at = { submitted: post.whopSubmittedAt, approved: post.whopApprovedAt, paid: post.whopPaidAt };
    const i = WHOP_STEPS.indexOf(step);
    if (on && i > 0 && !at[WHOP_STEPS[i - 1]!]) {
      throw new ValidationError(i === 1 ? "Mark it sent to Whop first." : "Mark it approved by Whop first.");
    }
    const now = this.now().toISOString();
    const value = (s: WhopStep) => (s === step ? (on ? (at[s] ?? now) : null) : on || WHOP_STEPS.indexOf(s) < i ? at[s] : null);
    this.db
      // Marked sent, even late: the manager says it was submitted, so it no longer counts as a missed window.
      .prepare(
        `UPDATE posts SET whop_submitted_at = ?, whop_approved_at = ?, whop_paid_at = ?${value("submitted") ? ", submit_missed_at = NULL" : ""}${
          // Approved after all, or no longer sent: a rejection no longer stands.
          (step === "approved" && on) || !value("submitted") ? ", whop_rejected_at = NULL, whop_reject_reason = NULL" : ""
        } WHERE id = ?`,
      )
      .run(value("submitted"), value("approved"), value("paid"), id);
    return this.get(id);
  }

  rules(): PostingRules {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'posting_rules'").get() as { value: string } | undefined;
    return row ? { ...DEFAULT_RULES, ...(JSON.parse(row.value) as Partial<PostingRules>) } : DEFAULT_RULES;
  }

  saveRules(rules: PostingRules): PostingRules {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES ('posting_rules', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(rules));
    return this.rules();
  }

  submitHours(): SubmitHours {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'submit_hours'").get() as { value: string } | undefined;
    return row ? { ...this.submitDefaults, ...(JSON.parse(row.value) as Partial<SubmitHours>) } : this.submitDefaults;
  }

  saveSubmitHours(hours: SubmitHours): SubmitHours {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES ('submit_hours', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(hours));
    return this.submitHours();
  }

  /** "I'm busy" until then; null when not snoozed, or the snooze is over. */
  snoozeUntil(): Date | null {
    const value = this.db.prepare("SELECT value FROM settings WHERE key = 'submit_snooze_until'").pluck().get() as string | undefined;
    return value && new Date(value).getTime() > this.now().getTime() ? new Date(value) : null;
  }

  setSnooze(until: Date | null): void {
    if (!until) this.db.prepare("DELETE FROM settings WHERE key = 'submit_snooze_until'").run();
    else {
      this.db
        .prepare("INSERT INTO settings (key, value) VALUES ('submit_snooze_until', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(until.toISOString());
    }
  }

  /** Transcription spend so far, for cost per approved clip. */
  spendUsd(): number {
    return (this.db.prepare("SELECT COALESCE(SUM(transcript_cost_usd), 0) AS s FROM vods").get() as { s: number }).s;
  }
}
