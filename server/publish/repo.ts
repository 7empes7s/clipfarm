import type { Db } from "../db/index.js";
import type { Platform, Post, PostingRules, PostingServiceName, PostStatus } from "../../shared/types.js";
import { NotFoundError } from "../errors.js";
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
}

const SELECT = `
  SELECT p.*, c.title AS clip_title, c.source_id, s.creator_name, m.campaign_url, m.proof_url, m.cpm_rate_usd, m.min_views
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
    estimatedEarningsUsd: estimateEarnings(r.views, r.cpm_rate_usd, r.min_views),
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
    private db: Db,
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
    if (sets.length === 0) return;
    this.db
      .prepare(`UPDATE posts SET ${sets.join(", ")} WHERE service = ? AND external_id = ? AND account_id = ?`)
      .run(...args, service, u.externalId, u.accountId);
  }

  /** Times of the account's posts that went out or are still due. */
  takenTimes(accountId: string): Date[] {
    return (
      this.db.prepare("SELECT scheduled_at FROM posts WHERE account_id = ? AND status != 'failed'").all(accountId) as { scheduled_at: string }[]
    ).map((r) => new Date(r.scheduled_at));
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
    return this.get(id);
  }

  markWhopSubmitted(id: number): Post {
    this.get(id);
    this.db.prepare("UPDATE posts SET whop_submitted_at = ? WHERE id = ?").run(this.now().toISOString(), id);
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
