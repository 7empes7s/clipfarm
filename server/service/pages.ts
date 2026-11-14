import type { Express } from "express";
import { PLATFORM_LABELS } from "../../shared/types.js";
import { PLAN_KIND_LABELS, type Plan, planPrice } from "../../shared/service.js";
import { SERVICE_PAGE_PATHS } from "../access.js";
import { APP_NAME, LOGO, STYLE } from "../publicPages.js";
import type { PlansRepo } from "./plans.js";

/** The day the service terms took effect. */
export const SERVICE_TERMS_DATE = "14 November 2026";

const [SERVICE, PRICING, SERVICE_TERMS] = SERVICE_PAGE_PATHS;

const EXTRA = `
.cta{display:flex;flex-wrap:wrap;gap:var(--s2);margin:var(--s4) 0}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 var(--s4);border-radius:var(--radius-small);border:1px solid var(--line);background:var(--surface);color:var(--ink);font-weight:700;text-decoration:none}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.plans{display:grid;gap:var(--s3);grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));margin:var(--s4) 0}
.plan{padding:var(--s4);border:1px solid var(--line);border-radius:var(--radius);background:var(--surface)}
.plan h2{margin:0 0 var(--s1)}
.plan .price{font:700 var(--t-lg)/1.2 var(--font-head);margin-bottom:var(--s2)}
.plan .kind{color:var(--muted);font-size:var(--t-sm);margin:0}
.plan ul{padding-left:var(--s4)}
.sheet.wide{max-width:64rem}
`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(path: string, title: string, description: string, body: string, email: string, wide = false): string {
  const mail = `<a href="mailto:${email}">${email}</a>`;
  const link = (p: string, label: string) => `<a href="${p}"${p === path ? ' aria-current="page"' : ""}>${label}</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="description" content="${esc(description)}">
<title>${APP_NAME}: ${esc(title)}</title>
<style>${STYLE}${EXTRA}</style>
</head>
<body>
<div class="sheet${wide ? " wide" : ""}">
<header class="top">
<a class="brand" href="${SERVICE}">${LOGO}${APP_NAME}</a>
<nav aria-label="Pages">${link(SERVICE, "Clipping service")}${link(PRICING, "Pricing")}${link("/portal", "Sign in")}</nav>
</header>
<main>
${body}
</main>
<footer>
<p>${APP_NAME}. Questions: ${mail}</p>
<p><a href="${SERVICE}">Clipping service</a> | <a href="${PRICING}">Pricing</a> | <a href="${SERVICE_TERMS}">Service terms</a> | <a href="/privacy">Privacy Policy</a></p>
</footer>
</div>
</body>
</html>
`;
}

function planCard(p: Plan): string {
  const items = [
    p.minutes === null ? "No limit on video minutes" : `${p.minutes} minutes of video a month`,
    p.clips === null ? "As many clips as the videos give" : `Up to ${p.clips} clips a month`,
    `Posts to ${p.platforms.map((x) => PLATFORM_LABELS[x]).join(", ")}`,
    p.brandTemplates > 0 ? `Your brand kit (${p.brandTemplates} template${p.brandTemplates === 1 ? "" : "s"})` : "Standard captions",
    p.kind === "managed" ? "We post for you and report the views" : "You approve each clip, or switch on auto-approve",
  ];
  return `<article class="plan"><p class="kind">${PLAN_KIND_LABELS[p.kind]}</p><h2>${esc(p.name)}</h2><p class="price">${esc(planPrice(p))}</p><p>${esc(p.blurb)}</p>
<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul><a class="btn primary" href="/portal?plan=${encodeURIComponent(p.id)}">Start with ${esc(p.name)}</a></article>`;
}

const landing = `<h1>Your streams, cut into Shorts while you sleep</h1>
<p class="lead">Send us your channel or a video link. We find the best moments, cut them to 9:16 with big word-by-word captions in your colours, and line them up for TikTok, YouTube Shorts and Reels.</p>
<div class="cta"><a class="btn primary" href="/portal">Sign up free</a><a class="btn" href="${PRICING}">See the prices</a></div>
<h2>How it works</h2>
<ul>
<li><strong>Connect your channel.</strong> Paste a YouTube, Twitch or Kick link. New videos are picked up by themselves.</li>
<li><strong>Clips come to your phone.</strong> Approve or reject each one with a tap, or let them approve themselves.</li>
<li><strong>They post on schedule.</strong> Connect your own accounts, or pick a managed plan and we post for you.</li>
<li><strong>See what works.</strong> Views per platform and your best clips, on one screen.</li>
</ul>
<h2>Only your own videos</h2>
<p>You confirm that you own the videos or have the owner's OK. Every clip keeps that record, and nothing posts without it.</p>`;

const terms = (mail: string) => `<h1>Clipping service terms</h1>
<p class="dated">Effective ${SERVICE_TERMS_DATE}</p>
<p class="lead">These terms cover the paid clipping service for creators. Our <a href="/terms">Terms of Use</a> and <a href="/privacy">Privacy Policy</a> apply as well.</p>
<h2>What you get</h2>
<p>We turn the videos you send or the channels you connect into short vertical clips, within the limits of your plan (minutes of video and clips a month, platforms, brand templates). On a managed plan we also post the clips for you.</p>
<h2>Your videos</h2>
<ul>
<li>Send only videos you own, or that the owner allows you to have clipped. You confirm this for each channel or video.</li>
<li>The clips stay yours. We do not use your videos for anyone else.</li>
<li>No leaks, no game endings or spoilers, nothing unlawful.</li>
</ul>
<h2>Payment</h2>
<ul>
<li>Plans are paid monthly in advance through Stripe. Per-view plans are billed after the month for the views the clips got. VAT is added where it applies.</li>
<li>We never see or keep your card: Stripe handles it.</li>
<li>You can change or cancel your plan at any time in Billing. A cancelled plan runs to the end of the month you paid for.</li>
<li>When a payment fails, new videos wait until it goes through.</li>
</ul>
<h2>Your data</h2>
<p>We keep your email address, your plan and invoices, your videos' clips and their numbers, and nothing else about you. Stripe keeps the payment details. To close your account and have your data deleted, write to ${mail}.</p>
<h2>Limits</h2>
<p>We cannot promise views or earnings: the platforms decide what they show. As far as the law allows, we are liable at most for what you paid in the last three months.</p>
<h2>Contact</h2>
<p>Write to ${mail}.</p>`;

/** The service's public pages: landing, pricing (from the plans in force) and the service terms. */
export function servicePages(app: Express, supportEmail: string | null, plans: PlansRepo): void {
  const send = (res: import("express").Response, html: string, cache: boolean) =>
    res
      .status(200)
      .set({ "Cache-Control": cache ? "public, max-age=300" : "no-cache", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" })
      .type("html")
      .send(html);
  const ready = (res: import("express").Response): string | null => {
    if (!supportEmail) res.status(503).type("text/plain").send("This page is not set up yet.");
    return supportEmail;
  };
  app.get(SERVICE, (_req, res) => {
    const email = ready(res);
    if (email) send(res, page(SERVICE, "Clipping service", "Your streams cut into captioned vertical clips for TikTok, Shorts and Reels.", landing, email), true);
  });
  app.get(PRICING, (_req, res) => {
    const email = ready(res);
    if (!email) return;
    const active = plans.list().filter((p) => p.active);
    const body = `<h1>Pricing</h1><p class="lead">Pick a plan when you sign up. Change or cancel it at any time.</p><div class="plans">${active.map(planCard).join("")}</div>
<p class="dated">Prices before VAT. VAT is added at checkout where it applies.</p>`;
    send(res, page(PRICING, "Pricing", "Monthly plans by minutes of video, or managed plans by views.", body, email, true), false);
  });
  app.get(SERVICE_TERMS, (_req, res) => {
    const email = ready(res);
    if (email) send(res, page(SERVICE_TERMS, "Service terms", "The terms of the paid clipping service.", terms(`<a href="mailto:${email}">${email}</a>`), email), true);
  });
}
