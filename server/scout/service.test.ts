import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { campaignInput } from "../../test/helpers.js";
import { createApp } from "../app.js";
import { ClipsRepo } from "../clips/repo.js";
import { openDb } from "../db/index.js";
import { JobQueue } from "../jobs/queue.js";
import { FakeNotifier } from "../live/notify.js";
import { PicksRepo } from "../picks/repo.js";
import { FakePostingService } from "../publish/fake.js";
import { Publisher } from "../publish/publisher.js";
import { PostsRepo } from "../publish/repo.js";
import { SourcesRepo } from "../sources/repo.js";
import { VodsRepo } from "../vods/repo.js";
import { DEMO_AGENCY, DEMO_HARBOR, DEMO_NIGHT_OWL, DEMO_PIXEL_RUSH, DEMO_SCOUT_PAGES, DEMO_SCOUT_START, FakeScoutFetcher } from "./fake.js";
import { PoliteFetcher } from "./polite.js";
import { ScoutRepo } from "./repo.js";
import { Scout } from "./service.js";

const dir = mkdtempSync(join(tmpdir(), "clipfarm-scout-"));
const videoPath = join(dir, "clip.mp4");
writeFileSync(videoPath, "not really a video");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ROBOTS = "https://contentrewards.com/robots.txt";

function setup(pages: Record<string, string> = DEMO_SCOUT_PAGES, opts: { maxPages?: number } = {}) {
  let now = new Date("2026-11-20T08:00:00.000Z");
  const clock = () => now;
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db, clock);
  const clips = new ClipsRepo(db, clock);
  const posts = new PostsRepo(db, clock);
  const service = new FakePostingService();
  const notifier = new FakeNotifier();
  const web = new FakeScoutFetcher(pages);
  const sleeps: number[] = [];
  const scout: Scout = new Scout({
    repo: new ScoutRepo(db),
    sources,
    posts,
    accounts: () => publisher.accounts.list(),
    fetcher: new PoliteFetcher(web, {
      now: () => now.getTime(),
      sleep: (ms) => {
        sleeps.push(ms);
        now = new Date(now.getTime() + ms);
        return Promise.resolve();
      },
    }),
    startUrls: [DEMO_SCOUT_START],
    notifier,
    watched: () => [],
    maxPages: opts.maxPages,
    now: clock,
  });
  const publisher = new Publisher({ sources, clips, posts, service, now: clock, campaignLimit: (p, clipId) => scout.postBlock(p, clipId) });
  const queue = new JobQueue(db, { handlers: {} });
  queue.stop();
  const app = createApp({ sources, vods: new VodsRepo(db, clock), picks: new PicksRepo(db), queue, clips, posts, publisher, scout });
  const approvedClip = (sourceId: number, title: string) => {
    const clip = clips.create({ sourceId, vodId: null, title, filePath: videoPath, durationSec: 25, score: 80 });
    clips.setStatus(clip.id, "approved");
    return clip.id;
  };
  /** Joins a campaign the way the import form saves it. */
  const join = (creatorName: string, campaignUrl: string, cpmRateUsd: number) =>
    sources.saveCampaign({ ...campaignInput({ campaignUrl, cpmRateUsd, minViews: null, briefRules: "" }), creatorName });
  return { db, app, scout, sources, posts, publisher, notifier, web, sleeps, approvedClip, join, setNow: (d: Date) => (now = d), clock };
}

describe("a scout run over the fixture site", () => {
  it("reads the listing, the campaigns and the agency page it leads to, politely, and ranks what it found", async () => {
    const t = setup();
    await t.scout.run();

    // robots.txt first, then one page at a time: the agency page right after the campaign that names it.
    expect(t.web.asked).toEqual([ROBOTS, DEMO_SCOUT_START, DEMO_NIGHT_OWL, DEMO_AGENCY, DEMO_HARBOR, DEMO_PIXEL_RUSH]);
    expect(t.sleeps).toEqual([5000, 5000, 5000, 5000, 5000]);

    const info = t.scout.info();
    expect(info).toMatchObject({ found: 3, running: false, lastError: null, lastRunAt: t.clock().toISOString() });
    expect(info.suggestions.map((s) => [s.facts.title, s.facts.agency, s.score.perDayUsd])).toEqual([
      ["Pixel Rush Kick streams", "Demo Clip Agency", 31.59],
      ["Night Owl GTA VI stream clips", "Demo Clip Agency", 24.14],
      ["Harbor Talk podcast clipping", null, 0.21],
    ]);
    expect(info.suggestions[0]!.url).toBe(DEMO_PIXEL_RUSH);
    expect(info.suggestions[0]!.score.steps.at(-2)).toEqual({
      label: "Score",
      value: "$10.53",
      why: "Expected earnings per clip × budget left × fit × streams, less the rule risk and the competition.",
    });
  });

  it("pushes the new campaigns worth a dollar a day or more once, not again on the next run", async () => {
    const t = setup();
    await t.scout.run();
    expect(t.notifier.sent).toEqual([{ title: "clipfarm: campaigns", body: "2 new campaigns worth joining (est. $55.73/day)", url: "/#dashboard" }]);
    await t.scout.run();
    expect(t.notifier.sent).toHaveLength(1);
  });

  it("runs once a day", async () => {
    const t = setup();
    expect(await t.scout.runIfDue()).toBe(true);
    const first = t.web.asked.length;
    t.setNow(new Date(t.clock().getTime() + 23 * 3600_000));
    expect(await t.scout.runIfDue()).toBe(false);
    expect(t.web.asked).toHaveLength(first);
    t.setNow(new Date(t.clock().getTime() + 2 * 3600_000));
    expect(await t.scout.runIfDue()).toBe(true);
    expect(t.web.asked.length).toBeGreaterThan(first);
  });

  it("stops at the run's page limit and reads the rest the next day, new campaigns first", async () => {
    const t = setup(DEMO_SCOUT_PAGES, { maxPages: 2 });
    await t.scout.run();
    // The listing and one campaign; the robots.txt read is not a page.
    expect(t.web.asked).toEqual([ROBOTS, DEMO_SCOUT_START, DEMO_NIGHT_OWL]);
    await t.scout.run();
    expect(t.web.asked.slice(3)).toEqual([ROBOTS, DEMO_SCOUT_START, DEMO_NIGHT_OWL]);
    expect(t.scout.info().found).toBe(1);
  });

  it("leaves out pages robots.txt disallows, and says why nothing was found", async () => {
    const t = setup({ ...DEMO_SCOUT_PAGES, [ROBOTS]: "User-agent: *\nDisallow: /c/campaigns/\nDisallow: /sitemap.xml\n" });
    await t.scout.run();
    expect(t.web.asked).toEqual([ROBOTS]);
    expect(t.scout.info()).toMatchObject({ found: 0, lastError: "contentrewards.com asks crawlers not to read this page (robots.txt)" });
    expect(t.notifier.sent).toEqual([]);
  });

  it("drops a campaign whose page is gone, and scores nothing for one that ended", async () => {
    const pages = { ...DEMO_SCOUT_PAGES };
    const t = setup(pages);
    await t.scout.run();
    delete pages[DEMO_HARBOR];
    pages[DEMO_NIGHT_OWL] = pages[DEMO_NIGHT_OWL]!.replace("Accepting clips", "Ended");
    await t.scout.run();
    expect(t.scout.info().found).toBe(2);
    expect(t.scout.info().suggestions.map((s) => s.facts.creatorName)).toEqual(["Pixel Rush"]);
  });
});

describe("Join, Joined? and Not interested", () => {
  it("hides a campaign, remembers that Join was tapped, and drops a campaign once it is imported", async () => {
    const t = setup();
    await t.scout.run();
    const [pixel, night, harbor] = (await request(t.app).get("/api/scout").expect(200)).body.suggestions;

    const hidden = await request(t.app).put(`/api/scout/campaigns/${harbor.id}`).send({ status: "hidden" }).expect(200);
    expect(hidden.body.suggestions.map((s: { id: number }) => s.id)).toEqual([pixel.id, night.id]);

    const opened = await request(t.app).put(`/api/scout/campaigns/${pixel.id}`).send({ status: "opened" }).expect(200);
    expect(opened.body.suggestions[0]).toMatchObject({ id: pixel.id, status: "opened" });

    // The manager joined and saved the campaign through the import form: it is a joined campaign now.
    t.join("Pixel Rush", `${DEMO_PIXEL_RUSH}?ref=share`, 2);
    const after = (await request(t.app).get("/api/scout").expect(200)).body;
    expect(after.suggestions.map((s: { id: number }) => s.id)).toEqual([night.id]);
    expect(after.auto.plan.map((r: { name: string }) => r.name)).toEqual(["Pixel Rush"]);

    // A hidden campaign stays hidden after the next run.
    await t.scout.run();
    expect(t.scout.info().suggestions.map((s) => s.id)).toEqual([night.id]);

    await request(t.app).put(`/api/scout/campaigns/${night.id}`).send({ status: "joined" }).expect(400);
    await request(t.app).put("/api/scout/campaigns/999").send({ status: "hidden" }).expect(404);
  });

  it("Scout now answers at once and reads in the background", async () => {
    const t = setup();
    const res = await request(t.app).post("/api/scout/run").expect(202);
    expect(res.body.running).toBe(true);
    await t.scout.run();
    expect((await request(t.app).get("/api/scout")).body).toMatchObject({ running: false, found: 3 });
  });
});

describe("auto mode", () => {
  async function joinedTwo() {
    const t = setup();
    await t.publisher.syncAccounts();
    const pixel = t.join("Pixel Rush", DEMO_PIXEL_RUSH, 2);
    const harbor = t.join("Harbor Talk", DEMO_HARBOR, 1.5);
    await t.scout.run();
    return { ...t, pixel, harbor };
  }

  it("is off until the manager turns it on, and then shares the accounts' clips by score", async () => {
    const t = await joinedTwo();
    // The busiest platform: two TikTok accounts at 3 posts a day.
    expect(t.scout.info().auto).toMatchObject({ on: false, slots: 6 });

    const on = await request(t.app).put("/api/scout/auto").send({ on: true }).expect(200);
    expect(on.body.auto.on).toBe(true);
    expect(on.body.auto.plan).toMatchObject([
      { name: "Pixel Rush", slots: 6, budgetUsedPct: 6, paused: null },
      { name: "Harbor Talk", slots: 0, budgetUsedPct: 90, paused: null },
    ]);
    await request(t.app).put("/api/scout/auto").send({ on: "yes" }).expect(400);
  });

  it("holds a campaign to its clips a day, lets a clip already out go on, and steps aside when off", async () => {
    const t = await joinedTwo();
    t.posts.saveRules({ maxPerDay: 1, minGapMinutes: 0 });
    // Two TikTok accounts at one post a day: two clips a day, both for Pixel Rush.
    const [a, b, c] = ["one", "two", "three"].map((title) => t.approvedClip(t.pixel.id, title));
    const harborClip = t.approvedClip(t.harbor.id, "harbor");

    // With auto mode off nothing is held back.
    expect((await t.publisher.dryRun(harborClip, ["fake-tiktok"], null)).wouldPost).toHaveLength(1);

    t.scout.repo.setAuto(true);
    await t.publisher.post(a!, ["fake-tiktok"], null);
    await t.publisher.post(b!, ["fake-tiktok-2"], null);
    // The first clip may still go to another platform; a third clip waits for tomorrow.
    expect((await t.publisher.dryRun(a!, ["fake-youtube"], null)).wouldPost).toHaveLength(1);
    await expect(t.publisher.post(c!, ["fake-youtube"], null)).rejects.toThrow(
      "GTA VI Moments was left out. Auto mode gives Pixel Rush 2 clips a day and 2 went out today. Try tomorrow. Turn auto mode off in Settings to post anyway. Nothing was posted.",
    );
    // Harbor Talk's score earns it no clip while Pixel Rush takes both.
    await expect(t.publisher.post(harborClip, ["fake-tiktok"], null)).rejects.toThrow("Auto mode gives Harbor Talk 0 clips a day");

    t.setNow(new Date(t.clock().getTime() + 24 * 3600_000));
    expect((await t.publisher.dryRun(c!, ["fake-youtube"], null)).wouldPost).toHaveLength(1);
  });

  it("pauses a joined campaign under 10% of its budget, moves its clips on, and tells the manager once", async () => {
    const pages = { ...DEMO_SCOUT_PAGES };
    const t = setup(pages);
    await t.publisher.syncAccounts();
    const pixel = t.join("Pixel Rush", DEMO_PIXEL_RUSH, 2);
    t.join("Night Owl", DEMO_NIGHT_OWL, 3);
    t.scout.repo.setAuto(true);
    await t.scout.run();
    expect(t.scout.info().auto.plan.map((r) => [r.name, r.slots])).toEqual([
      ["Pixel Rush", 3],
      ["Night Owl", 3],
    ]);
    t.notifier.sent.length = 0;

    // The next day Pixel Rush's page shows 95% of its budget paid out.
    pages[DEMO_PIXEL_RUSH] = pages[DEMO_PIXEL_RUSH]!.replace("$500 / $8,000", "$7,600 / $8,000");
    await t.scout.run();
    expect(t.scout.info().auto.plan).toMatchObject([
      { name: "Night Owl", slots: 6, paused: null },
      { name: "Pixel Rush", slots: 0, budgetUsedPct: 95, paused: "Under 10% of its budget is left (5%)." },
    ]);
    expect(t.notifier.sent.map((n) => n.body)).toEqual(["Pixel Rush budget at 95%, switching effort to Night Owl"]);
    await expect(t.publisher.post(t.approvedClip(pixel.id, "late"), ["fake-tiktok"], null)).rejects.toThrow(
      "Auto mode paused Pixel Rush: Under 10% of its budget is left (5%).",
    );

    await t.scout.run();
    expect(t.notifier.sent).toHaveLength(1);
  });

  it("reads joined campaigns first, even ones the listing no longer shows", async () => {
    const t = setup({ ...DEMO_SCOUT_PAGES, [DEMO_SCOUT_START]: "<urlset></urlset>" });
    t.join("Pixel Rush", DEMO_PIXEL_RUSH, 2);
    await t.scout.run();
    expect(t.web.asked).toEqual([ROBOTS, DEMO_SCOUT_START, DEMO_PIXEL_RUSH]);
    expect(t.scout.info().auto.plan[0]).toMatchObject({ name: "Pixel Rush", budgetUsedPct: 6 });
  });
});
