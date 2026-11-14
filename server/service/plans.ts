import type { Db } from "../db/index.js";
import { PLATFORMS, type Platform } from "../../shared/types.js";
import { PLAN_KINDS, type Plan, type PlanKind } from "../../shared/service.js";
import { NotFoundError, ValidationError } from "../errors.js";

/**
 * The plans every install starts with. Self-serve plans are sold by minutes processed (like the
 * self-serve clippers); managed plans by views ($2-5 per 1,000 at agencies) or a monthly retainer.
 * The admin changes them in the app; the Stripe setup (ops) makes their prices.
 */
export const DEFAULT_PLANS: Plan[] = [
  {
    id: "starter",
    name: "Starter",
    kind: "self-serve",
    blurb: "For one channel: two hours of video a month into clips you review and post.",
    currency: "eur",
    monthlyCents: 1900,
    per1kViewsCents: null,
    minutes: 120,
    clips: 60,
    platforms: ["youtube", "tiktok"],
    brandTemplates: 1,
    active: true,
    stripePriceId: null,
    stripeViewsPriceId: null,
  },
  {
    id: "pro",
    name: "Pro",
    kind: "self-serve",
    blurb: "Ten hours a month, every platform, and auto-approve when you trust the picks.",
    currency: "eur",
    monthlyCents: 4900,
    per1kViewsCents: null,
    minutes: 600,
    clips: 300,
    platforms: ["youtube", "tiktok", "instagram", "x", "facebook", "threads", "linkedin", "bluesky"],
    brandTemplates: 3,
    active: true,
    stripePriceId: null,
    stripeViewsPriceId: null,
  },
  {
    id: "managed-views",
    name: "Managed, per view",
    kind: "managed",
    blurb: "We clip and post on our channels for you. You pay for the views the clips get.",
    currency: "eur",
    monthlyCents: 0,
    per1kViewsCents: 300,
    minutes: null,
    clips: null,
    platforms: ["youtube", "tiktok", "instagram"],
    brandTemplates: 1,
    active: true,
    stripePriceId: null,
    stripeViewsPriceId: null,
  },
  {
    id: "managed-retainer",
    name: "Managed, monthly",
    kind: "managed",
    blurb: "We clip and post for you every day for a fixed monthly fee.",
    currency: "eur",
    monthlyCents: 150000,
    per1kViewsCents: null,
    minutes: null,
    clips: null,
    platforms: ["youtube", "tiktok", "instagram"],
    brandTemplates: 1,
    active: true,
    stripePriceId: null,
    stripeViewsPriceId: null,
  },
];

const limit = (v: unknown, label: string): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 1_000_000) throw new ValidationError(`${label} must be a whole number, or empty for no limit.`);
  return n;
};

const cents = (v: unknown, label: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 100_000_000) throw new ValidationError(`${label} must be a whole number of cents.`);
  return n;
};

/** Checks a plan from the admin screen. The Stripe ids are kept from `old`: only the setup writes them. */
export function parsePlan(body: unknown, old: Plan | null): Plan {
  const b = (body ?? {}) as Record<string, unknown>;
  const id = old?.id ?? (typeof b.id === "string" ? b.id.trim().toLowerCase() : "");
  if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(id)) throw new ValidationError("Give the plan a short id: letters, digits and dashes.");
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name || name.length > 40) throw new ValidationError("Give the plan a name under 40 characters.");
  if (!PLAN_KINDS.includes(b.kind as PlanKind)) throw new ValidationError("Pick self-serve or managed.");
  const blurb = typeof b.blurb === "string" ? b.blurb.trim().slice(0, 200) : "";
  const currency = typeof b.currency === "string" && b.currency ? b.currency.trim().toLowerCase() : "eur";
  if (!/^[a-z]{3}$/.test(currency)) throw new ValidationError("The currency is three letters, like eur.");
  const platforms = Array.isArray(b.platforms) ? b.platforms : [];
  if (platforms.length === 0 || platforms.some((p) => !PLATFORMS.includes(p as Platform))) throw new ValidationError("Tick at least one platform.");
  const per1k = b.per1kViewsCents === null || b.per1kViewsCents === undefined || b.per1kViewsCents === "" ? null : cents(b.per1kViewsCents, "The price per 1,000 views");
  const monthlyCents = cents(b.monthlyCents ?? 0, "The monthly price");
  if (monthlyCents === 0 && per1k === null) throw new ValidationError("Set a monthly price, a price per 1,000 views, or both.");
  const brandTemplates = limit(b.brandTemplates ?? 1, "Brand templates") ?? 1;
  return {
    id,
    name,
    kind: b.kind as PlanKind,
    blurb,
    currency,
    monthlyCents,
    per1kViewsCents: per1k,
    minutes: limit(b.minutes, "Minutes a month"),
    clips: limit(b.clips, "Clips a month"),
    platforms: [...new Set(platforms as Platform[])],
    brandTemplates,
    active: b.active !== false,
    // A new price means new Stripe prices: the setup makes them on its next run.
    stripePriceId: old && old.monthlyCents === monthlyCents && old.currency === currency ? old.stripePriceId : null,
    stripeViewsPriceId: old && old.per1kViewsCents === per1k && old.currency === currency ? old.stripeViewsPriceId : null,
  };
}

export class PlansRepo {
  constructor(private db: Db) {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM service_plans").get() as { n: number };
    if (n === 0) DEFAULT_PLANS.forEach((p, i) => this.write(p, i));
  }

  private write(p: Plan, position: number): void {
    this.db
      .prepare("INSERT INTO service_plans (id, position, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
      .run(p.id, position, JSON.stringify(p));
  }

  list(): Plan[] {
    return (this.db.prepare("SELECT data FROM service_plans ORDER BY position, id").all() as { data: string }[]).map((r) => JSON.parse(r.data) as Plan);
  }

  find(id: string | null): Plan | null {
    if (!id) return null;
    const row = this.db.prepare("SELECT data FROM service_plans WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Plan) : null;
  }

  get(id: string): Plan {
    const plan = this.find(id);
    if (!plan) throw new NotFoundError("That plan was not found.");
    return plan;
  }

  /** The plan a Stripe price belongs to. */
  byPrice(priceId: string): Plan | null {
    return this.list().find((p) => p.stripePriceId === priceId || p.stripeViewsPriceId === priceId) ?? null;
  }

  save(body: unknown, id?: string): Plan {
    const old = id ? this.get(id) : null;
    if (!old && this.find(String((body as { id?: unknown })?.id ?? "").trim().toLowerCase())) throw new ValidationError("There is already a plan with that id.");
    const plan = parsePlan(body, old);
    const position = old ? 0 : (this.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS n FROM service_plans").get() as { n: number }).n;
    this.write(plan, position);
    return plan;
  }

  /** Written by the Stripe setup only. */
  setStripeIds(id: string, ids: { stripePriceId: string | null; stripeViewsPriceId: string | null }): void {
    const plan = this.get(id);
    this.write({ ...plan, ...ids }, 0);
  }
}
