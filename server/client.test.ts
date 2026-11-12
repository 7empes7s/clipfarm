import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { clientBuildProblem, createApp } from "./app.js";
import { ClipsRepo } from "./clips/repo.js";
import { openDb } from "./db/index.js";
import { JobQueue } from "./jobs/queue.js";
import { PicksRepo } from "./picks/repo.js";
import { FakePostingService } from "./publish/fake.js";
import { Publisher } from "./publish/publisher.js";
import { PostsRepo } from "./publish/repo.js";
import { SourcesRepo } from "./sources/repo.js";
import { VodsRepo } from "./vods/repo.js";

const INDEX = "<!doctype html><title>clipfarm</title><div id=root></div>";
let tmp: string | undefined;

afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

/** A built layout like the floor's: the checkout sits under a dot-folder (~/.cubefarm/...). */
async function builtLayout({ withClient }: { withClient: boolean }): Promise<string> {
  tmp = await mkdtemp(join(tmpdir(), "clipfarm-built-"));
  const clientDir = join(tmp, ".floor", "dist", "client");
  if (withClient) {
    await mkdir(join(clientDir, "assets"), { recursive: true });
    await writeFile(join(clientDir, "index.html"), INDEX);
    await writeFile(join(clientDir, "assets", "app.js"), "console.log('app')");
  }
  return clientDir;
}

function appFor(clientDir: string) {
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
    clientDir,
  });
}

describe("built client", () => {
  it("serves the app at /, its assets, and client routes through the fallback", async () => {
    const app = appFor(await builtLayout({ withClient: true }));

    const root = await request(app).get("/");
    expect(root.status).toBe(200);
    expect(root.text).toBe(INDEX);

    const asset = await request(app).get("/assets/app.js");
    expect(asset.status).toBe(200);
    expect(asset.headers["content-type"]).toContain("javascript");

    const deep = await request(app).get("/review/12");
    expect(deep.status).toBe(200);
    expect(deep.headers["content-type"]).toContain("text/html");
    expect(deep.text).toBe(INDEX);
  });

  it("keeps /api as JSON", async () => {
    const app = appFor(await builtLayout({ withClient: true }));
    expect((await request(app).get("/api/health")).body).toEqual({ ok: true });
    const missing = await request(app).get("/api/nope");
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: "Not found." });
  });

  it("says the client build is missing instead of 'Cannot GET /'", async () => {
    const clientDir = await builtLayout({ withClient: false });
    expect(clientBuildProblem(clientDir)).toContain("npm run build");

    const app = appFor(clientDir);
    const res = await request(app).get("/");
    expect(res.status).toBe(503);
    expect(res.text).toContain("npm run build");
    expect(res.text).not.toContain("Cannot GET");
    expect(res.text).not.toContain(clientDir);
  });

  it("starts serving once the client is built, without a restart", async () => {
    const clientDir = await builtLayout({ withClient: false });
    const app = appFor(clientDir);
    expect((await request(app).get("/")).status).toBe(503);

    await mkdir(clientDir, { recursive: true });
    await writeFile(join(clientDir, "index.html"), INDEX);
    expect(clientBuildProblem(clientDir)).toBeNull();
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toBe(INDEX);
  });
});
