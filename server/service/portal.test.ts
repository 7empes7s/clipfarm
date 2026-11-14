import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { PLATFORMS } from "../../shared/types.js";
import type { AdminClients, PortalMe } from "../../shared/service.js";
import { createApp } from "../app.js";
import { ClipsRepo } from "../clips/repo.js";
import { OutputsRepo } from "../creator/outputs.js";
import { Creator } from "../creator/service.js";
import { UploadsRepo } from "../creator/uploads.js";
import { openDb } from "../db/index.js";
import { JobQueue } from "../jobs/queue.js";
import { PicksRepo } from "../picks/repo.js";
import { FakePostingService } from "../publish/fake.js";
import { Publisher } from "../publish/publisher.js";
import { PostsRepo } from "../publish/repo.js";
import { SourcesRepo } from "../sources/repo.js";
import { WatchlistRepo } from "../sources/watchlist/repo.js";
import { VodsRepo } from "../vods/repo.js";
import { WorkspacesRepo } from "../workspaces/repo.js";
import { FakeGoogleSignIn, FakeMailer } from "./auth.js";
import type { ClientRecord } from "./clients.js";
import { DEMO_WEBHOOK_SECRET } from "./routes.js";
import { ClientService } from "./service.js";
import { FakeStripe } from "./stripe.js";

const NOW = new Date("2026-11-14T10:00:00Z");
const dir = mkdtempSync(join(tmpdir(), "clipfarm-portal-"));
const videoPath = join(dir, "clip.mp4");
writeFileSync(videoPath, "not really a video");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function setup() {
  const clock = () => NOW;
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db, clock);
  const vods = new VodsRepo(db, clock);
  const clips = new ClipsRepo(db, clock);
  const posts = new PostsRepo(db, clock);
  const publisher = new Publisher({ sources, clips, posts, service: new FakePostingService([]), now: clock });
  const queue = new JobQueue(db, { handlers: { ingest: async () => undefined } });
  queue.stop();
  const workspaces = new WorkspacesRepo(db, clock);
  const uploads = new UploadsRepo(db, join(dir, `uploads-${Math.random().toString(36).slice(2)}`), clock);
  const watchRepo = new WatchlistRepo(db, sources, clock);
  const creator = new Creator({ sources, vods, queue, uploads, readFeed: async () => "", watchlist: watchRepo, pollCreator: () => undefined, now: clock });
  const stripe = new FakeStripe(clock);
  const service = new ClientService({ db, workspaces, sources, vods, clips, stripe, now: clock });
  const mailer = new FakeMailer();
  const app = createApp({
    sources,
    vods,
    picks: new PicksRepo(db),
    queue,
    clips,
    posts,
    publisher,
    workspaces,
    creator: { service: creator, uploads, outputs: new OutputsRepo(db, clock) },
    clientService: { service, stripe, mailer, google: new FakeGoogleSignIn(), webhookSecret: () => DEMO_WEBHOOK_SECRET, publicUrl: "https://clip.example", demo: true, now: clock },
  });

  /** A client on a plan, with a source, a clip waiting, a post and an invoice. */
  const client = (email: string, planId = "starter") => {
    let c = service.clients.create(email, email.split("@")[0]!);
    c = service.clients.update(c.id, { planId, status: "active", stripeCustomerId: `cus_${c.id}`, stripeSubscriptionId: `sub_${c.id}` });
    const source = sources.create(
      { creatorName: `${c.name} show`, channelUrls: [], permission: { kind: "own-content", allowedPlatforms: [...PLATFORMS], ownerName: c.name, attestedAt: NOW.toISOString() } },
      c.workspaceId,
    );
    const clip = clips.create({ sourceId: source.id, vodId: null, title: `${c.name} moment`, filePath: videoPath, durationSec: 24 });
    const approved = clips.create({ sourceId: source.id, vodId: null, title: `${c.name} posted`, filePath: videoPath, durationSec: 24 });
    clips.setStatus(approved.id, "approved");
    db.prepare(
      `INSERT INTO posts (clip_id, permission_id, platform, account_id, account_name, service, status, caption, scheduled_at, views, created_at)
       VALUES (?, ?, 'youtube', 'acc', 'acc', 'postiz', 'posted', '', ?, 1500, ?)`,
    ).run(approved.id, source.permissions[0]!.id, new Date(NOW.getTime() + 3600_000).toISOString(), NOW.toISOString());
    service.clients.saveInvoice(c.id, { id: `in_${c.id}`, number: `N-${c.id}`, status: "paid", amountDue: 2223, amountPaid: 2223, tax: 323, currency: "eur", hostedUrl: null, pdfUrl: null, periodStart: null, periodEnd: null, dueAt: null, createdAt: NOW.toISOString() });
    const { token } = service.clients.newSession(c.id);
    return { client: service.clients.get(c.id), source, clip, approved, cookie: `clipfarm_client=${token}` };
  };
  return { db, app, service, stripe, mailer, sources, clips, queue, client };
}

const cookieOf = (res: request.Response) => ((res.headers["set-cookie"] as unknown as string[] | undefined) ?? []).map((c) => c.split(";")[0]).join("; ");

describe("client sign-up and sign-in", () => {
  it("an email link signs a new creator up with a workspace of their own, works once, and leads to the plans", async () => {
    const { app, mailer, service } = setup();
    const sent = await request(app).post("/api/portal/auth/email").send({ email: "New@Example.com" }).expect(200);
    expect(sent.body.sent).toBe(true);
    const link = mailer.lastLink("new@example.com")!;
    expect(sent.body.demoLink).toBe(link);
    const path = link.replace(/^https?:\/\/[^/]+/, "");
    const res = await request(app).get(path).expect(302);
    expect(res.headers.location).toBe("/portal#plans");
    expect(res.headers["set-cookie"]?.[0]).toMatch(/clipfarm_client=.+; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax/);
    const me = (await request(app).get("/api/portal/me").set("Cookie", cookieOf(res)).expect(200)).body as PortalMe;
    expect(me.client).toMatchObject({ email: "new@example.com", planId: null, status: "none" });
    expect(me.blocked).toMatch(/Pick a plan/);
    expect(service.clients.list()).toHaveLength(1);
    // Used once.
    expect((await request(app).get(path).expect(302)).headers.location).toBe("/portal?signin=expired");
  });

  it("the same answer for any address, and no flood of emails to one inbox", async () => {
    const { app, mailer } = setup();
    for (let i = 0; i < 7; i++) await request(app).post("/api/portal/auth/email").send({ email: "a@example.com" }).expect(200);
    expect(mailer.sent).toHaveLength(5);
    await request(app).post("/api/portal/auth/email").send({ email: "not an email" }).expect(400);
  });

  it("Google sign-in counts only with the state this browser was given", async () => {
    const { app } = setup();
    const start = await request(app).get("/portal/auth/google").expect(302);
    const back = await request(app).get(start.headers.location!).set("Cookie", cookieOf(start)).expect(302);
    expect(back.headers.location).toBe("/portal#plans");
    expect((await request(app).get("/api/portal/me").set("Cookie", cookieOf(back)).expect(200)).body.client.email).toBe("creator@example.com");
    // Someone else's callback link, without the state cookie: refused.
    expect((await request(app).get(start.headers.location!).expect(302)).headers.location).toBe("/portal?signin=failed");
  });

  it("every portal call needs a session, and changes must come from the portal itself", async () => {
    const { app, client } = setup();
    expect((await request(app).get("/api/portal/me").expect(200)).body).toBeNull();
    for (const path of ["/api/portal/clips", "/api/portal/sources", "/api/portal/invoices", "/api/portal/dashboard", "/api/portal/accounts"]) {
      await request(app).get(path).expect(401);
    }
    const a = client("a@example.com");
    await request(app).put("/api/portal/settings").set("Cookie", a.cookie).set("Origin", "https://evil.example").send({ autoApprove: true }).expect(403);
    await request(app).put("/api/portal/settings").set("Cookie", a.cookie).set("Content-Type", "text/plain").send("autoApprove=true").expect(415);
  });

  it("signing out ends the session", async () => {
    const { app, client } = setup();
    const a = client("a@example.com");
    await request(app).post("/api/portal/auth/signout").set("Cookie", a.cookie).send({}).expect(200);
    await request(app).get("/api/portal/clips").set("Cookie", a.cookie).expect(401);
  });
});

describe("plans and billing in the portal", () => {
  it("pick a plan, pay on the (fake) Checkout: the plan is on and the invoice shows", async () => {
    const { app, service, mailer } = setup();
    await request(app).post("/api/portal/auth/email").send({ email: "pay@example.com" });
    const signin = await request(app).get(mailer.lastLink("pay@example.com")!.replace(/^https?:\/\/[^/]+/, ""));
    const cookie = cookieOf(signin);
    const { url } = (await request(app).post("/api/portal/checkout").set("Cookie", cookie).send({ planId: "starter" }).expect(200)).body as { url: string };
    expect(url).toMatch(/^\/portal\/fake-checkout\/cs_test_/);
    const page = await request(app).get(url).set("Cookie", cookie).expect(200);
    expect(page.text).toContain("No card is asked for");
    // Another visitor cannot see or pay someone's checkout.
    await request(app).get(url).expect(404);
    const paid = await request(app).post(url).set("Cookie", cookie).type("form").send({ action: "pay" }).expect(302);
    expect(paid.headers.location).toBe("/portal?checkout=done#home");
    const me = (await request(app).get("/api/portal/me").set("Cookie", cookie).expect(200)).body as PortalMe;
    expect(me.plan?.id).toBe("starter");
    expect(me.client.status).toBe("active");
    expect(me.blocked).toBeNull();
    const invoices = (await request(app).get("/api/portal/invoices").set("Cookie", cookie).expect(200)).body;
    expect(invoices).toEqual([expect.objectContaining({ status: "paid", amountDue: 2223, tax: 323 })]);
    expect((await request(app).get(invoices[0].hostedUrl).set("Cookie", cookie).expect(200)).text).toContain("€22.23");
    // A plan in force is changed on the billing page, not a second checkout.
    expect((await request(app).post("/api/portal/checkout").set("Cookie", cookie).send({ planId: "pro" }).expect(200)).body.url).toBe("/portal/fake-billing");
    expect(service.clients.list()[0]!.stripeCustomerId).toMatch(/^cus_test_/);
  });

  it("cancelling on the billing page stops new videos, with a way back", async () => {
    const { app, client } = setup();
    const a = client("a@example.com");
    await request(app).post("/portal/fake-billing").set("Cookie", a.cookie).type("form").send({ action: "cancel" }).expect(302);
    const me = (await request(app).get("/api/portal/me").set("Cookie", a.cookie).expect(200)).body as PortalMe;
    expect(me.client.status).toBe("canceled");
    expect(me.blocked).toMatch(/Your plan has ended/);
  });
});

describe("plan limits in the portal (an upgrade prompt, never a silent failure)", () => {
  const link = { name: "My show", ownerName: "Me", attested: true, link: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" };

  it("a client on a plan adds a video: it is queued in their own workspace", async () => {
    const { app, client, queue } = setup();
    const a = client("a@example.com");
    const res = await request(app).post("/api/portal/sources").set("Cookie", a.cookie).send(link).expect(201);
    expect(res.body.videos).toHaveLength(1);
    expect(queue.queued("ingest")).toHaveLength(1);
  });

  it("without a plan, or with the minutes used up, adding a video answers 402 with what to do", async () => {
    const { app, client, service, db } = setup();
    const a = client("a@example.com");
    service.clients.update(a.client.id, { status: "none" });
    expect((await request(app).post("/api/portal/sources").set("Cookie", a.cookie).send(link).expect(402)).body.error).toMatch(/Pick a plan/);
    service.clients.update(a.client.id, { status: "active" });
    db.prepare("INSERT INTO vods (source_id, url, status, duration_sec, created_at) VALUES (?, 'x', 'ready', ?, ?)").run(a.source.id, 120 * 60, NOW.toISOString());
    expect((await request(app).post("/api/portal/sources").set("Cookie", a.cookie).send(link).expect(402)).body.error).toMatch(/used all 120 minutes of Starter.*Upgrade/);
  });

  it("the same check stops a client's video that comes in another way (a watched channel) before any work", () => {
    const { client, service, db } = setup();
    const a = client("a@example.com");
    const vod = Number(db.prepare("INSERT INTO vods (source_id, url, status, duration_sec, created_at) VALUES (?, 'x', 'queued', ?, ?)").run(a.source.id, 7300, NOW.toISOString()).lastInsertRowid);
    expect(() => service.assertVodAllowed(vod)).toThrow(/used all 120 minutes/);
    // Our own workspace has no plan to run out of.
    expect(service.problemFor(1)).toBeNull();
  });

  it("a platform outside the plan, and a locked brand kit, say to upgrade", async () => {
    const { app, client, service } = setup();
    const a = client("a@example.com");
    expect((await request(app).post("/api/portal/accounts/connect").set("Cookie", a.cookie).send({ platform: "instagram" }).expect(402)).body.error).toMatch(/does not post to Instagram/);
    service.plans.save({ ...service.plans.get("starter"), brandTemplates: 0 }, "starter");
    expect((await request(app).put("/api/portal/brand").set("Cookie", a.cookie).send({ color: "#112233" }).expect(402)).body.error).toMatch(/no brand kit/);
  });
});

describe("the client's own clips, dashboard and calendar", () => {
  it("approve and reject; auto-approve takes the waiting ones", async () => {
    const { app, client, clips } = setup();
    const a = client("a@example.com");
    expect((await request(app).post(`/api/portal/clips/${a.clip.id}/approve`).set("Cookie", a.cookie).send({}).expect(200)).body.status).toBe("approved");
    const c2 = clips.create({ sourceId: a.source.id, vodId: null, title: "two", filePath: videoPath, durationSec: 20 });
    expect((await request(app).post(`/api/portal/clips/${c2.id}/reject`).set("Cookie", a.cookie).send({ reason: "boring" }).expect(200)).body.status).toBe("rejected");
    const c3 = clips.create({ sourceId: a.source.id, vodId: null, title: "three", filePath: videoPath, durationSec: 20 });
    const me = (await request(app).put("/api/portal/settings").set("Cookie", a.cookie).send({ autoApprove: true }).expect(200)).body as PortalMe;
    expect(me.client.autoApprove).toBe(true);
    expect(clips.get(c3.id).status).toBe("approved");
  });

  it("the dashboard and calendar hold the client's numbers only", async () => {
    const { app, client } = setup();
    const a = client("a@example.com");
    client("b@example.com");
    const dash = (await request(app).get("/api/portal/dashboard").set("Cookie", a.cookie).expect(200)).body;
    expect(dash).toMatchObject({ clipsWaiting: 1, clipsApproved: 1, posts: 1, views: 1500, byPlatform: [{ platform: "youtube", posts: 1, views: 1500 }] });
    expect(dash.topClips).toEqual([{ id: a.approved.id, title: "a posted", views: 1500 }]);
    const cal = (await request(app).get(`/api/portal/calendar?from=${NOW.toISOString()}&to=${new Date(NOW.getTime() + 86_400_000).toISOString()}`).set("Cookie", a.cookie).expect(200)).body;
    expect(cal.items.map((i: { clipId: number }) => i.clipId)).toEqual([a.approved.id]);
  });
});

describe("workspace isolation: another client's id is a 404 on every client route", () => {
  const routes: { name: string; call: (app: ReturnType<typeof setup>["app"], cookie: string, b: ReturnType<ReturnType<typeof setup>["client"]>) => request.Test }[] = [
    { name: "POST /api/portal/clips/:id/approve", call: (app, cookie, b) => request(app).post(`/api/portal/clips/${b.clip.id}/approve`).set("Cookie", cookie).send({}) },
    { name: "POST /api/portal/clips/:id/reject", call: (app, cookie, b) => request(app).post(`/api/portal/clips/${b.clip.id}/reject`).set("Cookie", cookie).send({}) },
    { name: "GET /api/portal/clips/:id/video", call: (app, cookie, b) => request(app).get(`/api/portal/clips/${b.clip.id}/video`).set("Cookie", cookie) },
    { name: "DELETE /api/portal/sources/:id", call: (app, cookie, b) => request(app).delete(`/api/portal/sources/${b.source.id}`).set("Cookie", cookie) },
    { name: "GET /api/portal/invoices/:id", call: (app, cookie, b) => request(app).get(`/api/portal/invoices/in_${b.client.id}`).set("Cookie", cookie) },
    {
      name: "POST /api/portal/sources (into another's source)",
      call: (app, cookie, b) => request(app).post("/api/portal/sources").set("Cookie", cookie).send({ sourceId: b.source.id, name: "x", ownerName: "x", attested: true, link: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
    },
  ];

  for (const route of routes) {
    it(route.name, async () => {
      const { app, client, clips, sources } = setup();
      const a = client("a@example.com");
      const b = client("b@example.com");
      await route.call(app, a.cookie, b).expect(404);
      // Nothing of B's changed.
      expect(clips.get(b.clip.id).status).toBe("pending");
      expect(sources.list(b.client.workspaceId)).toHaveLength(1);
      // The same call on A's own id is not a 404 (removing a source with posts is refused for its own reason), so the 404 is the guard.
      const own = await route.call(app, a.cookie, a);
      expect(own.status).not.toBe(404);
    });
  }

  it("lists never show another client's things, nor ours", async () => {
    const { app, client, sources } = setup();
    sources.create({ creatorName: "Our campaign creator", channelUrls: [], permission: { kind: "own-content", allowedPlatforms: ["youtube"], ownerName: "Us", attestedAt: NOW.toISOString() } }, 1);
    const a = client("a@example.com");
    const b = client("b@example.com");
    const clipsA = (await request(app).get("/api/portal/clips").set("Cookie", a.cookie).expect(200)).body as { sourceId: number }[];
    expect(new Set(clipsA.map((c) => c.sourceId))).toEqual(new Set([a.source.id]));
    const src = (await request(app).get("/api/portal/sources").set("Cookie", a.cookie).expect(200)).body;
    expect(src.sources.map((s: { id: number }) => s.id)).toEqual([a.source.id]);
    expect((await request(app).get("/api/portal/invoices").set("Cookie", a.cookie).expect(200)).body.map((i: { id: string }) => i.id)).toEqual([`in_${a.client.id}`]);
    expect(b.source.id).not.toBe(a.source.id);
  });
});

describe("the admin's client list and support view", () => {
  it("lists each client with plan, usage, MRR and overdue", async () => {
    const { app, client, service } = setup();
    const a = client("a@example.com", "pro");
    client("b@example.com");
    service.clients.update(a.client.id, { status: "past_due" });
    const list = (await request(app).get("/api/admin/clients").expect(200)).body as AdminClients;
    expect(list.clients.map((c) => [c.email, c.planName, c.overdue, c.mrrCents])).toEqual([
      ["a@example.com", "Pro", true, 4900],
      ["b@example.com", "Starter", false, 1900],
    ]);
    expect(list.mrr).toEqual([{ currency: "eur", cents: 6800 }]);
    expect(list.overdue).toBe(1);
    expect(list.clients[0]!.usage).toMatchObject({ clips: 2, posts: 1, views: 1500 });
  });

  it("the support view sees the client's portal and cannot change anything", async () => {
    const { app, client, clips } = setup();
    const a = client("a@example.com");
    const { url } = (await request(app).post(`/api/admin/clients/${a.client.id}/support-view`).send({}).expect(200)).body as { url: string };
    const res = await request(app).get(url).expect(302);
    const cookie = cookieOf(res);
    const me = (await request(app).get("/api/portal/me").set("Cookie", cookie).expect(200)).body as PortalMe;
    expect(me).toMatchObject({ readOnly: true, client: { email: "a@example.com" } });
    expect((await request(app).post(`/api/portal/clips/${a.clip.id}/approve`).set("Cookie", cookie).send({}).expect(403)).body.error).toMatch(/read-only/);
    await request(app).post("/api/portal/checkout").set("Cookie", cookie).send({ planId: "pro" }).expect(403);
    expect(clips.get(a.clip.id).status).toBe("pending");
    // The link works once.
    expect((await request(app).get(url).expect(302)).headers.location).toBe("/portal?signin=expired");
  });

  it("plans can be changed and added", async () => {
    const { app } = setup();
    const added = (await request(app).post("/api/admin/plans").send({ id: "plus", name: "Plus", kind: "self-serve", monthlyCents: 2900, platforms: ["youtube"], minutes: 300 }).expect(201)).body as AdminClients;
    expect(added.plans.map((p) => p.id)).toContain("plus");
    await request(app).put("/api/admin/plans/plus").send({ name: "Plus", kind: "self-serve", monthlyCents: 0, platforms: ["youtube"] }).expect(400);
  });
});

/** Per-view billing: only the views gained since the last report go to Stripe. */
describe("metered views", () => {
  it("reports the new views once", async () => {
    const { client, service, stripe, db } = setup();
    const a = client("a@example.com", "managed-views");
    expect(await service.reportViews()).toBe(1);
    expect(stripe.meterEvents).toEqual([{ customerId: a.client.stripeCustomerId, value: 1500, identifier: `client-${a.client.id}-views-1500` }]);
    expect(await service.reportViews()).toBe(0);
    db.prepare("UPDATE posts SET views = 2100").run();
    await service.reportViews();
    expect(stripe.meterEvents.at(-1)).toMatchObject({ value: 600 });
    expect((service.clients.get(a.client.id) as ClientRecord).viewsReported).toBe(2100);
  });
});
