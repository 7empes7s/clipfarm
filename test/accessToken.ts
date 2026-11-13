import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { type AccessVerifier, cloudflareAccessVerifier } from "../server/access.js";

export const TEST_TEAM = "https://clipfarm-test.cloudflareaccess.com";
export const TEST_AUD = "4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2";

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** A token signed like Cloudflare Access signs them (RS256), with a key made for the test. */
export function signAccessToken(key: KeyObject, kid: string, claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: "RS256", kid, typ: "JWT", ...header })}.${b64({ iss: TEST_TEAM, aud: [TEST_AUD], iat: nowSec, exp: nowSec + 3600, email: "manager@example.com", ...claims })}`;
  return `${body}.${createSign("RSA-SHA256").update(body).sign(key).toString("base64url")}`;
}

/**
 * A stand-in for the Cloudflare team: a test key pair, its certs endpoint and the login redirect
 * of the public site, all answered in-process. `calls` lists every address that was asked.
 */
export function fakeAccess(opts: { discover?: boolean; now?: () => Date } = {}): {
  verifier: AccessVerifier;
  token: (claims?: Record<string, unknown>, header?: Record<string, unknown>) => string;
  calls: string[];
} {
  const kid = "test-key-1";
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const calls: string[] = [];
  const fetchFake = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url === `${TEST_TEAM}/cdn-cgi/access/certs`) {
      return Response.json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" }] });
    }
    if (url === "https://clip.example.test") {
      return new Response(null, { status: 302, headers: { location: `${TEST_TEAM}/cdn-cgi/access/login/clip.example.test?kid=${TEST_AUD}&redirect_url=%2F` } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const verifier = cloudflareAccessVerifier(
    opts.discover
      ? { publicUrl: "https://clip.example.test", fetch: fetchFake, now: opts.now }
      : { teamDomain: "clipfarm-test", aud: TEST_AUD, fetch: fetchFake, now: opts.now },
  );
  return { verifier, token: (claims, header) => signAccessToken(privateKey, kid, claims, header), calls };
}
