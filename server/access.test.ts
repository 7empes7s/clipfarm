import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
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
const JWT = "header.payload.signature";
let tmp: string | undefined;

afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

async function appFor(requireAccess: boolean) {
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
    requireAccess,
  });
}

describe("Cloudflare Access gate (CLIPFARM_REQUIRE_ACCESS=1)", () => {
  it("refuses the gallery, the API and the service worker without the Cf-Access-Jwt-Assertion header", async () => {
    const app = await appFor(true);

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
    const app = await appFor(true);
    expect((await request(app).get("/api/clips").set("Cf-Access-Jwt-Assertion", "")).status).toBe(403);
    expect((await request(app).get("/api/clips").set("Cf-Access-Jwt-Assertion", "  ")).status).toBe(403);
  });

  it("lets requests that came through Access in", async () => {
    const app = await appFor(true);
    const api = await request(app).get("/api/clips").set("Cf-Access-Jwt-Assertion", JWT);
    expect(api.status).toBe(200);
    expect(api.body).toEqual([]);
    const page = await request(app).get("/").set("Cf-Access-Jwt-Assertion", JWT);
    expect(page.status).toBe(200);
    expect(page.text).toBe(INDEX);
  });

  it("keeps the health check and the install files (manifest, icons) open: they hold nothing private", async () => {
    const app = await appFor(true);
    expect((await request(app).get("/api/health")).body).toEqual({ ok: true });
    expect((await request(app).get("/manifest.webmanifest")).status).toBe(200);
    expect((await request(app).get("/icons/icon-192.png")).status).toBe(200);
    // Look-alike paths are not open.
    expect((await request(app).get("/api/health/../clips")).status).toBe(403);
    expect((await request(app).get("/api/healthz")).status).toBe(403);
    expect((await request(app).get("/icons/../api/clips")).status).toBe(403);
  });

  it("is off unless asked for, so dev and the preview work without Cloudflare", async () => {
    const app = await appFor(false);
    expect((await request(app).get("/api/clips")).status).toBe(200);
    expect((await request(app).get("/")).status).toBe(200);
  });
});

describe("loadConfig: where the server listens and who may call it", () => {
  it("turns the Access gate on only with CLIPFARM_REQUIRE_ACCESS=1", () => {
    expect(loadConfig({}).requireAccess).toBe(false);
    expect(loadConfig({ CLIPFARM_REQUIRE_ACCESS: "0" }).requireAccess).toBe(false);
    expect(loadConfig({ CLIPFARM_REQUIRE_ACCESS: "1" }).requireAccess).toBe(true);
  });

  it("binds to HOST when set (127.0.0.1 on the live box)", () => {
    expect(loadConfig({}).host).toBeUndefined();
    expect(loadConfig({ HOST: "127.0.0.1" }).host).toBe("127.0.0.1");
  });
});
