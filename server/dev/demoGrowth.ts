import { type GrowthCampaignInput, NO_METRICS, STAT_OFFSETS } from "../../shared/growth.js";
import { seeded } from "../../shared/stats.js";
import type { Clip, Permission, Source } from "../../shared/types.js";
import type { Db } from "../db/index.js";
import { GrowthRepo } from "../growth/repo.js";
import { PostsRepo } from "../publish/repo.js";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

const DEMO_TESTS: { input: GrowthCampaignInput; startedDaysAgo: number; days: number; lift: number; noise: number; account: string }[] = [
  {
    input: {
      name: "Demo: short clips against long clips",
      hypothesis: "20-30 s clips get more views per hour than 45-60 s clips on YouTube Shorts",
      sourceIds: [],
      accountIds: ["demo-lab-a"],
      postsPerDay: 4,
      times: [],
      durationDays: 5,
      variable: "length",
      variants: [
        { key: "A", label: "20-30 s", minSec: 20, maxSec: 30, words: [], times: [] },
        { key: "B", label: "45-60 s", minSec: 45, maxSec: 60, words: [], times: [] },
      ],
      assignment: "alternate",
      metric: "vph24",
    },
    startedDaysAgo: 8,
    days: 5,
    lift: 2,
    noise: 0.3,
    account: "Shorts test A (demo)",
  },
  {
    input: {
      name: "Demo: morning against evening",
      hypothesis: "Posts at 18:00 and 21:00 beat posts at 09:00 and 12:00",
      sourceIds: [],
      accountIds: ["demo-lab-b"],
      postsPerDay: 4,
      times: [],
      durationDays: 7,
      variable: "time",
      variants: [
        { key: "A", label: "Morning", minSec: null, maxSec: null, words: [], times: ["09:00", "12:00"] },
        { key: "B", label: "Evening", minSec: null, maxSec: null, words: [], times: ["18:00", "21:00"] },
      ],
      assignment: "alternate",
      metric: "vph24",
    },
    startedDaysAgo: 5,
    days: 5,
    lift: 1.1,
    noise: 0.9,
    account: "Shorts test B (demo)",
  },
];

/**
 * Two demo test campaigns with 40 posts between them, so the Campaigns tab has a report to show:
 * one finished with a clear winner (and a recommendation), one still running and undecided.
 * Records only, like the other demo posts: on demo accounts that do not exist, under the demo
 * campaign that has already ended. The numbers look like YouTube's: views, likes, comments, watch
 * time and subscribers, and nothing for saves, shares or reach.
 */
export function seedDemoCampaigns(db: Db, made: { sources: Source[]; clips: Clip[] }, permissions: Permission[], now: Date): void {
  const clips = made.clips.slice(0, 4);
  if (clips.length === 0) return;
  const insertPoint = db.prepare("INSERT INTO post_stats (post_id, offset_key, age_hours, at, metrics) VALUES (?, ?, ?, ?, ?)");
  let n = 0;
  for (const test of DEMO_TESTS) {
    const start = new Date(now.getTime() - test.startedDaysAgo * DAY);
    const repo = new GrowthRepo(db, () => start);
    const campaign = repo.start(repo.create(test.input).id);
    for (let i = 0; i < test.days * 4; i++) {
      const variant = test.input.variants[i % 2]!;
      const at = new Date(start.getTime() + Math.floor(i / 4) * DAY + ((i % 4) * 3 + 1) * HOUR);
      const clip = clips[i % clips.length]!;
      const post = new PostsRepo(db, () => at).insert({
        clipId: clip.id,
        permissionId: permissions[made.sources.findIndex((s) => s.id === clip.sourceId)]!.id,
        platform: "youtube",
        accountId: test.input.accountIds[0]!,
        accountName: test.account,
        service: "fake",
        externalId: null,
        status: "posted",
        url: `https://example.com/demo/youtube/test-${++n}`,
        error: null,
        caption: `${clip.title} (demo post, never published)`,
        scheduledAt: at.toISOString(),
        postedAt: at.toISOString(),
      });
      repo.link(campaign.id, `demo#${i}`, post.id, variant.key);

      const rand = seeded(n * 7919);
      const z = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
      const level = 2400 * (variant.key === "A" ? test.lift : 1) * Math.exp(test.noise * z);
      const reading = (ageHours: number) => {
        const views = Math.round(level * Math.min(3, ageHours / 24) ** 0.7);
        return {
          ...NO_METRICS,
          views,
          likes: Math.round(views * 0.06),
          comments: Math.round(views * 0.004),
          avgWatchPct: Math.round((52 + 20 * rand()) * 10) / 10,
          followsGained: Math.round(views / 400),
        };
      };
      const ageNow = (now.getTime() - at.getTime()) / HOUR;
      for (const o of STAT_OFFSETS) {
        if (ageNow < o.hours) continue;
        insertPoint.run(post.id, o.key, o.hours, new Date(at.getTime() + o.hours * HOUR).toISOString(), JSON.stringify(reading(o.hours)));
      }
      const latest = reading(ageNow);
      db.prepare("UPDATE posts SET views = ?, views_source = 'service', views_updated_at = ?, metrics = ? WHERE id = ?").run(
        latest.views,
        now.toISOString(),
        JSON.stringify(latest),
        post.id,
      );
    }
    if (test.startedDaysAgo > test.input.durationDays) new GrowthRepo(db, () => now).finish(campaign.id);
  }
}
