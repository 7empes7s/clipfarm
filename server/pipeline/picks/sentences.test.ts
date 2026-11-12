import { describe, expect, it } from "vitest";
import type { Word } from "../../../shared/types.js";
import { snapWindow, toSentences, wordsIn } from "./sentences.js";

/** Words every 0.5 s; a sentence ends every `perSentence` words (with a period). */
function speech(seconds: number, perSentence = 10): Word[] {
  const words: Word[] = [];
  for (let i = 0; i * 0.5 + 0.4 <= seconds; i++) {
    const end = (i + 1) % perSentence === 0;
    words.push({ word: end ? "done." : "word", startSec: i * 0.5, endSec: i * 0.5 + 0.4 });
  }
  return words;
}

describe("toSentences", () => {
  it("breaks after end punctuation and after pauses", () => {
    const words: Word[] = [
      { word: "what", startSec: 0, endSec: 0.3 },
      { word: "happened?", startSec: 0.4, endSec: 0.8 },
      { word: "no", startSec: 0.9, endSec: 1.1 },
      { word: "way", startSec: 1.2, endSec: 1.5 },
      { word: "okay", startSec: 2.5, endSec: 2.9 },
    ];
    expect(toSentences(words)).toEqual([
      { startSec: 0, endSec: 0.8, text: "what happened?" },
      { startSec: 0.9, endSec: 1.5, text: "no way" },
      { startSec: 2.5, endSec: 2.9, text: "okay" },
    ]);
  });

  it("returns nothing for no words", () => {
    expect(toSentences([])).toEqual([]);
  });
});

describe("snapWindow", () => {
  // Sentences of 5 s: [0-4.9], [5-9.9], [10-14.9], ...
  const sentences = toSentences(speech(120));

  it("moves both ends onto the nearest sentence boundaries", () => {
    expect(snapWindow(sentences, { startSec: 11.2, endSec: 38.1 })).toEqual({ startSec: 10, endSec: 39.9 });
    const starts = new Set(sentences.map((s) => s.startSec));
    const ends = new Set(sentences.map((s) => s.endSec));
    for (const [a, b] of [[3, 33], [57.5, 80], [0, 15]] as const) {
      const r = snapWindow(sentences, { startSec: a, endSec: b })!;
      expect(starts.has(r.startSec)).toBe(true);
      expect(ends.has(r.endSec)).toBe(true);
    }
  });

  it("keeps clips between 15 and 60 s", () => {
    const short = snapWindow(sentences, { startSec: 20, endSec: 26 })!;
    expect(short.endSec - short.startSec).toBeGreaterThanOrEqual(15);
    const long = snapWindow(sentences, { startSec: 0, endSec: 110 })!;
    expect(long.endSec - long.startSec).toBeLessThanOrEqual(60);
    expect(long).toEqual({ startSec: 0, endSec: 59.9 });
  });

  it("gives up when no sentence-aligned window fits", () => {
    expect(snapWindow(toSentences(speech(10)), { startSec: 0, endSec: 10 })).toBeNull();
    // One 80 s sentence with no breaks cannot be cut to 60 s on a boundary.
    expect(snapWindow(toSentences(speech(80, 1000)), { startSec: 0, endSec: 40 })).toBeNull();
    expect(snapWindow([], { startSec: 0, endSec: 30 })).toBeNull();
  });
});

describe("wordsIn", () => {
  it("keeps only words inside the range", () => {
    const w = wordsIn(speech(10), { startSec: 2, endSec: 3.4 });
    expect(w.map((x) => x.startSec)).toEqual([2, 2.5, 3]);
  });
});
