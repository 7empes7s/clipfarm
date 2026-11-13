import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openDb } from "../../server/db/index.js";
import { Engine, ENGINE_SETUP_JOB } from "../../server/engine/engine.js";
import { engineSetupHandler } from "../../server/engine/setup.js";
import { JobQueue } from "../../server/jobs/queue.js";
import { run } from "../../server/tools/exec.js";

/** A streamer talking for about 40 s: calm lines, then two moments worth clipping. */
export const TALK = `Okay chat, we are heading into the city now. I think the mission starts over by the bridge.
Let me grab a car first. This one looks fast enough. Wait, what is that guy doing. No way. He actually jumped off the roof.
Oh my god, that was insane. Did you see that, chat. Clip it, clip it right now. Alright, calm down, calm down.
We still need to finish the delivery. The map says two more blocks and then a left turn.
I love how the lights look at night in this game. Somebody in chat asked about the settings.
I am playing on high with motion blur turned off. Hold on, the police are behind us. Go, go, go.
Why is the helicopter here already. This is crazy. Yes. We made it. Let us go.`;

/**
 * The real engine with no cloud AI at all, set up through the same download job the app uses
 * (pinned files, checksums). Files are kept in data/engine-test between runs.
 */
export async function realEngine(tmpRoot: string, writer: boolean): Promise<Engine> {
  const engine = new Engine({
    modelsDir: resolve(process.env.ENGINE_TEST_MODELS ?? "data/engine-test/models"),
    cloudTranscriber: () => null,
    cloudPicker: () => null,
  });
  const db = openDb(":memory:");
  engine.bind(db);
  // large-v3-turbo is left out: nothing here needs it, and it is an 870 MB download.
  engine.saveSettings({ writer, stt: engine.settings().stt.map((s) => (s.id === "whisper-turbo" ? { ...s, on: false } : s)) });
  const queue = new JobQueue(db, { handlers: { [ENGINE_SETUP_JOB]: engineSetupHandler(engine) }, tmpRoot });
  const job = queue.enqueue(ENGINE_SETUP_JOB, {});
  await queue.idle();
  const done = queue.get(job.id);
  if (done.status !== "done") throw new Error(`Engine setup failed: ${done.error}`);
  return engine;
}

/** Speech made by ffmpeg's built-in voice (flite): no real media, nothing committed. */
export async function speak(dir: string, name: string, text: string, opts: { voice?: string; padSec?: number } = {}): Promise<string> {
  const textFile = join(dir, `${name}.txt`);
  const out = join(dir, `${name}.wav`);
  await writeFile(textFile, text);
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `flite=textfile=${textFile}:voice=${opts.voice ?? "slt"}`,
    "-af", `apad=pad_dur=${opts.padSec ?? 0}`,
    "-ar", "16000", "-ac", "1", out,
  ]);
  return out;
}
