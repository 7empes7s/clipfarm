import type { Plan } from "../../shared/service.js";
import { HttpError } from "../errors.js";
import type { PlansRepo } from "./plans.js";
import { STRIPE_API_VERSION, STRIPE_EVENTS, STRIPE_WEBHOOK_PATH, stripeCall, VIEWS_METER_EVENT } from "./stripe.js";

export interface StripeSetupOptions {
  /** The secret key the manager pasted (Settings, Stripe) or STRIPE_SECRET_KEY. Never printed. */
  key: string;
  plans: PlansRepo;
  /** The public address Stripe sends events to. */
  publicUrl: string;
  /** Whether a webhook secret is saved already (Stripe shows it only when the endpoint is made). */
  hasWebhookSecret: boolean;
  saveWebhookSecret: (secret: string) => void;
  /** Where the business is (VAT): Luxembourg. */
  taxCountry?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

/** Stripe's tax code for software as a service sold to businesses. */
export const SAAS_TAX_CODE = "txcd_10103001";

interface List<T> {
  data: T[];
}
interface Price {
  id: string;
  unit_amount: number | null;
  currency: string;
}

/**
 * The whole Stripe side of the clipping service from the secret key alone, so nobody has to click
 * in Stripe's dashboard: VAT (Stripe Tax, Luxembourg and the EU's one-stop shop), a product and
 * prices per plan, the views meter, the billing page and the webhook. Safe to run again: it only
 * adds or changes what is missing or different. Plain OK / NOT OK lines, never the key.
 */
export async function setUpStripe(o: StripeSetupOptions): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  if (!/^(sk|rk)_(test|live)_\w+$/.test(o.key)) return { ok: false, lines: ["NOT OK: the Stripe secret key is not set (Settings, Stripe), or is not a secret key (sk_…)."] };
  const call = <T>(method: "GET" | "POST" | "DELETE", path: string, params?: Record<string, string | number | boolean>) => stripeCall<T>(o.key, method, path, params, o.fetch);
  /** null for a 404: "not made yet". */
  const find = async <T>(path: string): Promise<T | null> => {
    try {
      return await call<T>("GET", path);
    } catch (err) {
      if (err instanceof HttpError && err.message.startsWith("Stripe answered 404")) return null;
      throw err;
    }
  };
  const step = async (label: string, fn: () => Promise<string>) => {
    try {
      lines.push(`OK: ${await fn()}`);
    } catch (err) {
      lines.push(`NOT OK: ${label}: ${err instanceof Error ? err.message : String(err)}.`);
    }
  };
  const country = (o.taxCountry ?? "LU").toUpperCase();
  const base = o.publicUrl.replace(/\/+$/, "");
  const mode = o.key.includes("_test_") ? "test" : "live";
  lines.push(`OK: using a ${mode} key.`);

  await step("VAT settings", async () => {
    await call("POST", "/tax/settings", { "head_office[address][country]": country, "defaults[tax_code]": SAAS_TAX_CODE, "defaults[tax_behavior]": "exclusive" });
    const regs = await call<List<{ country: string }>>("GET", "/tax/registrations", { status: "active", limit: 100 });
    if (regs.data.some((r) => r.country === country)) return `Stripe Tax works out VAT from ${country}, and the ${country} registration is there.`;
    await call("POST", "/tax/registrations", {
      country,
      [`country_options[${country.toLowerCase()}][type]`]: "ou_oss_union",
      active_from: "now",
    });
    return `Stripe Tax works out VAT from ${country}; registered ${country} with the EU one-stop shop.`;
  });

  let meterId: string | null = null;
  await step("views meter", async () => {
    const meters = await call<List<{ id: string; event_name: string }>>("GET", "/billing/meters", { status: "active", limit: 100 });
    meterId = meters.data.find((m) => m.event_name === VIEWS_METER_EVENT)?.id ?? null;
    if (meterId) return "the views meter is there.";
    const made = await call<{ id: string }>("POST", "/billing/meters", {
      display_name: "Clip views",
      event_name: VIEWS_METER_EVENT,
      "default_aggregation[formula]": "sum",
      "customer_mapping[type]": "by_id",
      "customer_mapping[event_payload_key]": "stripe_customer_id",
      "value_settings[event_payload_key]": "value",
    });
    meterId = made.id;
    return "made the views meter.";
  });

  /** The active price with this lookup key, or a new one (which takes the key over). */
  const priceFor = async (plan: Plan, kind: "monthly" | "views", amount: number): Promise<string> => {
    const lookup = `clipfarm_${plan.id}_${kind}`;
    const found = await call<List<Price>>("GET", "/prices", { "lookup_keys[0]": lookup, active: true, limit: 1 });
    const current = found.data[0];
    if (current && current.unit_amount === amount && current.currency === plan.currency) return current.id;
    const productId = `clipfarm_${plan.id}`;
    if (!(await find(`/products/${productId}`))) {
      await call("POST", "/products", { id: productId, name: `clipfarm ${plan.name}`, tax_code: SAAS_TAX_CODE, "metadata[clipfarm_plan]": plan.id });
    }
    const params: Record<string, string | number | boolean> = {
      product: productId,
      currency: plan.currency,
      unit_amount: amount,
      "recurring[interval]": "month",
      lookup_key: lookup,
      transfer_lookup_key: true,
      tax_behavior: "exclusive",
      "metadata[clipfarm_plan]": plan.id,
    };
    if (kind === "views") {
      if (!meterId) throw new Error("the views meter is missing");
      Object.assign(params, { "recurring[usage_type]": "metered", "recurring[meter]": meterId, "transform_quantity[divide_by]": 1000, "transform_quantity[round]": "up" });
    }
    const made = await call<{ id: string }>("POST", "/prices", params);
    // The old price stays for subscriptions on it; new checkouts use the new one.
    if (current) await call("POST", `/prices/${current.id}`, { active: false });
    return made.id;
  };

  for (const plan of o.plans.list()) {
    await step(`plan ${plan.name}`, async () => {
      const monthly = plan.monthlyCents > 0 ? await priceFor(plan, "monthly", plan.monthlyCents) : null;
      const views = plan.per1kViewsCents !== null ? await priceFor(plan, "views", plan.per1kViewsCents) : null;
      o.plans.setStripeIds(plan.id, { stripePriceId: monthly, stripeViewsPriceId: views });
      return `plan ${plan.name} has its Stripe price${monthly && views ? "s" : ""}.`;
    });
  }

  await step("billing page", async () => {
    const selfServe = o.plans.list().filter((p) => p.active && p.kind === "self-serve" && p.stripePriceId && !p.stripeViewsPriceId);
    const params: Record<string, string | number | boolean> = {
      "business_profile[privacy_policy_url]": `${base}/privacy`,
      "business_profile[terms_of_service_url]": `${base}/service-terms`,
      "features[invoice_history][enabled]": true,
      "features[payment_method_update][enabled]": true,
      "features[customer_update][enabled]": true,
      "features[customer_update][allowed_updates][0]": "email",
      "features[customer_update][allowed_updates][1]": "address",
      "features[customer_update][allowed_updates][2]": "tax_id",
      "features[subscription_cancel][enabled]": true,
      "features[subscription_cancel][mode]": "at_period_end",
      "features[subscription_update][enabled]": selfServe.length > 1,
    };
    if (selfServe.length > 1) {
      params["features[subscription_update][default_allowed_updates][0]"] = "price";
      params["features[subscription_update][proration_behavior]"] = "create_prorations";
      selfServe.forEach((p, i) => {
        params[`features[subscription_update][products][${i}][product]`] = `clipfarm_${p.id}`;
        params[`features[subscription_update][products][${i}][prices][0]`] = p.stripePriceId!;
      });
    }
    const configs = await call<List<{ id: string }>>("GET", "/billing_portal/configurations", { is_default: true, active: true, limit: 1 });
    const existing = configs.data[0];
    await call("POST", existing ? `/billing_portal/configurations/${existing.id}` : "/billing_portal/configurations", params);
    return `the billing page lets clients see invoices, change their card${selfServe.length > 1 ? ", switch plans" : ""} and cancel.`;
  });

  await step("webhook", async () => {
    const url = `${base}${STRIPE_WEBHOOK_PATH}`;
    const events = Object.fromEntries(STRIPE_EVENTS.map((e, i) => [`enabled_events[${i}]`, e]));
    const all = await call<List<{ id: string; url: string }>>("GET", "/webhook_endpoints", { limit: 100 });
    const found = all.data.find((w) => w.url === url);
    if (found && o.hasWebhookSecret) {
      await call("POST", `/webhook_endpoints/${found.id}`, events);
      return `Stripe sends its events to ${url}.`;
    }
    // Stripe shows the signing secret only when an endpoint is made: one without a saved secret is made again.
    if (found) await call("DELETE", `/webhook_endpoints/${found.id}`);
    const made = await call<{ secret?: string }>("POST", "/webhook_endpoints", { url, api_version: STRIPE_API_VERSION, description: "clipfarm client billing", ...events });
    if (!made.secret) throw new Error("Stripe did not send the webhook's signing secret");
    o.saveWebhookSecret(made.secret);
    return `made the webhook to ${url} and saved its signing secret.`;
  });

  return { ok: lines.every((l) => l.startsWith("OK: ")), lines };
}
