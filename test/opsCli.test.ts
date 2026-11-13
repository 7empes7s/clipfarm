import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openSettings } from "../server/config.js";
import { runOps } from "../server/ops/commands.js";
import { openRuntime } from "../server/runtime.js";
import { probeVideo } from "../server/tools/ffmpeg.js";

// Made-up keys, shaped like the real ones. None may ever show up in what the CLI prints.
const KEYS = {
  openai: "sk-proj-clipfarmOpsTestKey00000000a1b2",
  openaiBad: "sk-proj-clipfarmOpsWrongKey0000000c3d4",
  twitchId: "twitchopsclientid00000000e5f6",
  twitchSecret: "twitchopsclientsecret0000g7h8",
};
const TJR_RULES = "Caption must include #TJR. English only. Made without AI voices or added logos. Submit within 30 minutes of posting.";

let dir: string;
let env: NodeJS.ProcessEnv;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "clipfarm-ops-test-"));
  env = { CLIPFARM_FAKES: "1", DATA_DIR: dir, MEDIA_DIR: join(dir, "media"), FAKE_VOD_SEC: "20" };
  // The pipeline steps log to the console; keep the test output to the test's own lines.
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

/** Runs one command the way the CLI does and returns what it printed. */
async function ops(args: string[], withEnv: NodeJS.ProcessEnv = env) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runOps(args, { env: withEnv, out: (l) => out.push(l), err: (l) => err.push(l), pollMs: 20 });
  return { code, out, err, all: [...out, ...err].join("\n") };
}

const addTjr = () => ops(["source", "add", "kick.com/tjr", "--kind", "whop-campaign", "--campaign", "tjr-clipping", "--name", "TJR", "--rules", TJR_RULES]);

describe("clipfarm-ops test-keys", () => {
  it("says Working, Failed with the service's reason, or Not set, and never prints a key", async () => {
    // The keys as the app saves them: in DATA_DIR/secrets.json, read by the CLI in-process.
    const live = { DATA_DIR: dir };
    openSettings(live).save({ OPENAI_API_KEY: KEYS.openaiBad, TWITCH_CLIENT_ID: KEYS.twitchId, TWITCH_CLIENT_SECRET: KEYS.twitchSecret });
    const secretsBefore = readFileSync(join(dir, "secrets.json"), "utf8");
    const asked: string[] = [];
    vi.stubGlobal("fetch", (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      asked.push(url.split("?")[0]!);
      // Refusals repeat the key, as some real APIs do.
      if (url.startsWith("https://api.openai.com/")) {
        const key = new Headers(init.headers).get("authorization")?.slice(7);
        return Response.json({ error: { message: `Incorrect API key provided: ${key}.` } }, { status: 401 });
      }
      if (url.startsWith("https://id.twitch.tv/oauth2/token")) return Response.json({ access_token: "app-token" });
      if (url.startsWith("https://api.twitch.tv/helix/streams")) return Response.json({ data: [] });
      return new Response("not found", { status: 404 });
    }) as typeof fetch);

    const { code, out, err, all } = await ops(["test-keys"], live);
    expect(out).toEqual([
      "OpenAI: Failed OpenAI says: Incorrect API key provided: ***.",
      "Google (Gemini): Not set",
      "Twitch: Working",
      "YouTube: Not set",
      "Postiz: Not set",
      "Upload-Post: Not set",
    ]);
    expect(err).toEqual(["clipfarm-ops: 1 of 2 connections failed."]);
    expect(code).toBe(1);
    expect(asked).toEqual(["https://api.openai.com/v1/models", "https://id.twitch.tv/oauth2/token", "https://api.twitch.tv/helix/streams"]);
    for (const key of Object.values(KEYS)) expect(all).not.toContain(key);
    // The keys file belongs to the server: testing from the CLI leaves it as it was.
    expect(readFileSync(join(dir, "secrets.json"), "utf8")).toBe(secretsBefore);
  });

  it("with fakes calls nothing outside and exits 0 when every saved key is fine", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { code, out, all } = await ops(["test-keys"], { ...env, OPENAI_API_KEY: KEYS.openai });
    expect(code).toBe(0);
    expect(out[0]).toBe("OpenAI: Working");
    expect(out.at(-1)).toContain("nothing outside was called");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(all).not.toContain(KEYS.openai);
  });

  it("fails with a plain line when no key is saved at all", async () => {
    const { code, err } = await ops(["test-keys"]);
    expect(code).toBe(1);
    expect(err).toEqual(["clipfarm-ops: No key is saved yet. Paste them in the app under Settings."]);
  });
});

describe("clipfarm-ops source", () => {
  it("adds a channel with its campaign and rules as a permission record, once", async () => {
    const added = await addTjr();
    expect(added.code).toBe(0);
    expect(added.out).toEqual([
      "Added. Source 1: TJR (https://kick.com/tjr), Whop campaign https://whop.com/tjr-clipping, tiktok, youtube, instagram, permission active",
    ]);

    const again = await ops(["source", "add", "https://kick.com/TJR/", "--campaign", "tjr-clipping"]);
    expect(again.code).toBe(0);
    expect(again.out[0]).toMatch(/^Already there, nothing changed\. Source 1: TJR/);

    const rt = openRuntime(env);
    const sources = rt.sources.list();
    rt.db.close();
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ creatorName: "TJR", channelUrls: ["https://kick.com/tjr"], permissionState: "active" });
    expect(sources[0]!.permissions).toMatchObject([
      { kind: "whop-campaign", campaignUrl: "https://whop.com/tjr-clipping", briefRules: TJR_RULES, allowedPlatforms: ["tiktok", "youtube", "instagram"] },
    ]);
    expect((await ops(["source", "list"])).out).toEqual([added.out[0]!.replace("Added. ", "")]);
  });

  it("refuses a campaign source without its campaign: no source without a permission record", async () => {
    const { code, err } = await ops(["source", "add", "kick.com/tjr"]);
    expect(code).toBe(1);
    expect(err).toEqual(["clipfarm-ops: Paste the Whop campaign link."]);
    expect((await ops(["source", "list"])).out).toEqual(["No sources yet."]);
  });

  it("removes a source by id, and answers a mistyped command with exit code 2", async () => {
    await addTjr();
    expect((await ops(["source", "remove", "1"])).out).toEqual(["Removed source 1 with 0 videos and 0 clips."]);
    expect((await ops(["source", "list"])).out).toEqual(["No sources yet."]);
    expect((await ops(["source", "frobnicate"])).code).toBe(2);
    expect((await ops(["post-everything"])).code).toBe(2);
    expect((await ops(["run", "latest", "kick.com/tjr", "--count", "0"])).code).toBe(2);
  });
});

describe("clipfarm-ops run, clips and status (fakes; real ffmpeg on a generated sample)", () => {
  it("turns the source's latest video into clips, prints each file and score, and posts nothing", async () => {
    await addTjr();
    const { code, out, err } = await ops(["run", "latest", "kick.com/tjr", "--count", "1"]);
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(out[0]).toBe("Latest video of TJR: GTA VI launch night with tjr");
    expect(out[1]).toBe("Job 1: video 1 of TJR: https://kick.com/tjr/videos/fake-gta6");
    expect(out[2]).toBe("The clipfarm service is not running, so this command does the work.");
    // Progress lines for each step, in order.
    const steps = out.filter((l) => /^\[\d\d:\d\d:\d\d\] job \d+ /.test(l)).map((l) => l.split(" ")[3]);
    expect([...new Set(steps)]).toEqual(["ingest:", "picks:", "render:"]);
    const summary = out.find((l) => l.startsWith("Done in "))!;
    expect(summary).toMatch(/^Done in \d+ s: 1 clip from a 20 s video\. Kept private: nothing was posted\.$/);

    const clipLine = out.at(-1)!;
    const match = /^clip 1 {2}pending {2}score (\d+) {2}(\d+) s {2}\S+ \S+ {2}(\S+\.mp4) {2}TJR moment 1$/.exec(clipLine);
    expect(match, clipLine).not.toBeNull();
    const file = match![3]!;
    expect(file.startsWith(join(dir, "media"))).toBe(true);
    expect(await probeVideo(file)).toMatchObject({ width: 1080, height: 1920, hasAudio: true });

    const rt = openRuntime(env);
    const posts = rt.posts.list();
    const clips = rt.clips.list();
    const queueRows = rt.db.prepare("SELECT COUNT(*) AS n FROM queue_worker").get() as { n: number };
    rt.db.close();
    expect(posts).toEqual([]);
    expect(clips.map((c) => [c.status, c.postCount])).toEqual([["pending", 0]]);
    // The command gave the queue back when it ended.
    expect(queueRows.n).toBe(0);

    // The same video is not made into clips twice.
    const again = await ops(["run", "latest", "1"]);
    expect(again.code).toBe(0);
    expect(again.out).toEqual(["Nothing new: the latest video of TJR is already in clipfarm (video 1, ready): https://kick.com/tjr/videos/fake-gta6"]);

    const listed = await ops(["clips", "--since", "1h"]);
    expect(listed.out).toEqual([clipLine, "1 clip ready."]);
    expect((await ops(["clips", "--since", "2999-01-01"])).out).toEqual(["No clips ready."]);

    const status = await ops(["status"]);
    expect(status.code).toBe(0);
    expect(status.out[0]).toBe("Worker: not running. Queued jobs wait until the clipfarm service is back.");
    expect(status.out[1]).toBe("Queue: 0 running, 0 waiting, 0 failed.");
    expect(status.out).toContain("job 1 ingest video 1: done, Done");
    expect(status.out).toContain("Clips: 1 waiting for review, 0 approved.");
    expect(status.out.at(-1)).toMatch(/^Disk: [\d.]+ GB free of [\d.]+ GB; clips use [\d.]+ GB/);
  });

  it("leaves the work to the running server: one heavy job at a time on the box", async () => {
    await addTjr();
    const server = openRuntime(env, { pollMs: 20 });
    server.queue.start();
    try {
      const { code, out, err } = await ops(["run", "https://kick.com/tjr/videos/some-stream", "--count", "1"]);
      expect(err).toEqual([]);
      expect(code).toBe(0);
      expect(out).toContain("The clipfarm service does the work; this command follows it.");
      expect(out.some((l) => /^Done in .*: 1 clip from a 20 s video/.test(l))).toBe(true);
      expect(server.queue.working).toBe(true);
      expect(existsSync(server.clips.filePath(server.clips.list()[0]!.id))).toBe(true);
    } finally {
      server.queue.stop();
      await server.queue.idle();
      server.db.close();
    }
  });

  it("refuses a source whose permission ran out, and a video that belongs to no source", async () => {
    await ops(["source", "add", "kick.com/tjr", "--campaign", "tjr-clipping", "--name", "TJR", "--expires", "2020-01-01"]);
    const expired = await ops(["run", "latest", "kick.com/tjr"]);
    expect(expired.code).toBe(1);
    expect(expired.err).toEqual(["clipfarm-ops: The permission for TJR expired on 2020-01-01. Add a current campaign first."]);

    const unknown = await ops(["run", "https://www.youtube.com/watch?v=abc"]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toEqual(["clipfarm-ops: Say whose video this is: --source <id or channel link> (see: clipfarm-ops source list)."]);

    const rt = openRuntime(env);
    const made = { vods: rt.vods.list().length, jobs: rt.queue.list().length };
    rt.db.close();
    expect(made).toEqual({ vods: 0, jobs: 0 });
  });

  it("exits non-zero with the step's reason when the pipeline fails", async () => {
    await addTjr();
    // Not demo mode: the transcript needs the local engine, and it is not downloaded here.
    const { code, out, err } = await ops(["run", "https://kick.com/tjr/videos/some-stream"], { DATA_DIR: dir, MEDIA_DIR: join(dir, "media"), DOWNLOADER: "fake", FAKE_VOD_SEC: "10" });
    expect(code).toBe(1);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^clipfarm-ops: The ingest step failed: The local engine is not set up yet\. /);
    expect(out.some((l) => l.startsWith("Done in"))).toBe(false);
  });
});
