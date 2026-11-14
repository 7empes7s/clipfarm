import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeAccess, signAccessToken, TEST_AUD, TEST_TEAM } from "../test/accessToken.js";
import { type AccessVerifier, cloudflareAccessVerifier } from "./access.js";
import { createApp } from "./app.js";
import { ClipsRepo } from "./clips/repo.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";
import { JobQueue } from "./jobs/queue.js";
import { PicksRepo } from "./picks/repo.js";
import { FakePostingService } from "./publish/fake.js";
import { Publisher } from "./publish/publisher.js";
import { PostsRepo } from "./publish/repo.js";
import { SourcesRepo } from "./sources/repo.js";
import { VodsRepo } from "./vods/repo.js";

const INDEX = "<!doctype html><title>clipfarm</title><div id=root></div>";
const HEADER = "Cf-Access-Jwt-Assertion";
let tmp: string | undefined;

afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

async function appFor(access?: AccessVerifier) {
  tmp = await mkdtemp(join(tmpdir(), "clipfarm-access-"));
  await mkdir(join(tmp, "icons"));
  await writeFile(join(tmp, "index.html"), INDEX);
  await writeFile(join(tmp, "manifest.webmanifest"), "{}");
  await writeFile(join(tmp, "sw.js"), "// sw");
  await writeFile(join(tmp, "icons", "icon-192.png"), "png");
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db);
  const clips = new ClipsRepo(db);
  const posts = new PostsRepo(db);
  return createApp({
    sources,
    vods: new VodsRepo(db),
    picks: new PicksRepo(db),
    queue: new JobQueue(db, { handlers: {} }),
    clips,
    posts,
    publisher: new Publisher({ sources, clips, posts, service: new FakePostingService() }),
    clientDir: tmp,
    access,
  });
}

describe("Cloudflare Access gate (CLIPFARM_REQUIRE_ACCESS=1)", () => {
  it("refuses the gallery, the API and the service worker without the Cf-Access-Jwt-Assertion header", async () => {
    const app = await appFor(fakeAccess().verifier);

    const api = await request(app).get("/api/clips");
    expect(api.status).toBe(403);
    expect(api.body.error).toContain("Cloudflare Access");

    expect((await request(app).post("/api/clips/1/approve")).status).toBe(403);
    expect((await request(app).post("/api/clips/1/posts").send({ platform: "youtube" })).status).toBe(403);
    expect((await request(app).get("/api/clips/1/video")).status).toBe(403);

    const page = await request(app).get("/");
    expect(page.status).toBe(403);
    expect(page.text).not.toContain("root");
    expect((await request(app).get("/sw.js")).status).toBe(403);
    expect((await request(app).get("/review/12")).status).toBe(403);
  });

  it("refuses an empty header", async () => {
    const app = await appFor(fakeAccess().verifier);
    expect((await request(app).get("/api/clips").set(HEADER, "")).status).toBe(403);
    expect((await request(app).get("/api/clips").set(HEADER, "  ")).status).toBe(403);
  });

  it("lets a token signed by the team's key for this app in", async () => {
    const signIn = fakeAccess();
    const app = await appFor(signIn.verifier);
    const api = await request(app).get("/api/clips").set(HEADER, signIn.token());
    expect(api.status).toBe(200);
    expect(api.body).toEqual([]);
    const page = await request(app).get("/").set(HEADER, signIn.token());
    expect(page.status).toBe(200);
    expect(page.text).toBe(INDEX);
    // The team's keys are read once and kept.
    expect(signIn.calls).toEqual([`${TEST_TEAM}/cdn-cgi/access/certs`]);
  });

  it("refuses a made-up header: any text, an unsigned token, or one signed with someone else's key", async () => {
    const signIn = fakeAccess();
    const app = await appFor(signIn.verifier);
    const refused = async (token: string) => (await request(app).get("/api/clips").set(HEADER, token)).status;
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const claims = { iss: TEST_TEAM, aud: [TEST_AUD], exp: Math.floor(Date.now() / 1000) + 3600 };

    expect(await refused("x")).toBe(403);
    expect(await refused("header.payload.signature")).toBe(403);
    // Right claims, no signature ("alg": "none"), with and without the last part.
    expect(await refused(`${part({ alg: "none", kid: "test-key-1" })}.${part(claims)}.`)).toBe(403);
    expect(await refused(`${part({ alg: "none", kid: "test-key-1" })}.${part(claims)}.AAAA`)).toBe(403);
    // Right claims and key name, signed with a key the team does not have.
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(await refused(signAccessToken(privateKey, "test-key-1"))).toBe(403);
    // A real token with its claims changed afterwards.
    const [head, , signature] = signIn.token({ email: "manager@example.com" }).split(".");
    expect(await refused(`${head}.${part({ ...claims, email: "someone@else.example" })}.${signature}`)).toBe(403);
  });

  it("refuses a real signature for another app or team, and one that ran out", async () => {
    const signIn = fakeAccess();
    const app = await appFor(signIn.verifier);
    const status = async (claims: Record<string, unknown>) => (await request(app).get("/api/clips").set(HEADER, signIn.token(claims))).status;
    const nowSec = Math.floor(Date.now() / 1000);

    expect(await status({})).toBe(200);
    expect(await status({ aud: ["0000000000000000000000000000000000000000000000000000000000000000"] })).toBe(403);
    expect(await status({ iss: "https://someone-else.cloudflareaccess.com" })).toBe(403);
    expect(await status({ exp: nowSec - 600 })).toBe(403);
    expect(await status({ exp: undefined })).toBe(403);
    expect(await status({ nbf: nowSec + 600 })).toBe(403);
  });

  it("finds the team and the app by itself from the public address's login link", async () => {
    const signIn = fakeAccess({ discover: true });
    const app = await appFor(signIn.verifier);
    expect((await request(app).get("/api/clips").set(HEADER, signIn.token())).status).toBe(200);
    expect((await request(app).get("/api/clips").set(HEADER, signIn.token({ aud: ["another-app"] }))).status).toBe(403);
    expect(signIn.calls).toEqual(["https://clip.example.test", `${TEST_TEAM}/cdn-cgi/access/certs`]);
  });

  it("refuses everyone, and says why in the log once, when the team's keys cannot be read", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const down = (async () => new Response("down", { status: 503 })) as typeof fetch;
    const app = await appFor(cloudflareAccessVerifier({ teamDomain: "clipfarm-test", aud: TEST_AUD, fetch: down }));
    const token = fakeAccess().token();
    expect((await request(app).get("/api/clips").set(HEADER, token)).status).toBe(403);
    expect((await request(app).get("/api/clips").set(HEADER, token)).status).toBe(403);
    expect(log.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringContaining("could not read https://clipfarm-test.cloudflareaccess.com/cdn-cgi/access/certs (HTTP 503)")]);
    log.mockRestore();
  });

  it("keeps the health check and the install files (manifest, icons) open: they hold nothing private", async () => {
    const app = await appFor(fakeAccess().verifier);
    expect((await request(app).get("/api/health")).body).toEqual({ ok: true });
    expect((await request(app).get("/manifest.webmanifest")).status).toBe(200);
    expect((await request(app).get("/icons/icon-192.png")).status).toBe(200);
    // Look-alike paths are not open.
    expect((await request(app).get("/api/health/../clips")).status).toBe(403);
    expect((await request(app).get("/api/healthz")).status).toBe(403);
    expect((await request(app).get("/icons/../api/clips")).status).toBe(403);
  });

  it("lets the clipping service's pages and client portal through (they sign clients in themselves), and nothing that looks like them", async () => {
    const app = await appFor(fakeAccess().verifier);
    for (const path of ["/service", "/pricing", "/service-terms", "/portal", "/portal/auth/verify?token=x", "/api/portal/me", "/assets/index-abc123.js"]) {
      expect((await request(app).get(path)).status, path).not.toBe(403);
    }
    expect((await request(app).post("/api/stripe/webhook").send("{}")).status).not.toBe(403);
    // The admin's side of the service, and look-alikes, keep the sign-in.
    for (const path of ["/api/admin/clients", "/portalx", "/api/portalx", "/api/portal", "/assets/../api/clips", "/api/stripe/webhook/x"]) {
      expect((await request(app).get(path)).status, path).toBe(403);
    }
    expect((await request(app).post("/api/admin/clients/1/support-view")).status).toBe(403);
  });

  it("is off unless asked for, so dev and the preview work without Cloudflare", async () => {
    const app = await appFor();
    expect((await request(app).get("/api/clips")).status).toBe(200);
    expect((await request(app).get("/")).status).toBe(200);
  });
});

describe("loadConfig: where the server listens and who may call it", () => {
  it("turns the Access gate on only with CLIPFARM_REQUIRE_ACCESS=1", () => {
    expect(loadConfig({}).access).toBeNull();
    expect(loadConfig({ CLIPFARM_REQUIRE_ACCESS: "0" }).access).toBeNull();
    expect(loadConfig({ CLIPFARM_REQUIRE_ACCESS: "1" }).access).not.toBeNull();
  });

  it("binds to HOST when set (127.0.0.1 on the live box)", () => {
    expect(loadConfig({}).host).toBeUndefined();
    expect(loadConfig({ HOST: "127.0.0.1" }).host).toBe("127.0.0.1");
  });
});
