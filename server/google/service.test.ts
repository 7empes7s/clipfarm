import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../db/index.js";
import { FakeGemini } from "./fake.js";
import { GoogleAi, GoogleUnavailableError } from "./service.js";

let logs: string[];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => void logs.push(line));
});
afterEach(() => vi.restoreAllMocks());

const req = { system: "s", text: "t", schema: { type: "object" } };

function setup(opts: { tokens?: { in: number; out: number }; creditEur?: number; expiresAt?: string } = {}) {
  let now = new Date("2026-11-20T10:00:00Z");
  const gemini = new FakeGemini({ json: () => ({ ok: true }) }, opts.tokens ?? { in: 1_000_000, out: 0 });
  const google = new GoogleAi({ client: () => gemini, creditEur: opts.creditEur, expiresAt: opts.expiresAt, now: () => now });
  google.bind(openDb(":memory:"));
  return { google, gemini, at: (iso: string) => (now = new Date(iso)) };
}

describe("Google spend guard", () => {
  it("logs what each call cost and keeps a running total against the credit", async () => {
    // 1M tokens in at the fallback Flash rate ($0.75 per million) is €0.69.
    const { google } = setup();
    const res = await google.json("rerank", req);
    expect(res.costUsd).toBeCloseTo(0.75, 6);
    expect(logs.join("\n")).toMatch(/\[google\] rerank fake-flash: 1000000 tokens in, 0 out, about €0\.69 \(today €0\.69 of €3\.00\)/);
    await google.json("writer", req);
    expect(google.status()).toMatchObject({
      configured: true,
      creditEur: 269,
      expiresAt: "2027-02-11",
      spentEur: 1.38,
      todayEur: 1.38,
      calls: 2,
      blocked: null,
      settings: { rerank: true, thumbnails: true, weight: 30, topN: 12, dailyCapEur: 3 },
    });
  });

  it("stops at the daily cap and starts again the next day", async () => {
    const { google, gemini, at } = setup();
    for (let i = 0; i < 5; i++) await google.json("rerank", req); // €3.45
    await expect(google.json("rerank", req)).rejects.toThrow(GoogleUnavailableError);
    await expect(google.json("rerank", req)).rejects.toThrow("Today's Google limit (€3.00) is reached.");
    expect(gemini.jsonCalls).toHaveLength(5);
    at("2026-11-21T00:05:00Z");
    expect(google.blocked()).toBeNull();
    await google.json("rerank", req);
    expect(google.status()).toMatchObject({ spentEur: 4.14, todayEur: 0.69 });
  });

  it("stops for good at 90% of the credit, and once the credit has ended", async () => {
    const low = setup({ creditEur: 1.5 });
    await low.google.json("rerank", req);
    await low.google.json("rerank", req); // €1.38 of €1.50: over 90%
    low.at("2026-11-25T00:00:00Z");
    expect(low.google.blocked()).toBe("90% of the Google credit (€1.50) is used, so Google is no longer called.");
    await expect(low.google.image("thumbnail", { prompt: "p", image: { mimeType: "image/jpeg", data: Buffer.from("x") }, aspectRatio: "9:16" })).rejects.toThrow(
      GoogleUnavailableError,
    );

    const ended = setup();
    ended.at("2027-02-12T00:00:01Z");
    expect(ended.google.blocked()).toBe("The Google credit ended on 2027-02-11, so Google is no longer called.");
  });

  it("takes a daily cap, a weight and the switches from the Dashboard, and refuses nonsense", () => {
    const { google } = setup();
    expect(google.saveSettings({ dailyCapEur: 1.5, weight: 60, rerank: false, thumbnails: false })).toMatchObject({
      dailyCapEur: 1.5, weight: 60, rerank: false, thumbnails: false, topN: 12,
    });
    expect(() => google.saveSettings({ dailyCapEur: -1 })).toThrow("The daily limit must be a number of euros, zero or more.");
    expect(() => google.saveSettings({ weight: 140 })).toThrow("How much the video counts must be from 0 to 100.");
  });

  it("is not available without a connection, and says so instead of calling", async () => {
    const google = new GoogleAi({ client: () => null });
    google.bind(openDb(":memory:"));
    expect(google.available()).toBe(false);
    expect(google.chat()).toBeNull();
    await expect(google.json("rerank", req)).rejects.toThrow(GoogleUnavailableError);
    expect(google.status().configured).toBe(false);
  });

  it("answers as a chat model for hooks and titles, under the same guard", async () => {
    const { google, gemini } = setup({ tokens: { in: 1000, out: 100 } });
    const chat = google.chat()!;
    expect(chat.name).toBe("gemini:fake-flash");
    const res = await chat.complete({ system: "Write a hook", user: "Transcript", schemaName: "clip_copy", schema: { type: "object" } });
    expect(JSON.parse(res.content)).toEqual({ ok: true });
    expect(res.costUsd).toBeGreaterThan(0);
    expect(gemini.jsonCalls[0]).toMatchObject({ system: "Write a hook", text: "Transcript" });
  });
});
