import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { openDb } from "../db/index.js";
import { servicePages } from "./pages.js";
import { PlansRepo } from "./plans.js";
import { setUpStripe } from "./stripeSetup.js";

/** A pretend Stripe API: records the calls, answers like Stripe, and keeps what was made. */
function fakeStripeApi() {
  const calls: string[] = [];
  const made = { products: new Set<string>(), prices: [] as { id: string; lookup_key: string; unit_amount: number; currency: string; active: boolean }[], webhooks: [] as { id: string; url: string }[], meters: [] as { id: string; event_name: string }[], regs: [] as { country: string }[], portal: [] as { id: string }[] };
  const fetch: typeof globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v1/, "");
    const method = init?.method ?? "GET";
    const form = new URLSearchParams(String(init?.body ?? ""));
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk_test_abc123");
    calls.push(`${method} ${path}`);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (method === "GET" && path === "/tax/registrations") return json({ data: made.regs });
    if (method === "POST" && path === "/tax/registrations") return json(made.regs[made.regs.push({ country: form.get("country")! }) - 1]);
    if (path === "/tax/settings") return json({});
    if (method === "GET" && path === "/billing/meters") return json({ data: made.meters });
    if (method === "POST" && path === "/billing/meters") return json(made.meters[made.meters.push({ id: "mtr_1", event_name: form.get("event_name")! }) - 1]);
    if (method === "GET" && path === "/prices") return json({ data: made.prices.filter((p) => p.active && p.lookup_key === url.searchParams.get("lookup_keys[0]")) });
    if (method === "GET" && path.startsWith("/products/")) return made.products.has(path.slice(10)) ? json({ id: path.slice(10) }) : json({ error: { message: "No such product" } }, 404);
    if (method === "POST" && path === "/products") {
      made.products.add(form.get("id")!);
      return json({ id: form.get("id") });
    }
    if (method === "POST" && path === "/prices") {
      for (const p of made.prices) if (p.lookup_key === form.get("lookup_key")) p.lookup_key = "";
      const price = { id: `price_${made.prices.length + 1}`, lookup_key: form.get("lookup_key")!, unit_amount: Number(form.get("unit_amount")), currency: form.get("currency")!, active: true };
      made.prices.push(price);
      return json(price);
    }
    if (method === "POST" && path.startsWith("/prices/")) {
      const p = made.prices.find((x) => x.id === path.slice(8))!;
      p.active = form.get("active") !== "false";
      return json(p);
    }
    if (method === "GET" && path === "/billing_portal/configurations") return json({ data: made.portal });
    if (method === "POST" && path.startsWith("/billing_portal/configurations")) {
      if (!made.portal.length) made.portal.push({ id: "bpc_1" });
      return json(made.portal[0]);
    }
    if (method === "GET" && path === "/webhook_endpoints") return json({ data: made.webhooks });
    if (method === "POST" && path === "/webhook_endpoints") {
      const w = { id: `we_${made.webhooks.length + 1}`, url: form.get("url")! };
      made.webhooks.push(w);
      return json({ ...w, secret: "whsec_made" });
    }
    if (method === "POST" && path.startsWith("/webhook_endpoints/")) return json({});
    if (method === "DELETE" && path.startsWith("/webhook_endpoints/")) {
      made.webhooks = made.webhooks.filter((w) => w.id !== path.slice(19));
      return json({ deleted: true });
    }
    return json({ error: { message: `unexpected ${method} ${path}` } }, 400);
  }) as typeof globalThis.fetch;
  return { fetch, calls, made };
}

describe("the scripted Stripe setup (npm run ops -- stripe-setup)", () => {
  it("makes VAT, prices, the meter, the billing page and the webhook from the secret key alone, and saves the webhook secret", async () => {
    const plans = new PlansRepo(openDb(":memory:"));
    const api = fakeStripeApi();
    let secret: string | null = null;
    const opts = { key: "sk_test_abc123", plans, publicUrl: "https://clip.example/", fetch: api.fetch, saveWebhookSecret: (s: string) => (secret = s) };
    const first = await setUpStripe({ ...opts, hasWebhookSecret: false });
    expect(first.ok, first.lines.join("\n")).toBe(true);
    expect(first.lines).toContain("OK: Stripe Tax works out VAT from LU; registered LU with the EU one-stop shop.");
    expect(first.lines).toContain("OK: made the webhook to https://clip.example/api/stripe/webhook and saved its signing secret.");
    expect(secret).toBe("whsec_made");
    expect(plans.get("starter").stripePriceId).toMatch(/^price_/);
    expect(plans.get("managed-views")).toMatchObject({ stripePriceId: null, stripeViewsPriceId: expect.stringMatching(/^price_/) });
    expect(plans.get("managed-retainer").stripePriceId).toMatch(/^price_/);
    expect(api.made.prices).toHaveLength(4);

    // Again: nothing new is made, and the key never shows up in what is printed.
    const again = await setUpStripe({ ...opts, hasWebhookSecret: true });
    expect(again.ok).toBe(true);
    expect(api.made.prices).toHaveLength(4);
    expect(api.made.webhooks).toHaveLength(1);
    expect(api.made.regs).toHaveLength(1);
    expect(again.lines.join("\n")).not.toContain("sk_test_abc123");
  });

  it("a changed price gets a new Stripe price and retires the old one", async () => {
    const plans = new PlansRepo(openDb(":memory:"));
    const api = fakeStripeApi();
    const opts = { key: "sk_test_abc123", plans, publicUrl: "https://clip.example", fetch: api.fetch, saveWebhookSecret: () => undefined, hasWebhookSecret: true };
    await setUpStripe(opts);
    const old = plans.get("starter").stripePriceId;
    plans.save({ ...plans.get("starter"), monthlyCents: 2400 }, "starter");
    await setUpStripe(opts);
    expect(plans.get("starter").stripePriceId).not.toBe(old);
    expect(api.made.prices.find((p) => p.id === old)?.active).toBe(false);
  });

  it("an endpoint whose secret was lost is made again", async () => {
    const plans = new PlansRepo(openDb(":memory:"));
    const api = fakeStripeApi();
    api.made.webhooks.push({ id: "we_old", url: "https://clip.example/api/stripe/webhook" });
    let secret = "";
    await setUpStripe({ key: "sk_test_abc123", plans, publicUrl: "https://clip.example", fetch: api.fetch, saveWebhookSecret: (s) => (secret = s), hasWebhookSecret: false });
    expect(api.calls).toContain("DELETE /webhook_endpoints/we_old");
    expect(secret).toBe("whsec_made");
  });

  it("says NOT OK without a secret key, and calls nothing", async () => {
    const api = fakeStripeApi();
    const r = await setUpStripe({ key: "", plans: new PlansRepo(openDb(":memory:")), publicUrl: "https://clip.example", fetch: api.fetch, saveWebhookSecret: () => undefined, hasWebhookSecret: false });
    expect(r).toEqual({ ok: false, lines: [expect.stringMatching(/^NOT OK: the Stripe secret key is not set/)] });
    expect(api.calls).toEqual([]);
  });
});

describe("the service's public pages", () => {
  const app = (email: string | null) => {
    const a = express();
    const plans = new PlansRepo(openDb(":memory:"));
    servicePages(a, email, plans);
    return { a, plans };
  };

  it("landing, pricing (the plans on offer) and the service terms, with the contact address", async () => {
    const { a, plans } = app("help@clips.example");
    plans.save({ ...plans.get("pro"), active: false }, "pro");
    const landing = await request(a).get("/service").expect(200);
    expect(landing.text).toContain('href="/portal"');
    const pricing = await request(a).get("/pricing").expect(200);
    expect(pricing.text).toContain("Starter");
    expect(pricing.text).toContain("€19.00 a month");
    expect(pricing.text).toContain("€3.00 per 1,000 views");
    expect(pricing.text).not.toContain(">Pro<");
    expect(pricing.text).toContain('href="/portal?plan=starter"');
    const terms = await request(a).get("/service-terms").expect(200);
    expect(terms.text).toContain("mailto:help@clips.example");
    expect(terms.text).toMatch(/We never see or keep your card/);
  });

  it("answer 503 without a contact address", async () => {
    await request(app(null).a).get("/pricing").expect(503);
  });
});
