import { HttpError } from "../errors.js";

/** Sends the sign-in emails. */
export interface Mailer {
  send(message: { to: string; subject: string; text: string }): Promise<void>;
}

/** Keeps what it would send (tests, demo mode): the portal's demo shows the last link. */
export class FakeMailer implements Mailer {
  readonly sent: { to: string; subject: string; text: string }[] = [];
  async send(message: { to: string; subject: string; text: string }) {
    this.sent.push(message);
  }
  /** The newest sign-in link sent to an address. */
  lastLink(to: string): string | null {
    const msg = [...this.sent].reverse().find((m) => m.to.toLowerCase() === to.toLowerCase());
    return msg?.text.match(/https?:\/\/\S+|\/portal\/auth\/verify\?\S+/)?.[0] ?? null;
  }
}

/** Email through Resend's API (RESEND_API_KEY, SERVICE_EMAIL_FROM). The key is only in the header. */
export class ResendMailer implements Mailer {
  constructor(
    private key: () => string | undefined,
    private from: () => string | undefined,
    private doFetch: typeof fetch = fetch,
  ) {}

  async send({ to, subject, text }: { to: string; subject: string; text: string }) {
    const key = this.key();
    const from = this.from();
    if (!key || !from) throw new HttpError(503, "Email sign-in is not set up yet. Use Google, or try again later.");
    const res = await this.doFetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new HttpError(502, "The sign-in email could not be sent. Try again in a minute.");
  }
}

export interface GoogleProfile {
  sub: string;
  email: string;
  name: string;
}

/** "Sign in with Google" (OpenID Connect, authorization code). */
export interface GoogleSignIn {
  available(): boolean;
  authorizeUrl(state: string, redirectUri: string): string;
  exchange(code: string, redirectUri: string): Promise<GoogleProfile>;
}

/** Google's sign-in with the client's OAuth app (CLIENT_GOOGLE_CLIENT_ID / CLIENT_GOOGLE_CLIENT_SECRET). */
export class HttpGoogleSignIn implements GoogleSignIn {
  constructor(
    private id: () => string | undefined,
    private secret: () => string | undefined,
    private doFetch: typeof fetch = fetch,
  ) {}

  available(): boolean {
    return !!this.id() && !!this.secret();
  }

  authorizeUrl(state: string, redirectUri: string): string {
    const q = new URLSearchParams({ client_id: this.id() ?? "", redirect_uri: redirectUri, response_type: "code", scope: "openid email profile", state, prompt: "select_account" });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  }

  async exchange(code: string, redirectUri: string): Promise<GoogleProfile> {
    const res = await this.doFetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: this.id() ?? "", client_secret: this.secret() ?? "", redirect_uri: redirectUri, grant_type: "authorization_code" }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { id_token?: string };
    if (!res.ok || !body.id_token) throw new HttpError(502, "Google did not finish the sign-in. Try again.");
    // The ID token came straight from Google's token endpoint over TLS, so its claims can be read
    // without checking the signature (Google's OpenID Connect guide says so).
    const claims = JSON.parse(Buffer.from(body.id_token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      sub?: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
      aud?: string;
    };
    if (!claims.sub || !claims.email || claims.email_verified !== true || claims.aud !== this.id()) throw new HttpError(400, "Google did not confirm that email address.");
    return { sub: claims.sub, email: claims.email.toLowerCase(), name: claims.name ?? "" };
  }
}

/** Google for tests and demo mode: the "consent" comes straight back as a demo creator. */
export class FakeGoogleSignIn implements GoogleSignIn {
  constructor(readonly profile: GoogleProfile = { sub: "fake-google-1", email: "creator@example.com", name: "Demo Creator" }) {}
  available(): boolean {
    return true;
  }
  authorizeUrl(state: string): string {
    return `/portal/auth/google/callback?code=fake&state=${encodeURIComponent(state)}`;
  }
  async exchange(code: string): Promise<GoogleProfile> {
    if (code !== "fake") throw new HttpError(400, "Google did not finish the sign-in. Try again.");
    return this.profile;
  }
}
