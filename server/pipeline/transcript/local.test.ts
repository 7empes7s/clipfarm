import { describe, expect, it } from "vitest";
import { parseWhisperJson, whisperArgs } from "./local.js";

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
