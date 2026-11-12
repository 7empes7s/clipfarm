import { describe, expect, it } from "vitest";
import type { Word } from "../../../shared/types.js";
import { FakeChatClient } from "./fake.js";
import type { ChatClient } from "./llm.js";
import { CLIP_COPY_SCHEMA, type HookWriter, keywordFlags, LocalPicker, parseClipCopy, templateHook, templateTitle, WriterUnavailableError } from "./local.js";
import { reviewPicks } from "./review.js";
import { toSentences } from "./sentences.js";
import { NO_FLAGS, type PickInput } from "./types.js";

/** Lines of speech: each line's words are spread over [start, start + 3 s], lines end with a full stop. */
function speech(lines: [number, string][]): Word[] {
  return lines.flatMap(([start, text]) => {
    const parts = text.split(" ");
    return parts.map((word, i) => ({ word, startSec: start + (i * 3) / parts.length, endSec: start + ((i + 1) * 3) / parts.length - 0.05 }));
  });
}

/** A 5-minute VOD, a line every 4 s; two loud, hyped stretches around 60 s and 200 s. */
function vod(extra: [number, string][] = []): PickInput {
  const lines: [number, string][] = [];
  for (let t = 0; t < 300; t += 4) lines.push([t, "we are driving to the next mission now."]);
  const at = (t: number, text: string) => {
    lines[lines.findIndex(([s]) => s === t)] = [t, text];
  };
  at(60, "no way he actually jumped off the roof!");
  at(64, "oh my god that was insane.");
  at(200, "go go go the police are behind us!");
  for (const [t, text] of extra) at(t, text);
  const loudness = Array.from({ length: 300 }, (_, i) => ((i >= 58 && i <= 68) || (i >= 198 && i <= 206) ? -10 : -30));
  return {
    title: "GTA night", durationSec: 300, chapters: [], words: speech(lines), signals: { loudness, chat: null },
    creatorName: "Kai", briefRules: "", bannedContent: "", maxPicks: 10,
  };
}

function fakeWriter(chat: ChatClient) {
  const state = { opened: 0, closed: 0 };
  const writer: HookWriter = {
    async session(fn) {
      state.opened++;
      try {
        return await fn(chat);
      } finally {
        state.closed++;
      }
    },
  };
  return { writer, state };
}

const noFlags = { spoiler: false, cutscene: false, ending: false, leak: false, breaks_brief: false };

describe("keywordFlags", () => {
  it("flags spoilers, endings, leaks and cutscenes from what is said, and nothing in ordinary talk", () => {
    expect(keywordFlags("oh my god he jumped off the roof I am dead")).toEqual(NO_FLAGS);
    expect(keywordFlags("spoiler warning he dies at the end")).toMatchObject({ spoiler: true });
    expect(keywordFlags("so this is the final mission and then the credits roll")).toMatchObject({ ending: true });
    expect(keywordFlags("somebody sent me the leaked build it is not out yet")).toMatchObject({ leak: true });
    expect(keywordFlags("let me skip this cutscene")).toMatchObject({ cutscene: true });
  });

  it("flags a window that falls in a chapter called Ending or Credits", () => {
    expect(keywordFlags("what a ride", ["Ending"])).toMatchObject({ ending: true });
    expect(keywordFlags("what a ride", ["Free roam"])).toEqual(NO_FLAGS);
  });
});

describe("template hooks and titles", () => {
  it("uses the line said at the peak, at most 8 words", () => {
    expect(templateHook("No way, he actually jumped off the roof.")).toBe("No way, he actually jumped off the roof");
    expect(templateHook("one two three four five six seven eight nine ten.")).toBe("one two three four five six seven eight…");
  });

  it("puts the streamer's name in the title and stays within 70 characters", () => {
    expect(templateTitle("Kai", "He actually jumped off the roof.")).toBe('Kai: "He actually jumped off the roof"');
    const long = templateTitle("Kai", "this is a very long line that keeps going and going and going far past what fits in a title");
    expect(long.length).toBeLessThanOrEqual(70);
    expect(long).toMatch(/^Kai: ".*…"$/);
  });
});

describe("parseClipCopy", () => {
  it("accepts an answer that matches the schema", () => {
    expect(parseClipCopy(JSON.stringify({ hook: " He jumped ", title: "Kai jumps", flags: { ...noFlags, leak: true } }))).toEqual({
      hook: "He jumped", title: "Kai jumps", flags: { ...NO_FLAGS, leak: true },
    });
  });

  it("rejects anything else: not JSON, an empty hook, a missing or non-boolean flag, an overlong hook", () => {
    expect(parseClipCopy("Sure! Here is your hook")).toBeNull();
    expect(parseClipCopy(JSON.stringify({ hook: "", title: "t", flags: noFlags }))).toBeNull();
    expect(parseClipCopy(JSON.stringify({ hook: "h", title: "t", flags: { spoiler: false } }))).toBeNull();
    expect(parseClipCopy(JSON.stringify({ hook: "h", title: "t", flags: { ...noFlags, leak: "no" } }))).toBeNull();
    expect(parseClipCopy(JSON.stringify({ hook: "h".repeat(81), title: "t", flags: noFlags }))).toBeNull();
    expect(parseClipCopy("null")).toBeNull();
  });
});

describe("LocalPicker with the writer off (signals and template hooks, no AI at all)", () => {
  it("ranks the loud, hyped moments first and writes hooks from the transcript", async () => {
    const input = vod();
    const { picks, costUsd } = await new LocalPicker().pick(input);

    expect(costUsd).toBe(0);
    expect(picks.length).toBeGreaterThanOrEqual(2);
    const [first, second] = picks;
    const peaks = [first!, second!].map((p) => (p.startSec < 100 ? "roof" : "police")).sort();
    expect(peaks).toEqual(["police", "roof"]);
    expect(first!.score).toBeGreaterThan(picks.at(-1)!.score);
    expect(picks.every((p, i) => i === 0 || p.score <= picks[i - 1]!.score)).toBe(true);
    const roof = picks.find((p) => p.startSec < 100)!;
    expect(roof.hook.split(" ").length).toBeLessThanOrEqual(8);
    expect(roof.hook).toMatch(/roof|insane/);
    expect(roof.title).toMatch(/^Kai: "/);
    expect(roof.reason).toMatch(/Peak at 1:0\d: 20 dB louder than usual/);
    expect(roof.flags).toEqual(NO_FLAGS);

    // The charter gate keeps them: sentence-aligned and 15-60 s.
    const kept = reviewPicks(picks, toSentences(input.words), input.words, [], 10).filter((p) => !p.dropReason);
    expect(kept.length).toBeGreaterThanOrEqual(2);
    for (const p of kept) expect(p.endSec - p.startSec).toBeGreaterThanOrEqual(15);
  });

  it("flags a moment where an ending or a leak is talked about, so the gate drops it", async () => {
    const input = vod([[204, "and that was the final mission of the leaked build."]]);
    const { picks } = await new LocalPicker().pick(input);
    const police = picks.find((p) => p.startSec > 150 && p.startSec < 210)!;
    expect(police.flags).toMatchObject({ ending: true, leak: true });
    const reviewed = reviewPicks(picks, toSentences(input.words), input.words, [], 10);
    expect(reviewed.find((p) => p.startSec === police.startSec)!.dropReason).toContain("leaked content");
  });

  it("gives no picks for a VOD without speech", async () => {
    expect((await new LocalPicker().pick({ ...vod(), words: [] })).picks).toEqual([]);
  });
});

describe("LocalPicker with the writer on", () => {
  it("asks the writer once per moment with a strict schema, and uses its hook and title", async () => {
    const chat = new FakeChatClient(() => ({ hook: "He really jumped", title: "Kai can't believe the roof jump", flags: noFlags }));
    const { writer, state } = fakeWriter(chat);
    const { picks } = await new LocalPicker(() => writer).pick(vod());

    expect(state).toEqual({ opened: 1, closed: 1 });
    expect(chat.requests.length).toBe(picks.length);
    expect(chat.requests[0]!.schema).toBe(CLIP_COPY_SCHEMA);
    expect(chat.requests[0]!.user).toContain("Streamer: Kai");
    expect(chat.requests.some((r) => /\[\d+\.\d-\d+\.\d\] .*roof/.test(r.user))).toBe(true);
    expect(picks.every((p) => p.hook === "He really jumped" && p.title === "Kai can't believe the roof jump")).toBe(true);
    expect(picks[0]!.reason).not.toContain("transcript");
  });

  it("adds the writer's flags to the keyword flags and never clears one", async () => {
    const input = vod([[204, "and that was the final mission."]]);
    const chat = new FakeChatClient((req) => ({ hook: "h", title: "t", flags: { ...noFlags, spoiler: req.user.includes("roof") } }));
    const { picks } = await new LocalPicker(() => fakeWriter(chat).writer).pick(input);
    expect(picks.find((p) => p.startSec < 100)!.flags).toMatchObject({ spoiler: true, ending: false });
    expect(picks.find((p) => p.startSec > 150 && p.startSec < 210)!.flags).toMatchObject({ spoiler: false, ending: true });
  });

  it("keeps the transcript hook, and says so, when the writer's answer does not match the schema", async () => {
    const chat = new FakeChatClient(() => ({ hook: "Nice", title: "t", flags: { spoiler: "maybe" } }));
    const { picks } = await new LocalPicker(() => fakeWriter(chat).writer).pick(vod());
    const roof = picks.find((p) => p.startSec < 100)!;
    expect(roof.hook).not.toBe("Nice");
    expect(roof.hook).toMatch(/roof|insane/);
    expect(roof.reason).toContain("Hook taken from the transcript: the writer's answer was not usable.");
  });

  it("falls back to transcript hooks with the plain reason when the writer cannot start (memory guard)", async () => {
    const why = "Not enough free memory to start the hook writer (qwen2.5-1.5b): it needs 1.6 GB plus 1.0 GB spare, and 1.2 GB is free.";
    const refused: HookWriter = { session: () => Promise.reject(new WriterUnavailableError(why)) };
    const { picks } = await new LocalPicker(() => refused).pick(vod());
    expect(picks.length).toBeGreaterThanOrEqual(2);
    expect(picks.every((p) => p.reason.endsWith(`Hook taken from the transcript: ${why}`))).toBe(true);
    expect(picks.find((p) => p.startSec < 100)!.hook).toMatch(/roof|insane/);
  });

  it("fails the picking when the writer breaks for any other reason", async () => {
    const broken: HookWriter = { session: () => Promise.reject(new Error("The hook writer did not start: boom")) };
    await expect(new LocalPicker(() => broken).pick(vod())).rejects.toThrow("did not start");
  });
});
