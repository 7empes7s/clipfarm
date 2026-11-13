import { describe, expect, it } from "vitest";
import type { Clip, Job, Source } from "../../shared/types";
import { DEFAULT_EFFECTS } from "../../shared/types";
import { clipView, decide, filterClips, inboxQueue, merge, nextAfter, tabCounts, undo } from "./review";

function clip(id: number, patch: Partial<Clip> = {}): Clip {
  return {
    id,
    sourceId: 1,
    vodId: null,
    title: `Clip ${id}`,
    hook: "",
    effects: DEFAULT_EFFECTS,
    quality: null,
    reason: "",
    score: null,
    durationSec: 20,
    status: "pending",
    rejectReason: null,
    layout: "center",
    startSec: 0,
    endSec: 20,
    masterDurationSec: 30,
    captionWords: [],
    postCount: 0,
    experiment: false,
    videoUrl: `/api/clips/${id}/video?v=1`,
    masterUrl: `/api/clips/${id}/master`,
    createdAt: "2026-11-12T00:00:00Z",
    ...patch,
  };
}

describe("clipView and filters", () => {
  const clips = [
    clip(1),
    clip(2, { status: "approved" }),
    clip(3, { status: "approved", postCount: 2 }),
    clip(4, { status: "rejected", rejectReason: "boring" }),
    clip(5, { status: "rendering" }),
    clip(6, { sourceId: 2 }),
  ];

  it("puts each clip in one list; a clip being remade is in none", () => {
    expect(clips.map(clipView)).toEqual(["inbox", "approved", "posted", "rejected", null, "inbox"]);
  });

  it("filters by list and by creator", () => {
    expect(filterClips(clips, "inbox").map((c) => c.id)).toEqual([1, 6]);
    expect(filterClips(clips, "inbox", 2).map((c) => c.id)).toEqual([6]);
    expect(filterClips(clips, "posted").map((c) => c.id)).toEqual([3]);
  });

  it("counts every tab, with only waiting or running jobs", () => {
    const sources = [{ id: 1 }, { id: 2 }] as Source[];
    const jobs = [{ status: "running" }, { status: "queued" }, { status: "done" }, { status: "failed" }] as Job[];
    expect(tabCounts(clips, sources, jobs)).toEqual({ inbox: 2, approved: 1, posted: 1, rejected: 1, sources: 2, jobs: 2 });
  });
});

describe("inboxQueue", () => {
  it("shows the newest VOD first, then the best score", () => {
    const q = inboxQueue([
      clip(1, { vodId: 1, score: 99 }),
      clip(2, { vodId: 2, score: 50 }),
      clip(3, { vodId: 2, score: 90 }),
      clip(4, { vodId: null, score: 100 }),
      clip(5, { vodId: 2, status: "approved", score: 95 }),
    ]);
    expect(q.map((c) => c.id)).toEqual([3, 2, 1, 4]);
  });
});

describe("decide and undo", () => {
  it("approving moves the clip out of the inbox; undo puts it back", () => {
    const start = [clip(1), clip(2)];
    const { clips, last } = decide(start, 1, "approve");
    expect(inboxQueue(clips).map((c) => c.id)).toEqual([2]);
    expect(tabCounts(clips, [], []).approved).toBe(1);
    const back = undo(clips, last!);
    expect(back).toEqual(start);
  });

  it("a rejection keeps its reason, and undo restores the earlier state exactly", () => {
    const start = [clip(1, { status: "rejected", rejectReason: "boring" })];
    const approved = decide(start, 1, "approve");
    expect(approved.clips[0]).toMatchObject({ status: "approved", rejectReason: null });
    expect(undo(approved.clips, approved.last!)[0]).toMatchObject({ status: "rejected", rejectReason: "boring" });

    const rejected = decide([clip(2)], 2, "reject", "spoiler");
    expect(rejected.clips[0]).toMatchObject({ status: "rejected", rejectReason: "spoiler" });
    expect(tabCounts(rejected.clips, [], []).rejected).toBe(1);
  });

  it("does nothing for an unknown clip", () => {
    const start = [clip(1)];
    expect(decide(start, 9, "approve")).toEqual({ clips: start, last: null });
  });
});

describe("nextAfter", () => {
  const q = [clip(1), clip(2), clip(3)];
  it("goes to the next clip, or back to the previous at the end", () => {
    expect(nextAfter(q, 1)).toBe(2);
    expect(nextAfter(q, 3)).toBe(2);
    expect(nextAfter([clip(1)], 1)).toBeNull();
    expect(nextAfter(q, 42)).toBe(1);
  });
});

describe("merge", () => {
  it("replaces clips with the server's copies and keeps the rest", () => {
    const merged = merge([clip(1), clip(2)], [clip(2, { title: "Server" })]);
    expect(merged.map((c) => c.title)).toEqual(["Clip 1", "Server"]);
  });
});
