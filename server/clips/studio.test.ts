import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_LOOK, type BrandTemplate } from "../../shared/studio.js";
import type { Word } from "../../shared/types.js";
import { DEFAULT_EFFECTS } from "../../shared/types.js";
import { campaignInput } from "../../test/helpers.js";
import { createApp } from "../app.js";
import { openDb } from "../db/index.js";
import { JobQueue } from "../jobs/queue.js";
import { PicksRepo } from "../picks/repo.js";
import { FakePostingService } from "../publish/fake.js";
import { Publisher } from "../publish/publisher.js";
import { PostsRepo } from "../publish/repo.js";
import { SourcesRepo } from "../sources/repo.js";
import { TemplatesRepo } from "../studio/templates.js";
import { VodsRepo } from "../vods/repo.js";
import { ClipsRepo } from "./repo.js";
import { scoreBreakdown } from "./studio.js";

const dir = mkdtempSync(join(tmpdir(), "clipfarm-studio-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string) => {
  const p = join(dir, name);
  writeFileSync(p, name);
  return p;
};

// 30 s of speech: "no way" shouted at the start, filler in the middle.
const WORDS: Word[] = Array.from({ length: 60 }, (_, i) => ({
  word: i === 0 ? "NO" : i === 1 ? "WAY!" : i === 20 ? "um" : `word${i}`,
  startSec: i * 0.5,
  endSec: i * 0.5 + 0.4,
}));

function setup(brief = "Clips 20-60 s, credit the streamer.") {
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db);
  const clips = new ClipsRepo(db);
  const posts = new PostsRepo(db);
  const templates = new TemplatesRepo(db);
  const publisher = new Publisher({ sources, clips, posts, service: new FakePostingService() });
  const queue = new JobQueue(db, { handlers: { "render-clip": async () => {} } });
  queue.stop();
  const app = createApp({ sources, vods: new VodsRepo(db), picks: new PicksRepo(db), queue, clips, posts, publisher, templates });
  const source = sources.create(campaignInput({ briefRules: brief }));
  const clip = clips.create({
    sourceId: source.id,
    vodId: null,
    title: "He landed it",
    hook: "Wait for it",
    filePath: file(`orig-${Math.random()}.mp4`),
    durationSec: 30,
    captionWords: WORDS,
    startSec: 0,
    endSec: 30,
    score: 82,
  });
  return { db, app, clips, sources, templates, queue, source, clip };
}

const edit = (over: Record<string, unknown> = {}) => ({
  title: "He landed it",
  hook: "NO WAY",
  layout: "center",
  startSec: 0,
  endSec: 30,
  cuts: [{ startSec: 10, endSec: 10.4 }],
  effects: DEFAULT_EFFECTS,
  look: DEFAULT_LOOK,
  ...over,
});

describe("Studio export", () => {
  it("saves the edit list and look, queues one render and keeps the clip as it was as the original version", async () => {
    const { app, clips, queue, clip } = setup();
    const look = { ...DEFAULT_LOOK, watermark: "@gtavimoments", captionStyle: { ...DEFAULT_LOOK.captionStyle, color: "#00FF00", position: "top" } };
    const res = await request(app).post(`/api/clips/${clip.id}/studio`).send(edit({ look }));
    expect(res.status).toBe(202);
    expect(res.body.clip).toMatchObject({ status: "rendering", hook: "NO WAY", cuts: [{ startSec: 10, endSec: 10.4 }], look });
    expect(res.body.job).toMatchObject({ type: "render-clip", clipId: clip.id });
    expect(queue.list().filter((j) => j.type === "render-clip")).toHaveLength(1);
    expect(clips.versions(clip.id)).toMatchObject([{ n: 0, label: "Original", current: true }]);
  });

  it("refuses an edit whose kept length is too short or too long, or an unknown look", async () => {
    const { app, clip } = setup();
    const short = await request(app).post(`/api/clips/${clip.id}/studio`).send(edit({ startSec: 0, endSec: 4, cuts: [{ startSec: 1, endSec: 3 }] }));
    expect(short.status).toBe(400);
    expect(short.body.error).toMatch(/at least 3 seconds/);
    const colour = await request(app)
      .post(`/api/clips/${clip.id}/studio`)
      .send(edit({ look: { ...DEFAULT_LOOK, captionStyle: { ...DEFAULT_LOOK.captionStyle, color: "red" } } }));
    expect(colour.status).toBe(400);
    expect(colour.body.error).toMatch(/colour/);
  });

  it("each render is kept as a version; Revert to original brings back the first file and its edit, with no new render", async () => {
    const { app, clips, clip } = setup();
    const original = clips.filePath(clip.id);
    await request(app).post(`/api/clips/${clip.id}/studio`).send(edit()).expect(202);
    const v1 = file("v1.mp4");
    clips.setRendered(clip.id, v1, 29.6, null);
    await request(app).post(`/api/clips/${clip.id}/studio`).send(edit({ cuts: [] , hook: "SECOND" })).expect(202);
    const v2 = file("v2.mp4");
    clips.setRendered(clip.id, v2, 30, null);
    // Every export is kept on disk.
    expect([original, v1, v2].every(existsSync)).toBe(true);
    const versions = (await request(app).get(`/api/clips/${clip.id}/versions`)).body;
    expect(versions.map((v: { n: number; current: boolean }) => [v.n, v.current])).toEqual([[2, true], [1, false], [0, false]]);

    const res = await request(app).post(`/api/clips/${clip.id}/revert`).expect(200);
    expect(res.body).toMatchObject({ status: "pending", hook: "Wait for it", cuts: [], durationSec: 30 });
    expect(clips.filePath(clip.id)).toBe(original);
    // Back to version 1: its cut and hook come back with its file.
    const one = versions.find((v: { n: number }) => v.n === 1);
    const back = await request(app).post(`/api/clips/${clip.id}/versions/${one.id}/restore`).expect(200);
    expect(back.body).toMatchObject({ hook: "NO WAY", cuts: [{ startSec: 10, endSec: 10.4 }], durationSec: 29.6 });
    expect(clips.filePath(clip.id)).toBe(v1);
  });

  it("splits a clip in two at a word gap: the second part becomes a new clip and both are remade", async () => {
    const { app, clips, queue, clip } = setup();
    const res = await request(app).post(`/api/clips/${clip.id}/split`).send({ ...edit({ cuts: [{ startSec: 20, endSec: 20.3 }] }), atSec: 14.1 });
    expect(res.status).toBe(202);
    const [a, b] = res.body.clips;
    // The gap between the word at 13.5–13.9 and the one at 14.0: its middle is 13.95.
    expect(a).toMatchObject({ id: clip.id, startSec: 0, endSec: 13.95, cuts: [], status: "rendering" });
    expect(b).toMatchObject({ startSec: 13.95, endSec: 30, cuts: [{ startSec: 20, endSec: 20.3 }], status: "rendering", sourceId: clip.sourceId });
    expect(b.title).toBe("He landed it (part 2)");
    expect(clips.masterPath(b.id)).toBe(clips.masterPath(clip.id));
    expect(queue.list().filter((j) => j.type === "render-clip").map((j) => j.clipId).sort()).toEqual([a.id, b.id].sort());
  });

  it("refuses to change a posted clip", async () => {
    const { app, clip, db, source } = setup();
    db.prepare("INSERT INTO posts (clip_id, permission_id, account_id, account_name, service, platform, status, caption, scheduled_at, created_at) VALUES (?, ?, 'tt-1', 'TT', 'fake', 'tiktok', 'posted', '', '2026-11-14', ?)").run(
      clip.id,
      source.permissions[0]!.id,
      new Date().toISOString(),
    );
    const res = await request(app).post(`/api/clips/${clip.id}/studio`).send(edit());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already posted/);
  });
});

describe("Studio screen info", () => {
  it("gives the clip, why it was picked, the AI gate, templates and versions", async () => {
    const { app, clip, templates } = setup();
    templates.create({ name: "Main", accountIds: ["yt-1"], layout: null, captionStyle: DEFAULT_LOOK.captionStyle, watermark: "", outro: "", effects: DEFAULT_EFFECTS, hashtags: ["#gta6"] });
    const res = await request(app).get(`/api/clips/${clip.id}/studio`).expect(200);
    expect(res.body.clip.id).toBe(clip.id);
    expect(res.body.breakdown.map((p: { key: string }) => p.key)).toEqual(["hook", "payoff", "energy", "chat", "length"]);
    expect(res.body.ai.banned).toBe(false);
    expect(res.body.templates).toHaveLength(1);
    expect(res.body.versions).toEqual([]);
  });

  it("turns AI off when the clip's campaign bans AI content, and AI thumbnails are made as plain frames", async () => {
    const { app, clip } = setup("Original content only. No AI content, one strike and you're out.");
    const res = await request(app).get(`/api/clips/${clip.id}/studio`).expect(200);
    expect(res.body.ai).toMatchObject({ banned: true, elements: { hook: { allowed: false }, thumbnails: { allowed: false }, voice: { allowed: false } } });
    const ideas = await request(app).post(`/api/clips/${clip.id}/hook-ideas`).send({ ai: true });
    expect(ideas.status).toBe(400);
    expect(ideas.body.error).toMatch(/bans AI/);
    // Hook ideas without AI still work.
    const plain = await request(app).post(`/api/clips/${clip.id}/hook-ideas`).send({ ai: false }).expect(200);
    expect(plain.body.length).toBeGreaterThan(0);
  });
});

describe("why this clip", () => {
  it("scores the hook, payoff, energy and length from the words; chat is not measured without chat logs", () => {
    const parts = scoreBreakdown({ captionWords: WORDS, startSec: 0, endSec: 30, cuts: [] });
    const by = Object.fromEntries(parts.map((p) => [p.key, p]));
    expect(by.hook!.value).toBeGreaterThanOrEqual(70); // opens on a shout
    expect(by.length!.value).toBe(100); // 30 s is in the 20–35 s sweet spot
    expect(by.chat!.value).toBeNull();
    expect(by.chat!.note).toMatch(/not measured/i);
    const long = scoreBreakdown({ captionWords: WORDS, startSec: 0, endSec: 59, cuts: [] });
    expect(long.find((p) => p.key === "length")!.value).toBeLessThan(60);
    // A quiet opening scores a weaker hook.
    const quiet = scoreBreakdown({ captionWords: WORDS, startSec: 5, endSec: 30, cuts: [] });
    expect(quiet.find((p) => p.key === "hook")!.value).toBeLessThan(by.hook!.value!);
  });
});

describe("brand templates in Settings", () => {
  const body: Omit<BrandTemplate, "id"> = {
    name: "GTA VI moments",
    accountIds: ["yt-1"],
    layout: "center",
    captionStyle: { ...DEFAULT_LOOK.captionStyle, font: "DejaVu Serif", size: 96 },
    watermark: "@gtavimoments",
    outro: "Follow for more",
    effects: DEFAULT_EFFECTS,
    hashtags: ["#gta6", "gtavi"],
  };

  it("adds, edits and removes a template; hashtags get their #", async () => {
    const { app } = setup();
    const made = await request(app).post("/api/templates").send(body).expect(201);
    expect(made.body).toMatchObject({ name: "GTA VI moments", hashtags: ["#gta6", "#gtavi"] });
    const put = await request(app).put(`/api/templates/${made.body.id}`).send({ ...body, name: "Main channel" }).expect(200);
    expect(put.body.name).toBe("Main channel");
    expect((await request(app).get("/api/templates")).body).toHaveLength(1);
    await request(app).delete(`/api/templates/${made.body.id}`).expect(204);
    expect((await request(app).get("/api/templates")).body).toEqual([]);
  });

  it("an account belongs to one template at most", async () => {
    const { app } = setup();
    await request(app).post("/api/templates").send(body).expect(201);
    const res = await request(app).post("/api/templates").send({ ...body, name: "Other" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already uses/);
  });

  it("refuses a template without a name or with a bad size", async () => {
    const { app } = setup();
    expect((await request(app).post("/api/templates").send({ ...body, name: " " })).body.error).toMatch(/name/);
    expect((await request(app).post("/api/templates").send({ ...body, captionStyle: { ...body.captionStyle, size: 400 } })).body.error).toMatch(/size/);
  });
});
