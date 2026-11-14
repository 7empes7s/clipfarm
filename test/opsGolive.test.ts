import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runOps } from "../server/ops/commands.js";
import { beforePublic, findChannel, keyProblems, pickPrivateClip, reusablePost } from "../server/ops/golive.js";
import { openRuntime } from "../server/runtime.js";
import { DEFAULT_SUBMIT_HOURS } from "../shared/submitWindow.js";
import type { ChannelAccount, Clip, Permission } from "../shared/types.js";

let dir: string;
let env: NodeJS.ProcessEnv;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "clipfarm-golive-test-"));
  // One clip per video: the stand-in video is 20 s long and every clip is a real ffmpeg render.
  env = { CLIPFARM_FAKES: "1", DATA_DIR: dir, MEDIA_DIR: join(dir, "media"), FAKE_VOD_SEC: "20", PROOF_MAX_PICKS: "1" };
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

async function ops(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runOps(args, { env, out: (l) => out.push(l), err: (l) => err.push(l), pollMs: 20 });
  return { code, out, err };
}

// The stand-in posting service lists "GTA VI Moments" as its YouTube channel.
const GOLIVE = ["golive", "--channel", "GTA VI Moments", "--drill-minutes", "0", "--url-wait", "0"];

describe("clipfarm-ops golive (fakes; real ffmpeg on a generated sample)", () => {
  it("adds the TJR campaign, runs the proof, prints each clip's hook and title, uploads one PRIVATE video and lists what is missing", async () => {
    const { code, out, err } = await ops([...GOLIVE, "--campaign", "tjr-clipping"]);
    expect(err).toEqual([]);
    expect(out).toEqual(
      expect.arrayContaining([
        "== Posting accounts ==",
        "Posting through Test posting service: 5 accounts.",
        "  GTA VI Moments (youtube)",
        "== Keys ==",
        "YouTube: Not set",
        expect.stringMatching(/^Added\. Source 1: TJR \(https:\/\/kick\.com\/tjr\), Whop campaign https:\/\/whop\.com\/tjr-clipping/),
        expect.stringMatching(/^Campaign video: PASSED {2}TJR: /),
        expect.stringMatching(/^ {2}ok {3}Quality check: 1 of 1 passed$/),
        expect.stringMatching(/^TJR video 1 \(20 s\): 1 clips in \d+ min, quality check 1 of 1 passed\. https:\/\//),
        expect.stringMatching(/^clip 1 {2}score \d+ {2}20 s {2}quality ok$/),
        "  Hook: Wait for it",
        "  Title: TJR moment 1",
        "Uploaded clip 1 to GTA VI Moments as a private video.",
        "Private post on GTA VI Moments: https://example.com/youtube/fake-post-1 (private: only the channel's owner can see it)",
        "== Before a public post ==",
        expect.stringMatching(/^ {2}- The manager's go-ahead: approve clip 1 \(".+"\) in the app, then Post to GTA VI Moments\. Nothing goes public before that\.$/),
        expect.stringMatching(/^ {2}- The Whop submit window: TJR posts go out only in the manager's submit hours/),
      ]),
    );
    // No key is saved in this test: Postiz and YouTube are missing, so it exits 1 with them listed.
    expect(out.slice(out.indexOf("Still missing:"))).toEqual([
      "Still missing:",
      expect.stringMatching(/^ {2}- YouTube: no Data API key\. Put a line YOUTUBE_API_KEY=<key> in a file under \/etc\/clipfarm\/pending-keys\//),
      expect.stringMatching(/^ {2}- Postiz: no key in clipfarm\./),
    ]);
    expect(code).toBe(1);

    // The private test is not a post: nothing stored, nothing approved for the manager.
    const rt = openRuntime(env);
    try {
      expect(rt.posts.list()).toEqual([]);
      expect(rt.clips.list().map((c) => c.status)).toEqual(["pending"]);
    } finally {
      rt.db.close();
    }
    expect(existsSync(join(dir, "golive.json"))).toBe(true);

    // Again: nothing new to clip, the same clips are reported, and the private video is not uploaded twice.
    const again = await ops(GOLIVE);
    expect(again.out).toEqual(
      expect.arrayContaining([
        "No new TJR video this time; the newest one clipfarm already clipped is video 1.",
        "Already uploaded by an earlier go-live (clip 1): not uploading again.",
        "Private post on GTA VI Moments: https://example.com/youtube/fake-post-1 (private: only the channel's owner can see it)",
      ]),
    );
    expect(again.out.filter((l) => l.startsWith("Uploaded clip"))).toEqual([]);
  }, 180_000);

  it("without the TJR source or the channel: says what is missing and uploads nothing", async () => {
    const { code, out } = await ops(["golive", "--channel", "Leonida Daily", "--drill-minutes", "0"]);
    expect(code).toBe(1);
    expect(out).toEqual(
      expect.arrayContaining([
        "Missing: Leonida Daily (YouTube) is not among the accounts Test posting service lists. Connect it in Test posting service (Add Channel, YouTube), then run go-live again.",
        "Missing: No source for https://kick.com/tjr with its campaign permission record: run go-live with --campaign <the TJR Whop campaign link>.",
        "Skipped: it needs the TJR source with a permission record in force.",
        "Skipped: it needs Leonida Daily in the accounts and a TJR clip (see Missing above).",
      ]),
    );
    expect(existsSync(join(dir, "golive.json"))).toBe(false);
  });

  it("refuses a mistyped command with exit code 2", async () => {
    expect((await ops(["golive", "--url-wait", "soon"])).code).toBe(2);
  });
});

const account = (over: Partial<ChannelAccount>): ChannelAccount => ({ id: "a", platform: "youtube", name: "Leonida Daily", disabled: false, direct: false, handle: null, ...over }) as ChannelAccount;
const clip = (over: Partial<Clip>): Clip => ({ id: 1, status: "pending", score: 50, quality: { issues: [], fix: null }, title: "t", ...over }) as Clip;

describe("go-live planners", () => {
  it("findChannel: the connected YouTube account of that name, never a TikTok of the same name or a disconnected one", () => {
    expect(findChannel([account({ platform: "tiktok" }), account({ id: "yt" })], "leonida daily", "Postiz").account?.id).toBe("yt");
    expect(findChannel([account({ disabled: true })], "Leonida Daily", "Postiz").problem).toMatch(/disconnected in Postiz/);
    expect(findChannel([account({ platform: "tiktok" })], "Leonida Daily", "Postiz").problem).toMatch(/not among the accounts Postiz lists/);
  });

  it("keyProblems: Postiz and YouTube must be set, and no saved key may fail", () => {
    const r = (id: string, state: "Working" | "Failed" | "Not set") => ({ id, label: id, state, detail: state === "Failed" ? "refused" : "" }) as Parameters<typeof keyProblems>[0][number];
    expect(keyProblems([r("postiz", "Working"), r("youtube", "Working"), r("twitch", "Not set")])).toEqual([]);
    expect(keyProblems([r("postiz", "Not set"), r("youtube", "Working"), r("openai", "Failed")])).toEqual([
      expect.stringMatching(/^Postiz: no key in clipfarm/),
      "openai: the saved key fails (refused). Fix it in the app under Settings.",
    ]);
  });

  it("pickPrivateClip: the best clip the quality check passed, never a rejected one or one with issues", () => {
    const issue = { issues: [{}], fix: null } as unknown as Clip["quality"];
    expect(pickPrivateClip([clip({ id: 1, score: 90, quality: issue }), clip({ id: 2, score: 40 }), clip({ id: 3, score: 95, status: "rejected" }), clip({ id: 4, score: 99, quality: null })])?.id).toBe(2);
    expect(pickPrivateClip([clip({ status: "rejected" })])).toBeNull();
  });

  it("reusablePost: only for the same channel while its clip is still there", () => {
    const saved = { clipId: 3, accountId: "a", externalId: "p", url: null, at: "2026-11-14T00:00:00.000Z" };
    expect(reusablePost(saved, "a", [3])).toBe(saved);
    expect(reusablePost(saved, "b", [3])).toBeNull();
    expect(reusablePost(saved, "a", [4])).toBeNull();
  });

  it("beforePublic: the go-ahead, and the Whop submit window only for a campaign that is submitted by hand", () => {
    const submit = { hours: { ...DEFAULT_SUBMIT_HOURS, enabled: false }, snoozeUntil: null, waiting: 0, nextAt: null, open: 0 };
    const whop = { kind: "whop-campaign", rules: null, expiresAt: "2026-12-31T00:00:00.000Z" } as unknown as Permission;
    expect(beforePublic({ clip: null, channel: "Leonida Daily", permission: whop, submit })).toEqual([
      "The manager's go-ahead: approve a TJR clip in the app, then Post to Leonida Daily. Nothing goes public before that.",
      "The Whop submit window: submit hours are off, so a TJR post goes out at once and must be submitted on Whop within 30 minutes (the phone counts down).",
      "The TJR permission record runs until 2026-12-31.",
    ]);
    expect(beforePublic({ clip: null, channel: "Leonida Daily", permission: { ...whop, kind: "direct-permission", expiresAt: null }, submit })).toHaveLength(1);
  });
});
