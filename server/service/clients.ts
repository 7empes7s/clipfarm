import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db/index.js";
import type { Client, Invoice, SubscriptionStatus, Usage } from "../../shared/service.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { currentPeriod } from "./limits.js";

interface ClientRow {
  id: number;
  email: string;
  name: string;
  workspace_id: number;
  google_sub: string | null;
  plan_id: string | null;
  status: SubscriptionStatus;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_event_at: number;
  period_start: string | null;
  period_end: string | null;
  auto_approve: number;
  views_reported: number;
  created_at: string;
}

/** A client with the billing fields only the server sees. */
export interface ClientRecord extends Client {
  googleSub: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripeEventAt: number;
  periodStart: string | null;
  periodEnd: string | null;
  viewsReported: number;
}

function toClient(r: ClientRow): ClientRecord {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    workspaceId: r.workspace_id,
    planId: r.plan_id,
    status: r.status,
    autoApprove: r.auto_approve === 1,
    createdAt: r.created_at,
    googleSub: r.google_sub,
    stripeCustomerId: r.stripe_customer_id,
    stripeSubscriptionId: r.stripe_subscription_id,
    stripeEventAt: r.stripe_event_at,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    viewsReported: r.views_reported,
  };
}

/** What the portal may show of a client. */
export function publicClient(c: ClientRecord): Client {
  return { id: c.id, email: c.email, name: c.name, workspaceId: c.workspaceId, planId: c.planId, status: c.status, autoApprove: c.autoApprove, createdAt: c.createdAt };
}

interface InvoiceRow {
  id: string;
  client_id: number;
  number: string | null;
  status: string;
  amount_due: number;
  amount_paid: number;
  tax: number;
  currency: string;
  hosted_url: string | null;
  pdf_url: string | null;
  period_start: string | null;
  period_end: string | null;
  due_at: string | null;
  created_at: string;
}

function toInvoice(r: InvoiceRow): Invoice {
  return {
    id: r.id,
    number: r.number,
    status: r.status,
    amountDue: r.amount_due,
    amountPaid: r.amount_paid,
    tax: r.tax,
    currency: r.currency,
    hostedUrl: r.hosted_url,
    pdfUrl: r.pdf_url,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    dueAt: r.due_at,
    createdAt: r.created_at,
  };
}

export const SESSION_DAYS = 30;
const LINK_MINUTES = 30;
/** Sign-in links one address may ask for in an hour. */
const LINKS_PER_HOUR = 5;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");

/** Checks an email address for sign-up. */
export function parseEmail(raw: unknown): string {
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError("Enter your email address.");
  return email;
}

export interface Session {
  client: ClientRecord;
  readOnly: boolean;
}

export class ClientsRepo {
  constructor(
    private db: Db,
    private now: () => Date = () => new Date(),
  ) {}

  list(): ClientRecord[] {
    return (this.db.prepare("SELECT * FROM clients ORDER BY id").all() as ClientRow[]).map(toClient);
  }

  get(id: number): ClientRecord {
    const row = this.db.prepare("SELECT * FROM clients WHERE id = ?").get(id) as ClientRow | undefined;
    if (!row) throw new NotFoundError("That client was not found.");
    return toClient(row);
  }

  byEmail(email: string): ClientRecord | null {
    const row = this.db.prepare("SELECT * FROM clients WHERE email = ?").get(email) as ClientRow | undefined;
    return row ? toClient(row) : null;
  }

  byCustomer(customerId: string): ClientRecord | null {
    const row = this.db.prepare("SELECT * FROM clients WHERE stripe_customer_id = ?").get(customerId) as ClientRow | undefined;
    return row ? toClient(row) : null;
  }

  byWorkspace(workspaceId: number): ClientRecord | null {
    const row = this.db.prepare("SELECT * FROM clients WHERE workspace_id = ?").get(workspaceId) as ClientRow | undefined;
    return row ? toClient(row) : null;
  }

  /** Signs up a creator: a client and a workspace of their own, in one go. */
  create(email: string, name: string, googleSub: string | null = null): ClientRecord {
    return this.db.transaction(() => {
      const ts = this.now().toISOString();
      const base = (name || email.split("@")[0]!).trim().slice(0, 50) || "Creator";
      // Workspace names are unique: a second "Alex" becomes "Alex (2)".
      let wsName = base;
      for (let i = 2; this.db.prepare("SELECT 1 FROM workspaces WHERE name = ? COLLATE NOCASE").get(wsName); i++) wsName = `${base} (${i})`;
      const ws = this.db.prepare("INSERT INTO workspaces (name, created_at) VALUES (?, ?)").run(wsName, ts);
      const { lastInsertRowid } = this.db
        .prepare("INSERT INTO clients (email, name, workspace_id, google_sub, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(email, base, Number(ws.lastInsertRowid), googleSub, ts);
      return this.get(Number(lastInsertRowid));
    })();
  }

  /** Signs in with Google: by Google's id, else by a verified email (linking it), else a new client. */
  findOrCreateGoogle(sub: string, email: string, name: string): ClientRecord {
    const bySub = this.db.prepare("SELECT * FROM clients WHERE google_sub = ?").get(sub) as ClientRow | undefined;
    if (bySub) return toClient(bySub);
    const known = this.byEmail(email);
    if (known) {
      this.db.prepare("UPDATE clients SET google_sub = ? WHERE id = ?").run(sub, known.id);
      return this.get(known.id);
    }
    return this.create(email, name, sub);
  }

  update(id: number, fields: Partial<Pick<ClientRecord, "planId" | "status" | "stripeCustomerId" | "stripeSubscriptionId" | "stripeEventAt" | "periodStart" | "periodEnd" | "autoApprove" | "viewsReported">>): ClientRecord {
    const cols: Record<string, string> = {
      planId: "plan_id",
      status: "status",
      stripeCustomerId: "stripe_customer_id",
      stripeSubscriptionId: "stripe_subscription_id",
      stripeEventAt: "stripe_event_at",
      periodStart: "period_start",
      periodEnd: "period_end",
      autoApprove: "auto_approve",
      viewsReported: "views_reported",
    };
    const sets = Object.keys(fields).filter((k) => k in cols);
    if (sets.length > 0) {
      const values = sets.map((k) => {
        const v = fields[k as keyof typeof fields];
        return typeof v === "boolean" ? Number(v) : (v ?? null);
      });
      this.db.prepare(`UPDATE clients SET ${sets.map((k) => `${cols[k]} = ?`).join(", ")} WHERE id = ?`).run(...values, id);
    }
    return this.get(id);
  }

  /**
   * A one-time sign-in link for an email address (30 minutes). Returns null when that address asked
   * too often this hour, so nobody can flood an inbox through the form.
   */
  newLoginLink(email: string): string | null {
    const t = this.now();
    const { n } = this.db
      .prepare("SELECT COUNT(*) AS n FROM client_login_links WHERE email = ? AND client_id IS NULL AND created_at > ?")
      .get(email, new Date(t.getTime() - 3600_000).toISOString()) as { n: number };
    if (n >= LINKS_PER_HOUR) return null;
    const token = newToken();
    this.db
      .prepare("INSERT INTO client_login_links (token_hash, email, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run(hash(token), email, new Date(t.getTime() + LINK_MINUTES * 60_000).toISOString(), t.toISOString());
    return token;
  }

  /** A one-time, read-only link into a client's portal, for support (made behind Cloudflare Access). */
  newSupportLink(clientId: number): string {
    const c = this.get(clientId);
    const t = this.now();
    const token = newToken();
    this.db
      .prepare("INSERT INTO client_login_links (token_hash, email, client_id, read_only, expires_at, created_at) VALUES (?, ?, ?, 1, ?, ?)")
      .run(hash(token), c.email, c.id, new Date(t.getTime() + 5 * 60_000).toISOString(), t.toISOString());
    return token;
  }

  /**
   * Uses a sign-in link once: the client (made now on a first sign-in) and whether the session is
   * read-only. Null for an unknown, used or expired link.
   */
  useLoginLink(token: string): { client: ClientRecord; readOnly: boolean } | null {
    if (typeof token !== "string" || token.length < 20) return null;
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM client_login_links WHERE token_hash = ?").get(hash(token)) as
        | { email: string; client_id: number | null; read_only: number; expires_at: string; used_at: string | null }
        | undefined;
      if (!row || row.used_at || new Date(row.expires_at) <= this.now()) return null;
      this.db.prepare("UPDATE client_login_links SET used_at = ? WHERE token_hash = ?").run(this.now().toISOString(), hash(token));
      if (row.client_id !== null) return { client: this.get(row.client_id), readOnly: row.read_only === 1 };
      return { client: this.byEmail(row.email) ?? this.create(row.email, ""), readOnly: false };
    })();
  }

  /** Starts a session; the token goes into the cookie, only its hash is kept. */
  newSession(clientId: number, readOnly = false): { token: string; expires: Date } {
    const expires = new Date(this.now().getTime() + (readOnly ? 3600_000 : SESSION_DAYS * 86_400_000));
    const token = newToken();
    this.db.prepare("DELETE FROM client_sessions WHERE expires_at < ?").run(this.now().toISOString());
    this.db.prepare("INSERT INTO client_sessions (token_hash, client_id, read_only, expires_at) VALUES (?, ?, ?, ?)").run(hash(token), clientId, Number(readOnly), expires.toISOString());
    return { token, expires };
  }

  session(token: string | undefined): Session | null {
    if (!token) return null;
    const row = this.db.prepare("SELECT client_id, read_only, expires_at FROM client_sessions WHERE token_hash = ?").get(hash(token)) as
      | { client_id: number; read_only: number; expires_at: string }
      | undefined;
    if (!row || new Date(row.expires_at) <= this.now()) return null;
    return { client: this.get(row.client_id), readOnly: row.read_only === 1 };
  }

  endSession(token: string | undefined): void {
    if (token) this.db.prepare("DELETE FROM client_sessions WHERE token_hash = ?").run(hash(token));
  }

  /** What the workspace used in the billing period that holds now. Read from what was made, so nothing can drift. */
  usage(client: ClientRecord): Usage {
    const { start, end } = currentPeriod(client.periodStart, client.periodEnd, this.now());
    const p = { ws: client.workspaceId, from: start.toISOString(), to: end.toISOString() };
    const ofWs = "(SELECT id FROM sources WHERE workspace_id = @ws)";
    const one = (sql: string) => (this.db.prepare(sql).get(p) as { n: number | null }).n ?? 0;
    return {
      periodStart: p.from,
      periodEnd: p.to,
      minutes: Math.ceil(one(`SELECT SUM(duration_sec) AS n FROM vods WHERE source_id IN ${ofWs} AND created_at >= @from AND created_at < @to`) / 60),
      clips: one(`SELECT COUNT(*) AS n FROM clips WHERE source_id IN ${ofWs} AND created_at >= @from AND created_at < @to`),
      posts: one(`SELECT COUNT(*) AS n FROM posts WHERE clip_id IN (SELECT id FROM clips WHERE source_id IN ${ofWs}) AND created_at >= @from AND created_at < @to`),
      views: one(`SELECT SUM(views) AS n FROM posts WHERE clip_id IN (SELECT id FROM clips WHERE source_id IN ${ofWs}) AND created_at >= @from AND created_at < @to`),
    };
  }

  /** Every view the workspace's posts ever got: what per-view billing reports to Stripe. */
  totalViews(workspaceId: number): number {
    const row = this.db
      .prepare("SELECT SUM(views) AS n FROM posts WHERE clip_id IN (SELECT id FROM clips WHERE source_id IN (SELECT id FROM sources WHERE workspace_id = ?))")
      .get(workspaceId) as { n: number | null };
    return row.n ?? 0;
  }

  invoices(clientId: number): Invoice[] {
    return (this.db.prepare("SELECT * FROM client_invoices WHERE client_id = ? ORDER BY created_at DESC, id").all(clientId) as InvoiceRow[]).map(toInvoice);
  }

  invoice(clientId: number, id: string): Invoice {
    const row = this.db.prepare("SELECT * FROM client_invoices WHERE client_id = ? AND id = ?").get(clientId, id) as InvoiceRow | undefined;
    if (!row) throw new NotFoundError("That invoice was not found.");
    return toInvoice(row);
  }

  saveInvoice(clientId: number, inv: Invoice): void {
    this.db
      .prepare(
        `INSERT INTO client_invoices (id, client_id, number, status, amount_due, amount_paid, tax, currency, hosted_url, pdf_url, period_start, period_end, due_at, created_at)
         VALUES (@id, @clientId, @number, @status, @amountDue, @amountPaid, @tax, @currency, @hostedUrl, @pdfUrl, @periodStart, @periodEnd, @dueAt, @createdAt)
         ON CONFLICT(id) DO UPDATE SET number = excluded.number, status = excluded.status, amount_due = excluded.amount_due,
           amount_paid = excluded.amount_paid, tax = excluded.tax, hosted_url = excluded.hosted_url, pdf_url = excluded.pdf_url, due_at = excluded.due_at`,
      )
      .run({ ...inv, clientId });
  }

  /** Has an open invoice whose due date passed, or a failed payment. */
  overdue(client: ClientRecord): boolean {
    if (client.status === "past_due" || client.status === "unpaid") return true;
    const row = this.db
      .prepare("SELECT 1 FROM client_invoices WHERE client_id = ? AND status = 'open' AND due_at IS NOT NULL AND due_at < ? LIMIT 1")
      .get(client.id, this.now().toISOString());
    return row !== undefined;
  }

  /** Records a Stripe event id; false when it was seen before (Stripe sends some more than once). */
  markEvent(id: string, type: string): boolean {
    const { changes } = this.db.prepare("INSERT OR IGNORE INTO stripe_events (id, type, received_at) VALUES (?, ?, ?)").run(id, type, this.now().toISOString());
    return changes === 1;
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
