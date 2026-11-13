import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Word } from "../../shared/types.js";
import { campaignInput } from "../../test/helpers.js";
import { openDb } from "../db/index.js";
import { JobQueue } from "../jobs/queue.js";
import { PicksRepo } from "../picks/repo.js";
import { FakeChatClient } from "../pipeline/picks/fake.js";
import { PICKS_JOB, picksHandler } from "../pipeline/picks/job.js";
import { LlmPicker } from "../pipeline/picks/llm.js";
import { writerPrompt } from "../pipeline/picks/local.js";
import { NO_FLAGS, type PickInput, type RawPick } from "../pipeline/picks/types.js";
import { SourcesRepo } from "../sources/repo.js";
import { VodsRepo } from "../vods/repo.js";
import { applyTrendBoost, type TrendBoost, trendHints } from "./boost.js";

const BOOST: TrendBoost = {
  weight: 5,
  momentTypes: [
    { type: "police-chase", share: 1 },
    { type: "stunt", share: 0.4 },
  ],
  hookPatterns: [{ pattern: "name-reaction", example: "Kai Cenat LOSES IT in GTA 6" }],
};

const say = (text: string, from: number): Word[] => text.split(" ").map((word, i) => ({ word, startSec: from + i * 0.5, endSec: from + i * 0.5 + 0.4 }));
const WORDS = [...say("so we are just driving around the city.", 10), ...say("oh no the cops are right behind us.", 100)];
const raw = (startSec: number, score: number, title: string): RawPick => ({
  startSec, endSec: startSec + 20, hook: "Wait for it", title, score, reason: "Loud.", layout: "center", flags: NO_FLAGS,
});

describe("trend boost", () => {
  it("adds points to picks of a moment type that is trending today, and says why", () => {
    const [drive, chase, jump] = applyTrendBoost([raw(10, 70, "Driving"), raw(100, 68, "Uh oh"), raw(200, 50, "He landed the stunt jump")], WORDS, BOOST);
    expect(drive).toMatchObject({ score: 70, reason: "Loud." });
    // The words said in the window decide it: "cops" is a police chase, today's top type.
    expect(chase).toMatchObject({ score: 73, reason: "Loud. +trend: police chase" });
    // A weaker trend gives fewer points.
    expect(jump).toMatchObject({ score: 52, reason: "Loud. +trend: stunt" });
  });

  it("changes nothing without trends or with the weight at 0, and never goes over 100", () => {
    const picks = [raw(100, 68, "Uh oh")];
    expect(applyTrendBoost(picks, WORDS, null)).toEqual(picks);
    expect(applyTrendBoost(picks, WORDS, { ...BOOST, weight: 0 })).toEqual(picks);
    expect(applyTrendBoost([raw(100, 99, "Uh oh")], WORDS, BOOST)[0]!.score).toBe(100);
  });

  it("offers the winning title patterns to the hook writer", () => {
    const hints = trendHints(BOOST);
    expect(hints).toEqual(['Streamer name + big reaction (like "Kai Cenat LOSES IT in GTA 6")']);
    const input = { creatorName: "Test Streamer", title: "VOD", briefRules: "", bannedContent: "", trendHints: hints } as PickInput;
    expect(writerPrompt(input, [])).toContain('Title patterns winning today (use one only when it fits this clip): Streamer name + big reaction (like "Kai Cenat LOSES IT in GTA 6")');
    expect(writerPrompt({ ...input, trendHints: undefined }, [])).not.toContain("winning today");
  });
});

describe("picks job with a trend boost (fixture)", () => {
  let tmpRoot: string;
  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "clipfarm-trend-boost-"));
  });
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  const flags = { spoiler: false, cutscene: false, ending: false, leak: false, breaks_brief: false };
  const answer = {
    picks: [
      { candidate: 0, start: 20, end: 45, hook: "Wait for it", title: "Driving around", score: 80, reason: "Loud.", layout: "center", flags },
      { candidate: 1, start: 140, end: 170, hook: "Wait for it", title: "Five stars", score: 78, reason: "Loud.", layout: "center", flags },
    ],
  };

  async function run(trends: TrendBoost | null) {
    const db = openDb(":memory:");
    const sources = new SourcesRepo(db);
    const vods = new VodsRepo(db);
    const picks = new PicksRepo(db);
    const chat = new FakeChatClient(() => answer);
    const queue = new JobQueue(db, {
      handlers: { [PICKS_JOB]: picksHandler({ sources, vods, picks, maxPicks: 10, picker: new LlmPicker(chat), trends: () => trends }) },
      tmpRoot,
    });
    const source = sources.create(campaignInput());
    const vod = vods.create(source.id, "https://www.twitch.tv/videos/1");
    const words: Word[] = [];
    for (let i = 0; i * 0.5 + 0.4 <= 300; i++) {
      const word = i === 300 ? "police" : (i + 1) % 10 === 0 ? "okay." : "so";
      words.push({ word, startSec: i * 0.5, endSec: i * 0.5 + 0.4 });
    }
    vods.saveMeta(vod.id, { title: "VOD", durationSec: 300, chapters: [] });
    vods.saveTranscript(vod.id, words, "fake", 0);
    const loud = new Array<number>(300).fill(-30);
    loud[30] = loud[150] = -5;
    vods.saveLoudness(vod.id, loud);
    queue.enqueue(PICKS_JOB, { vodId: vod.id }, { vodId: vod.id });
    await queue.idle();
    queue.stop();
    return { picks: picks.listForVod(vod.id), prompt: chat.requests[0]!.user };
  }

  it("ranks by the picker's score alone without trends", async () => {
    const { picks, prompt } = await run(null);
    expect(picks.map((p) => [p.rank, p.title, p.score, p.reason])).toEqual([
      [1, "Driving around", 80, "Loud."],
      [2, "Five stars", 78, "Loud."],
    ]);
    expect(prompt).not.toContain("winning today");
  });

  it("moves a trending moment up, shows the reason on the pick, and offers the winning patterns for titles", async () => {
    const { picks, prompt } = await run(BOOST);
    // "police" is said at 150 s, inside the second pick: +5 puts it first.
    expect(picks.map((p) => [p.rank, p.title, p.score, p.reason])).toEqual([
      [1, "Five stars", 83, "Loud. +trend: police chase"],
      [2, "Driving around", 80, "Loud."],
    ]);
    expect(prompt).toContain("Title patterns winning today");
  });
});
