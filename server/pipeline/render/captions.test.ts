import { describe, expect, it } from "vitest";
import type { Word } from "../../../shared/types.js";
import { OUT_H, OUT_W } from "./layout.js";
import {
  assTime,
  buildAss,
  CAPTION_FONT_SIZE,
  captionText,
  chunkCaptions,
  clipWords,
  HOOK_SECONDS,
  karaokeEvents,
  lineWidth,
  SAFE,
  SAFE_WIDTH,
} from "./captions.js";

const TEXT =
  "no way he actually did that. chat look at this clip, extraordinarily unbelievable moment right now we go again okay";
const words: Word[] = TEXT.split(" ").map((w, i) => ({ word: w, startSec: i * 0.4, endSec: i * 0.4 + 0.3 }));

describe("chunkCaptions", () => {
  const lines = chunkCaptions(words);

  it("makes lines of at most 4 words, mostly 2-4, keeping every word in order", () => {
    expect(lines.flatMap((l) => l.words)).toEqual(words);
    for (const l of lines) expect(l.words.length).toBeLessThanOrEqual(4);
    expect(lines.filter((l) => l.words.length >= 2).length).toBeGreaterThan(lines.length / 2);
  });

  it("breaks at sentence ends", () => {
    expect(lines.some((l) => l.words.at(-1)!.word === "that.")).toBe(true);
  });

  it("never draws a line wider than the safe area", () => {
    for (const l of lines) expect(lineWidth(l.words.map((w) => w.word), l.fontSize)).toBeLessThanOrEqual(SAFE_WIDTH);
    const long = chunkCaptions([{ word: "supercalifragilisticexpialidocious", startSec: 0, endSec: 1 }]);
    expect(long[0]!.fontSize).toBeLessThan(CAPTION_FONT_SIZE);
    expect(lineWidth(["supercalifragilisticexpialidocious"], long[0]!.fontSize)).toBeLessThanOrEqual(SAFE_WIDTH);
  });

  it("shows each line until the next one starts, with no overlap", () => {
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i - 1]!.endSec).toBe(lines[i]!.startSec);
      expect(lines[i]!.startSec).toBe(lines[i]!.words[0]!.startSec);
    }
  });
});

describe("karaokeEvents", () => {
  it("highlights each word exactly while it is said", () => {
    const events = karaokeEvents(chunkCaptions(words));
    expect(events).toHaveLength(words.length);
    events.forEach((e, i) => {
      expect(e.line.words[e.current]).toBe(words[i]);
      expect(e.startSec).toBe(words[i]!.startSec);
      expect(e.endSec).toBeGreaterThanOrEqual(words[i]!.endSec);
      if (i + 1 < events.length) expect(e.endSec).toBeLessThanOrEqual(events[i + 1]!.startSec);
    });
  });
});

describe("buildAss", () => {
  const ass = buildAss(words, "He did NOT expect this");

  it("uses the 1080×1920 canvas with margins outside platform UI (bottom 20%, right 15%)", () => {
    expect(ass).toContain(`PlayResX: ${OUT_W}`);
    expect(ass).toContain(`PlayResY: ${OUT_H}`);
    const style = ass.split("\n").find((l) => l.startsWith("Style: Caption,"))!.split(",");
    const [marginL, marginR, marginV] = style.slice(19, 22).map(Number);
    expect(style[18]).toBe("2"); // bottom centre
    expect(marginV).toBeGreaterThanOrEqual(OUT_H * 0.2);
    expect(marginR).toBeGreaterThanOrEqual(OUT_W * 0.15);
    expect(marginL).toBe(SAFE.left);
  });

  it("shows the hook for the first 1.5 s and one caption event per word, highlighting it", () => {
    const events = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(events[0]).toBe(`Dialogue: 1,0:00:00.00,${assTime(HOOK_SECONDS)},Hook,,0,0,0,,HE DID NOT EXPECT THIS`);
    const captions = events.slice(1);
    expect(captions).toHaveLength(words.length);
    expect(captions[0]).toBe(
      "Dialogue: 0,0:00:00.00,0:00:00.40,Caption,,0,0,0,,{\\c&H0000E5FF&}NO{\\c&H00FFFFFF&} WAY HE",
    );
    expect(captions[1]).toContain("NO {\\c&H0000E5FF&}WAY{\\c&H00FFFFFF&} HE");
  });

  it("keeps ASS markup characters out of spoken words", () => {
    expect(captionText("{\\b1}hi")).toBe("B1HI");
    expect(buildAss([{ word: "a}b", startSec: 0, endSec: 1 }], "")).not.toContain("a}b");
  });
});

describe("assTime and clipWords", () => {
  it("formats h:mm:ss.cc", () => {
    expect(assTime(0)).toBe("0:00:00.00");
    expect(assTime(61.237)).toBe("0:01:01.24");
    expect(assTime(3725.5)).toBe("1:02:05.50");
  });

  it("shifts words to clip time and keeps only those inside it", () => {
    expect(
      clipWords(
        [
          { word: "before", startSec: 9, endSec: 9.5 },
          { word: "in", startSec: 10.2, endSec: 10.6 },
          { word: "edge", startSec: 29.8, endSec: 30.4 },
          { word: "after", startSec: 31, endSec: 31.5 },
        ],
        10,
        30,
      ),
    ).toEqual([
      { word: "in", startSec: 0.2, endSec: 0.6 },
      { word: "edge", startSec: 19.8, endSec: 20 },
    ]);
  });

  it("keeps how sure the speech-to-text was of each word", () => {
    expect(clipWords([{ word: "Margaret", startSec: 11, endSec: 11.5, confidence: 0.38 }], 10, 30)).toEqual([
      { word: "Margaret", startSec: 1, endSec: 1.5, confidence: 0.38 },
    ]);
  });
});
