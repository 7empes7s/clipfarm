import { type PayoutRow, type PayoutStatus, postLinkKey } from "../../shared/business.js";
import type { Db } from "../db/index.js";

/** A campaign's reading of one of our posts, from its CSV export. */
export interface Payout {
  url: string;
  postId: number | null;
  viewsCounted: number | null;
  status: PayoutStatus;
  payoutUsd: number | null;
  reason: string;
  importedAt: string;
}

/** Recorded spend in a time range, from clipfarm's own records of every paid call and job. */
export interface RecordedSpend {
  transcriptsUsd: number;
  picksUsd: number;
  geminiEur: number;
  jobSeconds: number;
}

/** Campaign payouts (CSV import) and the spend clipfarm records itself. */
export class BusinessRepo {
  constructor(
    private db: Db,
    private now: () => Date = () => new Date(),
  ) {}

  /**
   * Stores a campaign export: one row per post link, replacing an earlier import of the same link.
   * Approved and paid rows also tick the post's Whop steps (the first time is kept).
   */
  importPayouts(rows: PayoutRow[]): { imported: number; matched: number; unmatched: string[] } {
    const at = this.now().toISOString();
    const posts = this.db.prepare("SELECT id, url FROM posts WHERE url IS NOT NULL").all() as { id: number; url: string }[];
    const byKey = new Map(posts.map((p) => [postLinkKey(p.url), p.id]));
    const unmatched: string[] = [];
    let matched = 0;
    const upsert = this.db.prepare(
      `INSERT INTO campaign_payouts (link_key, url, post_id, views_counted, status, payout_usd, reason, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(link_key) DO UPDATE SET url = excluded.url, post_id = excluded.post_id, views_counted = excluded.views_counted,
         status = excluded.status, payout_usd = excluded.payout_usd, reason = excluded.reason, imported_at = excluded.imported_at`,
    );
    const approve = this.db.prepare("UPDATE posts SET whop_approved_at = COALESCE(whop_approved_at, ?) WHERE id = ?");
    const pay = this.db.prepare("UPDATE posts SET whop_paid_at = COALESCE(whop_paid_at, ?) WHERE id = ?");
    this.db.transaction(() => {
      for (const r of rows) {
        const key = postLinkKey(r.url);
        const postId = byKey.get(key) ?? null;
        if (postId === null) unmatched.push(r.url);
        else matched++;
        upsert.run(key, r.url, postId, r.viewsCounted, r.status, r.payoutUsd, r.reason, at);
        if (postId !== null && (r.status === "approved" || r.status === "paid")) approve.run(at, postId);
        if (postId !== null && r.status === "paid") pay.run(at, postId);
      }
    })();
    return { imported: rows.length, matched, unmatched };
  }

  payouts(): Payout[] {
    const rows = this.db.prepare("SELECT * FROM campaign_payouts ORDER BY imported_at DESC, url").all() as {
      url: string;
      post_id: number | null;
      views_counted: number | null;
      status: PayoutStatus;
      payout_usd: number | null;
      reason: string;
      imported_at: string;
    }[];
    return rows.map((r) => ({
      url: r.url,
      postId: r.post_id,
      viewsCounted: r.views_counted,
      status: r.status,
      payoutUsd: r.payout_usd,
      reason: r.reason,
      importedAt: r.imported_at,
    }));
  }

  /** What clipfarm itself recorded spending between `from` and `to` (ISO times). */
  spend(from: string, to: string): RecordedSpend {
    const sum = (sql: string) => (this.db.prepare(sql).get(from, to) as { s: number | null }).s ?? 0;
    return {
      transcriptsUsd: sum("SELECT SUM(transcript_cost_usd) AS s FROM vods WHERE created_at >= ? AND created_at < ?"),
      picksUsd: sum("SELECT SUM(cost_usd) AS s FROM picks WHERE created_at >= ? AND created_at < ?"),
      geminiEur: sum("SELECT SUM(cost_eur) AS s FROM google_calls WHERE at >= ? AND at < ?"),
      jobSeconds: sum(
        `SELECT SUM((julianday(finished_at) - julianday(started_at)) * 86400) AS s FROM jobs
         WHERE started_at IS NOT NULL AND finished_at IS NOT NULL AND finished_at >= ? AND finished_at < ?`,
      ),
    };
  }
}
