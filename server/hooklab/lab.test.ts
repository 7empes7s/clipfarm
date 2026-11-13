import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AccountRole, NewSourceInput, PostingAccount } from "../../shared/types.js";
import { NO_CAMPAIGN_RULES, PERMISSION_KINDS } from "../../shared/types.js";
import { HOOK_PATTERNS } from "../../shared/trends.js";
import { campaignInput } from "../../test/helpers.js";
import { ClipsRepo } from "../clips/repo.js";
import { openDb } from "../db/index.js";
import { FakeChatClient } from "../pipeline/picks/fake.js";
import { FakePostingService } from "../publish/fake.js";
import { Publisher } from "../publish/publisher.js";
import { PostsRepo } from "../publish/repo.js";
import { SourcesRepo } from "../sources/repo.js";
import { HookLab } from "./lab.js";
import { writeVariants } from "./variants.js";

const dir = mkdtempSync(join(tmpdir(), "clipfarm-hooklab-"));
const videoPath = join(dir, "clip.mp4");
writeFileSync(videoPath, "not really a video");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ACCOUNTS: PostingAccount[] = [
  { id: "yt-main", platform: "youtube", name: "GTA VI Moments", disabled: false },
  { id: "tt-main", platform: "tiktok", name: "gtavimoments", disabled: false },
  { id: "tt-b1", platform: "tiktok", name: "burner.one", disabled: false },
  { id: "tt-b2", platform: "tiktok", name: "burner.two", disabled: false },
  { id: "tt-b3", platform: "tiktok", name: "burner.three", disabled: false },
  { id: "x-b1", platform: "x", name: "burner.x", disabled: false },
];
const MAINS = ["yt-main", "tt-main"];
const HOUR = 3_600_000;
const T0 = new Date("2026-11-19T12:00:00.000Z");

async function setup(opts: { permission?: Partial<NewSourceInput["permission"]>; burners?: string[] } = {}) {
  let now = T0;
  const clock = () => now;
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db, clock);
  const clips = new ClipsRepo(db, clock);
  const posts = new PostsRepo(db, clock);
  const service = new FakePostingService(ACCOUNTS);
  service.today = clock;
  service.publishesOnTime = true;
  service.views = 0;
  const publisher = new Publisher({ sources, clips, posts, service, now: clock });
  await publisher.syncAccounts();
  const setRole = (id: string, role: AccountRole) =>
    publisher.accounts.update(id, {
      role, niche: "", maxPerDay: 50, minGapMinutes: 0, enabled: true, health: "healthy", takes: [...PERMISSION_KINDS], pinnedCampaignIds: [],
    });
  for (const a of ACCOUNTS) setRole(a.id, (opts.burners ?? ["tt-b1", "tt-b2", "tt-b3", "x-b1"]).includes(a.id) ? "burner" : "main");
  const queued: number[] = [];
  const lab = new HookLab({ db, clips, sources, posts, publisher, enqueueRender: (testId) => queued.push(testId), now: clock });
  const source = sources.create(campaignInput(opts.permission));
  const clip = clips.create({ sourceId: source.id, vodId: null, title: "He actually landed the jump", hook: "No way", filePath: videoPath, durationSec: 24 });
  clips.setStatus(clip.id, "approved");
  /** What the render job does, without ffmpeg: every variant that needs its own video gets a file. */
  const render = () => {
    for (const testId of queued.splice(0)) {
      for (const v of lab.variantsToRender(testId)) {
        const file = join(dir, `variant-${Math.random().toString(36).slice(2)}.mp4`);
        writeFileSync(file, v.hook);
        lab.setVariantFile(v.id, file);
      }
    }
  };
  const sentTo = () => service.published.map((i) => i.account.id);
  const roleOf = (id: string) => publisher.accounts.list().find((a) => a.id === id)!.role;
  return { db, lab, service, publisher, posts, clip, source, queued, render, sentTo, roleOf, setRole, setNow: (d: Date) => (now = d), clock };
}

describe("hook lab (faked posting)", () => {
  it("is off by default and does nothing until it is switched on", async () => {
    const t = await setup();
    expect(t.lab.settings()).toEqual({ on: false, hours: 6 });
    await t.lab.tick();
    expect(t.lab.info().tests).toEqual([]);
    expect(t.queued).toEqual([]);
    expect(t.service.published).toEqual([]);
    expect(t.lab.saveSettings({ on: true })).toEqual({ on: true, hours: 6 });
    expect(() => t.lab.saveSettings({ hours: 0 })).toThrow(/1 to 72/);
  });

  it("tests 3 hooks on burner accounts only, sends the winner by views per hour to main after the window, and keeps score", async () => {
    const t = await setup();
    t.lab.saveSettings({ on: true });

    // 1. Variants are written and queued for rendering: nothing is posted yet.
    await t.lab.tick();
    let [test] = t.lab.info().tests;
    expect(test).toMatchObject({ clipId: t.clip.id, status: "rendering", endsAt: null, mainPosts: 0 });
    expect(test!.variants.map((v) => [v.label, v.hook, v.title, v.pattern, v.accountName])).toEqual([
      ["A", "No way", "He actually landed the jump", "other", "burner.one"],
      ["B", "Test Streamer can't believe it", "Test Streamer can't believe this: He actually landed the jump", "name-reaction", "burner.three"],
      ["C", "Did that really just happen?", "Did Test Streamer really just do this? He actually landed the jump", "question", "burner.two"],
    ]);
    expect(t.queued).toEqual([test!.id]);
    expect(t.service.published).toEqual([]);
    // A second look while they render starts nothing new and posts nothing.
    await t.lab.tick();
    expect(t.lab.info().tests).toHaveLength(1);
    expect(t.service.published).toEqual([]);

    // 2. Rendered: each variant goes to its own burner account, with its own title and video.
    t.render();
    await t.lab.tick();
    expect(t.sentTo()).toEqual(["tt-b1", "tt-b3", "tt-b2"]);
    expect(t.sentTo().map(t.roleOf)).toEqual(["burner", "burner", "burner"]);
    expect(t.service.published.map((i) => i.title)).toEqual(test!.variants.map((v) => v.title));
    expect(new Set(t.service.videos.map((v) => v.path)).size).toBe(3);
    expect(t.service.videos[0]!.path).toBe(videoPath);
    [test] = t.lab.info().tests;
    // The accounts go out a minute apart; the window runs 6 h from the last one.
    expect(test).toMatchObject({ status: "running", endsAt: new Date(T0.getTime() + 2 * 60_000 + 6 * HOUR).toISOString() });

    // 3. Before the window ends nothing goes to a main account, whatever the views say.
    t.service.viewsFor.set("fake-post-1", 600).set("fake-post-2", 6000).set("fake-post-3", 1200);
    t.setNow(new Date(T0.getTime() + 5 * HOUR));
    await t.lab.tick();
    expect(t.sentTo()).toHaveLength(3);
    expect(t.lab.info().tests[0]!.status).toBe("running");
    expect(t.posts.list().every((p) => t.roleOf(p.accountId) === "burner")).toBe(true);

    // 4. After the window: B has the most views per hour, so B goes to the main accounts.
    t.setNow(new Date(T0.getTime() + 2 * 60_000 + 6 * HOUR));
    await t.lab.tick();
    expect(t.sentTo().slice(3).sort()).toEqual([...MAINS].sort());
    const mainItems = t.service.published.slice(3);
    expect(mainItems.map((i) => i.title)).toEqual([test!.variants[1]!.title, test!.variants[1]!.title]);
    expect(t.service.videos.at(-1)!.path).toBe(t.service.videos[1]!.path);
    [test] = t.lab.info().tests;
    expect(test).toMatchObject({ status: "done", mainPosts: 2, note: "B won with 997 views an hour and went to 2 main accounts." });
    expect(test!.variants.map((v) => [v.label, v.views, v.viewsPerHour, v.winner])).toEqual([
      ["A", 600, 99, false],
      ["B", 6000, 997, true],
      ["C", 1200, 200, false],
    ]);

    // 5. The scoreboard learns which pattern won.
    expect(t.lab.info().scoreboard).toEqual([
      { pattern: "name-reaction", label: "Streamer name + big reaction", tests: 1, wins: 1, avgViewsPerHour: 997 },
      { pattern: "question", label: "A question", tests: 1, wins: 0, avgViewsPerHour: 200 },
      { pattern: "other", label: "Other", tests: 1, wins: 0, avgViewsPerHour: 99 },
    ]);

    // The clip is done: another look posts nothing more.
    await t.lab.tick();
    expect(t.sentTo()).toHaveLength(5);
    expect(t.lab.info().tests).toHaveLength(1);
  });

  it("an experiment clip is tested on burners and never goes to a main account", async () => {
    const t = await setup({ permission: { kind: "experiment", note: "Which hook survives?", campaignUrl: null, cpmRateUsd: null, minViews: null } });
    t.lab.saveSettings({ on: true });
    await t.lab.tick();
    t.render();
    await t.lab.tick();
    expect(t.sentTo().map(t.roleOf)).toEqual(["burner", "burner", "burner"]);
    t.service.viewsFor.set("fake-post-3", 900);
    t.setNow(new Date(T0.getTime() + 2 * 60_000 + 6 * HOUR));
    await t.lab.tick();
    expect(t.sentTo()).toHaveLength(3);
    expect(t.posts.list().every((p) => p.experiment && t.roleOf(p.accountId) === "burner")).toBe(true);
    expect(t.lab.info().tests[0]).toMatchObject({
      status: "done",
      mainPosts: 0,
      note: "C won with 150 views an hour. It stays on the burner accounts: this creator is an experiment, which never goes to a main account.",
    });
    expect(t.lab.info().scoreboard[0]).toMatchObject({ pattern: "question", wins: 1 });
  });

  it("needs two burner accounts on one platform, and says so", async () => {
    const t = await setup({ burners: ["tt-b1", "x-b1"] });
    t.lab.saveSettings({ on: true });
    await t.lab.tick();
    expect(t.lab.info().tests).toEqual([]);
    expect(t.service.published).toEqual([]);
    expect(t.lab.info().note).toBe("The hook lab needs at least 2 burner accounts on one platform, switched on. Mark accounts as Burner in Accounts.");
    // With two, it runs two variants.
    t.setRole("tt-b2", "burner");
    expect(t.lab.info().note).toBeNull();
    await t.lab.tick();
    expect(t.lab.info().tests[0]!.variants.map((v) => v.label)).toEqual(["A", "B"]);
  });

  it("starts nothing for a clip without a permission in force", async () => {
    const t = await setup({ permission: { expiresAt: "2026-11-01T00:00:00.000Z" } });
    t.lab.saveSettings({ on: true });
    await t.lab.tick();
    expect(t.lab.info().tests).toEqual([]);
    expect(t.service.calls.filter((c) => c === "publish")).toEqual([]);
  });

  it("stops, sending nothing, when a variant's account is no longer a burner", async () => {
    const t = await setup();
    t.lab.saveSettings({ on: true });
    await t.lab.tick();
    t.render();
    t.setRole("tt-b3", "main");
    await t.lab.tick();
    expect(t.service.published).toEqual([]);
    expect(t.lab.info().tests[0]).toMatchObject({ status: "stopped", note: "burner.three is no longer a burner account, so the test was stopped. Nothing was sent." });
    t.setNow(new Date(T0.getTime() + 24 * HOUR));
    await t.lab.tick();
    expect(t.service.published).toEqual([]);
  });

  it("a variant that was removed or struck cannot win", async () => {
    const t = await setup();
    t.lab.saveSettings({ on: true });
    await t.lab.tick();
    t.render();
    await t.lab.tick();
    t.service.viewsFor.set("fake-post-1", 600).set("fake-post-2", 6000).set("fake-post-3", 1200);
    t.setNow(new Date(T0.getTime() + 7 * HOUR));
    await t.publisher.refresh();
    const removed = t.posts.list().find((p) => p.accountId === "tt-b3")!;
    t.posts.setFlag(removed.id, "removal", true);
    await t.lab.tick();
    const [test] = t.lab.info().tests;
    expect(test!.variants.find((v) => v.winner)!.label).toBe("C");
    expect(t.service.published.slice(3).map((i) => i.title)).toEqual([test!.variants[2]!.title, test!.variants[2]!.title]);
  });

  it("never writes or posts a variant that breaks the campaign's rules", async () => {
    const t = await setup({ permission: { rules: { ...NO_CAMPAIGN_RULES, bannedWords: ["believe"] } } });
    t.lab.saveSettings({ on: true });
    await t.lab.tick();
    // The "can't believe" template is passed over for the next pattern.
    expect(t.lab.info().tests[0]!.variants.map((v) => [v.label, v.pattern])).toEqual([["A", "other"], ["B", "question"], ["C", "wait-for-it"]]);
    t.render();
    await t.lab.tick();
    t.service.viewsFor.set("fake-post-2", 6000);
    t.setNow(new Date(T0.getTime() + 7 * HOUR));
    await t.lab.tick();
    expect(t.sentTo()).toHaveLength(5);
    expect(t.service.published.filter((i) => /believe/i.test(`${i.title}\n${i.caption}`))).toEqual([]);
    expect(t.lab.info().tests[0]!.variants.filter((v) => /believe/i.test(`${v.title}\n${v.hook}`))).toEqual([]);
  });

  it("starts no test, and says why, when every other hook would break the campaign's rules", async () => {
    const t = await setup({ permission: { rules: { ...NO_CAMPAIGN_RULES, bannedWords: ["jump"] } } });
    t.lab.saveSettings({ on: true });
    await t.lab.tick();
    await t.lab.tick();
    expect(t.queued).toEqual([]);
    expect(t.service.published).toEqual([]);
    expect(t.lab.info().tests).toHaveLength(1);
    expect(t.lab.info().tests[0]).toMatchObject({
      status: "stopped",
      variants: [],
      note: "Every other hook would break the campaign's rules, so there was nothing to test. Nothing was sent.",
    });
  });

  it("checks the campaign's rules on the variant's own title and hook when it posts", async () => {
    const ban = (t: Awaited<ReturnType<typeof setup>>, word: string) =>
      t.db.prepare("UPDATE permissions SET campaign_rules = ?").run(JSON.stringify({ ...NO_CAMPAIGN_RULES, bannedWords: [word] }));
    // The rules change after the variants were written: B's title now breaks them.
    const t = await setup({ permission: { rules: NO_CAMPAIGN_RULES } });
    t.lab.saveSettings({ on: true });
    await t.lab.tick();
    t.render();
    ban(t, "believe");
    await t.lab.tick();
    expect(t.service.published.map((i) => i.title)).toEqual(["He actually landed the jump"]);
    expect(t.lab.info().tests[0]).toMatchObject({ status: "stopped" });
    expect(t.lab.info().tests[0]!.note).toMatch(/the title says “believe”, which the campaign bans/);
    t.setNow(new Date(T0.getTime() + 24 * HOUR));
    await t.lab.tick();
    expect(t.sentTo()).toEqual(["tt-b1"]);

    // The banned word is only in C's on-screen hook ("Did that really just happen?").
    const u = await setup({ permission: { rules: NO_CAMPAIGN_RULES } });
    u.lab.saveSettings({ on: true });
    await u.lab.tick();
    u.render();
    ban(u, "happen");
    await u.lab.tick();
    expect(u.sentTo()).toEqual(["tt-b1", "tt-b3"]);
    expect(u.lab.info().tests[0]).toMatchObject({ status: "stopped" });
  });

  it("a winner that broke the rules since is not marked as sent to Whop", async () => {
    const t = await setup({ permission: { rules: NO_CAMPAIGN_RULES } });
    t.lab.saveSettings({ on: true });
    await t.lab.tick();
    t.render();
    await t.lab.tick();
    t.service.viewsFor.set("fake-post-2", 6000);
    t.setNow(new Date(T0.getTime() + 7 * HOUR));
    await t.lab.tick();
    const main = t.posts.list().find((p) => p.accountId === "tt-main")!;
    expect(main.caption).toMatch(/can't believe this/);
    t.db.prepare("UPDATE permissions SET campaign_rules = ?").run(JSON.stringify({ ...NO_CAMPAIGN_RULES, bannedWords: ["believe"] }));
    // The clip's own title and hook keep the rules; what was posted does not.
    expect(() => t.publisher.markWhop(main.id, "submitted", true)).toThrow(/Not marked as sent.*“believe”/);
  });

  it("waits while it is switched off, and picks up again when switched on", async () => {
    const t = await setup();
    t.lab.saveSettings({ on: true });
    await t.lab.tick();
    t.render();
    await t.lab.tick();
    t.lab.saveSettings({ on: false });
    t.setNow(new Date(T0.getTime() + 7 * HOUR));
    await t.lab.tick();
    expect(t.sentTo()).toHaveLength(3);
    t.lab.saveSettings({ on: true });
    await t.lab.tick();
    expect(t.sentTo()).toHaveLength(5);
  });
});

describe("hook variants", () => {
  const clip = { title: 'Test Streamer: "no way he landed that"', hook: "no way he landed that", captionWords: [] };

  it("keeps the clip's own hook as A and writes the others from different patterns, the winning ones first", async () => {
    const variants = await writeVariants({ clip, creatorName: "Test Streamer", count: 3, prefer: ["wait-for-it", "quote"], chat: null });
    expect(variants.map((v) => v.pattern)).toEqual(["quote", "wait-for-it", "name-reaction"]);
    expect(variants[0]).toMatchObject({ hook: clip.hook, title: clip.title });
    expect(variants[1]).toEqual({ pattern: "wait-for-it", hook: "Wait for it…", title: "Wait for it: no way he landed that" });
    expect(new Set(variants.map((v) => v.hook)).size).toBe(3);
    expect(new Set(variants.map((v) => v.title)).size).toBe(3);
    for (const v of variants) expect(HOOK_PATTERNS).toContain(v.pattern);
  });

  it("uses the AI writer's lines when they are usable, and its own when they are not (a spoiler, a wrong pattern)", async () => {
    const chat = new FakeChatClient(() => ({
      variants: [
        { pattern: "name-reaction", hook: "Test Streamer screams at the landing", title: "Test Streamer screams: the jump nobody lands" },
        { pattern: "question", hook: "He dies at the end?", title: "Spoiler: does he die at the end?" },
      ],
    }));
    const variants = await writeVariants({ clip, creatorName: "Test Streamer", count: 3, prefer: [], chat });
    expect(chat.requests).toHaveLength(1);
    expect(variants[1]).toEqual({ pattern: "name-reaction", hook: "Test Streamer screams at the landing", title: "Test Streamer screams: the jump nobody lands" });
    expect(variants[2]).toEqual({ pattern: "question", hook: "Did that really just happen?", title: "Did Test Streamer really just do this? no way he landed that" });
  });
});
