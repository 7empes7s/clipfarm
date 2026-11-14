import type { Platform } from "../../shared/types.js";
import type { AdminClient, AdminClients, PortalDashboard } from "../../shared/service.js";
import type { ClipsRepo } from "../clips/repo.js";
import type { Db } from "../db/index.js";
import type { SourcesRepo } from "../sources/repo.js";
import type { VodsRepo } from "../vods/repo.js";
import type { WorkspacesRepo } from "../workspaces/repo.js";
import { type ClientRecord, ClientsRepo } from "./clients.js";
import { mrrCents, processProblem, UpgradeRequired } from "./limits.js";
import { PlansRepo } from "./plans.js";
import type { StripeApi } from "./stripe.js";

export interface ClientServiceDeps {
  db: Db;
  workspaces: WorkspacesRepo;
  sources: SourcesRepo;
  vods: VodsRepo;
  clips: ClipsRepo;
  stripe: StripeApi;
  now?: () => Date;
}

/**
 * Clipping as a service, the parts that run without a request: the plan check before a client's
 * video is processed, auto-approve, per-view usage sent to Stripe, and the admin's client list.
 */
export class ClientService {
  readonly clients: ClientsRepo;
  readonly plans: PlansRepo;

  constructor(private deps: ClientServiceDeps) {
    this.clients = new ClientsRepo(deps.db, deps.now);
    this.plans = new PlansRepo(deps.db);
  }

  /** Why a client's workspace cannot process another video now; null for our own workspaces. */
  problemFor(workspaceId: number): string | null {
    const client = this.clients.byWorkspace(workspaceId);
    if (!client) return null;
    return processProblem(this.plans.find(client.planId), client.status, this.clients.usage(client));
  }

  /**
   * Run before a video's transcript job: a client over the plan's minutes or clips (or without a
   * plan in force) gets a failed job that says why, never a silent skip or an overage.
   */
  assertVodAllowed(vodId: number): void {
    const vod = this.deps.vods.get(vodId);
    const problem = this.problemFor(this.deps.sources.get(vod.sourceId).workspaceId);
    if (problem) throw new UpgradeRequired(problem);
  }

  /** Approves the waiting clips of clients who switched on auto-approve. Returns how many. */
  autoApprove(): number {
    const auto = new Set(this.clients.list().filter((c) => c.autoApprove).map((c) => c.workspaceId));
    if (auto.size === 0) return 0;
    let n = 0;
    for (const clip of this.deps.clips.list()) {
      if (clip.status !== "pending") continue;
      if (!auto.has(this.deps.sources.get(clip.sourceId).workspaceId)) continue;
      this.deps.clips.review(clip.id, "approve");
      n++;
    }
    return n;
  }

  /**
   * Per-view plans: sends Stripe the views gained since the last report. The identifier holds the
   * running total, so a report repeated after a crash counts once.
   */
  async reportViews(): Promise<number> {
    let sent = 0;
    for (const c of this.clients.list()) {
      const plan = this.plans.find(c.planId);
      if (!plan || plan.per1kViewsCents === null || !c.stripeCustomerId || !["active", "trialing", "past_due"].includes(c.status)) continue;
      const total = this.clients.totalViews(c.workspaceId);
      const delta = total - c.viewsReported;
      if (delta <= 0) continue;
      await this.deps.stripe.meterEvent({ customerId: c.stripeCustomerId, value: delta, identifier: `client-${c.id}-views-${total}` });
      this.clients.update(c.id, { viewsReported: total });
      sent++;
    }
    return sent;
  }

  /** The client's own numbers, nothing of anyone else's. */
  dashboard(client: ClientRecord): PortalDashboard {
    const ids = new Set(this.deps.sources.list(client.workspaceId).map((s) => s.id));
    const clips = this.deps.clips.list().filter((c) => ids.has(c.sourceId));
    const rows = this.deps.db
      .prepare(
        `SELECT p.platform AS platform, p.clip_id AS clipId, COALESCE(p.views, 0) AS views FROM posts p
         WHERE p.clip_id IN (SELECT id FROM clips WHERE source_id IN (SELECT id FROM sources WHERE workspace_id = ?))`,
      )
      .all(client.workspaceId) as { platform: Platform; clipId: number; views: number }[];
    const byPlatform = new Map<Platform, { posts: number; views: number }>();
    const byClip = new Map<number, number>();
    for (const r of rows) {
      const p = byPlatform.get(r.platform) ?? { posts: 0, views: 0 };
      byPlatform.set(r.platform, { posts: p.posts + 1, views: p.views + r.views });
      byClip.set(r.clipId, (byClip.get(r.clipId) ?? 0) + r.views);
    }
    const title = new Map(clips.map((c) => [c.id, c.title]));
    return {
      usage: this.clients.usage(client),
      clipsWaiting: clips.filter((c) => c.status === "pending").length,
      clipsApproved: clips.filter((c) => c.status === "approved").length,
      posts: rows.length,
      views: rows.reduce((s, r) => s + r.views, 0),
      byPlatform: [...byPlatform].map(([platform, v]) => ({ platform, ...v })).sort((a, b) => b.views - a.views),
      topClips: [...byClip]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([id, views]) => ({ id, title: title.get(id) ?? "Clip", views })),
    };
  }

  /** The admin's list: plan, usage, MRR and who is overdue. */
  adminList(): AdminClients {
    const plans = this.plans.list();
    const clients: AdminClient[] = this.clients.list().map((c) => {
      const plan = plans.find((p) => p.id === c.planId) ?? null;
      return {
        id: c.id,
        email: c.email,
        name: c.name,
        workspaceId: c.workspaceId,
        planId: c.planId,
        status: c.status,
        autoApprove: c.autoApprove,
        createdAt: c.createdAt,
        workspaceName: this.deps.workspaces.get(c.workspaceId).name,
        planName: plan?.name ?? null,
        usage: this.clients.usage(c),
        mrrCents: mrrCents(plan, c.status),
        currency: plan?.currency ?? "eur",
        overdue: this.clients.overdue(c),
      };
    });
    const mrr = new Map<string, number>();
    for (const c of clients) if (c.mrrCents > 0) mrr.set(c.currency, (mrr.get(c.currency) ?? 0) + c.mrrCents);
    return { clients, mrr: [...mrr].map(([currency, cents]) => ({ currency, cents })), overdue: clients.filter((c) => c.overdue).length, plans };
  }
}
