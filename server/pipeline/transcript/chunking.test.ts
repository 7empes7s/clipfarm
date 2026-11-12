import { describe, expect, it } from "vitest";
import { mergeChunkWords, planChunks } from "./chunking.js";

describe("planChunks", () => {
  it("returns one chunk when the audio fits", () => {
    expect(planChunks(300, 600, 10)).toEqual([{ index: 0, startSec: 0, durationSec: 300 }]);
  });

  it("covers the whole audio with overlapping chunks whose offsets add up", () => {
    const chunks = planChunks(3600, 1300, 10);
    expect(chunks.map((c) => c.startSec)).toEqual([0, 1290, 2580]);
    expect(chunks.map((c) => c.durationSec)).toEqual([1300, 1300, 1020]);
    for (let i = 1; i < chunks.length; i++) {
      const prevEnd = chunks[i - 1]!.startSec + chunks[i - 1]!.durationSec;
      expect(prevEnd - chunks[i]!.startSec).toBe(10);
    }
    const last = chunks.at(-1)!;
    expect(last.startSec + last.durationSec).toBe(3600);
  });

  it("rejects an overlap as long as a chunk", () => {
    expect(() => planChunks(100, 10, 10)).toThrow();
  });
});

describe("mergeChunkWords", () => {
  it("adds each chunk's offset to its word times", () => {
    const words = mergeChunkWords([
      { startSec: 0, durationSec: 100, words: [{ word: "a", startSec: 1, endSec: 1.5 }] },
      { startSec: 90, durationSec: 100, words: [{ word: "b", startSec: 50, endSec: 50.5 }] },
    ]);
    expect(words).toEqual([
      { word: "a", startSec: 1, endSec: 1.5 },
      { word: "b", startSec: 140, endSec: 140.5 },
    ]);
  });

  it("keeps each word heard in an overlap only once", () => {
    // Overlap is 90-100 s; the cut is at 95 s. "hello" (92 s) and "world" (97 s) are in both chunks.
    const words = mergeChunkWords([
      {
        startSec: 0,
        durationSec: 100,
        words: [
          { word: "before", startSec: 85, endSec: 85.4 },
          { word: "hello", startSec: 92, endSec: 92.4 },
          { word: "world", startSec: 97, endSec: 97.4 },
        ],
      },
      {
        startSec: 90,
        durationSec: 100,
        words: [
          { word: "hello", startSec: 2.02, endSec: 2.4 },
          { word: "world", startSec: 7.01, endSec: 7.4 },
          { word: "after", startSec: 20, endSec: 20.3 },
        ],
      },
    ]);
    expect(words.map((w) => w.word)).toEqual(["before", "hello", "world", "after"]);
    expect(words[1]!.startSec).toBe(92);
    expect(words[2]!.startSec).toBeCloseTo(97.01);
  });
});
