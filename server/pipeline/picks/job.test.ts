import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Word } from "../../../shared/types.js";
import { campaignInput } from "../../../test/helpers.js";
import { openDb } from "../../db/index.js";
import { JobQueue } from "../../jobs/queue.js";
import { PicksRepo } from "../../picks/repo.js";
import { SourcesRepo } from "../../sources/repo.js";
import { VodsRepo } from "../../vods/repo.js";
import { pipelineOnFinished } from "../chain.js";
import { RENDER_JOB } from "../render/job.js";
import { bucketChat } from "../chat/buckets.js";
import { seededChat } from "../chat/fake.js";
import type { ChatBuckets } from "../chat/types.js";
import { FakeChatClient } from "./fake.js";
import { PICKS_JOB, picksHandler } from "./job.js";
import { LlmPicker } from "./llm.js";
import { LocalPicker } from "./local.js";
import type { Picker } from "./types.js";

let tmpRoot: string;
beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "clipfarm-picks-job-"));
});
afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

const flags = { spoiler: false, cutscene: false, ending: false, leak: false, breaks_brief: false };
const pick = (start: number, end: number, score: number, over: object = {}) => ({
  candidate: 0, start, end, hook: "Wait for it", title: `Pick ${score}`, score, reason: "Loud", layout: "center", flags, ...over,
});

function setup(answer: unknown, faceCam = false, permission: Parameters<typeof campaignInput>[0] = {}, extra: { picker?: Picker; chat?: ChatBuckets } = {}) {
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db);
  const vods = new VodsRepo(db);
  const picks = new PicksRepo(db);
  const rendered: number[] = [];
  const chat = new FakeChatClient(() => answer, 0.01);
  const queue: JobQueue = new JobQueue(db, {
    handlers: {
      [PICKS_JOB]: picksHandler({
        sources, vods, picks, maxPicks: 10, picker: extra.picker ?? new LlmPicker(chat),
      }),
      [RENDER_JOB]: async ({ payload }) => {
        rendered.push((payload as { pickId: number }).pickId);
      },
    },
    tmpRoot,
    onFinished: pipelineOnFinished({ vods, picks, queue: () => queue }),
  });
  const source = sources.create(campaignInput({ briefRules: "Credit the streamer. No ex.", ...permission }));
  if (faceCam) sources.setFaceCam(source.id, { x: 0.7, y: 0.7, w: 0.25, h: 0.25 });
  const vod = vods.create(source.id, "https://www.twitch.tv/videos/1");
  const words: Word[] = [];
  for (let i = 0; i * 0.5 + 0.4 <= 300; i++) {
    words.push({ word: i === 300 ? "ex" : (i + 1) % 10 === 0 ? "okay." : "so", startSec: i * 0.5, endSec: i * 0.5 + 0.4 });
  }
  vods.saveMeta(vod.id, { title: "VOD", durationSec: 300, chapters: [] });
  vods.saveTranscript(vod.id, words, "fake", 0.03);
  const loud = new Array<number>(300).fill(-30);
  loud[30] = loud[150] = loud[250] = -5;
  vods.saveLoudness(vod.id, loud);
  if (extra.chat) vods.saveChat(vod.id, extra.chat);
  return { queue, picks, vod, rendered, chat };
}

describe("picks job", () => {
  it("keeps good picks with their reason and cost, drops flagged and banned ones, and renders only the kept", async () => {
    const { queue, picks, vod, rendered } = setup({
      picks: [
        pick(20, 45, 90),
        pick(140, 170, 80, { flags: { ...flags, spoiler: true } }),
        pick(145, 165, 70), // mentions "ex" at 150 s
        pick(240, 262, 60, { flags: { ...flags, leak: true } }),
      ],
    });
    queue.enqueue(PICKS_JOB, { vodId: vod.id }, { vodId: vod.id });
    await queue.idle();

    const stored = picks.listForVod(vod.id);
    expect(stored.map((p) => [p.score, p.status, p.dropReason])).toEqual([
      [90, "picked", null],
      [80, "dropped", "Left out: story spoiler"],
      [70, "dropped", 'Left out: the brief bans "ex"'],
      [60, "dropped", "Left out: leaked content"],
    ]);
    const kept = stored[0]!;
    expect(kept).toMatchObject({ startSec: 20, endSec: 44.9, reason: "Loud", layout: "center", rank: 1 });
    // The transcript ($0.03) and picking ($0.01) shared over the one kept clip.
    expect(kept.costUsd).toBeCloseTo(0.04, 6);
    expect(kept.steps.map((s) => s.step)).toEqual(["pick"]);
    expect(rendered).toEqual([kept.id]);
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it("gives the picker the campaign's rules and leaves out picks that break them", async () => {
    const rules = { requiredTags: ["#ad"], requiredLinks: [], requiredText: [], bannedWords: ["ex"], minSec: null, maxSec: 20, budgetLeftUsd: null, manualSubmit: true };
    // The first pick is 25 s (the campaign takes 20 s); the second says "ex" (at 150 s), which only the campaign's rules ban.
    const { queue, picks, vod, chat, rendered } = setup({ picks: [pick(20, 45, 90), pick(140, 160, 80)] }, false, { briefRules: "Credit the streamer.", rules });
    queue.enqueue(PICKS_JOB, { vodId: vod.id }, { vodId: vod.id });
    await queue.idle();
    expect(chat.requests[0]!.user).toContain("Campaign brief: Credit the streamer.\nClip length: at most 20 s.\nNever pick a moment about: ex.");
    expect(picks.listForVod(vod.id).map((p) => p.dropReason)).toEqual([
      "Left out: the campaign takes clips of 20 s at most",
      'Left out: the brief bans "ex"',
    ]);
    expect(rendered).toEqual([]);
  });

  it("uses the stacked layout when the creator has a face cam saved", async () => {
    const { queue, picks, vod } = setup({ picks: [pick(20, 45, 90, { layout: "full" })] }, true);
    queue.enqueue(PICKS_JOB, { vodId: vod.id }, { vodId: vod.id });
    await queue.idle();
    expect(picks.listForVod(vod.id)[0]!.layout).toBe("stacked");
  });

  it("replaces unrendered picks when it runs again", async () => {
    const { queue, picks, vod } = setup({ picks: [pick(20, 45, 90), pick(100, 130, 50)] });
    queue.enqueue(PICKS_JOB, { vodId: vod.id }, { vodId: vod.id });
    await queue.idle();
    queue.enqueue(PICKS_JOB, { vodId: vod.id }, { vodId: vod.id });
    await queue.idle();
    expect(picks.listForVod(vod.id)).toHaveLength(2);
  });

  describe("chat spikes", () => {
    // Loud moments at 30, 150 and 250 s; chat explodes at 200 s, where the audio is quiet.
    const spike = () => bucketChat(seededChat(300, [{ atSec: 200, messages: 50, emote: "KEKW" }]), 300);

    it("ranks the moment chat exploded first, with the window opening ~30 s before the spike", async () => {
      const { queue, picks, vod } = setup(null, false, {}, { picker: new LocalPicker(), chat: spike() });
      queue.enqueue(PICKS_JOB, { vodId: vod.id }, { vodId: vod.id });
      await queue.idle();
      const top = picks.listForVod(vod.id).find((p) => p.rank === 1)!;
      expect(top.startSec).toBeGreaterThanOrEqual(165);
      expect(top.startSec).toBeLessThanOrEqual(175);
      expect(top.endSec).toBeGreaterThanOrEqual(195);
      expect(top.reason).toMatch(/Chat \d+× normal, KEKW burst\.$/);
    });

    it("lifts an LLM pick on the spike above a better-scored one", async () => {
      const { queue, picks, vod } = setup({ picks: [pick(20, 45, 90), pick(170, 195, 60)] }, false, {}, { chat: spike() });
      queue.enqueue(PICKS_JOB, { vodId: vod.id }, { vodId: vod.id });
      await queue.idle();
      const stored = picks.listForVod(vod.id);
      expect(stored.map((p) => [p.startSec, p.rank])).toEqual([[170, 1], [20, 2]]);
      expect(stored[0]!.score).toBeGreaterThan(90);
      expect(stored[1]).toMatchObject({ score: 90, reason: "Loud" });
    });

    it("falls back to the other signals without chat", async () => {
      const { queue, picks, vod } = setup(null, false, {}, { picker: new LocalPicker() });
      queue.enqueue(PICKS_JOB, { vodId: vod.id }, { vodId: vod.id });
      await queue.idle();
      const stored = picks.listForVod(vod.id);
      expect(stored.length).toBeGreaterThan(0);
      const top = stored.find((p) => p.rank === 1)!;
      expect([30, 150, 250].some((peak) => top.startSec <= peak && peak <= top.endSec)).toBe(true);
      expect(stored.every((p) => !p.reason.includes("Chat"))).toBe(true);
    });
  });
});
