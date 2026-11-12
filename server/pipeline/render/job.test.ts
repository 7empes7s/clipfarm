import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { campaignInput } from "../../../test/helpers.js";
import { ClipsRepo } from "../../clips/repo.js";
import { openDb } from "../../db/index.js";
import { JobQueue } from "../../jobs/queue.js";
import { type NewPick, PicksRepo } from "../../picks/repo.js";
import { SourcesRepo } from "../../sources/repo.js";
import { VodsRepo } from "../../vods/repo.js";
import { NO_FLAGS } from "../picks/types.js";
import { onRenderFinished, RENDER_JOB, renderHandler } from "./job.js";
import { FakeSectionDownloader } from "./section.js";

let tmpRoot: string;
beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "clipfarm-render-job-"));
});
afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

const base: NewPick = {
  startSec: 10, endSec: 35, title: "A pick", hook: "", score: 50, reason: "r", flags: NO_FLAGS,
  dropReason: null, layout: "center", costUsd: 0, steps: [],
};

function setup(now = () => new Date()) {
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db, now);
  const vods = new VodsRepo(db);
  const picks = new PicksRepo(db);
  const downloader = new FakeSectionDownloader();
  const queue = new JobQueue(db, {
    handlers: { [RENDER_JOB]: renderHandler({ sources, vods, picks, clips: new ClipsRepo(db), downloader, mediaDir: join(tmpRoot, "media") }) },
    tmpRoot,
    onFinished: onRenderFinished(picks),
  });
  return { sources, vods, picks, downloader, queue };
}

describe("render job gate", () => {
  it("never renders a dropped or flagged pick, and does not even download it", async () => {
    const { sources, vods, picks, downloader, queue } = setup();
    const source = sources.create(campaignInput());
    const vod = vods.create(source.id, "https://www.twitch.tv/videos/1");
    const [dropped, tampered] = picks.replaceForVod(vod.id, source.id, [
      { ...base, flags: { ...NO_FLAGS, spoiler: true }, dropReason: "Left out: story spoiler" },
      // Status says picked, but a flag is set: still refused.
      { ...base, startSec: 50, endSec: 80, flags: { ...NO_FLAGS, leak: true } },
    ]);
    const j1 = queue.enqueue(RENDER_JOB, { pickId: dropped!.id });
    const j2 = queue.enqueue(RENDER_JOB, { pickId: tampered!.id });
    await queue.idle();

    expect(queue.get(j1.id)).toMatchObject({ status: "failed", attempts: 1 });
    expect(queue.get(j1.id).error).toMatch(/left out \(Left out: story spoiler\)/);
    expect(queue.get(j2.id)).toMatchObject({ status: "failed", attempts: 1 });
    expect(downloader.calls).toEqual([]);
    expect(picks.get(dropped!.id)).toMatchObject({ status: "dropped", videoUrl: null });
    expect(picks.get(tampered!.id)).toMatchObject({ status: "failed", videoUrl: null });
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it("refuses to render once the creator's permission has expired", async () => {
    let now = new Date("2026-11-01T00:00:00Z");
    const { sources, vods, picks, downloader, queue } = setup(() => now);
    const source = sources.create(campaignInput({ expiresAt: "2026-11-10T00:00:00Z" }));
    const vod = vods.create(source.id, "https://www.twitch.tv/videos/1");
    const [p] = picks.replaceForVod(vod.id, source.id, [base]);
    now = new Date("2026-11-12T00:00:00Z");
    const job = queue.enqueue(RENDER_JOB, { pickId: p!.id });
    await queue.idle();
    expect(queue.get(job.id).error).toMatch(/expired on 2026-11-10/);
    expect(downloader.calls).toEqual([]);
    expect(picks.get(p!.id).status).toBe("failed");
  });
});
