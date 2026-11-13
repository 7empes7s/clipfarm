import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Word } from "../../shared/types.js";
import { campaignInput } from "../../test/helpers.js";
import { openDb } from "../db/index.js";
import { JobQueue } from "../jobs/queue.js";
import { PicksRepo } from "../picks/repo.js";
import { FakeChatClient } from "../pipeline/picks/fake.js";
import { PICKS_JOB, picksHandler } from "../pipeline/picks/job.js";
import { LlmPicker } from "../pipeline/picks/llm.js";
import { NO_FLAGS, type RawPick } from "../pipeline/picks/types.js";
import { SourcesRepo } from "../sources/repo.js";
import { VodsRepo } from "../vods/repo.js";
import { FakeGemini } from "./fake.js";
import { blendVisual, parseVisual, proxyWindow, videoReranker } from "./rerank.js";
import { GoogleAi } from "./service.js";

let tmpRoot: string;
beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "clipfarm-rerank-"));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpRoot, { recursive: true, force: true });
});

const flags = { spoiler: false, cutscene: false, ending: false, leak: false, breaks_brief: false };
const llmPick = (start: number, end: number, score: number) => ({
  candidate: 0, start, end, hook: "Wait for it", title: `Pick ${score}`, score, reason: "Loud.", layout: "center", flags,
});
const read = (intensity: number, over: object = {}) => ({
  visual_intensity: intensity,
  moment_type: "police-chase",
  opens_on_payoff: true,
  best_start: 3,
  best_end: 28,
  flags: { spoiler: false, leak: false, cutscene: false },
  ...over,
});

/** A picks job as runtime.ts wires it: three local picks (90, 70, 50), then Gemini watches each one's proxy. */
function setup(answer: (call: number) => unknown, settings: object = {}) {
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db);
  const vods = new VodsRepo(db);
  const picks = new PicksRepo(db);
  const gemini: FakeGemini = new FakeGemini({ json: (): unknown => answer(gemini.jsonCalls.length) });
  const google = new GoogleAi({ client: () => gemini });
  google.bind(db);
  google.saveSettings({ weight: 50, ...settings });
  const proxies: { startSec: number; endSec: number }[] = [];
  const queue = new JobQueue(db, {
    handlers: {
      [PICKS_JOB]: picksHandler({
        sources, vods, picks, maxPicks: 10,
        picker: new LlmPicker(new FakeChatClient(() => ({ picks: [llmPick(20, 45, 90), llmPick(100, 125, 70), llmPick(200, 225, 50)] }))),
        rerank: videoReranker({
          google,
          proxy: async (_url, window) => {
            proxies.push(window);
            return Buffer.from("proxy-video");
          },
        }),
      }),
    },
    tmpRoot,
  });
  const source = sources.create(campaignInput({ briefRules: "Credit the streamer." }));
  const vod = vods.create(source.id, "https://www.twitch.tv/videos/1");
  const words: Word[] = [];
  for (let i = 0; i * 0.5 + 0.4 <= 300; i++) words.push({ word: (i + 1) % 10 === 0 ? "okay." : "so", startSec: i * 0.5, endSec: i * 0.5 + 0.4 });
  vods.saveMeta(vod.id, { title: "VOD", durationSec: 300, chapters: [] });
  vods.saveTranscript(vod.id, words, "fake", 0);
  vods.saveLoudness(vod.id, new Array<number>(300).fill(-30));
  const runJob = async () => {
    const job = queue.enqueue(PICKS_JOB, { vodId: vod.id }, { vodId: vod.id });
    await queue.idle();
    return { job: queue.list().find((j) => j.id === job.id)!, stored: picks.listForVod(vod.id) };
  };
  return { runJob, gemini, google, proxies };
}

describe("video-aware re-ranking in the picks job (faked Gemini)", () => {
  it("changes the order when the video says otherwise, and shows the reason on each pick", async () => {
    // Asked best pick first: the transcript's favourite is dull to watch, its last pick is a chase.
    const { runJob, gemini, proxies } = setup((call) => read([2, 5, 10][call - 1]!));
    const { job, stored } = await runJob();
    expect(job.status).toBe("done");
    expect(stored.map((p) => [p.title, p.score])).toEqual([
      ["Pick 50", 75],
      ["Pick 70", 60],
      ["Pick 90", 55],
    ]);
    expect(stored[0]!.reason).toBe("Loud. +visual: police chase, 10/10, opens on the payoff");
    expect(stored[2]!.reason).toContain("+visual: police chase, 2/10");
    // One short proxy per pick, sent as video with the low-resolution setting's schema.
    expect(proxies).toEqual([
      { startSec: 17, endSec: 48 },
      { startSec: 97, endSec: 128 },
      { startSec: 197, endSec: 228 },
    ]);
    expect(gemini.jsonCalls[0]!.media).toMatchObject({ mimeType: "video/mp4" });
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it("rejects an answer that does not match the schema and keeps the local order", async () => {
    const bad = [{ visual_intensity: 11 }, read(4, { moment_type: "dance-off" }), "not json at all"];
    const { runJob, gemini } = setup((call) => bad[call - 1]);
    const { job, stored } = await runJob();
    expect(job.status).toBe("done");
    expect(gemini.jsonCalls).toHaveLength(3);
    expect(stored.map((p) => [p.title, p.score, p.reason])).toEqual([
      ["Pick 90", 90, "Loud."],
      ["Pick 70", 70, "Loud."],
      ["Pick 50", 50, "Loud."],
    ]);
  });

  it("stops calling Google at the daily cap, and the job still finishes on the local picks", async () => {
    // Each faked call is priced at about €0.0024, so a €0.004 cap is reached by the second one.
    const { runJob, gemini, google } = setup(() => read(10), { dailyCapEur: 0.004 });
    const { job, stored } = await runJob();
    expect(job.status).toBe("done");
    expect(gemini.jsonCalls).toHaveLength(2);
    expect(stored).toHaveLength(3);
    // The pick Google never saw keeps its local score and reason.
    expect(stored.find((p) => p.title === "Pick 50")).toMatchObject({ score: 50, reason: "Loud." });
    expect(google.blocked()).toMatch(/Today's Google limit/);
    // Next job: no call at all, same local picks.
    const again = await runJob();
    expect(again.job.status).toBe("done");
    expect(gemini.jsonCalls).toHaveLength(2);
    expect(again.stored.map((p) => p.score)).toEqual([90, 70, 50]);
  });

  it("falls back to the local picks when Google fails", async () => {
    const { runJob, gemini } = setup(() => {
      throw new Error("Google says: quota exceeded");
    });
    const { job, stored } = await runJob();
    expect(job.status).toBe("done");
    // One failed call is enough to stop asking for this video.
    expect(gemini.jsonCalls).toHaveLength(1);
    expect(stored.map((p) => p.score)).toEqual([90, 70, 50]);
  });

  it("a spoiler, leak or cutscene seen in the video leaves the pick out", async () => {
    const { runJob } = setup((call) => read(9, call === 1 ? { flags: { spoiler: false, leak: true, cutscene: false } } : {}));
    const { stored } = await runJob();
    expect(stored.find((p) => p.title === "Pick 90")).toMatchObject({ status: "dropped", dropReason: "Left out: leaked content" });
  });

  it("switched off: nothing is sent", async () => {
    const { runJob, gemini } = setup(() => read(10), { rerank: false });
    const { stored } = await runJob();
    expect(gemini.jsonCalls).toHaveLength(0);
    expect(stored.map((p) => p.score)).toEqual([90, 70, 50]);
  });
});

describe("re-ranking math", () => {
  const pick: RawPick = { startSec: 100, endSec: 130, hook: "h", title: "t", score: 80, reason: "Loud.", layout: "center", flags: NO_FLAGS };

  it("the proxy covers the pick with 3 s before it, 40 s at most, inside the video", () => {
    expect(proxyWindow({ startSec: 100, endSec: 130 }, 600)).toEqual({ startSec: 97, endSec: 133 });
    expect(proxyWindow({ startSec: 100, endSec: 160 }, 600)).toEqual({ startSec: 97, endSec: 137 });
    expect(proxyWindow({ startSec: 1, endSec: 31 }, 32)).toEqual({ startSec: 0, endSec: 32 });
  });

  it("blends by the weight, moves the cut by 3 s at most, and only ever adds flags", () => {
    const window = { startSec: 97, endSec: 133 };
    const seen = parseVisual(JSON.stringify(read(10, { best_start: 5, best_end: 31.5, opens_on_payoff: false })))!;
    expect(blendVisual(pick, seen, 0.3, window)).toMatchObject({ score: 86, startSec: 102, endSec: 128.5, reason: "Loud. +visual: police chase, 10/10" });
    // A cut more than 3 s away from the local one is not taken.
    const far = parseVisual(JSON.stringify(read(10, { best_start: 20, best_end: 30 })))!;
    expect(blendVisual(pick, far, 0.3, window)).toMatchObject({ startSec: 100, endSec: 130 });
    const flagged = blendVisual({ ...pick, flags: { ...NO_FLAGS, ending: true } }, seen, 0.3, window);
    expect(flagged.flags).toMatchObject({ ending: true, spoiler: false });
    expect(blendVisual(pick, seen, 0, window).score).toBe(80);
  });

  it("takes only answers that match the schema", () => {
    expect(parseVisual(JSON.stringify(read(7)))).toMatchObject({ intensity: 7, momentType: "police-chase", opensOnPayoff: true });
    expect(parseVisual(JSON.stringify(read(7.5)))).toBeNull();
    expect(parseVisual(JSON.stringify(read(-1)))).toBeNull();
    expect(parseVisual(JSON.stringify(read(7, { opens_on_payoff: "yes" })))).toBeNull();
    expect(parseVisual(JSON.stringify(read(7, { flags: { spoiler: false, leak: false } })))).toBeNull();
    expect(parseVisual(JSON.stringify(read(7, { best_end: null })))).toBeNull();
    expect(parseVisual("[]")).toBeNull();
  });
});
