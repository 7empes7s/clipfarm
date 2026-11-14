import type { AutopilotInfo, AutopilotRule, AutopilotStep } from "../../shared/publishing.js";
import type { ClipsRepo } from "../clips/repo.js";
import { isActive } from "../sources/permission.js";
import type { SourcesRepo } from "../sources/repo.js";
import { type PlannedStep, parseRule, planRule, type RuleClip } from "./autopilot.js";
import type { AutopilotRepo } from "./autopilotRepo.js";
import type { Publisher } from "./publisher.js";

/** Clips older than this are left alone, so switching a rule on does not post the whole back catalogue. */
export const AUTOPILOT_CLIP_DAYS = 7;

export interface AutopilotDeps {
  repo: AutopilotRepo;
  publisher: Publisher;
  clips: ClipsRepo;
  sources: SourcesRepo;
  now?: () => Date;
}

/**
 * Autopilot: each rule that is on posts its matching clips to its accounts at their next best slot,
 * through the publisher, so every post passes the same permission gate, campaign rules, isolation
 * and platform limits as a tapped one. A campaign post gets its 30-minute submit reminder (#70).
 * A rule in dry run records what it would have done instead.
 */
export class Autopilot {
  private now: () => Date;
  private running = false;

  constructor(private deps: AutopilotDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  info(): AutopilotInfo {
    return { rules: this.deps.repo.list(), recent: this.deps.repo.recent() };
  }

  async create(body: unknown): Promise<AutopilotRule> {
    return this.deps.repo.create(parseRule(body, await this.deps.publisher.knownAccounts()));
  }

  async update(id: number, body: unknown): Promise<AutopilotRule> {
    return this.deps.repo.update(id, parseRule(body, await this.deps.publisher.knownAccounts()));
  }

  remove(id: number): void {
    this.deps.repo.remove(id);
  }

  /** Recent clips a rule may take, with the source's records in force now. */
  private ruleClips(): RuleClip[] {
    const now = this.now();
    const since = now.getTime() - AUTOPILOT_CLIP_DAYS * 86_400_000;
    const permissions = new Map<number, number[]>();
    return this.deps.clips
      .list()
      .filter((c) => (c.status === "pending" || c.status === "approved") && new Date(c.createdAt).getTime() >= since)
      .map((c) => {
        if (!permissions.has(c.sourceId)) permissions.set(c.sourceId, this.deps.sources.get(c.sourceId).permissions.filter((p) => isActive(p, now)).map((p) => p.id));
        return { id: c.id, title: c.title, sourceId: c.sourceId, score: c.score, quality: c.quality, status: c.status, experiment: c.experiment, permissionIds: permissions.get(c.sourceId)! };
      });
  }

  private async plan(rule: AutopilotRule, dryRun: boolean): Promise<PlannedStep[]> {
    const { repo, publisher } = this.deps;
    return planRule({
      rule,
      clips: this.ruleClips(),
      accounts: await publisher.knownAccounts(),
      doneToday: repo.doneToday(rule.id, dryRun),
      handled: repo.handled(rule.id, dryRun),
    });
  }

  /**
   * What the rule would do right now, every check run and nothing sent or stored: the posts with
   * their slot, the clips waiting for an approve tap, and what it skips and why.
   */
  async dryRun(ruleId: number): Promise<AutopilotStep[]> {
    const rule = this.deps.repo.get(ruleId);
    return (await this.carryOut(rule, await this.plan(rule, true), true)).map((s) => ({ ...s, ruleName: rule.name, createdAt: this.now().toISOString() }));
  }

  /** One pass of every rule that is on (run every few minutes). */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const rule of this.deps.repo.list().filter((r) => r.enabled)) {
        const steps = await this.carryOut(rule, await this.plan(rule, rule.dryRun), rule.dryRun);
        // Waiting for a tap and the daily cap are looked at again next time; the rest is done once.
        for (const step of steps) if (step.action !== "wait-approval" && !step.reason.startsWith("The rule's daily cap")) this.deps.repo.log(step);
      }
    } finally {
      this.running = false;
    }
  }

  /** Posts (or, in dry run, plans) the steps that post, one publisher call per clip; the publisher's answer is what is kept. */
  private async carryOut(rule: AutopilotRule, planned: PlannedStep[], dryRun: boolean): Promise<Omit<AutopilotStep, "ruleName" | "createdAt">[]> {
    const { publisher, clips } = this.deps;
    const out: Omit<AutopilotStep, "ruleName" | "createdAt">[] = [];
    const base = (s: PlannedStep) => ({ ruleId: rule.id, clipId: s.clipId, clipTitle: s.clipTitle, accountId: s.accountId, accountName: s.accountName, dryRun });
    for (const s of planned.filter((p) => p.action !== "post")) out.push({ ...base(s), action: s.action, at: null, reason: s.reason });
    const byClip = new Map<number, PlannedStep[]>();
    for (const s of planned.filter((p) => p.action === "post")) byClip.set(s.clipId, [...(byClip.get(s.clipId) ?? []), s]);
    for (const [clipId, steps] of byClip) {
      const ids = steps.map((s) => s.accountId!);
      const named = (id: string) => steps.find((s) => s.accountId === id)!;
      try {
        if (dryRun) {
          const { wouldPost, skipped } = await publisher.dryRun(clipId, ids, null, { bestSlot: true, asApproved: true });
          for (const w of wouldPost) out.push({ ...base(named(w.accountId)), action: "post", at: w.scheduledAt, reason: [named(w.accountId).reason, w.note].filter(Boolean).join(" ") });
          for (const k of skipped) out.push({ ...base(named(k.accountId)), action: "skip", at: null, reason: k.reason });
          continue;
        }
        // The rule says auto (or posts to burners only): it gives the approve tap itself.
        // Only a rule that says auto gives the approve tap. A burner rule (or an experiment clip, which
        // only reaches burners) posts a waiting clip to burners and leaves it waiting in the Inbox, so
        // other rules still wait for the manager's tap before a main account gets it.
        const waiting = clips.get(clipId).status === "pending";
        if (waiting && rule.auto) clips.setStatus(clipId, "approved");
        const { posts, skipped } = await publisher.post(clipId, ids, null, undefined, { bestSlot: true, burnersOnly: waiting && !rule.auto });
        for (const p of posts) {
          const ok = p.status !== "failed";
          out.push({ ...base(named(p.accountId)), action: ok ? "post" : "skip", at: p.scheduledAt, reason: ok ? [named(p.accountId).reason, p.note].filter(Boolean).join(" ") : (p.error ?? "The post failed.") });
        }
        for (const k of skipped) out.push({ ...base(named(k.accountId)), action: "skip", at: null, reason: k.reason });
      } catch (err) {
        for (const s of steps) out.push({ ...base(s), action: "skip", at: null, reason: (err as Error).message });
      }
    }
    return out;
  }
}
