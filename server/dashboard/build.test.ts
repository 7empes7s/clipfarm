import { describe, expect, it } from "vitest";
import type { AccountCard, Clip, Job, Post, Source, Vod } from "../../shared/types.js";
import { buildDashboard, earningsRows, goals, vodProgress } from "./build.js";

const now = new Date("2026-11-19T15:00:00.000Z"); // a Thursday; the week began Monday 16th

const source = (id: number, minViews: number | null, cpm = 1.5): Source => ({
  id,
  creatorName: `Streamer ${id}`,
  channelUrls: [],
  bannedContent: "",
  faceCam: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  permissionState: "active",
  permissions: [
    {
      id: id * 10,
      sourceId: id,
      kind: "whop-campaign",
      campaignUrl: `https://whop.com/c${id}`,
      briefRules: "",
      cpmRateUsd: cpm,
      minViews,
      allowedPlatforms: ["youtube", "tiktok"],
      expiresAt: null,
      createdAt: "2026-11-01T00:00:00.000Z",
    },
  ],
});

let postId = 0;
const post = (o: Partial<Post> & Pick<Post, "permissionId">): Post => ({
  id: ++postId,
  clipId: 1,
  clipTitle: "Clip",
  sourceId: 1,
  creatorName: "Streamer 1",
  platform: "youtube",
  accountId: "yt",
  accountName: "GTA VI Moments",
  service: "fake",
  status: "posted",
  url: null,
  error: null,
  caption: "",
  scheduledAt: "2026-11-19T10:00:00.000Z",
  postedAt: "2026-11-19T10:00:00.000Z",
  campaignUrl: "https://whop.com/c1",
  views: null,
  viewsUpdatedAt: null,
  viewsSource: null,
  whopSubmittedAt: null,
  estimatedEarningsUsd: 0,
  ...o,
});

let clipId = 0;
const clip = (o: Partial<Clip> = {}): Clip => ({
  id: ++clipId,
  sourceId: 1,
  vodId: 1,
  title: `Clip ${clipId}`,
  hook: "",
  reason: "",
  score: null,
  durationSec: 25,
  status: "pending",
  rejectReason: null,
  layout: "center",
  startSec: 0,
  endSec: 25,
  masterDurationSec: 25,
  captionWords: [],
  postCount: 0,
  videoUrl: "",
  masterUrl: "",
  createdAt: "2026-11-19T00:00:00.000Z",
  ...o,
});

const vod = (o: Partial<Vod> = {}): Vod => ({
  id: 1,
  sourceId: 1,
  url: "https://example.com/v1",
  status: "ready",
  title: "Night one",
  durationSec: 3600,
  chapters: [],
  transcriber: "fake",
  transcriptCostUsd: 0.36,
  wordCount: 100,
  createdAt: "2026-11-18T10:00:00.000Z",
  ...o,
});

let jobId = 0;
const job = (o: Partial<Job> & Pick<Job, "type">): Job => ({
  id: ++jobId,
  status: "done",
  progress: 1,
  message: "Done",
  error: null,
  attempts: 1,
  maxAttempts: 3,
  vodId: 1,
  clipId: null,
  createdAt: "2026-11-18T10:00:00.000Z",
  updatedAt: "2026-11-18T10:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  ...o,
});

describe("earningsRows (earnings with minimums)", () => {
  it("groups by campaign and platform, counts posts over the minimum and this week's pay", () => {
    const rows = earningsRows(
      [
        post({ permissionId: 10, views: 24_000, estimatedEarningsUsd: 36, whopSubmittedAt: "2026-11-19T11:00:00.000Z" }),
        post({ permissionId: 10, views: 2_999, estimatedEarningsUsd: 0 }),
        // Last week: in the total, not in this week.
        post({ permissionId: 10, views: 10_000, estimatedEarningsUsd: 15, postedAt: "2026-11-12T10:00:00.000Z", scheduledAt: "2026-11-12T10:00:00.000Z" }),
        post({ permissionId: 10, platform: "tiktok", views: 3_000, estimatedEarningsUsd: 4.5 }),
        post({ permissionId: 10, status: "failed", views: 99_999, estimatedEarningsUsd: 150 }),
      ],
      [source(1, 3000)],
      now,
    );
    expect(rows).toEqual([
      {
        key: "10:youtube",
        campaign: "Streamer 1 · whop.com",
        platform: "youtube",
        posts: 3,
        views: 36_999,
        minViews: 3000,
        overMinimum: 2,
        estimatedUsd: 51,
        weekUsd: 36,
        submitted: 1,
      },
      {
        key: "10:tiktok",
        campaign: "Streamer 1 · whop.com",
        platform: "tiktok",
        posts: 1,
        views: 3_000,
        minViews: 3000,
        overMinimum: 1,
        estimatedUsd: 4.5,
        weekUsd: 4.5,
        submitted: 0,
      },
    ]);
  });

  it("without a minimum, any post with views counts as over it", () => {
    const [row] = earningsRows([post({ permissionId: 20, views: 50, estimatedEarningsUsd: 0.08 }), post({ permissionId: 20 })], [source(2, null)], now);
    expect(row!.overMinimum).toBe(1);
  });
});

describe("vodProgress and goals", () => {
  const jobs = [
    // Newest first, like the queue lists them: the latest try of a stage counts.
    job({ id: 104, type: "render", status: "running", progress: 0.5, startedAt: "2026-11-18T10:08:00.000Z" }),
    job({ id: 103, type: "picks", startedAt: "2026-11-18T10:06:00.000Z", finishedAt: "2026-11-18T10:08:00.000Z" }),
    job({ id: 102, type: "ingest", startedAt: "2026-11-18T10:00:00.000Z", finishedAt: "2026-11-18T10:06:00.000Z" }),
    job({ id: 101, type: "ingest", status: "failed", startedAt: "2026-11-18T09:00:00.000Z", finishedAt: "2026-11-18T09:01:00.000Z" }),
  ];

  it("shows each stage with its time, and the share of clips approved", () => {
    const clips = [clip({ status: "approved" }), clip({ status: "rejected" }), clip(), clip({ status: "approved" }), clip({ vodId: 2 })];
    const p = vodProgress(vod(), jobs, clips, "Streamer 1");
    expect(p.stages).toEqual([
      { stage: "transcript", state: "done", seconds: 360, progress: 1 },
      { stage: "picks", state: "done", seconds: 120, progress: 1 },
      { stage: "render", state: "running", seconds: null, progress: 0.5 },
    ]);
    expect(p).toMatchObject({ clips: 4, approved: 2, approvedShare: 0.5 });
  });

  it("adds up the render jobs of every pick, after the latest picks run", () => {
    const picks = job({ type: "picks", startedAt: "2026-11-18T10:06:00.000Z", finishedAt: "2026-11-18T10:08:00.000Z" });
    const renders = [
      job({ type: "render", status: "queued", progress: 0 }),
      job({ type: "render", status: "running", progress: 0.5, startedAt: "2026-11-18T10:12:00.000Z" }),
      job({ type: "render", startedAt: "2026-11-18T10:08:00.000Z", finishedAt: "2026-11-18T10:12:00.000Z" }),
    ];
    const old = job({ id: picks.id - 1, type: "render", status: "failed" });
    // Newest first, as listed: the old render belongs to an earlier picks run and is left out.
    const listed = [...renders.reverse(), picks, old];
    const running = vodProgress(vod(), listed, [], "Streamer 1").stages[2];
    expect(running).toEqual({ stage: "render", state: "running", seconds: null, progress: 0.5 });

    for (const r of renders) Object.assign(r, { status: "done", startedAt: "2026-11-18T10:20:00.000Z", finishedAt: "2026-11-18T10:23:00.000Z" });
    expect(vodProgress(vod(), listed, [], "Streamer 1").stages[2]).toEqual({ stage: "render", state: "done", seconds: 540, progress: 1 });
  });

  it("measures O1 and O2 against their targets", () => {
    const doneJobs = [
      job({ id: 105, type: "render", startedAt: "2026-11-18T10:08:00.000Z", finishedAt: "2026-11-18T10:20:00.000Z" }),
      ...jobs.slice(1),
    ];
    const clips = Array.from({ length: 8 }, (_, i) => clip({ status: i < 3 ? "approved" : "pending", vodId: 1 }));
    const p = vodProgress(vod({ durationSec: 3600 }), doneJobs, clips, "Streamer 1");
    const decided = ["2026-11-19T12:00:00.000Z", "2026-11-19T12:00:12.000Z", "2026-11-19T12:00:32.000Z"];
    const g = goals([p], clips, decided);
    expect(g.map((x) => [x.id, x.now, x.value])).toEqual([
      ["clips-per-hour", "8 clips", 0.8],
      ["minutes-per-hour", "20 min", 1],
      ["approved-share", "38 %", 0.75],
      ["seconds-per-clip", "16 s", 10 / 16],
    ]);
  });

  it("says when there is no data yet", () => {
    expect(goals([], [], []).every((x) => x.value === null && x.now === "No data yet")).toBe(true);
  });
});

describe("buildDashboard", () => {
  const card = (o: Partial<AccountCard>): AccountCard => ({
    account: null,
    estimatedEarningsUsd: 0,
    claims: null,
    accountId: "yt",
    platform: "youtube",
    name: "GTA VI Moments",
    followers: null,
    followersSeries: [],
    followersGrowth: null,
    followersSource: "none",
    viewsPerDay: [],
    viewsSource: "none",
    posts: 0,
    avgViewsPerPost: null,
    topClips: [],
    postsLast7Days: 0,
    plannedLast7Days: 21,
    updatedAt: null,
    demo: false,
    ...o,
  });

  const base = {
    now,
    clips: [clip({ status: "pending" }), clip({ status: "pending" }), clip({ status: "approved" }), clip({ status: "approved", postCount: 1 }), clip({ status: "rejected" })],
    posts: [
      post({ permissionId: 10, views: 5000, estimatedEarningsUsd: 7.5 }),
      post({ permissionId: 10, views: 9000, estimatedEarningsUsd: 13.5, postedAt: "2026-11-18T10:00:00.000Z" }),
      post({ permissionId: 10, status: "scheduled", postedAt: null, scheduledAt: "2026-11-19T18:00:00.000Z" }),
    ],
    vods: [vod({ transcriptCostUsd: 0.36 }), vod({ id: 2, transcriptCostUsd: 0.24, createdAt: "2026-11-10T10:00:00.000Z" })],
    jobs: [job({ type: "ingest", vodId: 1, status: "running", progress: 0.25, startedAt: new Date(now.getTime() - 600_000).toISOString() })],
    sources: [source(1, 3000)],
    decisionTimes: [],
  };

  it("fills the Today tiles", () => {
    const d = buildDashboard({ ...base, accounts: [] });
    expect(d.empty).toBe(false);
    expect(d.today).toEqual({
      waiting: 2,
      approved: 1,
      postedToday: 1,
      viewsToday: 5000,
      viewsTodayFrom: "posts",
      earningsWeekUsd: 21,
      costWeekUsd: 0.36,
      costPerApprovedClipUsd: 0.3,
    });
    expect(d.running).toEqual([{ jobId: expect.any(Number), label: "Transcript: Night one", progress: 0.25, message: "Done", etaSec: 1800 }]);
  });

  it("takes today's views from the accounts when the service has them", () => {
    const d = buildDashboard({
      ...base,
      accounts: [
        card({ viewsPerDay: [{ date: "2026-11-18", value: 900 }, { date: "2026-11-19", value: 1200 }] }),
        card({ accountId: "tt", viewsPerDay: [{ date: "2026-11-19", value: 300 }] }),
      ],
    });
    expect(d.today).toMatchObject({ viewsToday: 1500, viewsTodayFrom: "accounts" });
  });

  it("is empty on a new database", () => {
    const d = buildDashboard({ now, clips: [], posts: [], vods: [], jobs: [], sources: [], accounts: [], decisionTimes: [] });
    expect(d.empty).toBe(true);
    expect(d.today.costPerApprovedClipUsd).toBeNull();
  });
});
