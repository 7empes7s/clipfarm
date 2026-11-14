import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openSettings } from "../server/config.js";
import { FakeNotifier } from "../server/live/notify.js";
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
      "Stripe: Not set",
      "Client sign-in: Not set",
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

describe("clipfarm-ops notify", () => {
  it("sends the title and text to the phones that turned notifications on, with saved keys taken out", async () => {
    const live = { DATA_DIR: dir, MEDIA_DIR: join(dir, "media") };
    openSettings(live).save({ OPENAI_API_KEY: KEYS.openai });
    const notifier = new FakeNotifier();
    const send = (args: string[]) => {
      const out: string[] = [];
      return runOps(args, { env: live, out: (l) => out.push(l), err: (l) => out.push(l), notifier }).then((code) => ({ code, out }));
    };

    expect(await send(["notify", "clipfarm update rolled back", "Update 1a2b3c4 did not start."])).toEqual({
      code: 0,
      out: ["Nobody turned notifications on in the app, so nothing was sent."],
    });

    const rt = openRuntime(live);
    rt.liveRepo.addPushSubscription({ endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } }, new Date());
    rt.db.close();
    expect(await send(["notify", "clipfarm update failed", `The key test said: ${KEYS.openai}`])).toEqual({ code: 0, out: ["Sent to 1 phone or browser."] });
    expect(notifier.sent).toHaveLength(2);
    expect(notifier.sent[0]).toEqual({ title: "clipfarm update rolled back", body: "Update 1a2b3c4 did not start.", url: "/#dashboard" });
    expect(notifier.sent[1]!.body).not.toContain(KEYS.openai);
    expect(notifier.sent[1]!.body).toContain("The key test said:");
  });

  it("wants exactly a title and a text", async () => {
    const { code, err } = await ops(["notify", "only a title"]);
    expect(code).toBe(2);
    expect(err[0]).toContain('Unknown command "notify only a title"');
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

describe("clipfarm-ops proof and drill", () => {
  it("proof runs the campaign channel's latest video on the real pipeline, keeps it private and prints the numbers against the target", async () => {
    await addTjr();
    // One clip is enough here: the stand-in video is 20 s long, and every clip is a real ffmpeg render.
    const proofEnv = { ...env, PROOF_MAX_PICKS: "1" };
    const { code, out, err } = await ops(["proof"], proofEnv);
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(out[0]).toBe("The clipfarm service is not running, so this command does the work.");
    const report = out.slice(out.findIndex((l) => l.startsWith("Campaign video:")));
    expect(report[0]).toMatch(/^Campaign video: PASSED {2}TJR: /);
    expect(report).toEqual(
      expect.arrayContaining([
        "       Video length: 20 s",
        "  ok   Clips: 1 (target: at least 1)",
        expect.stringMatching(/^ {2}ok {3}Time to all clips: (under 1|\d+) min \(target: under 30 min\)$/),
        expect.stringMatching(/^ {7}Time to first clip: (under 1|\d+) min$/),
        expect.stringMatching(/^ {2}ok {3}Quality check: 1 of 1 passed$/),
        "       Approved by you: No swipes yet (target: half)",
        "       Engine: Stand-in (demo)",
        expect.stringMatching(/^ {7}Cost: (under )?\$0\.\d+$/),
        expect.stringMatching(/^ {7}Memory peak: \d+\.\d GB$/),
        "GTA video: SKIPPED  (No creator with a public clipping allowance is in Sources yet. Add one from the suggested list.)",
        "Kept private: nothing was posted. The clips wait in the Inbox, tagged Proof.",
        "Launch ready: no",
      ]),
    );

    // Stored in SQLite, and the clips are real files waiting for review, tagged Proof.
    const rt = openRuntime(proofEnv);
    try {
      const [campaign] = rt.proof.info().runs;
      expect(campaign).toMatchObject({ status: "passed", askedBy: "ops", metrics: { vodSec: 20, engine: "Stand-in (demo)" } });
      const clips = rt.clips.list();
      expect(clips).toHaveLength(1);
      expect(campaign!.clipIds.sort()).toEqual(clips.map((c) => c.id).sort());
      for (const c of clips) {
        expect(c).toMatchObject({ proof: true, status: "pending", postCount: 0 });
        expect(await probeVideo(rt.clips.filePath(c.id)!)).toMatchObject({ width: 1080, height: 1920 });
      }
      expect(rt.posts.list()).toEqual([]);
    } finally {
      rt.db.close();
    }

    const status = await ops(["proof", "status"]);
    expect(status.code).toBe(0);
    expect(status.out[0]).toMatch(/^Campaign video: PASSED/);
    expect(status.out).toContain("The daily timer is off (PROOF_HOUR).");
    expect(status.out).toContain("  - No live drill has run yet. Run one while an allowed creator is live.");
  }, 120_000);

  it("proof exits non-zero with the reason when there is nothing to run on", async () => {
    const { code, out, err } = await ops(["proof"]);
    expect(code).toBe(1);
    expect(out).toContain("Campaign video: SKIPPED  (No source has the channel https://kick.com/tjr. Add its campaign in Sources.)");
    expect(err).toEqual(["clipfarm-ops: The proof had no video to run on."]);
  });

  it("drill live loads the launch-day watchlist, records an allowed live creator and reports the time from moment to LIVE clip", async () => {
    // Launch time is behind us here, so the stand-in GTA VI streams are no leak; short segments keep it quick.
    const drillEnv = { ...env, LAUNCH_AT: "2026-01-01T00:00:00Z", LIVE_SEGMENT_SEC: "20", LIVE_OVERLAP_SEC: "0", LIVE_MAX_PICKS: "1" };
    const { code, out, err } = await ops(["drill", "live", "--minutes", "0.25"], drillEnv);
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(out[1]).toBe("The clipfarm service is not running, so this command does the work.");
    expect(out[0]).toMatch(/^Launch-day watchlist: \d+ creators, \d+ with a permission record in force \(\d+ loaded from the list, \d+ added with a public allowance\)\.$/);
    const report = out.slice(out.findIndex((l) => l.startsWith("Drill:")));
    expect(report[0]).toMatch(/^Drill: PASSED {2}/);
    expect(report).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^ {2}ok {3}Moment to LIVE clip: \d+ s \(target: under 15 min\)$/),
        expect.stringMatching(/^ {2}ok {3}LIVE clips: \d+ \(target: at least 1\)$/),
        "  ok   Segments dropped: 0 of 1 (target: none)",
        expect.stringMatching(/^ {7}Memory peak: \d+\.\d GB$/),
      ]),
    );

    const rt = openRuntime(drillEnv);
    try {
      expect(rt.watchRepo.list().length).toBeGreaterThan(10);
      expect(rt.liveRepo.activeCaptures()).toEqual([]);
      const clips = rt.clips.list();
      expect(clips.length).toBeGreaterThan(0);
      expect(clips.every((c) => c.proof && c.live !== null && c.status === "pending" && c.postCount === 0)).toBe(true);
    } finally {
      rt.db.close();
    }
    // The second time nothing is loaded twice.
    const again = await ops(["drill", "live", "nobody-by-this-name"], drillEnv);
    expect(again.code).toBe(1);
    expect(again.out[0]).toMatch(/^Launch-day watchlist: \d+ creators, \d+ with a permission record in force\.$/);
    expect(again.err).toEqual(["clipfarm-ops: nobody-by-this-name is not on the watchlist with a permission record in force."]);
  }, 120_000);
});
