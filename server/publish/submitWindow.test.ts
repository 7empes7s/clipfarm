import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_SUBMIT_HOURS, nextSubmitTime } from "../../shared/submitWindow.js";
import { NO_CAMPAIGN_RULES } from "../../shared/types.js";
import { allowanceInput, campaignInput } from "../../test/helpers.js";
import { createApp } from "../app.js";
import { ClipsRepo } from "../clips/repo.js";
import { openDb } from "../db/index.js";
import { JobQueue } from "../jobs/queue.js";
import { FakeNotifier } from "../live/notify.js";
import { PicksRepo } from "../picks/repo.js";
import { SourcesRepo } from "../sources/repo.js";
import { VodsRepo } from "../vods/repo.js";
import { FakePostingService } from "./fake.js";
import { Publisher } from "./publisher.js";
import { PostsRepo } from "./repo.js";
import { nextFreeSlot, nextSubmitSlot } from "./spacing.js";
import { SubmitWatch } from "./submitWatch.js";

const dir = mkdtempSync(join(tmpdir(), "clipfarm-submit-"));
const videoPath = join(dir, "clip.mp4");
writeFileSync(videoPath, "not really a video");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const at = (iso: string) => new Date(iso);
const YT = "fake-youtube";
const TT = "fake-tiktok";
/** 03:00 in Luxembourg, and 08:00 the same morning. */
const NIGHT = "2026-11-19T02:00:00.000Z";
const MORNING = "2026-11-19T07:00:00.000Z";
const NOON = "2026-11-19T12:00:00.000Z";

function setup(nowIso: string, perm: Parameters<typeof campaignInput>[0] = {}) {
  let now = at(nowIso);
  const clock = () => now;
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db, clock);
  const clips = new ClipsRepo(db, clock);
  const posts = new PostsRepo(db, clock);
  const service = new FakePostingService();
  service.today = clock;
  const publisher = new Publisher({ sources, clips, posts, service, submitWindow: true, now: clock });
  const notifier = new FakeNotifier();
  const watch = new SubmitWatch({ posts, publisher, notifier, now: clock });
  const queue = new JobQueue(db, { handlers: {} });
  queue.stop();
  const app = createApp({ sources, vods: new VodsRepo(db, clock), picks: new PicksRepo(db), queue, clips, posts, publisher });
  const clipOf = (input: ReturnType<typeof campaignInput>, title: string) => {
    const source = sources.create(input);
    const clip = clips.create({ sourceId: source.id, vodId: null, title, filePath: videoPath, durationSec: 24 });
    clips.setStatus(clip.id, "approved");
    return clip;
  };
  const clip = clipOf(campaignInput(perm), "He actually landed the jump");
  return { app, service, publisher, posts, notifier, watch, clip, clipOf, sources, clips, setNow: (iso: string) => (now = at(iso)) };
}

describe("nextSubmitSlot (the scheduler)", () => {
  const rules = { maxPerDay: 3, minGapMinutes: 90 };
  const allowed = (t: Date) => nextSubmitTime(t, DEFAULT_SUBMIT_HOURS);

  it("moves a campaign clip due at 03:00 to 08:00", () => {
    expect(nextSubmitSlot([], at(NIGHT), rules, [], allowed).toISOString()).toBe(MORNING);
  });

  it("keeps the spacing: 90 minutes from the account's other posts, and from the same clip on other accounts", () => {
    // The account already posts at 08:00 and 09:00: the next free gap that fits is 10:30.
    const taken = [at(MORNING), at("2026-11-19T08:00:00.000Z")];
    expect(nextSubmitSlot(taken, at(NIGHT), rules, [], allowed).toISOString()).toBe("2026-11-19T09:30:00.000Z");
    expect(nextSubmitSlot([], at(NIGHT), rules, [at(MORNING)], allowed).toISOString()).toBe("2026-11-19T08:30:00.000Z");
  });

  it("when spacing pushes a post past the evening, it waits for the next morning", () => {
    // 20:00 UTC is 21:00 there; a post at 20:00 UTC leaves 21:30 UTC, after the last slot (20:30 UTC).
    const slot = nextSubmitSlot([at("2026-11-19T20:00:00.000Z")], at("2026-11-19T20:10:00.000Z"), rules, [], allowed);
    expect(slot.toISOString()).toBe("2026-11-20T07:00:00.000Z");
  });

  it("a full day sends the post to the next day's hours, not to midnight", () => {
    const taken = [at("2026-11-19T08:00:00.000Z"), at("2026-11-19T10:00:00.000Z"), at("2026-11-19T12:00:00.000Z")];
    expect(nextFreeSlot(taken, at("2026-11-19T14:00:00.000Z"), rules).toISOString()).toBe("2026-11-20T00:00:00.000Z");
    expect(nextSubmitSlot(taken, at("2026-11-19T14:00:00.000Z"), rules, [], allowed).toISOString()).toBe("2026-11-20T07:00:00.000Z");
  });

  it("inside the hours it is the same slot as spacing alone", () => {
    const taken = [at(NOON)];
    expect(nextSubmitSlot(taken, at(NOON), rules, [], allowed)).toEqual(nextFreeSlot(taken, at(NOON), rules));
  });
});

describe("posting a campaign clip outside the submit hours", () => {
  it("holds it until 08:00 instead of posting at 03:00, and says why", async () => {
    const { publisher, service, clip } = setup(NIGHT);
    const { posts: made } = await publisher.post(clip.id, [YT], null);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ status: "scheduled", scheduledAt: MORNING, url: null });
    expect(made[0]!.note).toMatch(/submit hours/);
    expect(made[0]!.submit).toEqual({ liveAt: null, dueBy: null, missedAt: null });
    // Nothing was handed to the posting service yet: clipfarm sends it when it is due.
    expect(service.calls.filter((c) => c === "publish")).toEqual([]);
  });

  it("two accounts keep their distance inside the hours", async () => {
    const { publisher, clip } = setup(NIGHT);
    const { posts: made } = await publisher.post(clip.id, [YT, TT], null);
    expect(made.map((p) => p.scheduledAt)).toEqual([MORNING, "2026-11-19T08:30:00.000Z"]);
  });

  it("leaves a clip that is not a campaign untouched: it posts at 03:00 as before", async () => {
    const { publisher, service, clipOf } = setup(NIGHT);
    const own = clipOf(allowanceInput(), "Open clip");
    const { posts: made } = await publisher.post(own.id, [YT], null);
    expect(made[0]).toMatchObject({ status: "posted", scheduledAt: NIGHT, submit: null });
    expect(service.published).toHaveLength(1);
    // A set time at night stays where it was put, too.
    const later = await publisher.post(own.id, [TT], at("2026-11-20T02:00:00.000Z"));
    expect(later.posts[0]!.scheduledAt).toBe("2026-11-20T02:00:00.000Z");
    expect(service.published[1]!.when).toEqual(at("2026-11-20T02:00:00.000Z"));
  });

  it("leaves a campaign whose rules say no manual submit is needed untouched", async () => {
    const { publisher, clip } = setup(NIGHT, { rules: { ...NO_CAMPAIGN_RULES, manualSubmit: false } });
    const { posts: made } = await publisher.post(clip.id, [YT], null);
    expect(made[0]).toMatchObject({ status: "posted", scheduledAt: NIGHT, submit: null });
  });

  it("inside the hours a campaign clip still posts at once, and its window starts", async () => {
    const { publisher, service, clip } = setup(NOON);
    const { posts: made } = await publisher.post(clip.id, [YT], null);
    expect(made[0]).toMatchObject({ status: "posted", scheduledAt: NOON, note: null });
    expect(made[0]!.submit).toEqual({ liveAt: NOON, dueBy: "2026-11-19T12:30:00.000Z", missedAt: null });
    expect(service.published).toHaveLength(1);
  });

  it("with submit hours switched off, a campaign clip goes out at 03:00 again", async () => {
    const { publisher, clip } = setup(NIGHT);
    publisher.saveSubmitHours({ ...DEFAULT_SUBMIT_HOURS, enabled: false });
    const { posts: made } = await publisher.post(clip.id, [YT], null);
    expect(made[0]).toMatchObject({ status: "posted", scheduledAt: NIGHT });
  });
});

describe("the submit window of a live post", () => {
  it("sends the held post at 08:00, pushes at once and at 20 minutes, and marks it missed at 30", async () => {
    const { publisher, service, posts, notifier, watch, clip, setNow } = setup(NIGHT);
    const [held] = (await publisher.post(clip.id, [YT], null)).posts;
    await watch.tick();
    expect(service.published).toHaveLength(0);
    expect(notifier.sent).toEqual([]);

    setNow(MORNING);
    await watch.tick();
    expect(service.published).toHaveLength(1);
    expect(service.published[0]).toMatchObject({ when: null, paidPromotion: true });
    expect(posts.get(held!.id)).toMatchObject({ status: "posted", postedAt: MORNING, note: null, url: expect.stringContaining("https://example.com/youtube/") });
    expect(notifier.sent).toEqual([
      {
        title: "Test Streamer clip is live: submit within 30 min",
        body: "He actually landed the jump, on GTA VI Moments (YouTube Shorts). Tap to copy the link and open the campaign.",
        url: `/#posted/submit-${held!.id}`,
        snooze: true,
      },
    ]);

    setNow("2026-11-19T07:10:00.000Z");
    await watch.tick();
    setNow("2026-11-19T07:19:00.000Z");
    await watch.tick();
    expect(notifier.sent).toHaveLength(1);

    setNow("2026-11-19T07:20:00.000Z");
    await watch.tick();
    await watch.tick();
    expect(notifier.sent).toHaveLength(2);
    expect(notifier.sent[1]).toMatchObject({ title: "Test Streamer clip: 10 min left to submit", url: `/#posted/submit-${held!.id}` });
    expect(posts.get(held!.id).submit!.missedAt).toBeNull();

    setNow("2026-11-19T07:30:00.000Z");
    await watch.tick();
    await watch.tick();
    expect(posts.get(held!.id).submit).toEqual({ liveAt: MORNING, dueBy: "2026-11-19T07:30:00.000Z", missedAt: "2026-11-19T07:30:00.000Z" });
    expect(notifier.sent).toHaveLength(2);
    // The service was asked to post it once.
    expect(service.published).toHaveLength(1);
  });

  it("a post that is marked sent in time gets no reminder and is never missed", async () => {
    const { publisher, posts, notifier, watch, clip, setNow } = setup(NOON);
    const [post] = (await publisher.post(clip.id, [YT], null)).posts;
    await watch.tick();
    expect(notifier.sent).toHaveLength(1);
    setNow("2026-11-19T12:05:00.000Z");
    publisher.markWhop(post!.id, "submitted", true);
    for (const t of ["2026-11-19T12:20:00.000Z", "2026-11-19T12:40:00.000Z"]) {
      setNow(t);
      await watch.tick();
    }
    expect(notifier.sent).toHaveLength(1);
    expect(posts.get(post!.id).submit!.missedAt).toBeNull();
  });

  it("counts missed windows and what they would have earned, and takes them out of the earnings", async () => {
    const { publisher, posts, watch, clip, clipOf, setNow } = setup(NOON);
    const [missed] = (await publisher.post(clip.id, [YT], null)).posts;
    const other = clipOf({ ...campaignInput(), creatorName: "Second Streamer" }, "Sent in time");
    const [sent] = (await publisher.post(other.id, [TT], null)).posts;
    publisher.markWhop(sent!.id, "submitted", true);
    setNow("2026-11-19T12:31:00.000Z");
    await watch.tick();
    // The stand-in service reports 12,000 views per post: 12 × $1.50 less Whop's 10% is $16.20.
    await publisher.refresh();
    expect(posts.get(missed!.id)).toMatchObject({ estimatedEarningsUsd: 0, lostEarningsUsd: 16.2 });
    expect(posts.get(sent!.id)).toMatchObject({ estimatedEarningsUsd: 16.2, lostEarningsUsd: 0 });
    expect(publisher.stats()).toMatchObject({ posts: 2, estimatedEarningsUsd: 16.2, missedWindows: 1, lostEarningsUsd: 16.2 });
    // Marked sent after all (it was submitted, only the tap came late): it earns again.
    publisher.markWhop(missed!.id, "submitted", true);
    expect(posts.get(missed!.id)).toMatchObject({ estimatedEarningsUsd: 16.2, lostEarningsUsd: 0 });
    expect(publisher.stats()).toMatchObject({ missedWindows: 0, lostEarningsUsd: 0 });
  });

  it("a service that posts in the background is asked about that one post, then the push carries on", async () => {
    const { publisher, service, posts, notifier, watch, clip, setNow } = setup(NOON);
    // Like Postiz: even "now" comes back as scheduled, and the link arrives with a later read.
    const publish = service.publish.bind(service);
    service.publish = async (video, items) => (await publish(video, items.map((i) => ({ ...i, when: at(NOON) })))).map((r) => ({ ...r, status: "scheduled" as const }));
    const [post] = (await publisher.post(clip.id, [YT], null)).posts;
    expect(post).toMatchObject({ status: "scheduled", url: null });
    expect(post!.submit!.liveAt).toBeNull();
    setNow("2026-11-19T12:01:00.000Z");
    await watch.tick();
    expect(service.calls.filter((c) => c === "refresh")).toHaveLength(1);
    expect(posts.get(post!.id)).toMatchObject({ status: "posted", url: expect.stringContaining("https://example.com/") });
    expect(notifier.sent.map((n) => n.title)).toEqual(["Test Streamer clip is live: submit within 29 min"]);
  });
});

describe("“I'm busy”", () => {
  it("moves the campaign posts due in that time to after the snooze, in order and still spaced", async () => {
    const { publisher, posts, clip, clipOf } = setup(NOON);
    const second = clipOf({ ...campaignInput(), creatorName: "Second Streamer" }, "Second clip");
    const [a] = (await publisher.post(clip.id, [YT], at("2026-11-19T12:30:00.000Z"))).posts;
    const [b] = (await publisher.post(second.id, [YT], at("2026-11-19T14:00:00.000Z"))).posts;
    expect([a!.scheduledAt, b!.scheduledAt]).toEqual(["2026-11-19T12:30:00.000Z", "2026-11-19T14:00:00.000Z"]);

    const info = publisher.snooze("1h");
    expect(info).toMatchObject({ snoozeUntil: "2026-11-19T13:00:00.000Z", waiting: 2, nextAt: "2026-11-19T13:00:00.000Z" });
    expect(posts.get(a!.id).scheduledAt).toBe("2026-11-19T13:00:00.000Z");
    // 90 minutes after the first, which now goes out at 13:00.
    expect(posts.get(b!.id).scheduledAt).toBe("2026-11-19T14:30:00.000Z");

    // Busy for the rest of the day: both wait for tomorrow morning.
    publisher.snooze("today");
    expect(posts.get(a!.id).scheduledAt).toBe("2026-11-20T07:00:00.000Z");
    expect(posts.get(b!.id).scheduledAt).toBe("2026-11-20T08:30:00.000Z");
    // "I'm back" ends the snooze; what was moved stays where it is.
    expect(publisher.snooze(null).snoozeUntil).toBeNull();
    expect(posts.get(a!.id).scheduledAt).toBe("2026-11-20T07:00:00.000Z");
  });

  it("does not touch posts that are not campaign clips, and holds a campaign clip posted during the snooze", async () => {
    const { publisher, posts, service, clip, clipOf } = setup(NOON);
    const own = clipOf(allowanceInput(), "Open clip");
    const [scheduled] = (await publisher.post(own.id, [TT], at("2026-11-19T12:30:00.000Z"))).posts;
    publisher.snooze("3h");
    expect(posts.get(scheduled!.id).scheduledAt).toBe("2026-11-19T12:30:00.000Z");
    const other = clipOf({ ...allowanceInput(), creatorName: "Other Open Streamer" }, "Another open clip");
    const [now] = (await publisher.post(other.id, [YT], null)).posts;
    expect(now).toMatchObject({ status: "posted", scheduledAt: NOON });
    const published = service.published.length;
    const [campaign] = (await publisher.post(clip.id, [TT], null)).posts;
    expect(campaign).toMatchObject({ status: "scheduled", scheduledAt: "2026-11-19T15:00:00.000Z" });
    expect(service.published).toHaveLength(published);
  });

  it("a held post is not sent while snoozed or after hours, even when the server was away at its time", async () => {
    const { publisher, service, posts, watch, clip, setNow } = setup(NOON);
    const [held] = (await publisher.post(clip.id, [YT], at("2026-11-19T12:30:00.000Z"))).posts;
    // The server comes back at 22:15 local time.
    setNow("2026-11-19T21:15:00.000Z");
    await watch.tick();
    expect(service.published).toHaveLength(0);
    expect(posts.get(held!.id)).toMatchObject({ status: "scheduled", scheduledAt: "2026-11-20T07:00:00.000Z" });
  });

  it("new submit hours move the posts that no longer fit", async () => {
    const { publisher, posts, clip } = setup(NOON);
    const [held] = (await publisher.post(clip.id, [YT], at("2026-11-19T12:30:00.000Z"))).posts;
    publisher.saveSubmitHours({ ...DEFAULT_SUBMIT_HOURS, weekdays: { from: "15:00", to: "22:00" } });
    expect(posts.get(held!.id).scheduledAt).toBe("2026-11-19T14:00:00.000Z");
  });
});

describe("the submit window over the API", () => {
  it("reads and saves the hours, and snoozes", async () => {
    const { app } = setup(NOON);
    const first = await request(app).get("/api/posting/submit");
    expect(first.body).toEqual({ hours: DEFAULT_SUBMIT_HOURS, snoozeUntil: null, waiting: 0, nextAt: null, open: 0 });

    const hours = { enabled: true, timeZone: "Europe/Paris", weekdays: { from: "09:00", to: "21:00" }, weekends: { from: "10:00", to: "20:00" } };
    const saved = await request(app).put("/api/posting/submit-hours").send(hours);
    expect(saved.status).toBe(200);
    expect(saved.body.hours).toEqual(hours);
    const bad = await request(app).put("/api/posting/submit-hours").send({ ...hours, weekdays: { from: "21:00", to: "09:00" } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("Weekday hours must be at least an hour long, and end after they start.");

    const busy = await request(app).post("/api/posting/snooze").send({ for: "today" });
    expect(busy.body.snoozeUntil).toBe("2026-11-19T23:00:00.000Z");
    const back = await request(app).post("/api/posting/snooze").send({ for: "off" });
    expect(back.body.snoozeUntil).toBeNull();
    expect((await request(app).post("/api/posting/snooze").send({ for: "forever" })).status).toBe(400);
  });
});
