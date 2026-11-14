import { describe, expect, it } from "vitest";
import type { Word } from "../../../shared/types.js";
import { bucketChat } from "../chat/buckets.js";
import { seededChat } from "../chat/fake.js";
import { toSentences } from "./sentences.js";
import { candidateWindows, isHypeWord, parseEbur128, secondScores } from "./signals.js";

const LOG = `[Parsed_ebur128_0 @ 0x1] t: 0.0999773  TARGET:-23 LUFS    M:-120.7 S:-120.7     I: -70.0 LUFS       LRA:   0.0 LU
[Parsed_ebur128_0 @ 0x1] t: 0.499977   TARGET:-23 LUFS    M: -30.2 S:-120.7     I: -70.0 LUFS       LRA:   0.0 LU
[Parsed_ebur128_0 @ 0x1] t: 1          TARGET:-23 LUFS    M: -25.0 S:-120.7     I: -70.0 LUFS       LRA:   0.0 LU
[Parsed_ebur128_0 @ 0x1] t: 1.2        TARGET:-23 LUFS    M: -12.3 S: -20.0     I: -20.0 LUFS       LRA:   0.0 LU
  Summary:
  Integrated loudness:
    I:         -20.0 LUFS`;

function talk(seconds: number): Word[] {
  const words: Word[] = [];
  for (let i = 0; i * 0.5 + 0.4 <= seconds; i++) {
    words.push({ word: (i + 1) % 10 === 0 ? "okay." : "so", startSec: i * 0.5, endSec: i * 0.5 + 0.4 });
  }
  return words;
}

describe("parseEbur128", () => {
  it("keeps the loudest momentary value per second", () => {
    expect(parseEbur128(LOG)).toEqual([-25, -12.3]);
  });
  it("is empty for no meter lines", () => {
    expect(parseEbur128("nothing here")).toEqual([]);
  });
});

describe("secondScores and candidateWindows", () => {
  const duration = 300;
  const quiet = new Array<number>(duration).fill(-35);

  it("peaks where it gets loud and where people shout", () => {
    const loud = [...quiet];
    for (let s = 100; s < 104; s++) loud[s] = -8;
    const scores = secondScores(duration, talk(duration), { loudness: loud, chat: null });
    const peak = scores.indexOf(Math.max(...scores));
    expect(peak).toBeGreaterThanOrEqual(99);
    expect(peak).toBeLessThanOrEqual(104);

    const words = talk(duration).map((w) => (w.startSec >= 200 && w.startSec < 203 ? { ...w, word: "LMAO" } : w));
    const hype = secondScores(duration, words, { loudness: quiet, chat: null });
    expect(hype.indexOf(Math.max(...hype))).toBeGreaterThanOrEqual(199);
    expect(isHypeWord("NOOO!")).toBe(true);
    expect(isHypeWord("table")).toBe(false);
  });

  it("uses chat spikes when there is a chat replay, opening the window ~30 s before the spike", () => {
    const chat = bucketChat(seededChat(duration, [{ atSec: 250, messages: 60, emote: "KEKW" }]), duration);
    const words = talk(duration);
    const scores = secondScores(duration, words, { loudness: quiet, chat });
    expect(Math.abs(scores.indexOf(Math.max(...scores)) - 228)).toBeLessThanOrEqual(1);
    const [top] = candidateWindows(scores, toSentences(words), { count: 1 });
    expect(Math.abs(top!.startSec - 220)).toBeLessThanOrEqual(5);
    expect(top!.endSec).toBeGreaterThanOrEqual(245);
  });

  it("turns peaks into separate, sentence-aligned windows that open just before the peak", () => {
    const loud = [...quiet];
    loud[60] = -5;
    loud[200] = -6;
    const words = talk(duration);
    const sentences = toSentences(words);
    const scores = secondScores(duration, words, { loudness: loud, chat: null });
    const cands = candidateWindows(scores, sentences, { count: 5 });
    expect(cands.length).toBeGreaterThanOrEqual(2);
    const peaks = cands.slice(0, 2).map((c) => c.peakSec).sort((a, b) => a - b);
    expect(Math.abs(peaks[0]! - 60)).toBeLessThanOrEqual(1);
    expect(Math.abs(peaks[1]! - 200)).toBeLessThanOrEqual(1);
    for (const c of cands) {
      expect(sentences.some((s) => s.startSec === c.startSec)).toBe(true);
      expect(sentences.some((s) => s.endSec === c.endSec)).toBe(true);
      expect(c.endSec - c.startSec).toBeGreaterThanOrEqual(15);
      expect(c.endSec - c.startSec).toBeLessThanOrEqual(60);
      expect(c.startSec).toBeLessThanOrEqual(c.peakSec);
    }
    for (let i = 0; i < cands.length; i++) {
      for (let j = i + 1; j < cands.length; j++) {
        expect(cands[i]!.endSec <= cands[j]!.startSec || cands[j]!.endSec <= cands[i]!.startSec).toBe(true);
      }
    }
  });
});
