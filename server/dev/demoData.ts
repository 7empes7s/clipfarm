import type { Clip, DailyPoint, Platform, RejectReason, Source } from "../../shared/types.js";
import { dayOf } from "../../shared/metrics.js";
import type { AccountStatsStore } from "../accounts/stats.js";
import { ClipsRepo } from "../clips/repo.js";
import type { Db } from "../db/index.js";
import { ValidationError } from "../errors.js";
import type { JobHandler } from "../jobs/queue.js";
import { PostsRepo } from "../publish/repo.js";
import type { VodsRepo } from "../vods/repo.js";
import { type DemoClipsDeps, makeDemoClips } from "./demo.js";

export const DEMO_DATA_JOB = "demo-data";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export const DEMO_ACCOUNTS: { accountId: string; platform: Platform; name: string; followers: number; perDay: number; views: number }[] = [
  { accountId: "demo-youtube", platform: "youtube", name: "GTA VI Moments (demo)", followers: 820, perDay: 31, views: 5200 },
  { accountId: "demo-tiktok", platform: "tiktok", name: "gtavimoments (demo)", followers: 2400, perDay: 95, views: 14800 },
  { accountId: "demo-instagram", platform: "instagram", name: "gtavi.moments (demo)", followers: 1150, perDay: 18, views: 3100 },
];

/** [clip index, account index, days ago, views, sent to Whop]. */
const DEMO_POSTS: [number, number, number, number, boolean][] = [
  [0, 0, 5, 42_000, true],
  [0, 1, 5, 61_000, true],
  [1, 1, 3, 18_500, false],
  [1, 2, 3, 2_600, false],
  [2, 0, 1, 9_100, false],
  [3, 1, 0, 4_800, false],
];

export interface DemoDataDeps extends DemoClipsDeps {
  db: Db;
  vods: VodsRepo;
  accountStats: AccountStatsStore;
}

/** Whether "Load demo data" already ran on this database. */
export function demoDataLoaded(accountStats: AccountStatsStore): boolean {
  return accountStats.rows().some((r) => r.demo);
}

export function assertNoDemoData(accountStats: AccountStatsStore): void {
  if (demoDataLoaded(accountStats)) throw new ValidationError("Demo data is already loaded.");
}

/** Day-by-day series ending today: a steady trend with a small wobble, so charts look real. */
function demoSeries(now: Date, days: number, start: number, perDay: number, wobble: number): DailyPoint[] {
  return Array.from({ length: days }, (_, i) => ({
    date: dayOf(new Date(now.getTime() - (days - 1 - i) * DAY)),
    value: Math.max(0, Math.round(start + perDay * i + wobble * Math.sin(i * 1.7))),
  }));
}

/**
 * Everything around the demo clips that the dashboard shows: two finished VODs with stage times,
 * review decisions, posts with views on three demo accounts, and 30 days of account stats.
 *
 * Posts are records only (nothing is sent anywhere). They point to a demo campaign that has
 * already ended, and the creators' current record allows no platform, so demo clips stay
 * impossible to post.
 */
export function seedDemoHistory(deps: DemoDataDeps, made: { sources: Source[]; clips: Clip[] }, now: Date): void {
  const { db, sources, vods, accountStats } = deps;
  const ago = (ms: number) => new Date(now.getTime() - ms);

  const campaigns = made.sources.map((s, i) => {
    sources.addPermission(
      s.id,
      {
        kind: "whop-campaign",
        campaignUrl: `https://whop.com/demo/gta-vi-clips-${i === 0 ? "a" : "b"}`,
        briefRules: "Demo campaign, already ended. Nothing can be posted from it.",
        cpmRateUsd: i === 0 ? 1.5 : 1,
        minViews: i === 0 ? 3000 : 5000,
        allowedPlatforms: ["youtube", "tiktok", "instagram"],
        expiresAt: ago(60 * MIN).toISOString(),
      },
      ago(30 * DAY).toISOString(),
    );
    return sources.get(s.id).permissions.at(-1)!;
  });

  // One finished hour-long VOD per creator, with the time each stage took.
  const stageMinutes = [
    [6, 1.5, 9],
    [7, 2, 12],
  ];
  const insertJob = db.prepare(
    `INSERT INTO jobs (type, payload, status, progress, message, attempts, vod_id, created_at, updated_at, started_at, finished_at)
     VALUES (?, '{}', 'done', 1, 'Done', 1, ?, ?, ?, ?, ?)`,
  );
  made.sources.forEach((s, i) => {
    const vod = vods.create(s.id, `https://example.com/demo/vod-${i + 1}`);
    vods.saveMeta(vod.id, { title: i === 0 ? "Demo stream A: first night in Vice City" : "Demo stream B: heist practice", durationSec: 3600, chapters: [] });
    vods.saveTranscript(vod.id, [{ word: "demo", startSec: 0, endSec: 0.5 }], "demo", 0.36);
    db.prepare("UPDATE clips SET vod_id = ? WHERE source_id = ?").run(vod.id, s.id);
    let t = ago((2 - i) * DAY).getTime();
    (["ingest", "picks", "render"] as const).forEach((type, k) => {
      const start = new Date(t).toISOString();
      t += stageMinutes[i]![k]! * MIN;
      const end = new Date(t).toISOString();
      insertJob.run(type, vod.id, start, end, start, end);
    });
  });

  // Review decisions a few seconds apart: six approved, two rejected, two left for the inbox.
  let reviewAt = ago(DAY).getTime();
  const reviewer = new ClipsRepo(db, () => new Date(reviewAt));
  const decisions: (RejectReason | "approve")[] = ["approve", "approve", "approve", "approve", "approve", "boring", "approve", "bad-crop"];
  decisions.forEach((d, i) => {
    reviewAt += (6 + (i % 3) * 2) * 1000;
    const clip = made.clips[i];
    if (!clip) return;
    if (d === "approve") reviewer.review(clip.id, "approve");
    else reviewer.review(clip.id, "reject", d);
  });

  for (const a of DEMO_ACCOUNTS) {
    accountStats.upsertAccount({ ...a, demo: true });
    accountStats.saveStats(
      {
        accountId: a.accountId,
        followers: demoSeries(now, 30, a.followers, a.perDay, a.perDay * 0.6),
        views: demoSeries(now, 30, a.views * 0.4, a.views * 0.02, a.views * 0.15),
      },
      now.toISOString(),
    );
  }

  for (const [clipIdx, accIdx, daysAgo, views, whop] of DEMO_POSTS) {
    const clip = made.clips[clipIdx];
    const account = DEMO_ACCOUNTS[accIdx]!;
    if (!clip) continue;
    const at = ago(daysAgo * DAY + 2 * 60 * MIN);
    const writer = new PostsRepo(db, () => at);
    const post = writer.insert({
      clipId: clip.id,
      permissionId: campaigns[made.sources.findIndex((s) => s.id === clip.sourceId)]!.id,
      platform: account.platform,
      accountId: account.accountId,
      accountName: account.name,
      service: "fake",
      externalId: null,
      status: "posted",
      url: `https://example.com/demo/${account.platform}/${clip.id}`,
      error: null,
      caption: `${clip.title} (demo post, never published)`,
      scheduledAt: at.toISOString(),
      postedAt: at.toISOString(),
    });
    db.prepare("UPDATE posts SET views = ?, views_source = 'service', views_updated_at = ? WHERE id = ?").run(views, now.toISOString(), post.id);
    if (whop) writer.markWhopSubmitted(post.id);
  }
}

/** "Load demo data": the ten demo clips (ffmpeg, about 20 s), then the history around them. */
export function demoDataHandler(deps: DemoDataDeps, now: () => Date = () => new Date()): JobHandler {
  return async ({ tmpDir, signal, progress }) => {
    assertNoDemoData(deps.accountStats);
    const made = await makeDemoClips(deps, { tmpDir, signal, progress: (f, m) => progress(f * 0.9, m) });
    progress(0.95, "Adding demo history");
    seedDemoHistory(deps, made, now());
  };
}
