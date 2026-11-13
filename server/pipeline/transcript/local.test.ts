import { describe, expect, it } from "vitest";
import { parseWhisperJson, readWhisperJson, whisperArgs } from "./local.js";

const seg = (text: string, from: number, to: number) => ({ text, offsets: { from, to }, tokens: [] });
const json = (...segs: object[]) => JSON.stringify({ transcription: segs });

describe("whisperArgs", () => {
  it("runs the speech finder first and asks for one word per segment in full JSON", () => {
    const args = whisperArgs({ bin: "whisper-cli", model: "/m/ggml-base.en.bin", vadModel: "/m/vad.bin", modelId: "base.en", needMb: 500 }, "/tmp/a.mp3", "/tmp/out", 4);
    expect(args.join(" ")).toContain("--vad -vm /m/vad.bin");
    expect(args.join(" ")).toContain("-ml 1 -sow");
    expect(args.join(" ")).toContain("-ojf -of /tmp/out");
    expect(args.join(" ")).toContain("-l en");
    expect(whisperArgs({ bin: "w", model: "m", vadModel: "v", modelId: "base", needMb: 500 }, "a", "o", 2).join(" ")).toContain("-l auto");
  });

  it("transcribes in the stream's language with a model that knows every language, and English with an English one", () => {
    const multi = { bin: "w", model: "m", vadModel: "v", modelId: "small-q8", needMb: 600 };
    expect(whisperArgs(multi, "a", "o", 2, "es").join(" ")).toContain("-l es");
    expect(whisperArgs(multi, "a", "o", 2, null).join(" ")).toContain("-l auto");
    expect(whisperArgs({ ...multi, modelId: "base.en" }, "a", "o", 2, "es").join(" ")).toContain("-l en");
  });
});

describe("parseWhisperJson", () => {
  it("turns one-word segments into words timed in seconds", () => {
    const words = parseWhisperJson(json(seg("", 190, 290), seg(" No", 20240, 20350), seg(" way,", 20350, 20920), seg(" he", 20920, 21020)));
    expect(words).toEqual([
      { word: "No", startSec: 20.24, endSec: 20.35 },
      { word: "way,", startSec: 20.35, endSec: 20.92 },
      { word: "he", startSec: 20.92, endSec: 21.02 },
    ]);
  });

  it("pulls the first word after a skipped silence up to its end (VAD maps its start to before the gap)", () => {
    const [that, oh] = parseWhisperJson(json(seg(" that.", 21820, 22190), seg(" Oh", 22190, 50270)));
    expect(that).toEqual({ word: "that.", startSec: 21.82, endSec: 22.19 });
    expect(oh!.endSec).toBe(50.27);
    expect(oh!.startSec).toBeGreaterThan(49);
    expect(oh!.startSec).toBeLessThan(oh!.endSec);
  });

  it("leaves out sound notes and joins stray punctuation to the word before", () => {
    const words = parseWhisperJson(
      json(seg(" [BLANK_AUDIO]", 0, 1000), seg(" (", 1000, 1100), seg(" laughs", 1100, 1500), seg(" )", 1500, 1600), seg(" Yes", 2000, 2300), seg(" -", 2300, 2350), seg(" go", 2400, 2600)),
    );
    expect(words.map((w) => w.word)).toEqual(["Yes-", "go"]);
  });

  it("never gives a word an end at or before its start", () => {
    const [w] = parseWhisperJson(json(seg(" was", 5350, 5350)));
    expect(w!.endSec).toBeGreaterThan(w!.startSec);
  });

  it("fails plainly on output that is not JSON", () => {
    expect(() => parseWhisperJson("whisper crashed")).toThrow("did not write a readable transcript");
  });
});

describe("readWhisperJson (what the fallback chain judges)", () => {
  const tok = (text: string, from: number, to: number, ...p: number[]) => ({ text, offsets: { from, to }, tokens: p.map((x) => ({ text, p: x })) });

  it("averages the log-probability of the word tokens, leaving out whisper's own marks", () => {
    const begin = { text: "", offsets: { from: 0, to: 100 }, tokens: [{ text: "[_BEG_]", p: 0.01 }] };
    const r = readWhisperJson(JSON.stringify({ result: { language: "es" }, transcription: [begin, tok(" No", 200, 400, 0.5), tok(" puede,", 400, 900, 0.9, 0.25)] }));
    expect(r.words.map((w) => w.word)).toEqual(["No", "puede,"]);
    expect(r.avgLogProb).toBeCloseTo((Math.log(0.5) + Math.log(0.9) + Math.log(0.25)) / 3, 6);
    expect(r.language).toBe("es");
  });

  it("counts sound notes as speech it had no words for", () => {
    const r = readWhisperJson(json(seg(" [BLANK_AUDIO]", 0, 4000), seg(" (", 4000, 4100), seg(" music", 4100, 6000), seg(" )", 6000, 6100), seg(" Yes", 7000, 7500)));
    expect(r.words.map((w) => w.word)).toEqual(["Yes"]);
    expect(r.silentSec).toBe(6.1);
    expect(r.heardSec).toBe(6.6);
  });

  it("does not let a note stretched over a skipped silence count for more than 30 s", () => {
    expect(readWhisperJson(json(seg(" [BLANK_AUDIO]", 1000, 400000))).silentSec).toBe(30);
  });

  it("has no confidence and nothing heard for silence", () => {
    expect(readWhisperJson(json())).toEqual({ words: [], avgLogProb: null, heardSec: 0, silentSec: 0, language: null });
  });
});
