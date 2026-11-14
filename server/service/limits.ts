import type { Platform } from "../../shared/types.js";
import { PLATFORM_LABELS } from "../../shared/types.js";
import type { Plan, SubscriptionStatus, Usage } from "../../shared/service.js";
import { HttpError } from "../errors.js";

/**
 * A plan limit was reached, or there is no plan in force. 402 so the portal shows "Upgrade" (or
 * "Pick a plan", "Update your card") instead of failing quietly.
 */
export class UpgradeRequired extends HttpError {
  constructor(message: string) {
    super(402, message);
  }
}

/** Stripe states in which the plan is in force. */
const IN_FORCE: SubscriptionStatus[] = ["active", "trialing"];

/** Why a client's plan does not let anything new start, or null when it does. */
export function planProblem(plan: Plan | null, status: SubscriptionStatus): string | null {
  if (!plan || status === "none" || status === "incomplete" || status === "incomplete_expired") return "Pick a plan to start making clips.";
  if (status === "past_due" || status === "unpaid") return "Your last payment did not go through. Update your card in Billing to carry on.";
  if (!IN_FORCE.includes(status)) return "Your plan has ended. Pick a plan to carry on.";
  return null;
}

/** Why a new video cannot be processed now (plan, minutes or clips used up), or null. */
export function processProblem(plan: Plan | null, status: SubscriptionStatus, usage: Usage): string | null {
  const problem = planProblem(plan, status);
  if (problem || !plan) return problem;
  if (plan.minutes !== null && usage.minutes >= plan.minutes) {
    return `You used all ${plan.minutes} minutes of ${plan.name} this month. Upgrade for more, or wait until ${usage.periodEnd.slice(0, 10)}.`;
  }
  if (plan.clips !== null && usage.clips >= plan.clips) {
    return `You made all ${plan.clips} clips of ${plan.name} this month. Upgrade for more, or wait until ${usage.periodEnd.slice(0, 10)}.`;
  }
  return null;
}

/** Throws UpgradeRequired when a new video cannot start. */
export function assertCanProcess(plan: Plan | null, status: SubscriptionStatus, usage: Usage): void {
  const problem = processProblem(plan, status, usage);
  if (problem) throw new UpgradeRequired(problem);
}

/** Throws UpgradeRequired when the plan does not post to that platform. */
export function assertPlatform(plan: Plan | null, status: SubscriptionStatus, platform: Platform): void {
  const problem = planProblem(plan, status);
  if (problem || !plan) throw new UpgradeRequired(problem ?? "Pick a plan first.");
  if (!plan.platforms.includes(platform)) throw new UpgradeRequired(`${plan.name} does not post to ${PLATFORM_LABELS[platform]}. Upgrade to add it.`);
}

/** Throws UpgradeRequired when the plan has no brand kit. */
export function assertBrand(plan: Plan | null, status: SubscriptionStatus): void {
  const problem = planProblem(plan, status);
  if (problem || !plan) throw new UpgradeRequired(problem ?? "Pick a plan first.");
  if (plan.brandTemplates < 1) throw new UpgradeRequired(`${plan.name} has no brand kit. Upgrade to add your colour and sign-off.`);
}

/** What a client pays a month for the plan, without metered views (cents). */
export function mrrCents(plan: Plan | null, status: SubscriptionStatus): number {
  return plan && (IN_FORCE.includes(status) || status === "past_due") ? plan.monthlyCents : 0;
}

/** The calendar month around `now` (UTC), used until Stripe sends a billing period. */
export function monthPeriod(now: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

/**
 * The billing period that holds `now`: Stripe's when it is current, else the calendar month.
 * A period that already ended (a webhook was missed) rolls forward by whole months.
 */
export function currentPeriod(start: string | null, end: string | null, now: Date): { start: Date; end: Date } {
  if (!start || !end) return monthPeriod(now);
  let s = new Date(start);
  let e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e <= s || s > now) return monthPeriod(now);
  for (let i = 0; e <= now && i < 120; i++) {
    s = e;
    e = new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth() + 1, e.getUTCDate(), e.getUTCHours(), e.getUTCMinutes(), e.getUTCSeconds()));
  }
  return { start: s, end: e };
}
