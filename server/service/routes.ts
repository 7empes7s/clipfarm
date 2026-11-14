import express, { type Express, type Request, type Response } from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import type { Clip, DirectPlatform, Platform, RejectReason } from "../../shared/types.js";
import { DIRECT_PLATFORMS, PLATFORMS, REJECT_REASONS } from "../../shared/types.js";
import type { PortalMe } from "../../shared/service.js";
import { money, planPrice } from "../../shared/service.js";
import type { ClipsRepo } from "../clips/repo.js";
import { type Creator, parseCreatorAdd } from "../creator/service.js";
import { HttpError, NotFoundError, ValidationError } from "../errors.js";
import type { Isolation } from "../isolation/isolation.js";
import type { DirectPoster } from "../publish/direct/direct.js";
import type { Publisher } from "../publish/publisher.js";
import type { SourcesRepo } from "../sources/repo.js";
import type { VodsRepo } from "../vods/repo.js";
import { parseBrand, type WorkspacesRepo } from "../workspaces/repo.js";
import type { GoogleSignIn, Mailer } from "./auth.js";
import { FakeMailer } from "./auth.js";
import { type ClientRecord, parseEmail, publicClient, type Session } from "./clients.js";
import { assertBrand, assertCanProcess, assertPlatform, processProblem } from "./limits.js";
import type { ClientService } from "./service.js";
import { applyStripeEvent, FakeStripe, signStripePayload, STRIPE_WEBHOOK_PATH, type StripeApi, type StripeEvent, verifyStripeSignature } from "./stripe.js";

/** The name of the isolation group whose apps connect clients' own channels. */
export const CLIENTS_GROUP_NAME = "Clients";
/** Where the Stripe setup keeps the webhook's signing secret (the saved-keys file, never the screen). */
export const WEBHOOK_SECRET_NAME = "stripe.webhook-secret";
/** Demo mode signs its stand-in events with this. */
export const DEMO_WEBHOOK_SECRET = "whsec_demo_only";
const SESSION_COOKIE = "clipfarm_client";
const STATE_COOKIE = "clipfarm_oauth";

export interface PortalDeps {
  service: ClientService;
  workspaces: WorkspacesRepo;
  sources: SourcesRepo;
  vods: VodsRepo;
  clips: ClipsRepo;
  publisher: Publisher;
  creator: Creator;
  stripe: StripeApi;
  mailer: Mailer;
  google: GoogleSignIn;
  /** The Stripe webhook endpoint's signing secret (saved by the Stripe setup). */
  webhookSecret: () => string | undefined;
  /** The public address: sign-in links and Stripe's return addresses use it (never the Host header). */
  publicUrl: string;
  /** Demo mode: links use the address the browser came from, and the portal says what is a stand-in. */
  demo: boolean;
  /** Connecting clients' own channels with clipfarm's platform apps. */
  direct?: { isolation: Isolation; poster: DirectPoster };
  now?: () => Date;
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

function setCookie(req: Request, res: Response, name: string, value: string, maxAgeSec: number, path = "/"): void {
  const secure = req.secure || req.get("x-forwarded-proto") === "https";
  res.append("Set-Cookie", `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`);
}

const idOf = (raw: unknown): number => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new NotFoundError("Not found.");
  return id;
};

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A small page of ours for the demo Checkout, billing and invoice (demo mode only). */
function demoPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escape(title)}</title>
<style>:root{--paper:#f5f2fa;--surface:#fff;--ink:#1b1530;--muted:#5d5577;--line:#dcd5ea;--accent:#ffb224;--accent-ink:#1b1530}@media (prefers-color-scheme:dark){:root{--paper:#15111f;--surface:#201a30;--ink:#f3effc;--muted:#aba3c4;--line:#3a3155}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:1rem/1.5 system-ui,sans-serif}main{max-width:30rem;margin:0 auto;padding:24px 16px}.card{background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:20px}
.note{color:var(--muted);font-size:.875rem}button,a.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 18px;border-radius:12px;border:1px solid var(--line);background:var(--surface);color:var(--ink);font:600 1rem system-ui;text-decoration:none;cursor:pointer;margin:6px 6px 0 0}
button.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}table{width:100%;border-collapse:collapse}td{padding:6px 0;border-bottom:1px solid var(--line)}td:last-child{text-align:right}</style></head>
<body><main><div class="card">${body}</div></main></body></html>`;
}

/**
 * Stripe's events, open to the internet (see access.ts). Mounted before the JSON parser: the
 * signature is over the raw body. Only events signed with our endpoint's secret count.
 */
export function serviceWebhook(app: Express, deps: Pick<PortalDeps, "service" | "webhookSecret" | "now">): void {
  app.post(STRIPE_WEBHOOK_PATH, express.raw({ type: () => true, limit: "1mb" }), (req, res) => {
    const secret = deps.webhookSecret();
    if (!secret) {
      res.status(503).json({ error: "The Stripe webhook is not set up yet." });
      return;
    }
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const nowSec = Math.floor((deps.now?.() ?? new Date()).getTime() / 1000);
    if (!verifyStripeSignature(body, req.get("stripe-signature"), secret, nowSec)) {
      res.status(400).json({ error: "The signature does not match." });
      return;
    }
    let event: StripeEvent;
    try {
      event = JSON.parse(body.toString("utf8")) as StripeEvent;
    } catch {
      res.status(400).json({ error: "The event was not valid JSON." });
      return;
    }
    if (typeof event?.id !== "string" || typeof event.type !== "string") {
      res.status(400).json({ error: "That is not a Stripe event." });
      return;
    }
    res.json({ received: true, outcome: applyStripeEvent(event, { clients: deps.service.clients, plans: deps.service.plans }) });
  });
}

/** The client portal's API and sign-in, open to the internet but each behind the client's own session. */
export function servicePortal(app: Express, deps: PortalDeps): void {
  const { service, workspaces, sources, vods, clips, publisher, creator, stripe, mailer, google } = deps;
  const { clients, plans } = service;
  const now = () => deps.now?.() ?? new Date();
  /** Where links and Stripe's return addresses point. Demo mode: wherever the browser is. */
  const base = (req: Request) => (deps.demo ? `${req.protocol}://${req.get("host")}` : deps.publicUrl.replace(/\/+$/, ""));

  const startSession = (req: Request, res: Response, client: ClientRecord, readOnly: boolean) => {
    const { token, expires } = clients.newSession(client.id, readOnly);
    setCookie(req, res, SESSION_COOKIE, token, Math.floor((expires.getTime() - now().getTime()) / 1000));
  };
  const landing = (client: ClientRecord) => (client.planId && client.status !== "none" ? "/portal#home" : "/portal#plans");

  const sessionOf = (req: Request): Session | null => clients.session(readCookie(req, SESSION_COOKIE));
  /** The signed-in client; a 401 otherwise. Changes are refused in a support view. */
  const who = (req: Request, write = false): ClientRecord => {
    const s = sessionOf(req);
    if (!s) throw new HttpError(401, "Sign in to carry on.");
    if (write && s.readOnly) throw new HttpError(403, "This is a read-only support view: nothing can be changed.");
    return s.client;
  };
  /** A source of the client's workspace, or 404: another client's id is never told apart from none. */
  const ownSource = (client: ClientRecord, raw: unknown) => {
    const id = idOf(raw);
    const s = sources.list(client.workspaceId).find((x) => x.id === id);
    if (!s) throw new NotFoundError("That was not found.");
    return s;
  };
  const ownClip = (client: ClientRecord, raw: unknown): Clip => {
    const id = idOf(raw);
    let clip: Clip;
    try {
      clip = clips.get(id);
    } catch {
      throw new NotFoundError("That clip was not found.");
    }
    if (!sources.list(client.workspaceId).some((s) => s.id === clip.sourceId)) throw new NotFoundError("That clip was not found.");
    return clip;
  };
  const clientsGroup = () => deps.direct?.isolation.list().find((g) => g.name.toLowerCase() === CLIENTS_GROUP_NAME.toLowerCase()) ?? null;
  const connectable = (): Platform[] => {
    const group = clientsGroup();
    return group ? DIRECT_PLATFORMS.filter((p) => deps.direct!.isolation.app(group.id, p)) : [];
  };

  // Unsafe calls must come from our own pages: a JSON body (no plain form can send one) and, when
  // the browser says where it came from, our own address.
  app.use("/api/portal", (req, _res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      const origin = req.get("origin");
      const ours = [base(req), `${req.protocol}://${req.get("host")}`];
      if (origin && !ours.includes(origin)) throw new HttpError(403, "That request did not come from the portal.");
      if (req.method !== "DELETE" && !req.is("application/json")) throw new HttpError(415, "Send JSON.");
    }
    next();
  });

  // ---- Sign-in -----------------------------------------------------------------------------

  app.post("/api/portal/auth/email", async (req, res) => {
    const email = parseEmail((req.body ?? {}).email);
    const token = clients.newLoginLink(email);
    // Always the same answer, so the form does not tell who has an account.
    let demoLink: string | undefined;
    if (token) {
      const link = `${base(req)}/portal/auth/verify?token=${token}`;
      await mailer.send({
        to: email,
        subject: "Your sign-in link for clipfarm",
        text: `Tap to sign in to clipfarm (works once, for 30 minutes):\n\n${link}\n\nIf you did not ask for this, ignore this email.`,
      });
      if (deps.demo && mailer instanceof FakeMailer) demoLink = link;
    }
    res.json({ sent: true, ...(demoLink ? { demoLink } : {}) });
  });

  app.get("/portal/auth/verify", (req, res) => {
    const used = clients.useLoginLink(String(req.query.token ?? ""));
    if (!used) {
      res.redirect("/portal?signin=expired");
      return;
    }
    startSession(req, res, used.client, used.readOnly);
    res.redirect(used.readOnly ? "/portal#home" : landing(used.client));
  });

  // Support's read-only view: the link is made behind Cloudflare Access (admin), works once, for 5 minutes.
  app.get("/portal/auth/support", (req, res) => {
    const used = clients.useLoginLink(String(req.query.token ?? ""));
    if (!used?.readOnly) {
      res.redirect("/portal?signin=expired");
      return;
    }
    startSession(req, res, used.client, true);
    res.redirect("/portal#home");
  });

  app.get("/portal/auth/google", (req, res) => {
    if (!google.available()) {
      res.redirect("/portal?signin=google-off");
      return;
    }
    const state = randomBytes(24).toString("base64url");
    setCookie(req, res, STATE_COOKIE, state, 600, "/portal/auth");
    res.redirect(google.authorizeUrl(state, `${base(req)}/portal/auth/google/callback`));
  });

  app.get("/portal/auth/google/callback", async (req, res) => {
    const want = readCookie(req, STATE_COOKIE) ?? "";
    const got = typeof req.query.state === "string" ? req.query.state : "";
    setCookie(req, res, STATE_COOKIE, "", 0, "/portal/auth");
    // Only a sign-in this browser started counts.
    if (!want || want.length !== got.length || !timingSafeEqual(Buffer.from(want), Buffer.from(got)) || typeof req.query.code !== "string") {
      res.redirect("/portal?signin=failed");
      return;
    }
    try {
      const profile = await google.exchange(req.query.code, `${base(req)}/portal/auth/google/callback`);
      const client = clients.findOrCreateGoogle(profile.sub, profile.email, profile.name);
      startSession(req, res, client, false);
      res.redirect(landing(client));
    } catch (err) {
      if (!(err instanceof HttpError)) console.error("Google sign-in failed:", err instanceof Error ? err.message : String(err));
      res.redirect("/portal?signin=failed");
    }
  });

  app.post("/api/portal/auth/signout", (req, res) => {
    clients.endSession(readCookie(req, SESSION_COOKIE));
    setCookie(req, res, SESSION_COOKIE, "", 0);
    res.json({ ok: true });
  });

  // ---- The client's own things -----------------------------------------------------------------

  const me = (req: Request): PortalMe => {
    const s = sessionOf(req);
    if (!s) throw new HttpError(401, "Sign in to carry on.");
    const client = s.client;
    const plan = plans.find(client.planId);
    const usage = clients.usage(client);
    const ws = workspaces.get(client.workspaceId);
    return {
      client: publicClient(client),
      workspace: { id: ws.id, name: ws.name, brand: ws.brand },
      plan,
      usage,
      blocked: processProblem(plan, client.status, usage),
      readOnly: s.readOnly,
      plans: plans.list().filter((p) => p.active || p.id === client.planId),
      demo: deps.demo,
      connectable: connectable().filter((p) => !plan || plan.platforms.includes(p)),
    };
  };

  // Signed out is an answer here (null), not an error: the portal opens on its sign-in screen.
  app.get("/api/portal/me", (req, res) => {
    res.json(sessionOf(req) ? me(req) : null);
  });

  app.put("/api/portal/settings", (req, res) => {
    const client = who(req, true);
    const { autoApprove } = (req.body ?? {}) as { autoApprove?: unknown };
    if (typeof autoApprove !== "boolean") throw new ValidationError("Say whether clips are approved by themselves.");
    clients.update(client.id, { autoApprove });
    if (autoApprove) service.autoApprove();
    res.json(me(req));
  });

  app.put("/api/portal/brand", (req, res) => {
    const client = who(req, true);
    assertBrand(plans.find(client.planId), client.status);
    const ws = workspaces.get(client.workspaceId);
    workspaces.update(ws.id, ws.name, parseBrand(req.body));
    res.json(me(req));
  });

  // ---- Billing --------------------------------------------------------------------------------

  const customerOf = async (client: ClientRecord): Promise<string> => {
    if (client.stripeCustomerId) return client.stripeCustomerId;
    const { id } = await stripe.createCustomer({ email: client.email, name: client.name, clientId: client.id });
    clients.update(client.id, { stripeCustomerId: id });
    return id;
  };

  app.post("/api/portal/checkout", async (req, res) => {
    const client = who(req, true);
    const plan = plans.get(String((req.body ?? {}).planId ?? ""));
    if (!plan.active) throw new ValidationError("That plan is not offered any more. Pick another one.");
    const customerId = await customerOf(client);
    // A plan in force is changed in Stripe's billing page (it prorates); a new one goes through Checkout.
    if (["active", "trialing", "past_due"].includes(client.status) && client.stripeSubscriptionId) {
      res.json(await stripe.createPortal({ customerId, returnUrl: `${base(req)}/portal#billing` }));
      return;
    }
    const { url } = await stripe.createCheckout({
      customerId,
      plan,
      clientId: client.id,
      successUrl: `${base(req)}/portal?checkout=done#home`,
      cancelUrl: `${base(req)}/portal?checkout=cancelled#plans`,
    });
    res.json({ url });
  });

  app.post("/api/portal/billing", async (req, res) => {
    const client = who(req, true);
    if (!client.stripeCustomerId) throw new ValidationError("Pick a plan first: billing opens after your first payment.");
    res.json(await stripe.createPortal({ customerId: client.stripeCustomerId, returnUrl: `${base(req)}/portal#billing` }));
  });

  app.get("/api/portal/invoices", (req, res) => {
    res.json(clients.invoices(who(req).id));
  });

  app.get("/api/portal/invoices/:id", (req, res) => {
    res.json(clients.invoice(who(req).id, String(req.params.id)));
  });

  // ---- Sources and videos ---------------------------------------------------------------------

  const sourcesView = (client: ClientRecord) => {
    const list = sources.list(client.workspaceId);
    const ids = new Set(list.map((s) => s.id));
    return {
      sources: list.map((s) => ({ id: s.id, name: s.creatorName, channelUrls: s.channelUrls })),
      videos: vods
        .list()
        .filter((v) => ids.has(v.sourceId))
        .map((v) => ({ id: v.id, sourceId: v.sourceId, title: v.title, url: v.url, status: v.status, durationSec: v.durationSec, createdAt: v.createdAt })),
    };
  };

  app.get("/api/portal/sources", (req, res) => {
    res.json(sourcesView(who(req)));
  });

  app.post("/api/portal/sources", async (req, res) => {
    const client = who(req, true);
    assertCanProcess(plans.find(client.planId), client.status, clients.usage(client));
    const input = parseCreatorAdd(req.body);
    if (input.sourceId !== null) ownSource(client, input.sourceId);
    // Uploads go through the team's app for now: the portal takes links.
    if (input.uploadId !== null) throw new ValidationError("Paste a link to the video or channel.");
    await creator.add(client.workspaceId, input);
    res.status(201).json(sourcesView(client));
  });

  app.delete("/api/portal/sources/:id", (req, res) => {
    const client = who(req, true);
    sources.remove(ownSource(client, req.params.id).id);
    res.json(sourcesView(client));
  });

  // ---- Their own channels -----------------------------------------------------------------------

  const accountsView = (client: ClientRecord) =>
    publisher.accounts
      .list()
      .filter((a) => (a.workspaceId ?? 1) === client.workspaceId)
      .map((a) => ({ id: a.id, platform: a.platform, name: a.name, handle: a.handle ?? null, disabled: a.disabled }));

  app.get("/api/portal/accounts", (req, res) => {
    res.json({ accounts: accountsView(who(req)), connectable: connectable() });
  });

  app.post("/api/portal/accounts/connect", async (req, res) => {
    const client = who(req, true);
    const platform = (req.body ?? {}).platform as Platform;
    if (!PLATFORMS.includes(platform)) throw new ValidationError("Pick a platform.");
    assertPlatform(plans.find(client.planId), client.status, platform);
    const group = clientsGroup();
    if (!group || !deps.direct || !connectable().includes(platform)) {
      throw new HttpError(409, "Connecting this platform yourself is not open yet. Write to us and we will connect it with you.");
    }
    res.json({ url: await deps.direct.poster.connectUrl(group.id, platform as DirectPlatform, { workspaceId: client.workspaceId }) });
  });

  // ---- Clips ----------------------------------------------------------------------------------

  app.get("/api/portal/clips", (req, res) => {
    const client = who(req);
    const ids = new Set(sources.list(client.workspaceId).map((s) => s.id));
    res.json(clips.list().filter((c) => ids.has(c.sourceId)));
  });

  app.post("/api/portal/clips/:id/approve", (req, res) => {
    const client = who(req, true);
    res.json(clips.review(ownClip(client, req.params.id).id, "approve"));
  });

  app.post("/api/portal/clips/:id/reject", (req, res) => {
    const client = who(req, true);
    const clip = ownClip(client, req.params.id);
    const reason = (req.body ?? {}).reason as unknown;
    if (reason !== undefined && reason !== null && !REJECT_REASONS.includes(reason as RejectReason)) throw new ValidationError("Pick a reason.");
    res.json(clips.review(clip.id, "reject", (reason as RejectReason | undefined) ?? null));
  });

  app.get("/api/portal/clips/:id/video", (req, res, next) => {
    const clip = ownClip(who(req), req.params.id);
    const file = clips.filePath(clip.id);
    if (!existsSync(file)) throw new NotFoundError("That clip's video is not there (yet).");
    res.sendFile(file, { dotfiles: "allow" }, (err) => err && !res.headersSent && next(err));
  });

  // ---- Calendar and dashboard -------------------------------------------------------------------

  app.get("/api/portal/calendar", (req, res) => {
    const client = who(req);
    const from = new Date(String(req.query.from ?? ""));
    const to = new Date(String(req.query.to ?? ""));
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from || to.getTime() - from.getTime() > 62 * 86_400_000) {
      throw new ValidationError("Pick a start and an end, at most two months apart.");
    }
    const ids = new Set(sources.list(client.workspaceId).map((s) => s.id));
    const cal = publisher.calendar(from, to);
    res.json({
      timeZone: cal.timeZone,
      items: cal.items
        .filter((i) => ids.has(i.post.sourceId))
        .map((i) => ({ id: i.post.id, clipId: i.post.clipId, title: i.post.clipTitle, platform: i.post.platform, account: i.post.accountName, at: i.post.scheduledAt, status: i.status, url: i.post.url, views: i.post.views })),
    });
  });

  app.get("/api/portal/dashboard", (req, res) => {
    res.json(service.dashboard(who(req)));
  });

  // ---- Demo mode only: Stripe's pages, played by ours ------------------------------------------

  if (stripe instanceof FakeStripe) {
    const fake = stripe;
    const deliver = (events: StripeEvent[]) => {
      // Signed and checked like Stripe's own, so the demo goes through the same path.
      const secret = deps.webhookSecret() ?? "";
      const nowSec = Math.floor(now().getTime() / 1000);
      for (const e of events) {
        const payload = JSON.stringify(e);
        if (verifyStripeSignature(payload, signStripePayload(payload, secret, nowSec), secret, nowSec)) {
          applyStripeEvent(JSON.parse(payload) as StripeEvent, { clients, plans });
        }
      }
    };
    const form = express.urlencoded({ extended: false });
    const signedIn = (req: Request) => sessionOf(req)?.client ?? null;

    app.get("/portal/fake-checkout/:id", (req, res) => {
      const client = signedIn(req);
      const s = fake.sessions.get(String(req.params.id));
      if (!client || !s || s.clientId !== client.id || s.done) throw new NotFoundError("That checkout was not found.");
      const plan = plans.get(s.planId);
      res.type("html").send(
        demoPage(
          "Test checkout",
          `<h1>Test checkout</h1><p class="note">Demo mode: this page stands in for Stripe Checkout. No card is asked for and nothing is charged.</p>
<table><tr><td>${escape(plan.name)}</td><td>${escape(planPrice(plan))}</td></tr><tr><td>VAT (Luxembourg, 17 %)</td><td>${escape(money(Math.round(plan.monthlyCents * 0.17), plan.currency))}</td></tr></table>
<form method="post"><button class="primary" name="action" value="pay">Pay (test)</button><button name="action" value="cancel">Cancel</button></form>`,
        ),
      );
    });

    app.post("/portal/fake-checkout/:id", form, (req, res) => {
      const client = signedIn(req);
      const s = fake.sessions.get(String(req.params.id));
      if (!client || !s || s.clientId !== client.id) throw new NotFoundError("That checkout was not found.");
      if ((req.body ?? {}).action !== "pay") {
        res.redirect("/portal?checkout=cancelled#plans");
        return;
      }
      deliver(fake.completeCheckout(s.done ? "" : String(req.params.id), plans.get(s.planId)));
      res.redirect("/portal?checkout=done#home");
    });

    app.get("/portal/fake-billing", (req, res) => {
      const client = signedIn(req);
      if (!client) throw new NotFoundError("Sign in first.");
      const plan = plans.find(client.planId);
      res.type("html").send(
        demoPage(
          "Test billing",
          `<h1>Test billing</h1><p class="note">Demo mode: this page stands in for Stripe's billing page.</p>
<p>Plan: <strong>${escape(plan?.name ?? "none")}</strong> (${escape(client.status)})</p>
<form method="post">${client.stripeSubscriptionId && client.status !== "canceled" ? '<button name="action" value="cancel">Cancel the plan (test)</button>' : ""}</form>
<a class="btn" href="/portal#billing">Back to the portal</a>`,
        ),
      );
    });

    app.post("/portal/fake-billing", form, (req, res) => {
      const client = signedIn(req);
      if (!client) throw new NotFoundError("Sign in first.");
      if ((req.body ?? {}).action === "cancel") deliver(fake.cancel(client));
      res.redirect("/portal#billing");
    });

    app.get("/portal/fake-invoice/:id", (req, res) => {
      const client = signedIn(req);
      if (!client) throw new NotFoundError("Sign in first.");
      const inv = clients.invoice(client.id, String(req.params.id));
      res.type("html").send(
        demoPage(
          `Invoice ${inv.number ?? ""}`,
          `<h1>Invoice ${escape(inv.number ?? "")}</h1><p class="note">Demo mode: a test invoice, nothing was charged.</p>
<table><tr><td>Billed to</td><td>${escape(client.email)}</td></tr><tr><td>Period</td><td>${escape((inv.periodStart ?? "").slice(0, 10))} to ${escape((inv.periodEnd ?? "").slice(0, 10))}</td></tr>
<tr><td>VAT</td><td>${escape(money(inv.tax, inv.currency))}</td></tr><tr><td><strong>Total</strong></td><td><strong>${escape(money(inv.amountDue, inv.currency))}</strong></td></tr><tr><td>Status</td><td>${escape(inv.status)}</td></tr></table>
<a class="btn" href="/portal#billing">Back to the portal</a>`,
        ),
      );
    });
  }
}

/** The admin's side (behind Cloudflare Access): clients, plans, and a read-only look as a client. */
export function serviceAdmin(app: Express, service: ClientService): void {
  app.get("/api/admin/clients", (_req, res) => {
    res.json(service.adminList());
  });

  app.post("/api/admin/plans", (req, res) => {
    service.plans.save(req.body);
    res.status(201).json(service.adminList());
  });

  app.put("/api/admin/plans/:id", (req, res) => {
    service.plans.save(req.body, String(req.params.id));
    res.json(service.adminList());
  });

  app.post("/api/admin/clients/:id/support-view", (req, res) => {
    const token = service.clients.newSupportLink(idOf(req.params.id));
    res.json({ url: `/portal/auth/support?token=${token}` });
  });
}
