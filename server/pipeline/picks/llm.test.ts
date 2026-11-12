import { describe, expect, it } from "vitest";
import type { Word } from "../../../shared/types.js";
import { FakeChatClient } from "./fake.js";
import { LlmPicker, OpenAiCompatibleChat, parsePicks, PICKS_SCHEMA } from "./llm.js";
import type { PickInput } from "./types.js";

function input(over: Partial<PickInput> = {}): PickInput {
  const words: Word[] = [];
  for (let i = 0; i * 0.5 + 0.4 <= 240; i++) {
    words.push({ word: (i + 1) % 10 === 0 ? "okay." : "so", startSec: i * 0.5, endSec: i * 0.5 + 0.4 });
  }
  const loudness = new Array<number>(240).fill(-30);
  loudness[120] = -5;
  return {
    title: "GTA VI day one",
    durationSec: 240,
    chapters: [{ title: "Story mission", startSec: 0, endSec: 240 }],
    words,
    signals: { loudness, chat: null },
    creatorName: "Test Streamer",
    briefRules: "Clips 20-60 s. No story spoilers.",
    bannedContent: "No talking about his ex",
    maxPicks: 5,
    ...over,
  };
}

const goodPick = {
  candidate: 0,
  start: 115,
  end: 140,
  hook: "He did NOT expect that",
  title: "Test Streamer gets launched across the map",
  score: 88,
  reason: "Huge reaction in the first second",
  layout: "center",
  flags: { spoiler: false, cutscene: false, ending: false, leak: false, breaks_brief: false },
};

describe("OpenAiCompatibleChat", () => {
  it("posts a strict JSON-schema chat request to the configured base URL and prices the tokens", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"picks":[]}' } }], usage: { prompt_tokens: 10000, completion_tokens: 1000 } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const chat = new OpenAiCompatibleChat({
      apiKey: "test-key",
      baseUrl: "https://api.cerebras.test/v1/",
      model: "some-model",
      usdPerMTokIn: 0.5,
      usdPerMTokOut: 2,
      fetchImpl,
    });
    const res = await chat.complete({ system: "sys", user: "usr", schemaName: "clip_picks", schema: PICKS_SCHEMA });
    expect(res).toEqual({ content: '{"picks":[]}', costUsd: 0.007 });
    expect(calls[0]!.url).toBe("https://api.cerebras.test/v1/chat/completions");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.model).toBe("some-model");
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "clip_picks", strict: true, schema: PICKS_SCHEMA },
    });
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(["system", "user"]);
  });

  it("reports API errors and empty answers plainly", async () => {
    const failing = new OpenAiCompatibleChat({
      apiKey: "k",
      baseUrl: "https://x.test/v1",
      model: "m",
      fetchImpl: (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch,
    });
    await expect(failing.complete({ system: "", user: "", schemaName: "s", schema: {} })).rejects.toThrow(
      "The picking model failed (429): rate limited",
    );
    const empty = new OpenAiCompatibleChat({
      apiKey: "k",
      baseUrl: "https://x.test/v1",
      model: "m",
      fetchImpl: (async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })) as unknown as typeof fetch,
    });
    await expect(empty.complete({ system: "", user: "", schemaName: "s", schema: {} })).rejects.toThrow("empty answer");
  });
});

describe("parsePicks", () => {
  it("maps the schema fields and treats missing flags as flagged", () => {
    const [ok, noFlags] = parsePicks(JSON.stringify({ picks: [goodPick, { ...goodPick, flags: undefined, score: 140 }] }));
    expect(ok).toEqual({
      startSec: 115,
      endSec: 140,
      hook: "He did NOT expect that",
      title: "Test Streamer gets launched across the map",
      score: 88,
      reason: "Huge reaction in the first second",
      layout: "center",
      flags: { spoiler: false, cutscene: false, ending: false, leak: false, breaksBrief: false },
    });
    expect(noFlags!.flags).toEqual({ spoiler: true, cutscene: true, ending: true, leak: true, breaksBrief: true });
    expect(noFlags!.score).toBe(100);
  });

  it("rejects answers that are not the expected JSON", () => {
    expect(() => parsePicks("not json")).toThrow("did not answer in JSON");
    expect(() => parsePicks("{}")).toThrow("no list of picks");
    expect(parsePicks(JSON.stringify({ picks: [{ ...goodPick, start: 50, end: 40 }] }))).toEqual([]);
  });
});

describe("LlmPicker", () => {
  it("sends the brief, off-limits note and timed candidate lines, and returns the model's picks", async () => {
    const chat = new FakeChatClient(() => ({ picks: [goodPick] }), 0.002);
    const result = await new LlmPicker(chat).pick(input());
    expect(result.costUsd).toBe(0.002);
    expect(result.picks).toHaveLength(1);
    const req = chat.requests[0]!;
    expect(req.schema).toBe(PICKS_SCHEMA);
    expect(req.system).toMatch(/spoiler/);
    expect(req.user).toContain("Campaign brief: Clips 20-60 s. No story spoilers.");
    expect(req.user).toContain("Off limits: No talking about his ex");
    expect(req.user).toContain("Story mission (0-240 s)");
    expect(req.user).toMatch(/Candidate 0 \(excitement [\d.]+, peak at 1(19|20|21) s\)/);
    expect(req.user).toMatch(/\[\d+\.\d-\d+\.\d\] so so/);
  });

  it("does not call the model when nothing can be cut", async () => {
    const chat = new FakeChatClient(() => ({ picks: [goodPick] }));
    const short = input({ durationSec: 8, words: input().words.slice(0, 16), signals: { loudness: [], chat: null } });
    expect(await new LlmPicker(chat).pick(short)).toEqual({ picks: [], costUsd: 0 });
    expect(chat.requests).toHaveLength(0);
  });
});
