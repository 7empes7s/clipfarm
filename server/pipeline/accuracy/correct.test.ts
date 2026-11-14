import { describe, expect, it } from "vitest";
import type { Word } from "../../../shared/types.js";
import type { ChatClient, ChatRequest } from "../picks/llm.js";
import { applyFixes, captionFixGate, changesBetween, copyProblems, correctCaptions, fixText, setFixApplied, soundsLike } from "./correct.js";
import { seedGlossary } from "./glossary.js";

/** What TJR said ("I forgot, market opens at ten thirty"), as the small model heard it. */
const HEARD: Word[] = [
  { word: "I", startSec: 10.0, endSec: 10.2, confidence: 0.9 },
  { word: "for", startSec: 10.2, endSec: 10.4, confidence: 0.41 },
  { word: "God,", startSec: 10.4, endSec: 10.8, confidence: 0.44 },
  { word: "Margaret", startSec: 10.9, endSec: 11.4, confidence: 0.38 },
  { word: "opens", startSec: 11.4, endSec: 11.8, confidence: 0.9 },
  { word: "at", startSec: 11.8, endSec: 11.9, confidence: 0.95 },
  { word: "ten", startSec: 11.9, endSec: 12.1, confidence: 0.95 },
  { word: "thirty", startSec: 12.1, endSec: 12.5, confidence: 0.95 },
];
const TJR = seedGlossary({ creatorName: "TJR", texts: ["TJR day trading NQ futures live"] });
const text = (ws: Word[]) => ws.map((w) => w.word).join(" ");

/** A deterministic stand-in for the correcting model: answers with fixed word indexes, and keeps what it was asked. */
function stubChat(fixes: { first: number; last: number; to: string; why: string }[]) {
  const asked: ChatRequest[] = [];
  const chat: ChatClient = {
    name: "llm:stub",
    complete: async (req) => {
      asked.push(req);
      return { content: JSON.stringify({ fixes }), costUsd: 0.0004 };
    },
  };
  return { chat, asked };
}

describe("correctCaptions", () => {
  it('fixes "I for God, Margaret opens at ten thirty" with the TJR glossary, keeping the word timings and logging each change', async () => {
    const { chat, asked } = stubChat([
      { first: 1, last: 2, to: "forgot,", why: "sounds like 'forgot'; 'for God' makes no sense here" },
      { first: 3, last: 3, to: "market", why: "'market' is in the glossary; a trader says the market opens" },
    ]);
    const out = await correctCaptions({ words: HEARD, glossary: TJR, chat, context: { creatorName: "TJR", title: "TJR live" } });
    expect(text(out.words)).toBe("I forgot, market opens at ten thirty");
    // The model sees the glossary and the numbered words.
    expect(asked[0]!.user).toContain("market");
    expect(asked[0]!.user).toContain("3:Margaret");
    // A word fixed one for one keeps its own times; two words made one take the span of both.
    expect(out.words[2]).toMatchObject({ word: "market", startSec: 10.9, endSec: 11.4 });
    expect(out.words[1]).toMatchObject({ word: "forgot,", startSec: 10.2, endSec: 10.8 });
    expect(out.words.slice(3)).toEqual(HEARD.slice(4));
    expect(out.fixes).toEqual([
      expect.objectContaining({ from: "for God,", to: "forgot,", startSec: 10.2, endSec: 10.8, applied: true, fromWords: HEARD.slice(1, 3) }),
      expect.objectContaining({ from: "Margaret", to: "market", startSec: 10.9, endSec: 11.4, applied: true }),
    ]);
    expect(out.rejected).toEqual([]);
    expect(out.costUsd).toBe(0.0004);
  });

  it("never adds words the audio does not support: a change that does not sound like what was heard is refused and logged", async () => {
    const { chat } = stubChat([
      { first: 4, last: 4, to: "really opens", why: "more punch" },
      { first: 6, last: 7, to: "huge big gains today", why: "better story" },
      { first: 9, last: 9, to: "x", why: "out of range" },
    ]);
    const out = await correctCaptions({ words: HEARD, glossary: TJR, chat, context: { creatorName: "TJR", title: null } });
    expect(out.words).toEqual(HEARD);
    expect(out.fixes).toEqual([]);
    expect(out.rejected.map((r) => r.why)).toEqual([
      expect.stringContaining("does not sound like"),
      expect.stringContaining("adds words"),
      expect.stringContaining("no such words"),
    ]);
  });
});

describe("the glossary and diff logic", () => {
  it("tells sound-alikes from made-up words", () => {
    expect(soundsLike("for God", "forgot")).toBeGreaterThan(0.8);
    expect(soundsLike("Margaret", "market")).toBeGreaterThanOrEqual(0.6);
    expect(soundsLike("opens", "really opens")).toBeLessThan(0.5);
  });

  it("applies non-overlapping fixes in order, carrying the punctuation the model dropped", () => {
    const out = applyFixes(HEARD, [
      { first: 3, last: 3, to: "market", why: "" },
      { first: 1, last: 2, to: "forgot", why: "" },
      { first: 2, last: 3, to: "got mark", why: "overlaps the one before" },
    ]);
    expect(text(out.words)).toBe("I forgot, market opens at ten thirty");
    expect(out.rejected).toHaveLength(1);
  });

  it("undoes and redoes one fix in the captions by its time, without touching the others", () => {
    const { words, fixes } = applyFixes(HEARD, [
      { first: 1, last: 2, to: "forgot,", why: "" },
      { first: 3, last: 3, to: "market", why: "" },
    ]);
    const undone = setFixApplied(words, fixes[0]!, false);
    expect(text(undone)).toBe("I for God, market opens at ten thirty");
    expect(undone[1]).toEqual(HEARD[1]);
    expect(text(setFixApplied(undone, fixes[0]!, true))).toBe("I forgot, market opens at ten thirty");
  });

  it("lines up two transcripts of the same audio by their words (timings may drift) and lists where they read differently", () => {
    // The accurate engine's times run 0.3 s early.
    const better: Word[] = "I forgot, Margaret opens at ten thirty".split(" ").map((word, i) => ({ word, startSec: 9.7 + i * 0.5, endSec: 10.1 + i * 0.5 }));
    const changes = changesBetween(HEARD, better);
    expect(changes.map((c) => [c.from, c.to])).toEqual([["for God,", "forgot,"]]);
    expect(fixText("I for God, Margaret opens", changes)).toBe("I forgot, Margaret opens");
    // A stretch that does not sound alike is not the same speech heard better.
    expect(changesBetween(HEARD.slice(0, 4), [HEARD[0]!, { word: "banana", startSec: 10.2, endSec: 11.4 }])).toEqual([]);
  });

  it("builds the title and hook from the corrected words", () => {
    const { fixes } = applyFixes(HEARD, [
      { first: 1, last: 2, to: "forgot,", why: "" },
      { first: 3, last: 3, to: "market", why: "" },
    ]);
    expect(fixText('TJR: "I for God, Margaret opens at ten thirty"', fixes)).toBe('TJR: "I forgot, market opens at ten thirty"');
    expect(fixText("Margaret opens at 10:30", fixes)).toBe("Market opens at 10:30");
    // An undone fix leaves the text alone.
    expect(fixText("Margaret opens", [{ ...fixes[1]!, applied: false }])).toBe("Margaret opens");
  });

  it("the spell/sense check catches misheard words left in a title or hook", () => {
    const { words, fixes } = applyFixes(HEARD, [{ first: 3, last: 3, to: "market", why: "" }]);
    expect(copyProblems("I forgot, market opens at ten thirty", words, fixes)).toEqual([]);
    expect(copyProblems("I for God, market opens", words, fixes)).toEqual([expect.stringContaining("“God”")]);
    expect(copyProblems("Margaret opens at ten", words, fixes)).toEqual([expect.stringContaining("“Margaret”")]);
    expect(copyProblems("the the market opens", words, fixes)).toEqual([expect.stringContaining("twice")]);
  });
});

describe("captionFixGate", () => {
  const perm = (briefRules: string, aiBanned = false) => ({ briefRules, rules: aiBanned ? { aiBanned: true } : null });

  it("allows fixing misheard words when the campaign has no AI rule", () => {
    expect(captionFixGate([perm("Post TJR clips, tag @TJRTrades")])).toEqual({ allowed: true, why: null });
  });

  it("allows it explicitly for a campaign that bans AI content: it is text correction of what was said", () => {
    const g = captionFixGate([perm("No AI-generated content.", true)]);
    expect(g.allowed).toBe(true);
    expect(g.why).toContain("text correction");
  });

  it("blocks it when the brief bans AI on the captions themselves", () => {
    const g = captionFixGate([perm("Captions must be written by hand: no AI captions or subtitles.")]);
    expect(g.allowed).toBe(false);
    expect(g.why).toContain("captions");
  });
});
