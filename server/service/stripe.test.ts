import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { ClipsRepo } from "../clips/repo.js";
import { openDb } from "../db/index.js";
import { SourcesRepo } from "../sources/repo.js";
import { VodsRepo } from "../vods/repo.js";
import { WorkspacesRepo } from "../workspaces/repo.js";
import { serviceWebhook } from "./routes.js";
import { ClientService } from "./service.js";
import { applyStripeEvent, FakeStripe, signStripePayload, type StripeEvent, verifyStripeSignature } from "./stripe.js";

const NOW = new Date("2026-11-14T10:00:00Z");
const NOW_SEC = NOW.getTime() / 1000;
const SECRET = "whsec_test_secret";

function setup() {
  const db = openDb(":memory:");
  const stripe = new FakeStripe(() => NOW);
  const service = new ClientService({ db, workspaces: new WorkspacesRepo(db), sources: new SourcesRepo(db), vods: new VodsRepo(db), clips: new ClipsRepo(db), stripe, now: () => NOW });
  const client = service.clients.update(service.clients.create("ana@example.com", "Ana").id, { stripeCustomerId: "cus_1" });
  const deps = { clients: service.clients, plans: service.plans };
  return { db, service, client, deps, stripe };
}

const ev = (type: string, object: Record<string, unknown>, id = `evt_${type}`, created = NOW_SEC): StripeEvent => ({ id, type, created, data: { object } });

describe("Stripe signatures", () => {
  const payload = JSON.stringify({ id: "evt_1" });
  it("accept Stripe's scheme with the endpoint secret", () => {
    expect(verifyStripeSignature(payload, signStripePayload(payload, SECRET, NOW_SEC), SECRET, NOW_SEC)).toBe(true);
    // Stripe may list several v1 signatures (during a secret roll): one matching is enough.
    expect(verifyStripeSignature(payload, `t=${NOW_SEC},v1=${"0".repeat(64)},${signStripePayload(payload, SECRET, NOW_SEC).split(",")[1]}`, SECRET, NOW_SEC)).toBe(true);
  });
  it("refuse another secret, a changed body, an old timestamp and junk", () => {
    expect(verifyStripeSignature(payload, signStripePayload(payload, "whsec_other", NOW_SEC), SECRET, NOW_SEC)).toBe(false);
    expect(verifyStripeSignature(`${payload} `, signStripePayload(payload, SECRET, NOW_SEC), SECRET, NOW_SEC)).toBe(false);
    expect(verifyStripeSignature(payload, signStripePayload(payload, SECRET, NOW_SEC - 301), SECRET, NOW_SEC)).toBe(false);
    expect(verifyStripeSignature(payload, "t=1,v1=zz", SECRET, NOW_SEC)).toBe(false);
    expect(verifyStripeSignature(payload, undefined, SECRET, NOW_SEC)).toBe(false);
    expect(verifyStripeSignature(payload, signStripePayload(payload, SECRET, NOW_SEC), "", NOW_SEC)).toBe(false);
  });
});

describe("Stripe events → the client's plan", () => {
  it("a finished checkout puts the plan in force", () => {
    const { client, deps, service } = setup();
    expect(applyStripeEvent(ev("checkout.session.completed", { client_reference_id: String(client.id), customer: "cus_1", subscription: "sub_1", payment_status: "paid", metadata: { plan_id: "pro" } }), deps)).toBe("applied");
    expect(service.clients.get(client.id)).toMatchObject({ planId: "pro", status: "active", stripeSubscriptionId: "sub_1" });
  });

  it("each event counts once, however often Stripe sends it", () => {
    const { client, deps, service } = setup();
    const cancel = ev("customer.subscription.deleted", { id: "sub_1", customer: "cus_1", status: "canceled" }, "evt_same");
    service.clients.update(client.id, { status: "active", planId: "starter" });
    expect(applyStripeEvent(cancel, deps)).toBe("applied");
    service.clients.update(client.id, { status: "active" });
    expect(applyStripeEvent(cancel, deps)).toBe("duplicate");
    expect(service.clients.get(client.id).status).toBe("active");
  });

  it("subscription updates set the status, plan (by price) and period; older ones arriving late change nothing", () => {
    const { client, deps, service } = setup();
    service.plans.setStripeIds("pro", { stripePriceId: "price_pro", stripeViewsPriceId: null });
    const item = { price: { id: "price_pro" }, current_period_start: NOW_SEC, current_period_end: NOW_SEC + 30 * 86400 };
    applyStripeEvent(ev("customer.subscription.updated", { id: "sub_1", customer: "cus_1", status: "past_due", items: { data: [item] } }, "evt_new", NOW_SEC), deps);
    expect(service.clients.get(client.id)).toMatchObject({ status: "past_due", planId: "pro", periodStart: NOW.toISOString() });
    expect(applyStripeEvent(ev("customer.subscription.updated", { id: "sub_1", customer: "cus_1", status: "active", items: { data: [item] } }, "evt_old", NOW_SEC - 60), deps)).toBe("ignored");
    expect(service.clients.get(client.id).status).toBe("past_due");
  });

  it("invoices are kept for the portal, and a failed payment marks the client overdue", () => {
    const { client, deps, service } = setup();
    service.clients.update(client.id, { status: "active" });
    const inv = { id: "in_1", customer: "cus_1", number: "A-1", status: "open", amount_due: 2223, amount_paid: 0, total_taxes: [{ amount: 323 }], currency: "eur", hosted_invoice_url: "https://invoice.stripe.com/i/1", created: NOW_SEC, due_date: NOW_SEC + 86400 };
    applyStripeEvent(ev("invoice.finalized", inv), deps);
    applyStripeEvent(ev("invoice.payment_failed", inv), deps);
    expect(service.clients.invoices(client.id)).toEqual([expect.objectContaining({ id: "in_1", number: "A-1", amountDue: 2223, tax: 323, status: "open" })]);
    expect(service.clients.get(client.id).status).toBe("past_due");
    expect(service.clients.overdue(service.clients.get(client.id))).toBe(true);
  });

  it("events about customers we do not know are ignored", () => {
    const { deps } = setup();
    expect(applyStripeEvent(ev("invoice.paid", { id: "in_x", customer: "cus_unknown" }), deps)).toBe("ignored");
  });

  it("the fake Checkout sends what Stripe sends: plan on, subscription and a paid invoice with VAT", () => {
    const { client, deps, service, stripe } = setup();
    return stripe.createCheckout({ customerId: "cus_1", plan: service.plans.get("starter"), clientId: client.id }).then(({ id }) => {
      for (const e of stripe.completeCheckout(id, service.plans.get("starter"))) applyStripeEvent(e, deps);
      expect(service.clients.get(client.id)).toMatchObject({ planId: "starter", status: "active" });
      expect(service.clients.invoices(client.id)[0]).toMatchObject({ status: "paid", amountDue: 1900 + 323, tax: 323 });
      expect(stripe.completeCheckout(id, service.plans.get("starter"))).toEqual([]);
    });
  });
});

describe("the webhook endpoint", () => {
  function app() {
    const s = setup();
    const a = express();
    serviceWebhook(a, { service: s.service, webhookSecret: () => SECRET, now: () => NOW });
    return { ...s, app: a };
  }
  const body = (client: number) => JSON.stringify(ev("checkout.session.completed", { client_reference_id: String(client), customer: "cus_1", subscription: "sub_1", payment_status: "paid", metadata: { plan_id: "starter" } }, "evt_hook"));

  it("applies a signed event once, and says so when it comes again", async () => {
    const { app: a, client, service } = app();
    const payload = body(client.id);
    const send = () => request(a).post("/api/stripe/webhook").set("Content-Type", "application/json").set("Stripe-Signature", signStripePayload(payload, SECRET, NOW_SEC)).send(payload);
    expect((await send().expect(200)).body).toEqual({ received: true, outcome: "applied" });
    expect(service.clients.get(client.id).planId).toBe("starter");
    expect((await send().expect(200)).body.outcome).toBe("duplicate");
  });

  it("refuses an unsigned or wrongly signed event, and changes nothing", async () => {
    const { app: a, client, service } = app();
    const payload = body(client.id);
    await request(a).post("/api/stripe/webhook").set("Content-Type", "application/json").send(payload).expect(400);
    await request(a).post("/api/stripe/webhook").set("Content-Type", "application/json").set("Stripe-Signature", signStripePayload(payload, "whsec_forged", NOW_SEC)).send(payload).expect(400);
    expect(service.clients.get(client.id).planId).toBeNull();
  });

  it("answers 503 until the setup saved a secret", async () => {
    const s = setup();
    const a = express();
    serviceWebhook(a, { service: s.service, webhookSecret: () => undefined });
    await request(a).post("/api/stripe/webhook").send("{}").expect(503);
  });
});
