// Clipping as a service: outside creators sign up, pick a plan, pay through Stripe and use the client portal.
import type { Brand } from "./creator.js";
import type { Platform } from "./types.js";

/** Self-serve: they review and post. Managed: we post for them. */
export const PLAN_KINDS = ["self-serve", "managed"] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];

export const PLAN_KIND_LABELS: Record<PlanKind, string> = { "self-serve": "Self-serve", managed: "Managed" };

/** A plan the admin can change. Amounts are in the smallest unit of `currency` (cents). */
export interface Plan {
  id: string;
  name: string;
  kind: PlanKind;
  /** One line for the pricing page. */
  blurb: string;
  currency: string;
  /** Monthly price (a retainer for managed plans); 0 for none. */
  monthlyCents: number;
  /** Managed plans priced on views: the price of 1,000 views; null for none. */
  per1kViewsCents: number | null;
  /** Minutes of video processed a month; null: no limit. */
  minutes: number | null;
  /** Clips made a month; null: no limit. */
  clips: number | null;
  /** Where its clips may post. */
  platforms: Platform[];
  /** Brand templates (0: the brand kit is locked). */
  brandTemplates: number;
  /** Shown on the pricing page and offered at sign-up. */
  active: boolean;
  /** Filled by the Stripe setup (ops). */
  stripePriceId: string | null;
  stripeViewsPriceId: string | null;
}

/** Stripe's subscription states, plus "none" before the first payment. */
export type SubscriptionStatus = "none" | "incomplete" | "incomplete_expired" | "trialing" | "active" | "past_due" | "canceled" | "unpaid" | "paused";

/** What a workspace used in the current billing period. */
export interface Usage {
  periodStart: string;
  periodEnd: string;
  minutes: number;
  clips: number;
  posts: number;
  views: number;
}

export interface Client {
  id: number;
  email: string;
  name: string;
  workspaceId: number;
  planId: string | null;
  status: SubscriptionStatus;
  autoApprove: boolean;
  createdAt: string;
}

export interface Invoice {
  id: string;
  number: string | null;
  status: string;
  amountDue: number;
  amountPaid: number;
  tax: number;
  currency: string;
  hostedUrl: string | null;
  pdfUrl: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  dueAt: string | null;
  createdAt: string;
}

/** What the portal shows on every screen. */
export interface PortalMe {
  client: Client;
  workspace: { id: number; name: string; brand: Brand };
  plan: Plan | null;
  usage: Usage;
  /** Why new videos cannot start now, in plain words; null when they can. */
  blocked: string | null;
  /** A support person looking through the client's eyes: nothing can be changed. */
  readOnly: boolean;
  plans: Plan[];
  /** Demo mode: Stripe, email and Google are stand-ins. */
  demo: boolean;
  /** Platforms the client can connect channels on right now (the team set up the apps). */
  connectable: Platform[];
}

export interface PortalDashboard {
  usage: Usage;
  clipsWaiting: number;
  clipsApproved: number;
  posts: number;
  views: number;
  byPlatform: { platform: Platform; posts: number; views: number }[];
  topClips: { id: number; title: string; views: number }[];
}

export interface AdminClient extends Client {
  workspaceName: string;
  planName: string | null;
  usage: Usage;
  /** Monthly recurring revenue from this client, in cents of `currency`. */
  mrrCents: number;
  currency: string;
  overdue: boolean;
}

export interface AdminClients {
  clients: AdminClient[];
  /** Total MRR per currency. */
  mrr: { currency: string; cents: number }[];
  overdue: number;
  plans: Plan[];
}

/** "€19.00", "$3.00". */
export function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/** "€19.00 a month", "€3.00 per 1,000 views", or both. */
export function planPrice(p: Plan): string {
  const parts: string[] = [];
  if (p.monthlyCents > 0) parts.push(`${money(p.monthlyCents, p.currency)} a month`);
  if (p.per1kViewsCents !== null) parts.push(`${money(p.per1kViewsCents, p.currency)} per 1,000 views`);
  return parts.join(" + ") || "Free";
}
