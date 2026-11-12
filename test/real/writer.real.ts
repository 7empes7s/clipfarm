import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Engine } from "../../server/engine/engine.js";
import { measureLoudness } from "../../server/pipeline/picks/signals.js";
import { probeDuration } from "../../server/tools/ffmpeg.js";
import { run } from "../../server/tools/exec.js";
import { realEngine, speak, TALK } from "./helpers.js";

let dir: string;
let engine: Engine;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "clipfarm-writer-real-"));
  engine = await realEngine(dir, true);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("local hook writer (real llama.cpp and Qwen2.5 1.5B; needs about 2.9 GB of free memory)", () => {
  it("writes a schema-valid hook and title for each ranked moment, then unloads", async () => {
    const talk = await speak(dir, "talk", TALK, { padSec: 12 });
    const audio = join(dir, "three-minutes.mp3");
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-stream_loop", "-1", "-i", talk,
      "-t", "180", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "48k", audio,
    ]);
    const durationSec = await probeDuration(audio);
    const loudness = await measureLoudness(audio);
    const { words } = await engine.transcriber.transcribe(audio, { durationSec, tmpDir: dir });

    const started = Date.now();
    const { picks } = await engine.picker.pick({
      title: "GTA night", durationSec, chapters: [], words, signals: { loudness, chat: null },
      creatorName: "Test Streamer", briefRules: "Clips 20-60 s, credit the streamer.", bannedContent: "", maxPicks: 15,
    });
    const seconds = (Date.now() - started) / 1000;
    for (const p of picks) console.log(`[writer] ${p.score} | ${p.hook} | ${p.title} | ${p.reason}`);
    console.log(`[writer] ${picks.length} moments in ${seconds.toFixed(0)} s (${(seconds / Math.max(1, picks.length)).toFixed(1)} s each)`);

    expect(picks.length).toBeGreaterThanOrEqual(2);
    for (const p of picks) {
      // A hook from the writer, not the transcript fallback (which says so in the reason).
      expect(p.reason).not.toContain("Hook taken from the transcript");
      expect(p.hook.length).toBeGreaterThan(0);
      expect(p.hook.length).toBeLessThanOrEqual(80);
      expect(p.title.length).toBeGreaterThan(0);
      expect(Object.values(p.flags).every((f) => typeof f === "boolean")).toBe(true);
    }
  });
});
