import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Engine } from "../../server/engine/engine.js";
import { reviewPicks } from "../../server/pipeline/picks/review.js";
import { toSentences } from "../../server/pipeline/picks/sentences.js";
import { measureLoudness } from "../../server/pipeline/picks/signals.js";
import type { Word } from "../../shared/types.js";
import { probeDuration } from "../../server/tools/ffmpeg.js";
import { run } from "../../server/tools/exec.js";
import { realEngine, speak, TALK } from "./helpers.js";

/** The charter's budget: 1 h of stream → transcript and ranked picks in 25 min, so 10 min in 250 s. */
const BUDGET_SEC_PER_10_MIN = 250;
const BUDGET_PEAK_MB = 2500;

let dir: string;
let engine: Engine;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "clipfarm-engine-real-"));
  engine = await realEngine(dir, false);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const input = (words: Word[], loudness: number[], durationSec: number) => ({
  title: "GTA night", durationSec, chapters: [], words, signals: { loudness, chat: null },
  creatorName: "Test Streamer", briefRules: "", bannedContent: "", maxPicks: 15,
});

describe("local engine on generated speech (real Moonshine and whisper.cpp, no OpenAI key, no outside AI)", () => {
  it("is ready once its parts are downloaded and checked", () => {
    expect(engine.status([])).toMatchObject({ mode: "local", ready: true, headline: "Local engine: ready", cloudAvailable: false });
    expect(engine.transcriber.name).toBe("local");
    expect(engine.status([]).steps.filter((s) => s.on).map((s) => `${s.id}:${s.state}`)).toEqual(["moonshine:ready", "whisper-small:ready"]);
  });

  it("times each word where it was said, across long silences the speech finder skips", async () => {
    // Speech at 20 s and at 50 s, silence everywhere else.
    const a = await speak(dir, "a", "No way. He actually did that.");
    const b = await speak(dir, "b", "Oh my god, chat, look at this. That was insane.", { voice: "kal16" });
    const audio = join(dir, "gaps.wav");
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-i", a, "-i", b,
      "-filter_complex", "[0]adelay=20000[x];[1]adelay=50000[y];[x][y]amix=inputs=2:normalize=0,apad=pad_dur=10",
      "-ar", "16000", "-ac", "1", audio,
    ]);

    const { words, costUsd } = await engine.transcriber.transcribe(audio, { durationSec: await probeDuration(audio), tmpDir: dir });

    expect(costUsd).toBe(0);
    const said = words.map((w) => w.word.toLowerCase().replace(/[^a-z]/g, ""));
    expect(said).toEqual(expect.arrayContaining(["actually", "that", "look", "insane"]));
    for (const w of words) {
      expect(w.endSec).toBeGreaterThan(w.startSec);
      expect(w.endSec - w.startSec).toBeLessThanOrEqual(1.5);
      const inFirst = w.startSec >= 19.5 && w.endSec <= 24;
      const inSecond = w.startSec >= 49.5 && w.endSec <= 56;
      expect(inFirst || inSecond, `"${w.word}" at ${w.startSec}-${w.endSec}`).toBe(true);
    }
    const at = (word: string) => words[said.indexOf(word)]!;
    expect(at("actually").startSec).toBeLessThan(23);
    expect(at("insane").startSec).toBeGreaterThan(50);
  });

  it("turns a 10-minute sample into a word-timed transcript and ranked picks within the time and memory budget", async () => {
    const talk = await speak(dir, "talk", TALK, { padSec: 12 });
    const audio = join(dir, "ten-minutes.mp3");
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-stream_loop", "-1", "-i", talk,
      "-t", "600", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "48k", audio,
    ]);
    const durationSec = await probeDuration(audio);
    expect(durationSec).toBeGreaterThan(599);

    const started = Date.now();
    const loudness = await measureLoudness(audio);
    const progress: number[] = [];
    const transcript = await engine.transcriber.transcribe(audio, { durationSec, tmpDir: dir, onProgress: (f) => progress.push(f) });
    const peakRssMb = Math.max(...transcript.report!.uses.map((u) => u.peakMb ?? 0));
    const { picks, costUsd } = await engine.picker.pick(input(transcript.words, loudness, durationSec));
    const seconds = (Date.now() - started) / 1000;
    const kept = reviewPicks(picks, toSentences(transcript.words), transcript.words, [], 15).filter((p) => !p.dropReason);
    console.log(
      `[budget] 10 min of speech → ${transcript.words.length} words, ${picks.length} ranked picks (${kept.length} kept) in ${seconds.toFixed(0)} s ` +
        `(= ${((seconds * 6) / 60).toFixed(1)} min per hour of stream), peak memory ${peakRssMb} MB. ${transcript.report!.summary}`,
    );
    for (const u of transcript.report!.uses) console.log(`[budget]   ${u.label}: ${u.count} segments, ${Math.round(u.audioSec)} s of audio in ${(u.ms / 1000).toFixed(0)} s, peak ${u.peakMb} MB`);
    for (const f of transcript.report!.fallbacks) console.log(`[budget]   passed over ${f.step} ${f.count}×: ${f.reason}`);

    // English goes to Moonshine, the first and fastest step.
    expect(transcript.report!.language).toBe("en");
    expect(transcript.report!.uses.find((u) => u.step === "moonshine")!.audioSec).toBeGreaterThan(durationSec * 0.8);

    // Transcript: the talk is ~125 words and repeats about 11 times.
    expect(transcript.words.length).toBeGreaterThan(1000);
    expect(transcript.words.every((w, i, all) => i === 0 || w.startSec >= all[i - 1]!.startSec - 0.5)).toBe(true);
    expect(transcript.words.at(-1)!.endSec).toBeLessThanOrEqual(durationSec + 1);
    expect(progress.at(-1)).toBe(1);

    // Picks: ranked, hooks from the transcript, and good to cut (sentence-aligned, 15-60 s).
    expect(costUsd).toBe(0);
    expect(kept.length).toBeGreaterThanOrEqual(5);
    expect(picks.every((p, i) => i === 0 || p.score <= picks[i - 1]!.score)).toBe(true);
    for (const p of kept) {
      expect(p.hook.length).toBeGreaterThan(0);
      expect(p.hook.split(" ").length).toBeLessThanOrEqual(8);
      expect(p.title).toMatch(/^Test Streamer: "/);
      expect(p.endSec - p.startSec).toBeGreaterThanOrEqual(15);
      expect(p.endSec - p.startSec).toBeLessThanOrEqual(60);
    }

    // Budget.
    expect(seconds).toBeLessThanOrEqual(BUDGET_SEC_PER_10_MIN);
    expect(peakRssMb).toBeGreaterThan(0);
    expect(peakRssMb).toBeLessThanOrEqual(BUDGET_PEAK_MB);
  });

  // flite only speaks English, so the other-language sample is yours: any speech WAV, e.g. made with
  // `moonshine-voice tts --language es --text "..." --out es.wav` (pip install moonshine-voice).
  it.skipIf(!process.env.ENGINE_OTHER_LANGUAGE_WAV)("sends a 10-minute sample in another language past Moonshine to Whisper small", async () => {
    const audio = join(dir, "other-language.mp3");
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-stream_loop", "-1", "-i", process.env.ENGINE_OTHER_LANGUAGE_WAV!,
      "-af", "apad=pad_dur=3", "-t", "600", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "48k", audio,
    ]);
    const durationSec = await probeDuration(audio);
    const started = Date.now();
    const transcript = await engine.transcriber.transcribe(audio, { durationSec, tmpDir: dir });
    const seconds = (Date.now() - started) / 1000;
    console.log(`[budget] 10 min in another language → ${transcript.words.length} words in ${seconds.toFixed(0)} s. ${transcript.report!.summary}`);
    for (const u of transcript.report!.uses) console.log(`[budget]   ${u.label}: ${u.count} segments, ${Math.round(u.audioSec)} s of audio in ${(u.ms / 1000).toFixed(0)} s, peak ${u.peakMb} MB`);
    for (const f of transcript.report!.fallbacks) console.log(`[budget]   passed over ${f.step} ${f.count}×: ${f.reason}`);

    expect(transcript.report!.language).not.toBe("en");
    expect(transcript.report!.uses.some((u) => u.step === "moonshine")).toBe(false);
    expect(transcript.report!.uses.find((u) => u.step === "whisper-small")!.audioSec).toBeGreaterThan(durationSec * 0.8);
    expect(transcript.words.length).toBeGreaterThan(500);
    expect(transcript.words.every((w, i, all) => i === 0 || w.startSec >= all[i - 1]!.startSec)).toBe(true);
  });
});
