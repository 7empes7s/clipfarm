import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import type { AutopilotStep, CalendarInfo, ClipVersions } from "../../shared/publishing.js";
import type { ChannelSettings, NewPermissionInput, PostingAccount } from "../../shared/types.js";
import { PERMISSION_KINDS } from "../../shared/types.js";
import { allowanceInput, campaignInput } from "../../test/helpers.js";
import { createApp } from "../app.js";
import { ClipsRepo } from "../clips/repo.js";
import { openDb } from "../db/index.js";
import { JobQueue } from "../jobs/queue.js";
import { PicksRepo } from "../picks/repo.js";
import { parsePermission, SourcesRepo } from "../sources/repo.js";
import { VodsRepo } from "../vods/repo.js";
import { AutopilotRepo } from "./autopilotRepo.js";
import { Autopilot } from "./autopilotService.js";
import { FakePostingService } from "./fake.js";
import { Publisher } from "./publisher.js";
import { PostsRepo } from "./repo.js";
import { VersionsRepo } from "./versionsRepo.js";

const dir = mkdtempSync(join(tmpdir(), "clipfarm-calendar-"));
mkdirSync(join(dir, ".data"));
const videoPath = join(dir, ".data", "clip.mp4");
writeFileSync(videoPath, "not really a video");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ACCOUNTS: PostingAccount[] = [
  { id: "yt-main", platform: "youtube", name: "GTA VI Moments", disabled: false },
  { id: "ig-main", platform: "instagram", name: "gtavi.moments", disabled: false },
  { id: "tt-main", platform: "tiktok", name: "gtavimoments", disabled: false },
  { id: "tt-burner", platform: "tiktok", name: "gta.testing", disabled: false },
];
const DEFAULTS: ChannelSettings = {
  role: "main",
  niche: "",
  maxPerDay: null,
  minGapMinutes: null,
  enabled: true,
  health: "healthy",
  takes: [...PERMISSION_KINDS],
  pinnedCampaignIds: [],
};
const NOON = new Date("2026-11-19T12:00:00.000Z");
const GOOD = { issues: [], fix: null };

function setup(input = allowanceInput({ allowedPlatforms: ["tiktok", "youtube", "instagram"] })) {
  let now = NOON;
  const clock = () => now;
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db, clock);
  const clips = new ClipsRepo(db, clock);
  const posts = new PostsRepo(db, clock);
  posts.submitDefaults = { ...posts.submitDefaults, timeZone: "UTC" };
  const service = new FakePostingService(ACCOUNTS);
  service.today = clock;
  const publisher = new Publisher({ sources, clips, posts, service, now: clock, holdLater: true, versions: new VersionsRepo(db, clock) });
  const autopilot = new Autopilot({ repo: new AutopilotRepo(db, clock), publisher, clips, sources, now: clock });
  const queue = new JobQueue(db, { handlers: {} });
  queue.stop();
  const app = createApp({ sources, vods: new VodsRepo(db, clock), picks: new PicksRepo(db), queue, clips, posts, publisher, autopilot });
  const source = sources.create(input);
  const makeClip = (over: { title?: string; score?: number; approved?: boolean } = {}) => {
    const c = clips.create({ sourceId: source.id, vodId: null, title: over.title ?? "He actually landed the jump", filePath: videoPath, durationSec: 24, score: over.score ?? 90, quality: GOOD });
    if (over.approved ?? true) clips.setStatus(c.id, "approved");
    return c;
  };
  const setAccount = async (id: string, s: Partial<ChannelSettings>) => {
    await publisher.syncAccounts();
    return publisher.accounts.update(id, { ...DEFAULTS, ...s });
  };
  const calendar = async (from = "2026-11-18T00:00:00.000Z", to = "2026-11-26T00:00:00.000Z") =>
    (await request(app).get("/api/calendar").query({ from, to }).expect(200)).body as CalendarInfo;
  return { app, db, sources, clips, posts, service, publisher, autopilot, source, makeClip, setAccount, calendar, setNow: (d: Date) => (now = d) };
}

const publishes = (service: FakePostingService) => service.calls.filter((c) => c === "publish").length;

describe("the calendar", () => {
  it("shows every post with its status; a later post waits in clipfarm and can be dragged to another time", async () => {
    const { app, makeClip, service, calendar, setNow } = setup();
    await request(app).post(`/api/clips/${makeClip().id}/posts`).send({ accountIds: ["tt-main"] }).expect(201);
    const later = await request(app).post(`/api/clips/${makeClip({ title: "Second" }).id}/posts`).send({ accountIds: ["yt-main"], when: "2026-11-20T15:00:00.000Z" }).expect(201);
    // Posted now goes to the service at once; the later one is not handed over yet.
    expect(publishes(service)).toBe(1);
    let cal = await calendar();
    expect(cal.items.map((i) => [i.post.accountId, i.status, i.movable])).toEqual([
      ["tt-main", "posted", false],
      ["yt-main", "scheduled", true],
    ]);
    expect(cal.items[0]!.post.url).toMatch(/^https:\/\/example.com\/tiktok\//);
    expect(cal.limits.map((l) => l.platform)).toEqual(["tiktok", "youtube", "instagram", "facebook", "threads"]);

    const id = later.body.posts[0].id;
    const moved = await request(app).post(`/api/posts/${id}/reschedule`).send({ at: "2026-11-21T09:30:00.000Z" }).expect(200);
    expect(moved.body.post.scheduledAt).toBe("2026-11-21T09:30:00.000Z");
    expect(moved.body.reasons).toEqual([]);

    // When its time comes it goes out through the service, and shows as posting until confirmed.
    setNow(new Date("2026-11-21T09:30:00.000Z"));
    cal = await calendar();
    expect(cal.items.find((i) => i.post.id === id)).toMatchObject({ status: "posting", movable: false });
  });

  it("a drag never overbooks: a seventh YouTube upload that day rolls to the next day, with the reason", async () => {
    const { app, makeClip, setAccount } = setup();

    await setAccount("yt-main", { maxPerDay: 20, minGapMinutes: 0 });
    const ids: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await request(app).post(`/api/clips/${makeClip({ title: `Clip ${i}` }).id}/posts`).send({ accountIds: ["yt-main"], when: `2026-11-22T${i + 10}:00:00.000Z` }).expect(201);
      ids.push(res.body.posts[0].id);
    }
    // Six fit on the 22nd (Pacific); the seventh was already rolled over when it was planned.
    const seventh = await request(app).get("/api/posts").expect(200);
    const rolled = seventh.body.find((p: { id: number }) => p.id === ids[6]);
    expect(rolled.scheduledAt).toBe("2026-11-23T08:00:00.000Z");
    expect(rolled.note).toMatch(/about 6 uploads a day/);
    // Dragging it back onto the full day lands it after the day again, saying why.
    const res = await request(app).post(`/api/posts/${ids[6]}/reschedule`).send({ at: "2026-11-22T20:00:00.000Z" }).expect(200);
    expect(res.body.post.scheduledAt).toBe("2026-11-23T08:00:00.000Z");
    expect(res.body.reasons[0]).toMatch(/6 are already booked that day/);
  });

  it("refuses to move a post that went out, or past the end of its permission", async () => {
    const { app, makeClip } = setup(allowanceInput({ allowedPlatforms: ["tiktok", "youtube"], expiresAt: "2026-11-25T00:00:00.000Z" }));
    const now = await request(app).post(`/api/clips/${makeClip().id}/posts`).send({ accountIds: ["tt-main"] }).expect(201);
    expect((await request(app).post(`/api/posts/${now.body.posts[0].id}/reschedule`).send({ at: "2026-11-21T09:00:00.000Z" })).body.error).toBe(
      "Only a post that has not gone out can be moved.",
    );
    const later = await request(app).post(`/api/clips/${makeClip({ title: "B" }).id}/posts`).send({ accountIds: ["yt-main"], when: "2026-11-20T09:00:00.000Z" }).expect(201);
    const res = await request(app).post(`/api/posts/${later.body.posts[0].id}/reschedule`).send({ at: "2026-11-26T09:00:00.000Z" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/expired on 2026-11-25/);
  });
});

describe("Retry", () => {
  it("posts the clip to the same account again and hides the failed post from the calendar", async () => {
    const { app, makeClip, posts, calendar } = setup();
    const res = await request(app).post(`/api/clips/${makeClip().id}/posts`).send({ accountIds: ["tt-main"] }).expect(201);
    const id = res.body.posts[0].id as number;
    posts.settle(id, { status: "failed", error: "TikTok refused the upload" });
    let cal = await calendar();
    expect(cal.items).toEqual([expect.objectContaining({ status: "failed", retryable: true })]);
    expect(cal.items[0]!.post.error).toBe("TikTok refused the upload");

    const retried = await request(app).post(`/api/posts/${id}/retry`).expect(201);
    expect(retried.body.posts[0]).toMatchObject({ accountId: "tt-main", status: "posted" });
    cal = await calendar();
    expect(cal.items.map((i) => [i.post.id, i.status])).toEqual([[retried.body.posts[0].id, "posted"]]);
    expect((await request(app).post(`/api/posts/${id}/retry`)).body.error).toBe("It was already tried again.");
  });

  it("goes through the permission gate again: no record, no post", async () => {
    const { app, db, makeClip, posts, service } = setup();
    const res = await request(app).post(`/api/clips/${makeClip().id}/posts`).send({ accountIds: ["tt-main"] }).expect(201);
    posts.settle(res.body.posts[0].id, { status: "failed", error: "Timeout" });
    db.prepare("UPDATE permissions SET expires_at = '2026-11-01T00:00:00.000Z'").run();
    const before = publishes(service);
    const retry = await request(app).post(`/api/posts/${res.body.posts[0].id}/retry`);
    expect(retry.status).toBe(403);
    expect(publishes(service)).toBe(before);
  });
});

describe("per-platform versions", () => {
  it("one sheet holds a version per platform; a saved one is what the post carries", async () => {
    const { app, makeClip, service } = setup(campaignInput({ briefRules: "Tag #TJR on every clip.", allowedPlatforms: ["tiktok", "youtube"] }));
    const clip = makeClip();
    const sheet = (await request(app).get(`/api/clips/${clip.id}/versions`).expect(200)).body as ClipVersions;
    expect(sheet.versions.map((v) => v.platform)).toEqual(["tiktok", "youtube", "instagram", "x", "facebook", "threads", "linkedin", "bluesky"]);
    expect(sheet.requiredTags).toEqual(["#TJR"]);
    const tiktok = sheet.versions.find((v) => v.platform === "tiktok")!;
    expect(tiktok).toMatchObject({ saved: false, hashtags: ["#TJR"], problems: [] });

    // Dropping the required tag is refused.
    const bad = await request(app).put(`/api/clips/${clip.id}/versions/tiktok`).send({ ...tiktok, hashtags: "#gta6" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("The campaign requires #TJR.");

    const saved = await request(app)
      .put(`/api/clips/${clip.id}/versions/tiktok`)
      .send({ title: "TikTok title", caption: "He landed it! Credit: Test Streamer", hashtags: "#TJR #gta6" })
      .expect(200);
    expect((saved.body as ClipVersions).versions.find((v) => v.platform === "tiktok")).toMatchObject({ saved: true, title: "TikTok title" });

    const out = await request(app).post(`/api/clips/${clip.id}/posts`).send({ accountIds: ["tt-main", "yt-main"] }).expect(201);
    expect(service.published.map((p) => [p.account.id, p.title, p.caption])).toEqual([["tt-main", "TikTok title", "He landed it! Credit: Test Streamer\n\n#TJR #gta6"]]);
    // YouTube keeps the version made from the clip (it waits its turn: one clip goes out on one account at a time).
    const yt = out.body.posts.find((p: { accountId: string }) => p.accountId === "yt-main");
    expect(yt.caption).toMatch(/^He actually landed the jump\n\nCredit: Test Streamer/);
    expect(yt.caption).toContain("#TJR");

    // Back to the made-up version.
    const reset = await request(app).delete(`/api/clips/${clip.id}/versions/tiktok`).expect(200);
    expect((reset.body as ClipVersions).versions.find((v) => v.platform === "tiktok")!.saved).toBe(false);
  });
});

describe("autopilot", () => {
  const RULE = { name: "Big moments", minScore: 80, accountIds: ["tt-main", "yt-main"], dailyCap: 5 };

  it("a dry run shows what the rule would post and when, and stores and sends nothing", async () => {
    const { app, publisher, makeClip, service, posts } = setup();
    await publisher.syncAccounts();
    makeClip({ score: 92 });
    makeClip({ title: "Weak one", score: 40 });
    const rule = (await request(app).post("/api/autopilot/rules").send(RULE).expect(201)).body;
    expect(rule).toMatchObject({ enabled: false, dryRun: true, auto: false });
    const steps = (await request(app).post(`/api/autopilot/rules/${rule.id}/dry-run`).expect(200)).body as AutopilotStep[];
    expect(steps.map((s) => [s.accountId, s.action])).toEqual([
      ["tt-main", "post"],
      ["yt-main", "post"],
    ]);
    // The next best hour on the manager's clock (UTC here): 12:00 is a TikTok best hour, YouTube's next is 12:00 as well.
    expect(steps.every((s) => s.at !== null)).toBe(true);
    expect(steps[0]!.reason).toMatch(/^It scores 92/);
    expect(publishes(service)).toBe(0);
    expect(posts.list()).toEqual([]);
  });

  it("a rule that is on posts matching clips at the next best slot; a main account waits for the approve tap", async () => {
    const { app, publisher, makeClip, autopilot, service, posts, clips } = setup();
    await publisher.syncAccounts();
    const approved = makeClip({ score: 90 });
    const waiting = makeClip({ title: "Waiting", score: 95, approved: false });
    await request(app).post("/api/autopilot/rules").send({ ...RULE, accountIds: ["tt-main"], enabled: true, dryRun: false }).expect(201);
    await autopilot.tick();
    expect(posts.list().map((p) => p.clipId)).toEqual([approved.id]);
    expect(posts.list()[0]).toMatchObject({ accountId: "tt-main", scheduledAt: "2026-11-19T12:00:00.000Z" });
    // Nothing twice.
    await autopilot.tick();
    expect(posts.list()).toHaveLength(1);
    const info = (await request(app).get("/api/autopilot").expect(200)).body;
    expect(info.recent.map((s: AutopilotStep) => [s.clipId, s.action])).toEqual([[approved.id, "post"]]);
    expect(publishes(service)).toBe(1);
    expect(clips.get(waiting.id).status).toBe("pending");
  });

  it("a burner rule posts a waiting clip without approving it, so a main rule still waits for the tap", async () => {
    const { app, publisher, makeClip, autopilot, clips, posts, setAccount } = setup();
    await setAccount("tt-burner", { role: "burner" });
    const waiting = makeClip({ score: 95, approved: false });
    await request(app).post("/api/autopilot/rules").send({ ...RULE, name: "Burners", burnerOnly: true, accountIds: ["tt-burner"], enabled: true, dryRun: false }).expect(201);
    const main = (await request(app).post("/api/autopilot/rules").send({ ...RULE, name: "Main", accountIds: ["yt-main"], enabled: true, dryRun: false }).expect(201)).body;
    await autopilot.tick();
    await autopilot.tick();
    expect(clips.get(waiting.id).status).toBe("pending");
    expect(posts.list().map((p) => p.accountId)).toEqual(["tt-burner"]);
    const steps = (await request(app).post(`/api/autopilot/rules/${main.id}/dry-run`).expect(200)).body as AutopilotStep[];
    expect(steps.map((s) => [s.accountId, s.action])).toEqual([["yt-main", "wait-approval"]]);
    // The publisher itself refuses a waiting clip to a main account, whatever the caller says.
    await expect(publisher.post(waiting.id, ["yt-main"], null, undefined, { burnersOnly: true })).rejects.toThrow("Approve the clip before posting it to a main account.");
  });

  it("a rule that says auto approves a waiting clip and posts it", async () => {
    const { app, publisher, makeClip, autopilot, clips, posts } = setup();
    await publisher.syncAccounts();
    const waiting = makeClip({ score: 95, approved: false });
    await request(app).post("/api/autopilot/rules").send({ ...RULE, accountIds: ["tt-main"], enabled: true, dryRun: false, auto: true }).expect(201);
    await autopilot.tick();
    expect(clips.get(waiting.id).status).toBe("approved");
    expect(posts.list()).toHaveLength(1);
  });

  it("dry-run mode records what the rule would have done instead of posting", async () => {
    const { app, publisher, makeClip, autopilot, posts, service } = setup();
    await publisher.syncAccounts();
    makeClip();
    await request(app).post("/api/autopilot/rules").send({ ...RULE, enabled: true }).expect(201);
    await autopilot.tick();
    expect(posts.list()).toEqual([]);
    expect(publishes(service)).toBe(0);
    const info = (await request(app).get("/api/autopilot").expect(200)).body;
    expect(info.recent.every((s: AutopilotStep) => s.dryRun && s.action === "post")).toBe(true);
  });

  it("permission guard: a clip whose source has no record in force is never posted by a rule", async () => {
    const { app, publisher, db, makeClip, autopilot, posts } = setup();
    await publisher.syncAccounts();
    makeClip();
    db.prepare("UPDATE permissions SET expires_at = '2026-11-01T00:00:00.000Z'").run();
    await request(app).post("/api/autopilot/rules").send({ ...RULE, enabled: true, dryRun: false, auto: true }).expect(201);
    await autopilot.tick();
    expect(posts.list()).toEqual([]);
    const info = (await request(app).get("/api/autopilot").expect(200)).body;
    expect(info.recent[0]).toMatchObject({ action: "skip", reason: "It has no permission record in force, so it never posts." });
  });

  it("burner rules take burner accounts only; an experiment clip only ever reaches burners", async () => {
    const experiment: NewPermissionInput = { kind: "experiment", note: "Does a claim come?", allowedPlatforms: ["tiktok", "youtube"] };
    const { app, publisher, sources, clips, autopilot, posts, setAccount } = setup();
    await publisher.syncAccounts();
    await setAccount("tt-burner", { role: "burner" });
    const bad = await request(app).post("/api/autopilot/rules").send({ ...RULE, burnerOnly: true, accountIds: ["tt-burner", "tt-main"] });
    expect(bad.body.error).toBe("A burner rule posts only to burner accounts: gtavimoments is a main account.");

    const other = sources.create({ creatorName: "Big Streamer", channelUrls: [], permission: parsePermission(experiment, NOON) });
    const clip = clips.create({ sourceId: other.id, vodId: null, title: "Test", filePath: videoPath, durationSec: 24, score: 99, quality: GOOD });
    await request(app).post("/api/autopilot/rules").send({ ...RULE, sourceId: other.id, accountIds: ["tt-main", "tt-burner"], enabled: true, dryRun: false }).expect(201);
    await autopilot.tick();
    expect(posts.list().map((p) => [p.clipId, p.accountId, p.experiment])).toEqual([[clip.id, "tt-burner", true]]);
  });
});

describe("campaign submits", () => {
  it("tracks a rejection with its reason; approving it again clears it", async () => {
    const { app, makeClip } = setup(campaignInput());
    const res = await request(app).post(`/api/clips/${makeClip().id}/posts`).send({ accountIds: ["tt-main"] }).expect(201);
    const id = res.body.posts[0].id;
    expect((await request(app).post(`/api/posts/${id}/whop-reject`).send({ reason: "Missing tag" })).body.error).toBe("Mark it sent to Whop first.");
    await request(app).post(`/api/posts/${id}/whop`).send({ step: "submitted" }).expect(200);
    const rejected = await request(app).post(`/api/posts/${id}/whop-reject`).send({ reason: "Missing tag" }).expect(200);
    expect(rejected.body).toMatchObject({ whopRejectReason: "Missing tag", whopApprovedAt: null });
    expect(rejected.body.whopRejectedAt).not.toBeNull();
    const approved = await request(app).post(`/api/posts/${id}/whop`).send({ step: "approved" }).expect(200);
    expect(approved.body).toMatchObject({ whopRejectedAt: null, whopRejectReason: null });
  });
});
