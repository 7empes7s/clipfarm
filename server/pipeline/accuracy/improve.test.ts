import { describe, expect, it } from "vitest";
import type { Word } from "../../../shared/types.js";
import type { ChatClient } from "../picks/llm.js";
import type { TranscribeOptions, Transcriber } from "../transcript/types.js";
import { improveCaptions } from "./improve.js";

const w = (word: string, startSec: number, endSec: number, confidence?: number): Word => ({ word, startSec, endSec, ...(confidence === undefined ? {} : { confidence }) });
/** What Moonshine heard in the section (master seconds). */
const FIRST_PASS = [w("I", 4, 4.2, 0.9), w("for", 4.2, 4.4, 0.4), w("God,", 4.4, 4.8, 0.4), w("Margaret", 4.9, 5.4, 0.3), w("opens", 5.4, 5.8, 0.9)];
/** What the accurate engine heard: better, but still one misheard word. */
const ACCURATE = [w("I", 4, 4.2), w("forgot,", 4.2, 4.8), w("Margaret", 4.9, 5.4), w("opens", 5.4, 5.8), w("at", 5.8, 5.9), w("ten", 5.9, 6.1), w("thirty", 6.1, 6.5)];

function fakeStt(words: Word[] | Error) {
  const asked: TranscribeOptions[] = [];
  const transcriber: Transcriber = {
    name: "fake-accurate",
    transcribe: async (_audio, o) => {
      asked.push(o);
      if (words instanceof Error) throw words;
      return { words, costUsd: 0.009, model: "gpt-transcribe" };
    },
  };
  return { transcriber, asked };
}

function stubChat(fixes: { first: number; last: number; to: string; why: string }[]) {
  let calls = 0;
  const chat: ChatClient = {
    name: "llm:stub",
    complete: async () => {
      calls += 1;
      return { content: JSON.stringify({ fixes }), costUsd: 0.0005 };
    },
  };
  return { chat, calls: () => calls };
}

const BASE = {
  input: "/section.mp4",
  durationSec: 40,
  words: FIRST_PASS,
  creatorName: "TJR",
  texts: ["TJR day trading NQ futures"],
  vodTitle: "TJR live",
  permissions: [{ briefRules: "Clip TJR's streams.", rules: null }],
  hook: "I for God, Margaret opens",
  title: 'TJR: "I for God, Margaret opens at ten thirty"',
  tmpDir: "/tmp/x",
  extract: async () => undefined,
};

describe("improveCaptions", () => {
  it("transcribes the clip again with the accurate engine and the glossary, corrects it, and rebuilds the hook and title from it", async () => {
    const stt = fakeStt(ACCURATE);
    const llm = stubChat([{ first: 2, last: 2, to: "market", why: "glossary word" }]);
    const out = await improveCaptions({ transcriber: () => stt.transcriber, chat: () => llm.chat }, BASE);
    expect(stt.asked[0]!.prompt).toContain("market");
    expect(stt.asked[0]!.durationSec).toBe(40);
    expect(out.words.map((x) => x.word).join(" ")).toBe("I forgot, market opens at ten thirty");
    expect(out.fixes).toEqual([expect.objectContaining({ from: "Margaret", to: "market", startSec: 4.9, endSec: 5.4 })]);
    expect(out.hook).toBe("I forgot, market opens");
    expect(out.title).toBe('TJR: "I forgot, market opens at ten thirty"');
    expect(out.costUsd).toBeCloseTo(0.0095, 6);
    expect(out.notes).toEqual([expect.stringContaining("gpt-transcribe"), expect.stringContaining("1 misheard")]);
  });

  it("keeps the first pass when the accurate engine fails, and still corrects it", async () => {
    const llm = stubChat([
      { first: 1, last: 2, to: "forgot,", why: "" },
      { first: 3, last: 3, to: "market", why: "" },
    ]);
    const out = await improveCaptions({ transcriber: () => fakeStt(new Error("quota")).transcriber, chat: () => llm.chat }, BASE);
    expect(out.words.map((x) => x.word).join(" ")).toBe("I forgot, market opens");
    expect(out.notes[0]).toContain("quota");
    expect(out.title).toBe('TJR: "I forgot, market opens at ten thirty"');
  });

  it("does not run the correction when the campaign keeps AI off the captions, and says so", async () => {
    const llm = stubChat([{ first: 3, last: 3, to: "market", why: "" }]);
    const out = await improveCaptions(
      { transcriber: () => null, chat: () => llm.chat },
      { ...BASE, permissions: [{ briefRules: "No AI captions or subtitles.", rules: null }] },
    );
    expect(llm.calls()).toBe(0);
    expect(out.words).toEqual(FIRST_PASS);
    expect(out.hook).toBe(BASE.hook);
    expect(out.notes).toEqual([expect.stringContaining("keeps AI off the captions")]);
  });

  it("never fails the render when the correcting model does", async () => {
    const chat: ChatClient = { name: "llm:down", complete: async () => Promise.reject(new Error("503")) };
    const out = await improveCaptions({ transcriber: () => null, chat: () => chat }, BASE);
    expect(out.words).toEqual(FIRST_PASS);
    expect(out.notes).toEqual([expect.stringContaining("503")]);
  });
});
