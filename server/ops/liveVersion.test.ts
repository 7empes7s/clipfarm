import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { openRuntime } from "../runtime.js";
import { readLiveVersion } from "./liveVersion.js";

const STATUS = {
  sha: "149b3019e0c4a6f5b1d27c3e8a9f0b1c2d3e4f50",
  at: "2026-11-13T08:10:00Z",
  result: "rolled back",
  reason: "Update 149b301 did not start: went back to 20261113-070000-ab5e7cf0aa11, which is live and healthy again.",
  keys: [
    { name: "OpenAI", state: "Working" },
    { name: "Twitch", state: "Failed" },
    { name: "YouTube", state: "Not set" },
  ],
  check: { ok: false, problems: ["NOT OK: nothing listens on 127.0.0.1:5310."] },
  postiz: { state: "not healthy", detail: "Postiz did not answer on port 5300 within 600 s." },
};

describe("the auto-deploy status file", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clipfarm-live-version-test-"));
    file = join(dir, "deploy-status.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is read as it was written", () => {
    writeFileSync(file, JSON.stringify(STATUS));
    expect(readLiveVersion(file)).toEqual(STATUS);
  });

  it("is null when missing, broken or not a deploy status", () => {
    expect(readLiveVersion(file)).toBeNull();
    for (const text of ["", "{", "null", "[]", JSON.stringify({ ...STATUS, result: "exploded" }), JSON.stringify({ ...STATUS, sha: "<b>x</b>" }), JSON.stringify({ ...STATUS, at: "soon" })]) {
      writeFileSync(file, text);
      expect(readLiveVersion(file), text).toBeNull();
    }
  });

  it("keeps only names and known states: anything else in the file is dropped", () => {
    writeFileSync(
      file,
      JSON.stringify({
        ...STATUS,
        secret: "sk-proj-shouldNeverBeServed",
        keys: [{ name: "OpenAI", state: "Working", reason: "sk-proj-shouldNeverBeServed" }, { name: "Kick", state: "Leaking" }, "x", null],
        check: { ok: "yes", problems: ["a", 5] },
        postiz: { state: "on fire" },
      }),
    );
    const read = readLiveVersion(file)!;
    expect(read.keys).toEqual([{ name: "OpenAI", state: "Working" }]);
    expect(read.check).toEqual({ ok: false, problems: ["a"] });
    expect(read.postiz).toEqual({ state: "not installed", detail: "" });
    expect(JSON.stringify(read)).not.toContain("shouldNeverBeServed");
  });

  it("GET /api/live-version serves it, and null where nothing deploys by itself", async () => {
    const rt = openRuntime({ CLIPFARM_FAKES: "1", DATA_DIR: dir, MEDIA_DIR: join(dir, "media") });
    try {
      const deps = { sources: rt.sources, vods: rt.vods, picks: rt.picks, queue: rt.queue, clips: rt.clips, posts: rt.posts, publisher: rt.publisher };
      const app = createApp({ ...deps, deployStatusFile: file });
      expect((await request(app).get("/api/live-version")).body).toBeNull();
      writeFileSync(file, JSON.stringify(STATUS));
      const res = await request(app).get("/api/live-version");
      expect(res.status).toBe(200);
      expect(res.body).toEqual(STATUS);
      expect((await request(createApp(deps)).get("/api/live-version")).body).toBeNull();
    } finally {
      rt.db.close();
    }
  });
});
