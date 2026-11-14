import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Invoice, Plan, SubscriptionStatus } from "../../shared/service.js";
import { HttpError, ValidationError } from "../errors.js";
import type { ClientRecord, ClientsRepo } from "./clients.js";
import type { PlansRepo } from "./plans.js";

/** The Stripe API version every call and the webhook endpoint use. */
export const STRIPE_API_VERSION = "2025-03-31.basil";
/** The billing meter per-view plans report to. */
export const VIEWS_METER_EVENT = "clipfarm_views";
/** Where Stripe sends its events (open to the internet; only signed events count). */
export const STRIPE_WEBHOOK_PATH = "/api/stripe/webhook";
/** The events the webhook endpoint asks for. */
export const STRIPE_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.created",
  "invoice.finalized",
  "invoice.updated",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.voided",
  "invoice.marked_uncollectible",
] as const;
/** How old a signed event may be (Stripe's own default). */
const TOLERANCE_SEC = 300;

/**
 * Checks a Stripe-Signature header the way Stripe documents it: t=<time>,v1=<hex HMAC-SHA256 of
 * "<t>.<raw body>" with the endpoint's secret>, within five minutes. Anything else is refused.
 */
export function verifyStripeSignature(payload: Buffer | string, header: unknown, secret: string, nowSec: number): boolean {
  if (typeof header !== "string" || !secret) return false;
  let t: number | null = null;
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2).map((s) => s.trim());
    if (k === "t" && /^\d+$/.test(v ?? "")) t = Number(v);
    if (k === "v1" && /^[0-9a-f]{64}$/.test(v ?? "")) sigs.push(v!);
  }
  if (t === null || sigs.length === 0 || Math.abs(nowSec - t) > TOLERANCE_SEC) return false;
  const expected = createHmac("sha256", secret).update(`${t}.`).update(payload).digest();
  return sigs.some((s) => timingSafeEqual(Buffer.from(s, "hex"), expected));
}

/** A Stripe-Signature header for a payload: used by the fake Checkout and by tests. */
export function signStripePayload(payload: string, secret: string, nowSec: number): string {
  return `t=${nowSec},v1=${createHmac("sha256", secret).update(`${nowSec}.${payload}`).digest("hex")}`;
}

export interface StripeEvent {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
}

/** The calls clipfarm makes to Stripe. Card data never passes through: Checkout and the portal are Stripe's pages. */
export interface StripeApi {
  createCustomer(input: { email: string; name: string; clientId: number }): Promise<{ id: string }>;
  createCheckout(input: { customerId: string; plan: Plan; clientId: number; successUrl: string; cancelUrl: string }): Promise<{ id: string; url: string }>;
  createPortal(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  /** Views for per-view plans; `identifier` makes a repeat of the same report count once. */
  meterEvent(input: { customerId: string; value: number; identifier: string }): Promise<void>;
}

/** A form-encoded call to the Stripe API with the secret key. The key is only ever in the header. */
export async function stripeCall<T>(
  key: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string | number | boolean> = {},
  doFetch: typeof fetch = fetch,
): Promise<T> {
  const body = new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)])).toString();
  const url = method === "GET" && body ? `https://api.stripe.com/v1${path}?${body}` : `https://api.stripe.com/v1${path}`;
  const res = await doFetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Stripe-Version": STRIPE_API_VERSION,
      ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: method === "POST" ? body : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const answer = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new HttpError(502, `Stripe answered ${res.status}${answer.error?.message ? `: ${answer.error.message}` : ""}`);
  return answer;
}

export class HttpStripe implements StripeApi {
  constructor(
    private key: () => string | undefined,
    private doFetch: typeof fetch = fetch,
  ) {}

  private call<T>(method: "GET" | "POST", path: string, params?: Record<string, string | number | boolean>): Promise<T> {
    const key = this.key();
    if (!key) throw new HttpError(503, "Payments are not set up yet. Try again later.");
    return stripeCall<T>(key, method, path, params, this.doFetch);
  }

  async createCustomer({ email, name, clientId }: { email: string; name: string; clientId: number }) {
    return this.call<{ id: string }>("POST", "/customers", { email, name, "metadata[client_id]": clientId });
  }

  async createCheckout({ customerId, plan, clientId, successUrl, cancelUrl }: { customerId: string; plan: Plan; clientId: number; successUrl: string; cancelUrl: string }) {
    const lines = [plan.stripePriceId, plan.stripeViewsPriceId].filter((p): p is string => !!p);
    const wanted = (plan.monthlyCents > 0 ? 1 : 0) + (plan.per1kViewsCents !== null ? 1 : 0);
    if (lines.length < wanted) throw new ValidationError("This plan is not ready for payment yet. We have to finish setting it up: try another plan or write to us.");
    const params: Record<string, string | number | boolean> = {
      mode: "subscription",
      customer: customerId,
      client_reference_id: clientId,
      success_url: successUrl,
      cancel_url: cancelUrl,
      "metadata[plan_id]": plan.id,
      "subscription_data[metadata][plan_id]": plan.id,
      "subscription_data[metadata][client_id]": clientId,
      // VAT: Stripe Tax works it out from the address Checkout asks for, and takes VAT numbers.
      "automatic_tax[enabled]": true,
      "customer_update[address]": "auto",
      "customer_update[name]": "auto",
      "tax_id_collection[enabled]": true,
      billing_address_collection: "required",
    };
    lines.forEach((price, i) => {
      params[`line_items[${i}][price]`] = price;
      // A metered price takes no quantity: Stripe counts the views.
      if (price === plan.stripePriceId) params[`line_items[${i}][quantity]`] = 1;
    });
    const s = await this.call<{ id: string; url: string }>("POST", "/checkout/sessions", params);
    return { id: s.id, url: s.url };
  }

  async createPortal({ customerId, returnUrl }: { customerId: string; returnUrl: string }) {
    const s = await this.call<{ url: string }>("POST", "/billing_portal/sessions", { customer: customerId, return_url: returnUrl });
    return { url: s.url };
  }

  async meterEvent({ customerId, value, identifier }: { customerId: string; value: number; identifier: string }) {
    await this.call("POST", "/billing/meter_events", { event_name: VIEWS_METER_EVENT, "payload[stripe_customer_id]": customerId, "payload[value]": value, identifier });
  }
}

/**
 * Stripe for tests and demo mode: nothing leaves the server. Checkout is a page of ours
 * (/portal/fake-checkout/<id>) whose "Pay" sends the same signed events Stripe would.
 */
export class FakeStripe implements StripeApi {
  readonly sessions = new Map<string, { clientId: number; planId: string; customerId: string; done: boolean }>();
  readonly meterEvents: { customerId: string; value: number; identifier: string }[] = [];
  private n = 0;

  constructor(private now: () => Date = () => new Date()) {}

  private id(prefix: string): string {
    return `${prefix}_test_${++this.n}${randomBytes(4).toString("hex")}`;
  }

  async createCustomer() {
    return { id: this.id("cus") };
  }

  async createCheckout({ customerId, plan, clientId }: { customerId: string; plan: Plan; clientId: number }) {
    const id = this.id("cs");
    this.sessions.set(id, { clientId, planId: plan.id, customerId, done: false });
    return { id, url: `/portal/fake-checkout/${id}` };
  }

  async createPortal() {
    return { url: "/portal/fake-billing" };
  }

  async meterEvent(e: { customerId: string; value: number; identifier: string }) {
    if (!this.meterEvents.some((m) => m.identifier === e.identifier)) this.meterEvents.push(e);
  }

  private event(type: string, object: Record<string, unknown>): StripeEvent {
    return { id: this.id("evt"), type, created: Math.floor(this.now().getTime() / 1000), data: { object } };
  }

  /** "Pay" on the fake Checkout: what Stripe sends after a paid subscription checkout. */
  completeCheckout(sessionId: string, plan: Plan): StripeEvent[] {
    const s = this.sessions.get(sessionId);
    if (!s || s.done) return [];
    s.done = true;
    const now = Math.floor(this.now().getTime() / 1000);
    const end = Math.floor(new Date(new Date(now * 1000).setUTCMonth(new Date(now * 1000).getUTCMonth() + 1)).getTime() / 1000);
    const sub = this.id("sub");
    // Luxembourg VAT (17 %) on top, the way Stripe Tax adds it for a customer there.
    const tax = Math.round(plan.monthlyCents * 0.17);
    const invoiceId = this.id("in");
    const subscription = { id: sub, customer: s.customerId, status: "active", metadata: { plan_id: plan.id }, current_period_start: now, current_period_end: end, items: { data: [] } };
    return [
      this.event("checkout.session.completed", { id: sessionId, client_reference_id: String(s.clientId), customer: s.customerId, subscription: sub, payment_status: "paid", metadata: { plan_id: plan.id } }),
      this.event("customer.subscription.created", subscription),
      this.event("invoice.paid", {
        id: invoiceId,
        customer: s.customerId,
        number: `TEST-${String(this.n).padStart(4, "0")}`,
        status: "paid",
        amount_due: plan.monthlyCents + tax,
        amount_paid: plan.monthlyCents + tax,
        total_taxes: [{ amount: tax }],
        currency: plan.currency,
        hosted_invoice_url: `/portal/fake-invoice/${invoiceId}`,
        invoice_pdf: null,
        period_start: now,
        period_end: end,
        due_date: null,
        created: now,
      }),
    ];
  }

  /** "Cancel" on the fake billing page. */
  cancel(client: ClientRecord): StripeEvent[] {
    if (!client.stripeSubscriptionId) return [];
    return [this.event("customer.subscription.deleted", { id: client.stripeSubscriptionId, customer: client.stripeCustomerId, status: "canceled", metadata: { plan_id: client.planId } })];
  }
}

const iso = (sec: unknown): string | null => (typeof sec === "number" && sec > 0 ? new Date(sec * 1000).toISOString() : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const STATUSES: SubscriptionStatus[] = ["incomplete", "incomplete_expired", "trialing", "active", "past_due", "canceled", "unpaid", "paused"];

function toInvoice(o: Record<string, unknown>): Invoice {
  const taxes = Array.isArray(o.total_taxes) ? (o.total_taxes as { amount?: number }[]).reduce((s, t) => s + (t.amount ?? 0), 0) : Number(o.tax ?? 0) || 0;
  return {
    id: String(o.id),
    number: str(o.number),
    status: str(o.status) ?? "draft",
    amountDue: Number(o.amount_due ?? 0) || 0,
    amountPaid: Number(o.amount_paid ?? 0) || 0,
    tax: taxes,
    currency: str(o.currency) ?? "eur",
    hostedUrl: str(o.hosted_invoice_url),
    pdfUrl: str(o.invoice_pdf),
    periodStart: iso(o.period_start),
    periodEnd: iso(o.period_end),
    dueAt: iso(o.due_date),
    createdAt: iso(o.created) ?? new Date().toISOString(),
  };
}

export type EventOutcome = "applied" | "duplicate" | "ignored";

/**
 * Applies one verified Stripe event to the client it is about. Each event id counts once (Stripe
 * retries and sometimes repeats), and a subscription event older than the last one applied
 * changes nothing (Stripe does not promise the order). All in one transaction: an event that
 * fails is not marked, so Stripe's retry applies it.
 */
export function applyStripeEvent(event: StripeEvent, deps: { clients: ClientsRepo; plans: PlansRepo }): EventOutcome {
  const { clients, plans } = deps;
  const o = event.data?.object ?? {};
  return clients.transaction(() => {
    if (!clients.markEvent(event.id, event.type)) return "duplicate";
    const customer = str(o.customer);
    let client = customer ? clients.byCustomer(customer) : null;

    if (event.type === "checkout.session.completed") {
      const ref = Number(o.client_reference_id);
      if (!client && Number.isInteger(ref) && ref > 0) client = clients.list().find((c) => c.id === ref) ?? null;
      if (!client) return "ignored";
      const planId = str((o.metadata as Record<string, unknown> | undefined)?.plan_id);
      const paid = o.payment_status === "paid" || o.payment_status === "no_payment_required";
      clients.update(client.id, {
        stripeCustomerId: customer ?? client.stripeCustomerId,
        stripeSubscriptionId: str(o.subscription) ?? client.stripeSubscriptionId,
        ...(planId && plans.find(planId) ? { planId } : {}),
        ...(paid && client.stripeEventAt <= event.created ? { status: "active" as const } : {}),
      });
      return "applied";
    }

    if (!client) return "ignored";

    if (event.type.startsWith("customer.subscription.")) {
      if (event.created < client.stripeEventAt) return "ignored";
      const items = ((o.items as { data?: Record<string, unknown>[] } | undefined)?.data ?? []) as Record<string, unknown>[];
      const meta = (o.metadata ?? {}) as Record<string, unknown>;
      const byMeta = plans.find(str(meta.plan_id));
      const byPrice = items.map((i) => plans.byPrice(String((i.price as { id?: string } | undefined)?.id ?? ""))).find((p) => p) ?? null;
      const status = event.type === "customer.subscription.deleted" ? "canceled" : STATUSES.includes(o.status as SubscriptionStatus) ? (o.status as SubscriptionStatus) : client.status;
      // Newer API versions keep the period on the items.
      const start = o.current_period_start ?? items[0]?.current_period_start;
      const end = o.current_period_end ?? items[0]?.current_period_end;
      clients.update(client.id, {
        status,
        stripeSubscriptionId: str(o.id) ?? client.stripeSubscriptionId,
        stripeEventAt: event.created,
        planId: (byMeta ?? byPrice)?.id ?? client.planId,
        periodStart: iso(start) ?? client.periodStart,
        periodEnd: iso(end) ?? client.periodEnd,
      });
      return "applied";
    }

    if (event.type.startsWith("invoice.")) {
      clients.saveInvoice(client.id, toInvoice(o));
      if (event.type === "invoice.payment_failed" && client.status === "active") clients.update(client.id, { status: "past_due" });
      return "applied";
    }
    return "ignored";
  });
}
