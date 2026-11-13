import type { CampaignStatus, GrowthCampaign, GrowthCampaignInput, GrowthDefaults, Recommendation, RecommendationStatus } from "../../shared/growth.js";
import type { Db } from "../db/index.js";
import { NotFoundError, ValidationError } from "../errors.js";
import type { ProposedChange } from "./report.js";

interface CampaignRow {
  id: number;
  name: string;
  hypothesis: string;
  config: string;
  status: CampaignStatus;
  paused_reason: string | null;
  note: string | null;
  started_at: string | null;
  resumed_at: string | null;
  ends_at: string | null;
  created_at: string;
}

interface RecRow {
  id: number;
  campaign_id: number;
  campaign_name: string;
  text: string;
  detail: string;
  change: string;
  status: RecommendationStatus;
  prev: string | null;
  created_at: string;
}

type Config = Omit<GrowthCampaignInput, "name" | "hypothesis">;

function toCampaign(r: CampaignRow): GrowthCampaign {
  return {
    ...(JSON.parse(r.config) as Config),
    id: r.id,
    name: r.name,
    hypothesis: r.hypothesis,
    status: r.status,
    pausedReason: r.paused_reason,
    note: r.note,
    startedAt: r.started_at,
    endsAt: r.ends_at,
    createdAt: r.created_at,
  };
}

function toRec(r: RecRow): Recommendation {
  return {
    id: r.id,
    campaignId: r.campaign_id,
    campaignName: r.campaign_name,
    text: r.text,
    detail: r.detail,
    change: JSON.parse(r.change) as Partial<GrowthDefaults>,
    status: r.status,
    createdAt: r.created_at,
  };
}

export const NO_DEFAULTS: GrowthDefaults = { clipMinSec: null, clipMaxSec: null, postTimes: [], boostWords: [] };

const DAY = 24 * 3600_000;
const REC_SELECT = "SELECT r.*, c.name AS campaign_name FROM growth_recommendations r JOIN growth_campaigns c ON c.id = r.campaign_id";

/** Test campaigns, which post belongs to which variant, recommendations and the defaults they change. */
export class GrowthRepo {
  constructor(
    private db: Db,
    private now: () => Date = () => new Date(),
  ) {}

  private config(input: GrowthCampaignInput): string {
    const { name: _name, hypothesis: _hypothesis, ...config } = input;
    return JSON.stringify(config);
  }

  create(input: GrowthCampaignInput): GrowthCampaign {
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO growth_campaigns (name, hypothesis, config, created_at) VALUES (?, ?, ?, ?)")
      .run(input.name, input.hypothesis, this.config(input), this.now().toISOString());
    return this.get(Number(lastInsertRowid));
  }

  get(id: number): GrowthCampaign {
    const row = this.db.prepare("SELECT * FROM growth_campaigns WHERE id = ?").get(id) as CampaignRow | undefined;
    if (!row) throw new NotFoundError("That campaign was not found.");
    return toCampaign(row);
  }

  list(): GrowthCampaign[] {
    return (this.db.prepare("SELECT * FROM growth_campaigns ORDER BY id DESC").all() as CampaignRow[]).map(toCampaign);
  }

  /** A test that has started keeps its setup, so its posts stay comparable. */
  update(id: number, input: GrowthCampaignInput): GrowthCampaign {
    if (this.get(id).status !== "draft") throw new ValidationError("A campaign that has started cannot be changed. Stop it and make a new one.");
    this.db.prepare("UPDATE growth_campaigns SET name = ?, hypothesis = ?, config = ? WHERE id = ?").run(input.name, input.hypothesis, this.config(input), id);
    return this.get(id);
  }

  remove(id: number): void {
    if (this.get(id).status !== "draft") throw new ValidationError("Only a draft can be deleted: a campaign that ran is the record of its posts.");
    this.db.prepare("DELETE FROM growth_campaigns WHERE id = ?").run(id);
  }

  /** Starts a draft (its days count from now) or resumes a paused campaign (its end date stays). */
  start(id: number): GrowthCampaign {
    const c = this.get(id);
    const now = this.now();
    if (c.status === "draft") {
      this.db
        .prepare("UPDATE growth_campaigns SET status = 'running', started_at = ?, resumed_at = ?, ends_at = ? WHERE id = ?")
        .run(now.toISOString(), now.toISOString(), new Date(now.getTime() + c.durationDays * DAY).toISOString(), id);
    } else if (c.status === "paused") {
      this.db.prepare("UPDATE growth_campaigns SET status = 'running', paused_reason = NULL, resumed_at = ? WHERE id = ?").run(now.toISOString(), id);
    } else {
      throw new ValidationError(c.status === "running" ? "The campaign is already running." : "A finished campaign cannot be started again. Make a new one.");
    }
    return this.get(id);
  }

  pause(id: number, reason: string | null = null): GrowthCampaign {
    if (this.get(id).status !== "running") throw new ValidationError("Only a running campaign can be paused.");
    this.db.prepare("UPDATE growth_campaigns SET status = 'paused', paused_reason = ? WHERE id = ?").run(reason, id);
    return this.get(id);
  }

  finish(id: number): GrowthCampaign {
    const c = this.get(id);
    if (c.status !== "running" && c.status !== "paused") throw new ValidationError("Only a campaign that has started can be stopped.");
    this.db.prepare("UPDATE growth_campaigns SET status = 'finished', paused_reason = NULL WHERE id = ?").run(id);
    return this.get(id);
  }

  setNote(id: number, note: string | null): void {
    this.db.prepare("UPDATE growth_campaigns SET note = ? WHERE id = ?").run(note, id);
  }

  /** The first strike recorded on one of the campaign's posts since it was last started. */
  strikeSinceStart(id: number): { clipTitle: string; accountName: string; at: string } | null {
    const row = this.db
      .prepare(
        `SELECT c.title AS clipTitle, p.account_name AS accountName, p.strike_at AS at
         FROM growth_posts g JOIN posts p ON p.id = g.post_id JOIN clips c ON c.id = p.clip_id
         JOIN growth_campaigns k ON k.id = g.campaign_id
         WHERE g.campaign_id = ? AND p.strike_at IS NOT NULL AND p.strike_at >= COALESCE(k.resumed_at, k.started_at)
         ORDER BY p.strike_at LIMIT 1`,
      )
      .get(id) as { clipTitle: string; accountName: string; at: string } | undefined;
    return row ?? null;
  }

  link(campaignId: number, slot: string, postId: number, variantKey: string): void {
    this.db.prepare("INSERT INTO growth_posts (campaign_id, slot, post_id, variant_key) VALUES (?, ?, ?, ?)").run(campaignId, slot, postId, variantKey);
  }

  /** The campaign's posts: which slot each filled and under which variant. */
  links(campaignId: number): { slot: string; postId: number; variantKey: string }[] {
    return this.db
      .prepare("SELECT slot, post_id AS postId, variant_key AS variantKey FROM growth_posts WHERE campaign_id = ? ORDER BY post_id")
      .all(campaignId) as { slot: string; postId: number; variantKey: string }[];
  }

  /** What each clip cost to make: the pick's AI share plus its compute time at `computeUsdPerHour`. */
  clipCosts(computeUsdPerHour: number): Map<number, number> {
    const rows = this.db.prepare("SELECT clip_id, cost_usd, steps FROM picks WHERE clip_id IS NOT NULL").all() as {
      clip_id: number;
      cost_usd: number;
      steps: string;
    }[];
    return new Map(
      rows.map((r) => {
        const ms = (JSON.parse(r.steps) as { ms: number }[]).reduce((s, x) => s + x.ms, 0);
        return [r.clip_id, r.cost_usd + (ms / 3600_000) * computeUsdPerHour];
      }),
    );
  }

  defaults(): GrowthDefaults {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'growth_defaults'").get() as { value: string } | undefined;
    return row ? { ...NO_DEFAULTS, ...(JSON.parse(row.value) as Partial<GrowthDefaults>) } : NO_DEFAULTS;
  }

  private saveDefaults(d: GrowthDefaults): void {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES ('growth_defaults', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(d));
  }

  /** Keeps a proposed change once per campaign and winner; a dismissed one is not offered again. */
  propose(campaignId: number, p: ProposedChange): void {
    this.db
      .prepare("INSERT OR IGNORE INTO growth_recommendations (campaign_id, variant_key, text, detail, change, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(campaignId, p.variantKey, p.text, p.detail, JSON.stringify(p.change), this.now().toISOString());
  }

  private rec(id: number): RecRow {
    const row = this.db.prepare(`${REC_SELECT} WHERE r.id = ?`).get(id) as RecRow | undefined;
    if (!row) throw new NotFoundError("That recommendation was not found.");
    return row;
  }

  /** Open and applied recommendations, newest first. */
  recommendations(): Recommendation[] {
    return (this.db.prepare(`${REC_SELECT} WHERE r.status != 'dismissed' ORDER BY r.id DESC`).all() as RecRow[]).map(toRec);
  }

  recommendationFor(campaignId: number): Recommendation | null {
    const row = this.db.prepare(`${REC_SELECT} WHERE r.campaign_id = ? AND r.status != 'dismissed' ORDER BY r.id DESC LIMIT 1`).get(campaignId) as
      | RecRow
      | undefined;
    return row ? toRec(row) : null;
  }

  /** Changes the defaults the recommendation names, and remembers what they were for Undo. */
  apply(id: number): Recommendation {
    const row = this.rec(id);
    if (row.status !== "open") throw new ValidationError(row.status === "applied" ? "That is already applied." : "That recommendation was dismissed.");
    const change = JSON.parse(row.change) as Partial<GrowthDefaults>;
    const before = this.defaults();
    const prev = Object.fromEntries((Object.keys(change) as (keyof GrowthDefaults)[]).map((k) => [k, before[k]]));
    const next = { ...before, ...change };
    // Words to favour add up: a second test must not wipe what the first one found.
    if (change.boostWords) next.boostWords = [...new Set([...before.boostWords, ...change.boostWords])];
    this.db.transaction(() => {
      this.saveDefaults(next);
      this.db.prepare("UPDATE growth_recommendations SET status = 'applied', prev = ? WHERE id = ?").run(JSON.stringify(prev), id);
    })();
    return toRec(this.rec(id));
  }

  /** Puts the defaults back to what they were before Apply. */
  undo(id: number): Recommendation {
    const row = this.rec(id);
    if (row.status !== "applied" || !row.prev) throw new ValidationError("There is nothing to undo: this was not applied.");
    this.db.transaction(() => {
      this.saveDefaults({ ...this.defaults(), ...(JSON.parse(row.prev!) as Partial<GrowthDefaults>) });
      this.db.prepare("UPDATE growth_recommendations SET status = 'open', prev = NULL WHERE id = ?").run(id);
    })();
    return toRec(this.rec(id));
  }

  dismiss(id: number): void {
    if (this.rec(id).status === "applied") throw new ValidationError("Undo it first, then dismiss it.");
    this.db.prepare("UPDATE growth_recommendations SET status = 'dismissed' WHERE id = ?").run(id);
  }
}
