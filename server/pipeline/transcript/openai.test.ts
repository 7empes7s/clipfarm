import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractAudio, generateSample } from "../../tools/ffmpeg.js";
import { OpenAiTranscriber } from "./openai.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "clipfarm-openai-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A stand-in for the OpenAI API: records requests and answers with a word every 6 s. */
function fakeApi() {
  const calls: { url: string; auth: string | null; form: FormData }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const form = init.body as FormData;
    calls.push({ url, auth: new Headers(init.headers).get("authorization"), form });
    const words = [0, 6, 12, 18].map((t) => ({ word: ` w${calls.length}-${t}`, start: t, end: t + 0.5 }));
    return new Response(JSON.stringify({ text: "", words }), { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("OpenAiTranscriber", () => {
  it("asks the chosen model for word timestamps with the key from its options, and says which model answered", async () => {
    const file = join(dir, "a.mp3");
    await writeFile(file, "small");
    const api = fakeApi();
    const t = new OpenAiTranscriber({ apiKey: "sk-test", model: "whisper-1", fetchImpl: api.fetchImpl });
    const result = await t.transcribe(file, { durationSec: 600, tmpDir: dir });
    expect(api.calls).toHaveLength(1);
    const { url, auth, form } = api.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(auth).toBe("Bearer sk-test");
    expect(form.get("model")).toBe("whisper-1");
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.getAll("timestamp_granularities[]")).toEqual(["word"]);
    expect(result.words[0]).toEqual({ word: "w1-0", startSec: 0, endSec: 0.5 });
    expect(result.costUsd).toBe(0.06); // 10 min × $0.006
    expect(result.model).toBe("whisper-1");
  });

  it("passes the source's glossary as the prompt, so names and domain words come out right", async () => {
    const file = join(dir, "a.mp3");
    await writeFile(file, "small");
    const api = fakeApi();
    await new OpenAiTranscriber({ apiKey: "sk-test", fetchImpl: api.fetchImpl }).transcribe(file, { durationSec: 60, tmpDir: dir, prompt: "TJR, market, NQ, ES." });
    expect(api.calls[0]!.form.get("prompt")).toBe("TJR, market, NQ, ES.");
    await new OpenAiTranscriber({ apiKey: "sk-test", fetchImpl: api.fetchImpl }).transcribe(file, { durationSec: 60, tmpDir: dir });
    expect(api.calls[1]!.form.get("prompt")).toBeNull();
  });

  it("asks gpt-transcribe unless told otherwise, and keeps it while it sends word timings", async () => {
    const file = join(dir, "a.mp3");
    await writeFile(file, "small");
    const api = fakeApi();
    const result = await new OpenAiTranscriber({ apiKey: "sk-test", fetchImpl: api.fetchImpl }).transcribe(file, { durationSec: 60, tmpDir: dir });
    expect(api.calls.map((c) => c.form.get("model"))).toEqual(["gpt-transcribe"]);
    expect(result.model).toBe("gpt-transcribe");
    expect(result.words).toHaveLength(4);
  });

  it.each([
    ["sends text but no word timings", () => Response.json({ text: "hello chat" })],
    ["refuses a word-timings request", () => Response.json({ error: { message: "timestamp_granularities is not supported" } }, { status: 400 })],
  ])("falls back to whisper-1, once, when the chosen model %s", async (_what, noWords) => {
    const video = join(dir, "sample.mp4");
    const audio = join(dir, "speech.mp3");
    await generateSample(video, 10);
    await extractAudio(video, audio);
    const { size } = await stat(audio);
    const models: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const model = String((init.body as FormData).get("model"));
      models.push(model);
      return model === "whisper-1" ? Response.json({ words: [{ word: " hi", start: 1, end: 1.5 }] }) : noWords();
    }) as unknown as typeof fetch;
    // Two chunks: the first finds out, the second goes straight to whisper-1.
    const t = new OpenAiTranscriber({ apiKey: "sk-test", model: "gpt-transcribe", fetchImpl, maxUploadBytes: Math.floor(size / 1.5) });
    const result = await t.transcribe(audio, { durationSec: 50, tmpDir: dir });
    expect(models).toEqual(["gpt-transcribe", "whisper-1", "whisper-1"]);
    expect(result.model).toBe("whisper-1");
    expect(result.words[0]).toEqual({ word: "hi", startSec: 1, endSec: 1.5 });
  });

  it("does not hide a real failure behind the fallback", async () => {
    const file = join(dir, "a.mp3");
    await writeFile(file, "small");
    const models: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      models.push(String((init.body as FormData).get("model")));
      return new Response("quota exceeded", { status: 429 });
    }) as unknown as typeof fetch;
    await expect(new OpenAiTranscriber({ apiKey: "sk-test", fetchImpl }).transcribe(file, { durationSec: 1, tmpDir: dir })).rejects.toThrow("(429): quota exceeded");
    expect(models).toEqual(["gpt-transcribe"]);
  });

  it("explains a failed API call", async () => {
    const file = join(dir, "a.mp3");
    await writeFile(file, "small");
    const fetchImpl = (async () => new Response("quota exceeded", { status: 429 })) as unknown as typeof fetch;
    const t = new OpenAiTranscriber({ apiKey: "sk-test", fetchImpl });
    await expect(t.transcribe(file, { durationSec: 1, tmpDir: dir })).rejects.toThrow("(429): quota exceeded");
  });

  it("refuses to chunk a large file whose length is unknown instead of returning no words", async () => {
    const file = join(dir, "a.mp3");
    await writeFile(file, "x".repeat(100));
    const api = fakeApi();
    const t = new OpenAiTranscriber({ apiKey: "sk-test", fetchImpl: api.fetchImpl, maxUploadBytes: 10 });
    await expect(t.transcribe(file, { durationSec: 0, tmpDir: dir })).rejects.toThrow("length of the audio");
    expect(api.calls).toHaveLength(0);
  });

  it("splits audio over the upload limit into chunks and shifts word times by each offset", async () => {
    const video = join(dir, "sample.mp4");
    const audio = join(dir, "speech.mp3");
    await generateSample(video, 10);
    await extractAudio(video, audio);
    const { size } = await stat(audio);
    const api = fakeApi();
    // Pretend the file is 100 s long with a limit of a third of its size: 30 s chunks, 10 s
    // overlap, so chunks start at 0, 20, 40, 60 and 80 s.
    const t = new OpenAiTranscriber({ apiKey: "sk-test", fetchImpl: api.fetchImpl, maxUploadBytes: Math.floor(size / 3) });
    const result = await t.transcribe(audio, { durationSec: 100, tmpDir: dir });
    expect(api.calls).toHaveLength(5);
    // Overlap words before each cut (25, 45, 65, 85 s) come from the earlier chunk only.
    expect(result.words.map((w) => w.startSec)).toEqual([0, 6, 12, 18, 26, 32, 38, 46, 52, 58, 66, 72, 78, 86, 92, 98]);
    expect(result.words[4]).toEqual({ word: "w2-6", startSec: 26, endSec: 26.5 });
    expect(result.costUsd).toBe(0.014); // billed 4 × 30 s + 20 s, overlap included
  });
});
