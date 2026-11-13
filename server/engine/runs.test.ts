import { describe, expect, it } from "vitest";
import type { EngineReport, EngineUse } from "../../shared/types.js";
import { openDb } from "../db/index.js";
import { shares } from "../pipeline/transcript/chain.js";
import { EngineRuns, measuredSpeed, reasonKind, vodEngineLines, weekLines } from "./runs.js";

const use = (step: string, label: string, count: number, audioSec: number, ms: number, note = ""): EngineUse => ({ step, label, count, audioSec, ms, peakMb: null, note });
const stt = (uses: EngineUse[], fallbacks: EngineReport["fallbacks"] = []): EngineReport => ({ kind: "stt", language: "en", uses, fallbacks, summary: "" });
const picks = (uses: EngineUse[], fallbacks: EngineReport["fallbacks"] = []): EngineReport => ({ kind: "picks", language: null, uses, fallbacks, summary: "" });

const english = stt(
  [use("moonshine", "Moonshine", 55, 3312, 150_000), use("whisper-small", "Whisper small", 5, 288, 48_000, "Spanish segment")],
  [{ step: "moonshine", reason: "the same word came out 6 times in a row", count: 3 }, { step: "moonshine", reason: "timed out", count: 2 }],
);
const spanish = stt(
  [use("whisper-small", "Whisper small", 10, 600, 103_000, "Spanish segments")],
  [{ step: "moonshine", reason: "the stream is in Spanish, and Moonshine only knows English", count: 10 }, { step: "whisper-turbo", reason: "Not enough free memory to start the speech model (large-v3-turbo-q8).", count: 1 }],
);
const written = picks([use("signals", "Signal scoring", 15, 0, 800), use("writer", "Local writer", 12, 0, 95_000), use("template", "Hooks from the transcript", 3, 0, 0)], [{ step: "writer", reason: "the writer's answer was not usable", count: 3 }]);

describe("what a stream's card says about its engine", () => {
  it("names each step with its share and its time, one line for the transcript and one for the picks", () => {
    expect(vodEngineLines([english, written])).toEqual([
      "Transcript: Moonshine 92% in 3 min, Whisper small 8% (Spanish segment) in 48 s",
      "Picks: Signal scoring 15 in under 1 s, Local writer 12 in 2 min, Hooks from the transcript 3",
    ]);
  });

  it("adds up a live stream's segments, and says nothing before anything ran", () => {
    const part = stt([use("moonshine", "Moonshine", 10, 600, 30_000)]);
    expect(vodEngineLines([part, part, stt([use("whisper-small", "Whisper small", 1, 60, 10_000)])])).toEqual(["Transcript: Moonshine 95% in 60 s, Whisper small 5% in 10 s"]);
    expect(vodEngineLines([])).toEqual([]);
  });
});

describe("the weekly summary", () => {
  it("says how much each step handled and how often, and why, it was passed over", () => {
    expect(weekLines([english, spanish, written], { "whisper-turbo": "Whisper large-v3-turbo" })).toEqual([
      "Moonshine: 79% of the audio. Passed over 15 times: 10 another language, 3 poor result, 2 timed out",
      "Whisper small: 21% of the audio",
      "Whisper large-v3-turbo: not used. Passed over 1 time: 1 not enough memory",
      "Local writer: 80% of the hooks. Passed over 3 times: 3 poor result",
      "Hooks from the transcript: 20% of the hooks",
    ]);
    expect(weekLines([])).toEqual([]);
  });

  it("sorts reasons into a few plain kinds", () => {
    expect(reasonKind("python3 failed (SIGSEGV)")).toBe("failed");
    expect(reasonKind("low confidence (average log-probability -1.31, below -1)")).toBe("poor result");
    expect(reasonKind("no words for 80% of the speech")).toBe("poor result");
    expect(reasonKind("the same phrase came out 17 times")).toBe("poor result");
    expect(reasonKind("the words came out garbled (one word over and over)")).toBe("poor result");
    expect(reasonKind("Whisper small is not downloaded yet.")).toBe("not set up");
    expect(reasonKind("there is no OpenAI key.")).toBe("not set up");
  });
});

describe("shares", () => {
  it("adds up to 100 and never shows a step that did some work as 0%", () => {
    expect(shares([999, 1])).toEqual([99, 1]);
    expect(shares([1, 1, 1])).toEqual([34, 33, 33]);
    expect(shares([5, 0])).toEqual([100, 0]);
    expect(shares([0, 0])).toEqual([0, 0]);
  });
});

describe("measured speed", () => {
  it("is the audio a step got through per second of its own time, over all its jobs", () => {
    expect(measuredSpeed([english, spanish], "moonshine")).toBe(22.1);
    expect(measuredSpeed([english, spanish], "whisper-small")).toBe(5.9);
    expect(measuredSpeed([english, spanish], "whisper-turbo")).toBeNull();
  });
});

describe("EngineRuns", () => {
  it("keeps a video's latest transcript run, adds live segments, and lists the week newest first", () => {
    const runs = new EngineRuns(openDb(":memory:"));
    const old = new Date("2026-11-01T10:00:00Z");
    const now = new Date("2026-11-12T10:00:00Z");
    runs.replace(1, english, old);
    runs.replace(1, written, old);
    runs.replace(1, spanish, now);
    expect(runs.forVod(1).map((r) => r.kind)).toEqual(["picks", "stt"]);
    expect(runs.forVod(1)[1]).toEqual(spanish);

    runs.record(2, english, now);
    runs.record(2, english, now);
    expect(runs.forVod(2).length).toBe(2);
    expect(runs.list({ since: new Date("2026-11-05T00:00:00Z") }).map((r) => r.vodId)).toEqual([2, 2, 1]);
    expect(runs.list().length).toBe(4);
  });
});
