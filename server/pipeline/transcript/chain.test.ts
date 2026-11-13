import { describe, expect, it } from "vitest";
import type { Word } from "../../../shared/types.js";
import {
  ChainFailedError,
  type ChainThresholds,
  DEFAULT_THRESHOLDS,
  lowConfidence,
  parsePauses,
  planSegments,
  repeats,
  runChain,
  type Segment,
  type StepResult,
  type StepRunOptions,
  stitch,
  type SttStep,
  summarize,
  thresholdsFromEnv,
} from "./chain.js";

const T = DEFAULT_THRESHOLDS;
const word = (w: string, startSec: number, endSec = startSec + 0.3): Word => ({ word: w, startSec, endSec });
/** "a b c" said from `at`, one word every half second. */
const say = (text: string, at = 1): Word[] => text.split(" ").map((w, i) => word(w, at + i * 0.5));
const good = (text: string, extra: Partial<StepResult> = {}): StepResult => ({ words: say(text), avgLogProb: -0.2, confidence: 0.95, heardSec: 10, silentSec: 0, ...extra });

/** A fake engine runner: answers per segment from a script, and notes every call. */
function fakeStep(
  id: string,
  answer: (segment: number, opts: StepRunOptions) => StepResult | Promise<StepResult>,
  extra: Partial<SttStep> = {},
): SttStep & { calls: { segment: number; language: string | null }[] } {
  const calls: { segment: number; language: string | null }[] = [];
  return {
    id,
    label: id === "moonshine" ? "Moonshine" : id === "whisper-small" ? "Whisper small" : id === "whisper-turbo" ? "Whisper large-v3-turbo" : "Cloud (OpenAI)",
    languages: id === "moonshine" ? "en" : "any",
    unavailable: () => null,
    calls,
    run: async (audio, opts) => {
      const segment = Number(/segment-(\d+)/.exec(audio)![1]);
      calls.push({ segment, language: opts.language });
      return answer(segment, opts);
    },
    ...extra,
  };
}

const segments = (n: number, each = 60): Segment[] => Array.from({ length: n }, (_, i) => ({ index: i, startSec: i * each, durationSec: each }));
const deps = (steps: SttStep[], thresholds: ChainThresholds = T) => ({
  steps,
  thresholds,
  tmpDir: "/nowhere",
  cut: async (s: Segment) => `segment-${s.index}.wav`,
});

describe("planSegments", () => {
  it("cuts about every 60 s, in the middle of the pause nearest to that", () => {
    const plan = planSegments(200, [{ startSec: 40, endSec: 41 }, { startSec: 57, endSec: 59 }, { startSec: 121.9, endSec: 122.1 }, { startSec: 125, endSec: 127 }]);
    // The 0.2 s pause at 122 is too short to cut at (minPauseSec 0.3): the cut goes to 126.
    expect(plan).toEqual([
      { index: 0, startSec: 0, durationSec: 58 },
      { index: 1, startSec: 58, durationSec: 68 },
      { index: 2, startSec: 126, durationSec: 74 },
    ]);
  });

  it("cuts at 60 s when no pause is in reach, and never leaves a gap or an overlap", () => {
    const plan = planSegments(250, [{ startSec: 10, endSec: 12 }]);
    expect(plan.map((s) => s.startSec)).toEqual([0, 60, 120, 180]);
    // 70 s are left after 180: within the longest a segment may be (90), so they stay in one piece.
    expect(plan.at(-1)).toEqual({ index: 3, startSec: 180, durationSec: 70 });
    const total = planSegments(250, []).reduce((sum, s) => sum + s.durationSec, 0);
    expect(total).toBe(250);
  });

  it("keeps a short file whole and gives nothing for no audio", () => {
    expect(planSegments(75, [{ startSec: 30, endSec: 40 }])).toEqual([{ index: 0, startSec: 0, durationSec: 75 }]);
    expect(planSegments(0, [])).toEqual([]);
  });
});

describe("parsePauses", () => {
  it("reads ffmpeg's silencedetect lines, and closes a pause that runs to the end", () => {
    const log = `[silencedetect @ 0x1] silence_start: 0
[silencedetect @ 0x1] silence_end: 20.2148 | silence_duration: 20.2148
[silencedetect @ 0x1] silence_start: 26
[silencedetect @ 0x1] silence_end: 50.172 | silence_duration: 24.172
[silencedetect @ 0x1] silence_start: 56`;
    expect(parsePauses(log, 66)).toEqual([
      { startSec: 0, endSec: 20.2148 },
      { startSec: 26, endSec: 50.172 },
      { startSec: 56, endSec: 66 },
    ]);
  });
});

describe("lowConfidence (the thresholds)", () => {
  it("keeps a clear answer", () => {
    expect(lowConfidence(good("no way he actually did that"))).toBeNull();
  });

  it("rejects Whisper's answer when its average log-probability is below the threshold, not at it", () => {
    expect(lowConfidence(good("no way", { avgLogProb: -1.01 }))).toContain("low confidence (average log-probability -1.01");
    expect(lowConfidence(good("no way", { avgLogProb: -1 }))).toBeNull();
    expect(lowConfidence(good("no way", { avgLogProb: -1.01 }), { ...T, minAvgLogProb: -1.5 })).toBeNull();
  });

  it("rejects an answer with no words for most of the speech it heard, once there is enough speech to judge", () => {
    expect(lowConfidence(good("ok", { heardSec: 10, silentSec: 6.1 }))).toBe("no words for 61% of the speech");
    expect(lowConfidence(good("ok", { heardSec: 10, silentSec: 6 }))).toBeNull();
    // 4 s of speech is under minJudgedSec (5): too little to judge.
    expect(lowConfidence(good("ok", { heardSec: 4, silentSec: 4 }))).toBeNull();
    expect(lowConfidence({ words: [], heardSec: 30, silentSec: 30 })).toBe("no words for 100% of the speech");
  });

  it("rejects Moonshine output with a stuck, repeated word or garbled tokens", () => {
    expect(repeats(say("go go go go go now"))).toEqual({ run: 5, share: 5 / 6, phrase: 1 });
    expect(lowConfidence(good("the the the the the the the the end"))).toBe("the same word came out 8 times in a row");
    // An excited "go, go, go" is speech: seven in a row are kept.
    expect(lowConfidence(good("go go go go go go go police"))).toBeNull();
    // One word is 7 of 12 (58%, over maxRepeatShare 50%) without ever being 5 in a row.
    expect(lowConfidence(good("a b a b a b a b a c a d"))).toBeNull();
    expect(lowConfidence(good("a a b a a b a a b a c d"))).toBe("the words came out garbled (one word over and over)");
    expect(lowConfidence(good("caf� is open"))).toBe("the words came out garbled");
  });

  it("rejects Moonshine's answer when its average word confidence is below the threshold", () => {
    expect(lowConfidence(good("no way", { avgLogProb: null, confidence: 0.49 }))).toBe("low confidence (49%, below 50%)");
    expect(lowConfidence(good("no way", { avgLogProb: null, confidence: 0.5 }))).toBeNull();
  });

  it("takes silence (no words, nothing heard) as a fine answer", () => {
    expect(lowConfidence({ words: [], heardSec: 0, silentSec: 0, avgLogProb: null })).toBeNull();
  });

  it("reads thresholds from the environment on top of the defaults", () => {
    const t = thresholdsFromEnv({ STT_MIN_AVG_LOGPROB: "-0.7", STT_SEGMENT_SEC: "45", STT_MAX_REPEAT_RUN: "", STT_TIMEOUT_FACTOR: "soon" });
    expect(t).toEqual({ ...T, minAvgLogProb: -0.7, segmentSec: 45 });
  });
});

describe("the speech-to-text chain (fake engine runners)", () => {
  it("sends English to Moonshine and never starts the fallbacks", async () => {
    const moonshine = fakeStep("moonshine", () => good("no way he did that"));
    const small = fakeStep("whisper-small", () => good("never"));
    const result = await runChain(segments(3), "en", deps([moonshine, small]));
    expect(moonshine.calls.map((c) => c.segment)).toEqual([0, 1, 2]);
    expect(small.calls).toEqual([]);
    expect(result.report.summary).toBe("Moonshine 100%");
    expect(result.report.fallbacks).toEqual([]);
  });

  it("skips Moonshine for Spanish and goes to Whisper small, in Spanish", async () => {
    const moonshine = fakeStep("moonshine", () => good("never"));
    const small = fakeStep("whisper-small", () => good("no puede ser", { language: "es" }));
    const result = await runChain(segments(2), "es", deps([moonshine, small]));
    expect(moonshine.calls).toEqual([]);
    expect(small.calls).toEqual([{ segment: 0, language: "es" }, { segment: 1, language: "es" }]);
    expect(result.report.language).toBe("es");
    expect(result.report.summary).toBe("Whisper small 100% (Spanish segments)");
    expect(result.report.fallbacks).toEqual([{ step: "moonshine", reason: "the stream is in Spanish, and Moonshine only knows English", count: 2 }]);
  });

  it("takes an unknown language as English", async () => {
    const moonshine = fakeStep("moonshine", () => good("hello"));
    await runChain(segments(1), null, deps([moonshine]));
    expect(moonshine.calls).toEqual([{ segment: 0, language: null }]);
  });

  it("retries only the segment that crashed on the next step", async () => {
    const moonshine = fakeStep("moonshine", (i) => {
      if (i === 1) throw new Error("python3 failed (SIGSEGV)");
      return good(`moon ${i}`);
    });
    const small = fakeStep("whisper-small", (i) => good(`small ${i}`));
    const result = await runChain(segments(3), "en", deps([moonshine, small]));
    expect(small.calls.map((c) => c.segment)).toEqual([1]);
    expect(result.words.map((w) => w.word)).toEqual(["moon", "0", "small", "1", "moon", "2"]);
    expect(result.report.fallbacks).toEqual([{ step: "moonshine", reason: "python3 failed (SIGSEGV)", count: 1 }]);
    expect(result.report.uses.map((u) => [u.step, u.count, u.audioSec])).toEqual([["moonshine", 2, 120], ["whisper-small", 1, 60]]);
    expect(result.report.summary).toBe("Moonshine 67%, Whisper small 33%");
  });

  it("retries a segment that ran out of memory on the next step", async () => {
    const moonshine = fakeStep("moonshine", () => {
      throw new Error("Not enough free memory to start the speech model (Moonshine)");
    });
    const small = fakeStep("whisper-small", () => good("ok then"));
    const result = await runChain(segments(1), "en", deps([moonshine, small]));
    expect(result.words.map((w) => w.word)).toEqual(["ok", "then"]);
  });

  it("retries a segment that timed out on the next step, and stops the stuck one", async () => {
    let stopped = false;
    const moonshine = fakeStep(
      "moonshine",
      (_i, opts) =>
        new Promise<StepResult>((_resolve, reject) => {
          opts.signal!.addEventListener("abort", () => {
            stopped = true;
            reject(new Error("killed"));
          });
        }),
    );
    const small = fakeStep("whisper-small", () => good("made it"));
    // 0.5 s of audio, at most 0.1 s per second of audio and at least 0.05 s: the step gets 50 ms.
    const result = await runChain([{ index: 0, startSec: 0, durationSec: 0.5 }], "en", deps([moonshine, small], { ...T, timeoutFactor: 0.1, minTimeoutSec: 0.05 }));
    expect(stopped).toBe(true);
    expect(result.words.map((w) => w.word)).toEqual(["made", "it"]);
    expect(result.report.fallbacks).toEqual([{ step: "moonshine", reason: "timed out", count: 1 }]);
  });

  it("retries a low-confidence segment on the next step, which listens for the language itself", async () => {
    const moonshine = fakeStep("moonshine", (i) => (i === 1 ? good("the the the the the the the the the") : good(`moon ${i}`)));
    const small = fakeStep("whisper-small", () => good("no puede ser", { language: "es" }));
    const result = await runChain(segments(12, 50), "en", deps([moonshine, small]));
    expect(small.calls).toEqual([{ segment: 1, language: null }]);
    expect(result.report.summary).toBe("Moonshine 92%, Whisper small 8% (Spanish segment)");
    expect(result.report.fallbacks).toEqual([{ step: "moonshine", reason: "the same word came out 9 times in a row", count: 1 }]);
  });

  it("goes down the whole chain: Whisper small's poor answer is retried on large-v3-turbo", async () => {
    const moonshine = fakeStep("moonshine", () => good("x", { confidence: 0.2 }));
    const small = fakeStep("whisper-small", () => good("y", { avgLogProb: -1.4 }));
    const turbo = fakeStep("whisper-turbo", () => good("clear now"));
    const result = await runChain(segments(1), "en", deps([moonshine, small, turbo]));
    expect(result.words.map((w) => w.word)).toEqual(["clear", "now"]);
    expect(result.report.fallbacks.map((f) => f.step)).toEqual(["moonshine", "whisper-small"]);
  });

  it("passes over a step that cannot run now (large-v3-turbo without memory) and says why", async () => {
    const small = fakeStep("whisper-small", () => good("y", { avgLogProb: -1.4 }));
    const turbo = fakeStep("whisper-turbo", () => good("never"), { unavailable: () => "Not enough free memory to start the speech model (large-v3-turbo-q8)." });
    const result = await runChain(segments(1), "es", deps([small, turbo]));
    expect(turbo.calls).toEqual([]);
    // Every local answer was poor: the last one that tried is kept, the job does not fail.
    expect(result.words.map((w) => w.word)).toEqual(["y"]);
    expect(result.report.fallbacks.at(-1)).toEqual({ step: "whisper-turbo", reason: "Not enough free memory to start the speech model (large-v3-turbo-q8).", count: 1 });
  });

  it("fails the job with a clear error when every local step fails and cloud is off", async () => {
    const moonshine = fakeStep("moonshine", () => {
      throw new Error("python3 failed (SIGKILL)");
    });
    const small = fakeStep("whisper-small", () => {
      throw new Error("whisper-cli failed: bad model file");
    });
    const run = runChain(segments(2), "en", deps([moonshine, small]));
    await expect(run).rejects.toBeInstanceOf(ChainFailedError);
    await expect(run).rejects.toThrow(
      'Speech-to-text failed for the part at 0:00: no step could transcribe it. Moonshine: python3 failed (SIGKILL) Whisper small: whisper-cli failed: bad model file Cloud AI is off; switch on "Fall back to cloud AI" on the Dashboard to let it take over when this happens.',
    );
  });

  it("falls back to cloud when every local step fails and cloud is on, for that segment only", async () => {
    const moonshine = fakeStep("moonshine", (i) => {
      if (i === 0) throw new Error("crashed");
      return good("local words");
    });
    const small = fakeStep("whisper-small", () => {
      throw new Error("crashed too");
    });
    const cloud = fakeStep("cloud", () => ({ words: say("cloud words"), costUsd: 0.006 }), { cloud: true });
    const result = await runChain(segments(2), "en", deps([moonshine, small, cloud]));
    expect(cloud.calls.map((c) => c.segment)).toEqual([0]);
    expect(result.words.map((w) => w.word)).toEqual(["cloud", "words", "local", "words"]);
    expect(result.costUsd).toBe(0.006);
    expect(result.report.summary).toBe("Moonshine 50%, Cloud (OpenAI) 50%");
  });

  it("does not pay for cloud when a local step answered, however poorly", async () => {
    const small = fakeStep("whisper-small", () => good("mumble", { avgLogProb: -2 }));
    const cloud = fakeStep("cloud", () => ({ words: say("never") }), { cloud: true });
    const result = await runChain(segments(1), "es", deps([small, cloud]));
    expect(cloud.calls).toEqual([]);
    expect(result.words.map((w) => w.word)).toEqual(["mumble"]);
  });

  it("stops without trying the next step when the job is cancelled", async () => {
    const controller = new AbortController();
    const moonshine = fakeStep("moonshine", () => {
      controller.abort();
      throw new Error("killed");
    });
    const small = fakeStep("whisper-small", () => good("never"));
    await expect(runChain(segments(1), "en", { ...deps([moonshine, small]), signal: controller.signal })).rejects.toThrow(/abort/i);
    expect(small.calls).toEqual([]);
  });

  it("keeps the word order and each engine's word times in the stitched transcript", async () => {
    const moonshine = fakeStep("moonshine", (i) => {
      if (i === 1) throw new Error("crashed");
      return { words: [word("one", 1, 1.4), word("two", 58.2, 58.9)], confidence: 1 };
    });
    const small = fakeStep("whisper-small", () => ({ words: [word("uno", 0.25, 0.6), word("dos", 30, 30.5)], avgLogProb: -0.1, language: "es" }));
    const result = await runChain(
      [{ index: 0, startSec: 0, durationSec: 59 }, { index: 1, startSec: 59, durationSec: 61 }, { index: 2, startSec: 120, durationSec: 60 }],
      "en",
      deps([moonshine, small]),
    );
    expect(result.words).toEqual([
      { word: "one", startSec: 1, endSec: 1.4 },
      { word: "two", startSec: 58.2, endSec: 58.9 },
      { word: "uno", startSec: 59.25, endSec: 59.6 },
      { word: "dos", startSec: 89, endSec: 89.5 },
      { word: "one", startSec: 121, endSec: 121.4 },
      { word: "two", startSec: 178.2, endSec: 178.9 },
    ]);
  });

  it("reports progress by audio done and cleans up each segment's audio", async () => {
    const progress: number[] = [];
    const cleaned: string[] = [];
    const moonshine = fakeStep("moonshine", (i) => {
      if (i === 1) throw new Error("crashed");
      return good("ok");
    });
    await expect(
      runChain(segments(3), "en", { ...deps([moonshine]), onProgress: (f) => progress.push(f), done: async (p) => void cleaned.push(p) }),
    ).rejects.toBeInstanceOf(ChainFailedError);
    expect(progress).toEqual([1 / 3]);
    // The failed segment's audio is deleted too.
    expect(cleaned).toEqual(["segment-0.wav", "segment-1.wav"]);
  });
});

describe("stitch", () => {
  it("keeps words inside their own segment, so a timing slip cannot put them out of order", () => {
    const words = stitch([
      { segment: { index: 1, startSec: 60, durationSec: 60 }, words: [word("late", -0.4, 0.2), word("end", 59.8, 61)] },
      { segment: { index: 0, startSec: 0, durationSec: 60 }, words: [word("first", 2, 2.5), word("over", 59.9, 60.6)] },
    ]);
    expect(words).toEqual([
      { word: "first", startSec: 2, endSec: 2.5 },
      { word: "over", startSec: 59.9, endSec: 60 },
      { word: "late", startSec: 60, endSec: 60.2 },
      { word: "end", startSec: 119.8, endSec: 120 },
    ]);
  });
});

describe("summarize", () => {
  const use = (label: string, audioSec: number, note = "") => ({ step: label, label, count: 1, audioSec, ms: 1000, peakMb: null, note });
  it("gives each step's share of the audio, adding up to 100", () => {
    expect(summarize([use("Moonshine", 552), use("Whisper small", 48, "Spanish segment")])).toBe("Moonshine 92%, Whisper small 8% (Spanish segment)");
    expect(summarize([use("A", 1), use("B", 1), use("C", 1)])).toBe("A 34%, B 33%, C 33%");
    expect(summarize([use("A", 999), use("B", 1)])).toBe("A 99%, B 1%");
    expect(summarize([])).toBe("");
  });
});
