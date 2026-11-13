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
import { NotFoundError, ValidationError } from "../errors.js";
import { mergeMetrics, offsetFor, parseMetrics } from "../growth/series.js";
import { estimateEarnings } from "./earnings.js";
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
  claim_at: string | null;
  removal_at: string | null;
  strike_at: string | null;
  kind: string;
}

const FLAG_COLUMNS: Record<PostFlag, string> = { claim: "claim_at", removal: "removal_at", strike: "strike_at" };

const SELECT = `
  SELECT p.*, c.title AS clip_title, c.source_id, s.creator_name, m.campaign_url, m.proof_url, m.cpm_rate_usd, m.min_views, m.kind
  FROM posts p
  JOIN clips c ON c.id = p.clip_id
  JOIN sources s ON s.id = c.source_id
  JOIN permissions m ON m.id = p.permission_id`;

function toPost(r: PostRow): Post {
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
    whopPayoutAt: r.whop_approved_at ? new Date(new Date(r.whop_approved_at).getTime() + WHOP_HOLD_DAYS * 86_400_000).toISOString() : null,
    experiment: r.kind === "experiment",
    flags: { claim: r.claim_at, removal: r.removal_at, strike: r.strike_at },
    estimatedEarningsUsd: estimateEarnings(r.views, r.cpm_rate_usd, r.min_views, r.kind === "whop-campaign" ? WHOP_FEE : 0),
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
}

export class PostsRepo {
  constructor(
    readonly db: Db,
    private now: () => Date = () => new Date(),
  ) {}

  insert(p: NewPost): Post {
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO posts (clip_id, permission_id, platform, account_id, account_name, service, external_id, status,
           url, error, caption, scheduled_at, posted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
    return this.get(Number(lastInsertRowid));
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

  /** Times of the account's posts that went out or are still due. */
  takenTimes(accountId: string): Date[] {
    return (
      this.db.prepare("SELECT scheduled_at FROM posts WHERE account_id = ? AND status != 'failed'").all(accountId) as { scheduled_at: string }[]
    ).map((r) => new Date(r.scheduled_at));
  }

  /** When this clip went out or is due, per account: two accounts never carry it at the same time. */
  clipTimes(clipId: number): { accountId: string; at: Date }[] {
    return (
      this.db.prepare("SELECT account_id, scheduled_at FROM posts WHERE clip_id = ? AND status != 'failed'").all(clipId) as {
        account_id: string;
        scheduled_at: string;
      }[]
    ).map((r) => ({ accountId: r.account_id, at: new Date(r.scheduled_at) }));
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
      .prepare("UPDATE posts SET whop_submitted_at = ?, whop_approved_at = ?, whop_paid_at = ? WHERE id = ?")
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

  /** Transcription spend so far, for cost per approved clip. */
  spendUsd(): number {
    return (this.db.prepare("SELECT COALESCE(SUM(transcript_cost_usd), 0) AS s FROM vods").get() as { s: number }).s;
  }
}
