import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../server/db/index.js";
import { JobQueue } from "../server/jobs/queue.js";
import { probeDuration } from "../server/tools/ffmpeg.js";
import { FakeDownloader } from "../server/pipeline/ingest/fakeDownloader.js";
import { INGEST_JOB, ingestHandler, onIngestFinished } from "../server/pipeline/ingest/ingest.js";
import { FakeTranscriber } from "../server/pipeline/transcript/fake.js";
import type { Transcriber } from "../server/pipeline/transcript/types.js";
import { SourcesRepo } from "../server/sources/repo.js";
import { VodsRepo } from "../server/vods/repo.js";
import { campaignInput } from "./helpers.js";

let tmpRoot: string;
beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "clipfarm-fixture-"));
});
afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

function setup(transcriber: Transcriber, now = () => new Date()) {
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db, now);
  const vods = new VodsRepo(db, now);
  const queue = new JobQueue(db, {
    handlers: { [INGEST_JOB]: ingestHandler({ sources, vods, downloader: new FakeDownloader(10), transcriber }) },
    tmpRoot,
    onFinished: onIngestFinished(vods),
  });
  return { sources, vods, queue };
}

describe("ingest (real ffmpeg on a generated 10 s sample)", () => {
  it("extracts the audio, transcribes it and stores timed words", async () => {
    let audioSeconds = 0;
    const fake = new FakeTranscriber();
    const spy: Transcriber = {
      name: fake.name,
      async transcribe(audio, opts) {
        audioSeconds = await probeDuration(audio);
        return fake.transcribe(audio, opts);
      },
    };
    const { sources, vods, queue } = setup(spy);
    const source = sources.create(campaignInput());
    const vod = vods.create(source.id, "https://www.twitch.tv/videos/1");
    const job = queue.enqueue(INGEST_JOB, { vodId: vod.id }, { vodId: vod.id });
    await queue.idle();

    expect(queue.get(job.id)).toMatchObject({ status: "done", error: null });
    expect(audioSeconds).toBeGreaterThan(9.5);
    expect(audioSeconds).toBeLessThan(10.5);

    const stored = vods.detail(vod.id);
    expect(stored).toMatchObject({ status: "ready", title: "Sample stream (test clip)", transcriber: "fake", transcriptCostUsd: 0 });
    expect(stored.durationSec).toBe(10);
    expect(stored.chapters).toHaveLength(2);
    expect(stored.words).toHaveLength(20);
    expect(stored.words[0]).toEqual({ word: "no", startSec: 0, endSec: 0.4 });
    expect(stored.words.at(-1)!.endSec).toBeLessThanOrEqual(10);
    for (let i = 1; i < stored.words.length; i++) {
      expect(stored.words[i]!.startSec).toBeGreaterThan(stored.words[i - 1]!.startSec);
    }
    // Audio and sample lived only in the job's temp folder.
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it("refuses to run if the permission expired after the link was added", async () => {
    let now = new Date("2026-11-01T00:00:00Z");
    const { sources, vods, queue } = setup(new FakeTranscriber(), () => now);
    queue.stop();
    const source = sources.create(campaignInput({ expiresAt: "2026-11-10T00:00:00Z" }));
    const vod = vods.create(source.id, "https://www.twitch.tv/videos/1");
    const job = queue.enqueue(INGEST_JOB, { vodId: vod.id }, { vodId: vod.id });
    now = new Date("2026-11-12T00:00:00Z");
    queue.start();
    await queue.idle();

    expect(queue.get(job.id)).toMatchObject({ status: "failed", attempts: 1 });
    expect(queue.get(job.id).error).toMatch(/expired on 2026-11-10/);
    expect(vods.get(vod.id).status).toBe("failed");
    expect(await readdir(tmpRoot)).toEqual([]);
  });
});
