import { describe, expect, it } from "vitest";
import { NO_FLAGS, type RawPick } from "../picks/types.js";
import { bucketChat, mergeBuckets, sliceBuckets } from "./buckets.js";
import { seededChat } from "./fake.js";
import { applyChatBoost, CHAT_LEAD_SEC, chatPerSecond, chatScore, describeSpike, detectSpikes, rollingBaselines, spikeWindow, zScores } from "./spikes.js";
import type { ChatLog } from "./types.js";

const msg = (sec: number, user: string, text: string, emotes?: string[]) => ({ sec, user, text, ...(emotes ? { emotes } : {}) });

describe("bucketChat", () => {
  it("counts messages, unique chatters, emote messages and keywords per 10 s", () => {
    const log: ChatLog = {
      messages: [
        msg(1, "a", "hello"),
        msg(2, "A", "KEKW KEKW KEKW"),
        msg(9.9, "b", "clip it"),
        msg(12, "c", "PogChamp no way"),
        msg(15, "d", "lol", ["catJAM"]),
        msg(25, "e", "W"),
      ],
      clips: [{ startSec: 20, endSec: 50 }, { startSec: 5, endSec: 30 }, { startSec: 9, endSec: 9 }],
    };
    const b = bucketChat(log, 30);
    expect(b.bucketSec).toBe(10);
    expect(b.offsetSec).toBe(0);
    expect(b.messages).toEqual([3, 2, 1]);
    // "a" and "A" are the same viewer.
    expect(b.chatters).toEqual([2, 2, 1]);
    // A spammed emote counts once per message.
    expect(b.emotes).toEqual([1, 2, 1]);
    expect(b.topEmote).toEqual(["KEKW", "catJAM", "W"]);
    expect(b.keywords).toEqual([1, 1, 1]);
    // Sorted, and an empty clip is left out.
    expect(b.clips).toEqual([{ startSec: 5, endSec: 30 }, { startSec: 20, endSec: 50 }]);
  });

  it("covers the whole VOD even where nobody chatted", () => {
    expect(bucketChat({ messages: [], clips: [] }, 45).messages).toEqual([0, 0, 0, 0, 0]);
  });
});

describe("baseline and spikes", () => {
  it("scores a bucket against the 5 minutes before it, with a Poisson floor on the spread", () => {
    const counts = new Array<number>(40).fill(4);
    counts[35] = 40;
    const base = rollingBaselines(counts);
    expect(base[35]).toEqual({ mean: 4, sd: 2 });
    expect(zScores(counts)[35]).toBe(18);
    // The start of the stream has no 5 minutes before it: the first minutes are its baseline.
    expect(base[0]).toEqual({ mean: 4, sd: 2 });
  });

  it("finds the spike in a fixture chat log and opens the window 30 s before it", () => {
    const b = bucketChat(seededChat(600, [{ atSec: 400, messages: 45, emote: "KEKW" }]), 600);
    const spikes = detectSpikes(b);
    expect(spikes).toHaveLength(1);
    const s = spikes[0]!;
    expect(s.atSec).toBe(400);
    expect(s.startSec).toBe(400 - CHAT_LEAD_SEC);
    expect(s.endSec).toBe(410);
    expect(s.z).toBeGreaterThan(10);
    expect(s.ratio).toBeGreaterThanOrEqual(14);
    expect(s.emote).toBe("KEKW");
    expect(describeSpike(s)).toBe(`chat ${s.ratio}× normal, KEKW burst`);
  });

  it("finds nothing in a calm chat, or one too small to judge", () => {
    expect(detectSpikes(bucketChat(seededChat(600, []), 600))).toEqual([]);
    // From 0 to 4 messages is a lot more, but too few to count.
    expect(detectSpikes(bucketChat(seededChat(600, [{ atSec: 300, messages: 4 }], { perBucket: 0 }), 600))).toEqual([]);
    expect(detectSpikes(null)).toEqual([]);
  });

  it("merges back-to-back spike buckets into one moment and counts community clips in its window", () => {
    const b = bucketChat(
      seededChat(600, [{ atSec: 300, messages: 30 }, { atSec: 310, messages: 50 }], { clips: [{ startSec: 285, endSec: 315 }, { startSec: 100, endSec: 130 }] }),
      600,
    );
    const spikes = detectSpikes(b);
    expect(spikes.map((s) => [s.startSec, s.endSec, s.atSec, s.clips])).toEqual([
      // A clip made where chat was calm is a moment of its own.
      [100, 130, 100, 1],
      [270, 320, 300, 1],
    ]);
    expect(spikes[1]!.keywords).toBe(80);
    expect(describeSpike(spikes[0]!)).toBe("1 community clip");
    expect(chatScore(spikes[1]!)).toBeGreaterThan(chatScore(spikes[0]!));
  });

  it("keeps window offsets inside the VOD and on the chat's own clock", () => {
    expect(spikeWindow({ bucketSec: 10, offsetSec: 0 }, 1)).toEqual({ startSec: 0, endSec: 20 });
    expect(spikeWindow({ bucketSec: 10, offsetSec: 0 }, 10, 12)).toEqual({ startSec: 70, endSec: 130 });
    expect(spikeWindow({ bucketSec: 10, offsetSec: -4 }, 10)).toEqual({ startSec: 66, endSec: 106 });
  });

  it("puts the per-second chat signal where a window opening at the spike's window start peaks", () => {
    const b = bucketChat(seededChat(600, [{ atSec: 400, messages: 45 }]), 600);
    const perSec = chatPerSecond(b, 600)!;
    expect(perSec).toHaveLength(600);
    expect(perSec.indexOf(Math.max(...perSec))).toBe(378);
    expect(perSec[300]).toBe(0);
    expect(chatPerSecond(null, 600)).toBeNull();
  });
});

describe("applyChatBoost", () => {
  const pick = (startSec: number, endSec: number, score: number): RawPick => ({
    startSec, endSec, score, hook: "", title: "", reason: "Loud.", layout: "center", flags: NO_FLAGS,
  });
  const chat = bucketChat(seededChat(600, [{ atSec: 400, messages: 60, emote: "KEKW" }]), 600);

  it("adds the chat signal as a weighted feature and says why", () => {
    const [onSpike, elsewhere] = applyChatBoost([pick(372, 400, 50), pick(100, 130, 80)], chat);
    const spike = detectSpikes(chat)[0]!;
    expect(onSpike!.score).toBe(50 + Math.round(0.4 * chatScore(spike)));
    expect(onSpike!.score).toBeGreaterThan(80);
    expect(onSpike!.reason).toBe(`Loud. Chat ${spike.ratio}× normal, KEKW burst.`);
    expect(elsewhere).toEqual(pick(100, 130, 80));
    // Never past 100.
    expect(applyChatBoost([pick(372, 400, 95)], chat)[0]!.score).toBe(100);
  });

  it("leaves the picks as they were without chat (uploads, YouTube) or without a spike", () => {
    const picks = [pick(372, 400, 50), pick(100, 130, 80)];
    expect(applyChatBoost(picks, null)).toBe(picks);
    expect(applyChatBoost(picks, bucketChat(seededChat(600, []), 600))).toBe(picks);
  });
});

describe("live chat buckets", () => {
  it("merges a segment's chat from its start on, so the overlap never counts twice", () => {
    const first = bucketChat({ messages: [msg(5, "a", "x"), msg(35, "a", "y"), msg(45, "b", "z")], clips: [] }, 50);
    const second = bucketChat({ messages: [msg(43, "c", "q"), msg(55, "c", "r")], clips: [{ startSec: 50, endSec: 60 }] }, 60);
    const merged = mergeBuckets(first, second, 40);
    expect(merged.messages).toEqual([1, 0, 0, 1, 1, 1]);
    expect(merged.clips).toEqual([{ startSec: 50, endSec: 60 }]);
    expect(mergeBuckets(null, second, 40)).toBe(second);
  });

  it("slices the part the live picker reads, on its clock", () => {
    const b = bucketChat({ messages: [msg(5, "a", "x"), msg(125, "a", "y")], clips: [{ startSec: 120, endSec: 140 }] }, 200);
    const s = sliceBuckets(b, 103, 160)!;
    expect(s.offsetSec).toBe(-3);
    expect(s.messages).toEqual([0, 0, 1, 0, 0, 0]);
    expect(s.clips).toEqual([{ startSec: 17, endSec: 37 }]);
    expect(sliceBuckets(null, 0, 10)).toBeNull();
  });
});
