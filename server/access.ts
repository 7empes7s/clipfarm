import { createPublicKey, type JsonWebKey, verify as verifySignature } from "node:crypto";
import type { RequestHandler } from "express";

/** Cloudflare Access adds this header (a signed token) to every request it lets through. */
const ACCESS_HEADER = "cf-access-jwt-assertion";

/** How long the team's signing keys are kept before they are read again. */
const CERTS_TTL_MS = 60 * 60_000;
/** A token signed with a key we do not know makes us read the keys again, at most this often. */
const CERTS_RETRY_MS = 60_000;
/** Clock difference allowed between Cloudflare and this box. */
const CLOCK_SKEW_SEC = 60;

/**
 * Paths that answer without the header: the health check (deploy.sh and clipfarm:check call it on
 * the box) and the files a phone fetches to install the app, which hold nothing private.
 */
function isOpenPath(path: string): boolean {
  return path === "/api/health" || path === "/manifest.webmanifest" || /^\/icons\/[\w-]+\.png$/.test(path);
}

/** Says whether a Cf-Access-Jwt-Assertion token is a real sign-in for this app. Never throws. */
export interface AccessVerifier {
  verify(token: string): Promise<boolean>;
}

export interface AccessOptions {
  /** The Zero Trust team: "myteam" or "myteam.cloudflareaccess.com". */
  teamDomain?: string;
  /** The Access application's audience tag (AUD). */
  aud?: string;
  /**
   * The site's public address. When the team or AUD is not given, both are read from where
   * Cloudflare sends a visitor who is not signed in (its login link names them).
   */
  publicUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

interface AccessApp {
  /** "https://myteam.cloudflareaccess.com" */
  issuer: string;
  aud: string;
}

function teamIssuer(teamDomain: string): string | null {
  const host = teamDomain.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
  if (/^[a-z0-9-]+$/.test(host)) return `https://${host}.cloudflareaccess.com`;
  return /^[a-z0-9-]+\.cloudflareaccess\.com$/.test(host) ? `https://${host}` : null;
}

/**
 * The team and AUD of the Access application in front of `publicUrl`, from the login link an
 * unsigned visitor is sent to: https://<team>.cloudflareaccess.com/cdn-cgi/access/login/<host>?kid=<AUD>.
 */
export async function discoverAccessApp(publicUrl: string, doFetch: typeof fetch = fetch): Promise<AccessApp> {
  const res = await doFetch(publicUrl, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  let login: URL | null = null;
  try {
    login = new URL(res.headers.get("location") ?? "");
  } catch {
    /* handled below */
  }
  const aud = login?.searchParams.get("kid") ?? "";
  if (!login || login.protocol !== "https:" || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(login.hostname) || !/^[0-9a-f]{32,}$/i.test(aud)) {
    throw new Error(`${publicUrl} answered ${res.status} and did not send visitors to a Cloudflare Access login.`);
  }
  return { issuer: `https://${login.hostname}`, aud };
}

function decodePart<T>(part: string): T | null {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Checks Access tokens the way Cloudflare documents it: an RS256 signature by one of the team's
 * keys (https://<team>.cloudflareaccess.com/cdn-cgi/access/certs, cached), issued by that team,
 * for this application (AUD), and not expired. Anything it cannot check is refused.
 */
export function cloudflareAccessVerifier(opts: AccessOptions): AccessVerifier {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? (() => new Date());
  const fixedIssuer = opts.teamDomain ? teamIssuer(opts.teamDomain) : null;
  let app: AccessApp | null = fixedIssuer && opts.aud ? { issuer: fixedIssuer, aud: opts.aud.trim() } : null;
  let keys = new Map<string, JsonWebKey>();
  let keysReadAt = -Infinity;
  let keysTriedAt = -Infinity;
  let discoveryTriedAt = -Infinity;
  let lastProblem = "";

  /** Said once per new reason, so a broken setup is in the log without a line per request. */
  function problem(message: string): void {
    if (message !== lastProblem) console.error(`Access gate: ${message} Every request is refused until this works.`);
    lastProblem = message;
  }

  async function theApp(): Promise<AccessApp | null> {
    if (app) return app;
    if (opts.teamDomain && !fixedIssuer) {
      problem("CF_ACCESS_TEAM_DOMAIN is not a Cloudflare team name.");
      return null;
    }
    if (!opts.publicUrl) {
      problem("set CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD, or CLIPFARM_PUBLIC_URL, so sign-ins can be checked.");
      return null;
    }
    if (now().getTime() - discoveryTriedAt < CERTS_RETRY_MS) return null;
    discoveryTriedAt = now().getTime();
    try {
      const found = await discoverAccessApp(opts.publicUrl, doFetch);
      // A value given in the env wins over what the login link says.
      app = { issuer: fixedIssuer ?? found.issuer, aud: opts.aud?.trim() || found.aud };
      return app;
    } catch (err) {
      problem(err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  async function readKeys(issuer: string): Promise<void> {
    keysTriedAt = now().getTime();
    try {
      const res = await doFetch(`${issuer}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
      const fresh = new Map<string, JsonWebKey>();
      for (const k of body.keys ?? []) if (typeof k.kid === "string" && k.kty === "RSA") fresh.set(k.kid, k);
      if (fresh.size === 0) throw new Error("no keys in the answer");
      keys = fresh;
      keysReadAt = now().getTime();
      lastProblem = "";
    } catch (err) {
      // The old keys stay in use: Cloudflare being slow must not lock the manager out.
      problem(`could not read ${issuer}/cdn-cgi/access/certs (${err instanceof Error ? err.message : String(err)}).`);
    }
  }

  return {
    async verify(token) {
      const parts = token.trim().split(".");
      if (parts.length !== 3 || parts.some((p) => p === "")) return false;
      const header = decodePart<{ alg?: unknown; kid?: unknown }>(parts[0]!);
      const claims = decodePart<{ iss?: unknown; aud?: unknown; exp?: unknown; nbf?: unknown }>(parts[1]!);
      // Only RS256: "none" and HMAC tokens are what a forger would send.
      if (!header || !claims || header.alg !== "RS256" || typeof header.kid !== "string") return false;

      const known = await theApp();
      if (!known) return false;
      const t = now().getTime();
      const stale = t - keysReadAt > CERTS_TTL_MS;
      if ((stale || !keys.has(header.kid)) && t - keysTriedAt >= CERTS_RETRY_MS) await readKeys(known.issuer);
      const jwk = keys.get(header.kid);
      if (!jwk) return false;

      let signed: boolean;
      try {
        signed = verifySignature(
          "RSA-SHA256",
          Buffer.from(`${parts[0]}.${parts[1]}`),
          createPublicKey({ key: jwk, format: "jwk" }),
          Buffer.from(parts[2]!, "base64url"),
        );
      } catch {
        return false;
      }
      if (!signed) return false;

      const nowSec = t / 1000;
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      return (
        claims.iss === known.issuer &&
        audiences.includes(known.aud) &&
        typeof claims.exp === "number" &&
        claims.exp > nowSec - CLOCK_SKEW_SEC &&
        (typeof claims.nbf !== "number" || claims.nbf <= nowSec + CLOCK_SKEW_SEC)
      );
    },
  };
}

/**
 * clipfarm has no login of its own: on the live box Cloudflare Access is the login. With
 * CLIPFARM_REQUIRE_ACCESS=1 a request without a token that Cloudflare Access signed for this app
 * is refused, so a hostname published without its Access application, a call straight to the port
 * or a made-up header cannot approve or post.
 */
export function accessGate(verifier: AccessVerifier): RequestHandler {
  return (req, res, next) => {
    if (isOpenPath(req.path)) {
      next();
      return;
    }
    const token = req.headers[ACCESS_HEADER];
    const checked = typeof token === "string" && token.trim() !== "" ? verifier.verify(token) : Promise.resolve(false);
    checked.then(
      (ok) => {
        if (ok) next();
        else res.status(403).json({ error: "Sign in through Cloudflare Access to use clipfarm." });
      },
      next,
    );
  };
}
