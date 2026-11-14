import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { accountsAllowedFor } from "../../shared/routing.js";
import type { AccountChoice, ChannelAccount, NewSourceInput, Permission, PostingAccount, Source, Vod } from "../../shared/types.js";
import { PLATFORMS } from "../../shared/types.js";
import type { Upload, WorkspaceSummary } from "../../shared/creator.js";
import { campaignInput } from "../../test/helpers.js";
import { AccountStatsStore } from "../accounts/stats.js";
import { createApp } from "../app.js";
import { ClipsRepo } from "../clips/repo.js";
import { openDb } from "../db/index.js";
import { JobQueue } from "../jobs/queue.js";
import { PicksRepo } from "../picks/repo.js";
import { assertCanPost } from "../publish/gate.js";
import { FakePostingService } from "../publish/fake.js";
import { Publisher } from "../publish/publisher.js";
import { PostsRepo } from "../publish/repo.js";
import { AI_BAN } from "../sources/campaign/extract.js";
import { aiAllowed, PermissionError } from "../sources/permission.js";
import { parsePermission, SourcesRepo } from "../sources/repo.js";
import { matchVod } from "../sources/watchlist/match.js";
import { WatchlistRepo } from "../sources/watchlist/repo.js";
import { VodsRepo } from "../vods/repo.js";
import { WorkspacesRepo } from "../workspaces/repo.js";
import { classifyLink, fakeFeedFetcher, parseFeed } from "./links.js";
import { OutputsRepo } from "./outputs.js";
import { Creator } from "./service.js";
import { parseNewUpload, uploadUrl, UploadsRepo } from "./uploads.js";

const dir = mkdtempSync(join(tmpdir(), "clipfarm-creator-"));
const videoPath = join(dir, "clip.mp4");
writeFileSync(videoPath, "not really a video");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const NOW = new Date("2026-11-19T12:00:00.000Z");
const ME = "yt-me";
const CLIENT = "yt-client";
const CHANNELS: PostingAccount[] = [
  { id: ME, platform: "youtube", name: "my.channel", disabled: false },
  { id: CLIENT, platform: "youtube", name: "client.channel", disabled: false },
];

const own = (overrides: Partial<NewSourceInput["permission"]> = {}): NewSourceInput => ({
  creatorName: "My Show",
  channelUrls: [],
  permission: { kind: "own-content", allowedPlatforms: [...PLATFORMS], ownerName: "Me", attestedAt: NOW.toISOString(), ...overrides },
});

let feedXml = "";
function setup() {
  const clock = () => NOW;
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db, clock);
  const vods = new VodsRepo(db, clock);
  const clips = new ClipsRepo(db, clock);
  const posts = new PostsRepo(db, clock);
  const service = new FakePostingService(CHANNELS);
  const publisher = new Publisher({ sources, clips, posts, service, now: clock });
  const accountStats = new AccountStatsStore(db, service, posts, { now: clock, accounts: publisher.accounts });
  // Stopped: jobs are only queued here, never run.
  const queue = new JobQueue(db, { handlers: { ingest: async () => undefined } });
  queue.stop();
  const workspaces = new WorkspacesRepo(db, clock);
  const uploads = new UploadsRepo(db, join(dir, `uploads-${Math.random().toString(36).slice(2)}`), clock);
  const watchRepo = new WatchlistRepo(db, sources, clock);
  const polled: number[] = [];
  const creator = new Creator({ sources, vods, queue, uploads, readFeed: async () => feedXml, watchlist: watchRepo, pollCreator: (id) => polled.push(id), now: clock });
  const app = createApp({
    sources,
    vods,
    picks: new PicksRepo(db),
    queue,
    clips,
    posts,
    publisher,
    accountStats,
    workspaces,
    creator: { service: creator, uploads, outputs: new OutputsRepo(db, clock) },
    watchlist: { repo: watchRepo, poller: { status: () => [], lastPollAt: null } as never },
  });
  const clipOf = (source: Source) => {
    const clip = clips.create({ sourceId: source.id, vodId: null, title: `${source.creatorName} moment`, filePath: videoPath, durationSec: 24 });
    clips.setStatus(clip.id, "approved");
    return clip;
  };
  const offered = async (clipId: number, ws = 1) =>
    ((await request(app).get(`/api/clips/${clipId}/accounts`).set("x-workspace", String(ws)).expect(200)).body as AccountChoice[]).map((c) => [c.account.id, c.canPost, c.note]);
  return { db, app, sources, vods, clips, queue, service, workspaces, uploads, watchRepo, creator, polled, clipOf, offered };
}

describe("own-content permission and the publish guard", () => {
  const perm = (p: Partial<Permission>): Permission => ({
    id: 1, sourceId: 1, kind: "own-content", campaignUrl: null, briefRules: "", note: "", cpmRateUsd: null, minViews: null,
    allowedPlatforms: ["youtube"], expiresAt: null, proofUrl: null, proofQuote: null, proofCheckedAt: null, reviewReason: null,
    rules: null, campaignCheckedAt: null, createdAt: NOW.toISOString(), ownerName: "Me", attestedAt: NOW.toISOString(), ...p,
  });
  const post = (permissions: Permission[]) =>
    assertCanPost({ clipStatus: "approved", creatorName: "My Show", permissions, targets: [{ platform: "youtube", role: "main" }], now: NOW });

  it("an own-content record with its owner and dated tick lets a clip post", () => {
    expect(post([perm({})])).toEqual([perm({})]);
  });

  it("a missing attestation (or owner) blocks posting, in plain words", () => {
    expect(() => post([perm({ attestedAt: null })])).toThrow(PermissionError);
    expect(() => post([perm({ attestedAt: null })])).toThrow(/Confirm that My Show's videos are yours/);
    expect(() => post([perm({ ownerName: " " })])).toThrow(PermissionError);
    // Another record in force still covers the post.
    expect(post([perm({ attestedAt: null }), perm({ id: 2, kind: "direct-permission" })])[0]!.id).toBe(2);
  });

  it("parses the owner and dates the tick; no tick leaves it undated, a tick without an owner is refused", () => {
    expect(parsePermission({ kind: "own-content", allowedPlatforms: ["youtube"], ownerName: " Me ", attested: true }, NOW)).toMatchObject({ ownerName: "Me", attestedAt: NOW.toISOString() });
    expect(parsePermission({ kind: "own-content", allowedPlatforms: ["youtube"], ownerName: "Me" }, NOW)).toMatchObject({ attestedAt: null });
    expect(() => parsePermission({ kind: "own-content", allowedPlatforms: ["youtube"], attested: true }, NOW)).toThrow("Say who owns the videos.");
    // Other kinds carry no owner.
    expect(parsePermission({ kind: "direct-permission", allowedPlatforms: ["youtube"], ownerName: "x", attested: true }, NOW)).toMatchObject({ ownerName: null, attestedAt: null });
  });

  it("through the API: not offered and not posted until 'I own these videos' is ticked", async () => {
    const t = setup();
    await request(t.app).post("/api/accounts/sync").expect(200);
    const source = t.sources.create(own({ attestedAt: null }));
    const clip = t.clipOf(source);
    expect((await t.offered(clip.id)).find(([id]) => id === ME)).toEqual([ME, false, "Confirm the videos are yours first (tick “I own these videos” in Creator)"]);
    const refused = await request(t.app).post(`/api/clips/${clip.id}/posts`).send({ accountIds: [ME] });
    expect(refused.status).toBe(403);
    expect(t.service.calls).not.toContain("publish");

    const attested = (await request(t.app).post(`/api/permissions/${source.permissions[0]!.id}/attest`).send({ ownerName: "Me" }).expect(200)).body as Source;
    expect(attested.permissions[0]).toMatchObject({ ownerName: "Me", attestedAt: NOW.toISOString() });
    const sent = (await request(t.app).post(`/api/clips/${clip.id}/posts`).send({ accountIds: [ME] }).expect(201)).body;
    expect(sent.posts.map((p: { accountId: string }) => p.accountId)).toEqual([ME]);
  });
});

describe("AI follows each source's rules", () => {
  it("is on for own content and off while a campaign that bans AI is in force", () => {
    const t = setup();
    expect(t.sources.create(own()).aiAllowed).toBe(true);
    const banned = t.sources.create(campaignInput({ rules: { requiredTags: [], requiredLinks: [], requiredText: [], bannedWords: [], minSec: null, maxSec: null, budgetLeftUsd: null, manualSubmit: true, aiBanned: true } }));
    expect(banned.aiAllowed).toBe(false);
    expect(aiAllowed(banned.permissions.map((p) => ({ ...p, expiresAt: "2026-01-01T00:00:00.000Z" })), NOW)).toBe(true);
  });

  it("reads an AI ban from a campaign page's rules", () => {
    for (const line of ["No AI content.", "AI-generated clips are not allowed", "Strictly prohibited: AI voices"]) expect(AI_BAN.test(line)).toBe(true);
    for (const line of ["Original content only", "Tag @tjr in the caption", "Say hi"]) expect(AI_BAN.test(line)).toBe(false);
  });
});

describe("workspaces", () => {
  it("starts with Me, adds clients, and refuses an empty or taken name", async () => {
    const t = setup();
    await request(t.app).post("/api/workspaces").send({ name: "Client A" }).expect(201);
    expect((await request(t.app).post("/api/workspaces").send({ name: "client a" })).status).toBe(400);
    expect((await request(t.app).post("/api/workspaces").send({ name: " " })).status).toBe(400);
    const list = (await request(t.app).get("/api/workspaces").expect(200)).body as WorkspaceSummary[];
    expect(list.map((w) => [w.id, w.name])).toEqual([
      [1, "Me"],
      [2, "Client A"],
    ]);
    const saved = await request(t.app).put("/api/workspaces/2").send({ name: "Client A", brand: { handle: "@clienta", color: "#FF0066", callToAction: "" } }).expect(200);
    expect(saved.body.brand).toEqual({ handle: "@clienta", color: "#ff0066", callToAction: "" });
    expect((await request(t.app).put("/api/workspaces/2").send({ name: "Client A", brand: { color: "red" } })).status).toBe(400);
  });

  it("keeps sources, videos and clips in their workspace: no leaks across", async () => {
    const t = setup();
    const client = t.workspaces.create("Client A");
    const mine = (await request(t.app).post("/api/sources").send(own()).expect(201)).body as Source;
    const theirs = (await request(t.app).post("/api/sources").set("x-workspace", String(client.id)).send({ ...own(), creatorName: "Client Show" }).expect(201)).body as Source;
    expect([mine.workspaceId, theirs.workspaceId]).toEqual([1, client.id]);
    t.clipOf(t.sources.get(mine.id));
    t.clipOf(t.sources.get(theirs.id));
    t.vods.create(theirs.id, "https://www.youtube.com/watch?v=abc");

    const names = async (path: string, ws: number) =>
      ((await request(t.app).get(path).set("x-workspace", String(ws)).expect(200)).body as { sourceId?: number; creatorName?: string; id: number }[]).map((x) => x.creatorName ?? x.sourceId);
    expect(await names("/api/sources", 1)).toEqual(["My Show"]);
    expect(await names("/api/sources", client.id)).toEqual(["Client Show"]);
    expect(await names("/api/clips", 1)).toEqual([mine.id]);
    expect(await names("/api/clips", client.id)).toEqual([theirs.id]);
    expect(await names("/api/vods", 1)).toEqual([]);
    expect(await names("/api/vods", client.id)).toEqual([theirs.id]);
    // A workspace that does not exist (or none named) is Me.
    expect(await names("/api/sources", 99)).toEqual(["My Show"]);
    expect(t.workspaces.stats(client.id)).toMatchObject({ sources: 1, videos: 1, clipsApproved: 1 });
  });

  it("a workspace's clips post only to its own accounts", async () => {
    const t = setup();
    const client = t.workspaces.create("Client A");
    await request(t.app).post("/api/accounts/sync").expect(200);
    await request(t.app).put(`/api/accounts/${CLIENT}/workspace`).send({ workspaceId: client.id }).expect(200);
    const mine = t.clipOf(t.sources.create(own()));
    const theirs = t.clipOf(t.sources.create({ ...own(), creatorName: "Client Show" }, client.id));

    expect(await t.offered(theirs.id, client.id)).toEqual([
      [CLIENT, true, null],
      [ME, false, "Belongs to another workspace"],
    ]);
    expect(await t.offered(mine.id)).toEqual([
      [CLIENT, false, "Belongs to another workspace"],
      [ME, true, null],
    ]);
    const sent = (await request(t.app).post(`/api/clips/${theirs.id}/posts`).send({ accountIds: [ME, CLIENT] }).expect(201)).body;
    expect(sent.posts.map((p: { accountId: string }) => p.accountId)).toEqual([CLIENT]);
    expect(sent.skipped[0].reason).toBe("my.channel belongs to another workspace, so nothing was sent to it.");
    expect(t.service.published.map((i) => i.account.id)).toEqual([CLIENT]);

    // The account cards follow the workspace too.
    const cards = async (ws: number) => ((await request(t.app).get("/api/accounts").set("x-workspace", String(ws)).expect(200)).body.cards as { accountId: string }[]).map((c) => c.accountId);
    expect(await cards(1)).toEqual([ME]);
    expect(await cards(client.id)).toEqual([CLIENT]);
  });

  it("routing never offers another workspace's account", () => {
    const account = (id: string, workspaceId: number) => ({ id, platform: "youtube", name: id, enabled: true, disabled: false, role: "main", takes: ["own-content"], pinnedCampaignIds: [], workspaceId }) as unknown as ChannelAccount;
    const p = { kind: "own-content", allowedPlatforms: ["youtube"], id: 1, workspaceId: 2 } as Permission;
    expect(accountsAllowedFor(p, [account("a", 1), account("b", 2)]).map((a) => a.id)).toEqual(["b"]);
  });
});

describe("creator links", () => {
  it("sorts videos, channels, feeds and shared files", () => {
    const kind = (u: string) => {
      const l = classifyLink(u);
      return [l.kind, l.channel?.handle ?? null];
    };
    expect(kind("https://www.youtube.com/watch?v=abc")).toEqual(["youtube-video", null]);
    expect(kind("https://youtu.be/abc")).toEqual(["youtube-video", null]);
    expect(kind("https://www.youtube.com/@MyShow")).toEqual(["youtube-channel", "MyShow"]);
    expect(kind("https://www.twitch.tv/videos/123")).toEqual(["twitch-vod", null]);
    expect(kind("https://www.twitch.tv/myshow")).toEqual(["twitch-channel", "myshow"]);
    expect(kind("https://kick.com/myshow/videos/0a1b")).toEqual(["kick-vod", null]);
    expect(kind("https://kick.com/myshow")).toEqual(["kick-channel", "myshow"]);
    expect(kind("https://feeds.example.com/show")).toEqual(["podcast-feed", null]);
    expect(kind("https://example.com/podcast.rss")).toEqual(["podcast-feed", null]);
    expect(kind("https://cdn.example.com/talk.mp4")).toEqual(["file", null]);
    expect(classifyLink("https://www.dropbox.com/s/x/ep.mp4?dl=0").url).toBe("https://www.dropbox.com/s/x/ep.mp4?dl=1");
    expect(classifyLink("https://drive.google.com/file/d/FILE123/view?usp=sharing").url).toBe("https://drive.google.com/uc?export=download&id=FILE123");
  });

  it("refuses what it cannot use, in plain words", () => {
    expect(() => classifyLink("ftp://x")).toThrow(/Paste a link/);
    expect(() => classifyLink("https://www.youtube.com/channel/UC123")).toThrow(/@name link/);
    expect(() => classifyLink("https://drive.google.com/drive/folders")).toThrow(/share link/);
  });

  it("reads a podcast feed's episodes, newest first", async () => {
    const feed = parseFeed(await fakeFeedFetcher("https://feeds.example.com/show/"));
    expect(feed.title).toBe("Demo podcast");
    expect(feed.episodes.map((e) => [e.title, e.url])).toEqual([
      ["Episode 2: the big one", "https://feeds.example.com/show/episode-2.mp3"],
      ["Episode 1", "https://feeds.example.com/show/episode-1.mp3"],
    ]);
    expect(parseFeed("<rss><channel><item><title>No file</title></item></channel></rss>").episodes).toEqual([]);
  });

  it("watches every video of your own channel, whatever the game", () => {
    expect(matchVod({ title: "Cooking stream", category: "Just Chatting" }, ["*"])).toEqual({ matched: true, game: "any video" });
  });
});

describe("resumable uploads", () => {
  it("takes the file in pieces and tells a dropped phone where to carry on", async () => {
    const t = setup();
    const data = Buffer.from("0123456789abcdefghij");
    const created = (await request(t.app).post("/api/uploads").send({ fileName: "Episode 1.mp4", sizeBytes: data.length }).expect(201)).body as Upload;
    const put = (offset: number, chunk: Buffer) => request(t.app).put(`/api/uploads/${created.id}?offset=${offset}`).set("Content-Type", "application/octet-stream").send(chunk);
    expect((await put(0, data.subarray(0, 8)).expect(200)).body).toMatchObject({ receivedBytes: 8, status: "receiving" });
    // The connection dropped and the phone sends a piece from the wrong place: it is told where to resume.
    expect((await put(12, data.subarray(12))).status).toBe(409);
    expect((await request(t.app).get(`/api/uploads/${created.id}`).expect(200)).body.receivedBytes).toBe(8);
    expect((await put(8, data.subarray(8)).expect(200)).body).toMatchObject({ receivedBytes: 20, status: "done" });
    expect(readFileSync(t.uploads.file(created.id).path)).toEqual(data);
  });

  it("refuses files that are not video or audio, empty or too big", () => {
    expect(() => parseNewUpload({ fileName: "notes.pdf", sizeBytes: 10 })).toThrow(/not a video or audio file/);
    expect(() => parseNewUpload({ fileName: "a.mp4", sizeBytes: 0 })).toThrow(/empty/);
    expect(() => parseNewUpload({ fileName: "a.mp4", sizeBytes: 30 * 1024 ** 3 })).toThrow(/20 GB/);
    expect(parseNewUpload({ fileName: " Talk.MOV ", sizeBytes: 5 })).toEqual({ fileName: "Talk.MOV", sizeBytes: 5 });
  });
});

describe("Add your video", () => {
  const add = (t: ReturnType<typeof setup>, body: object, ws = 1) => request(t.app).post("/api/creator").set("x-workspace", String(ws)).send({ name: "My Show", ownerName: "Me", attested: true, ...body });

  it("an upload becomes a video of a new own-content creator, queued for clips", async () => {
    const t = setup();
    const u = await t.uploads.create(1, { fileName: "ep.mp4", sizeBytes: 3 });
    await t.uploads.append(u.id, 0, Buffer.from("abc"));
    const res = (await add(t, { uploadId: u.id }).expect(201)).body as { source: Source; vods: Vod[] };
    expect(res.source.permissions[0]).toMatchObject({ kind: "own-content", ownerName: "Me", attestedAt: NOW.toISOString(), allowedPlatforms: [...PLATFORMS] });
    expect(res.vods.map((v) => v.url)).toEqual([uploadUrl(u.id)]);
    expect(t.queue.list().map((j) => [j.type, j.vodId])).toEqual([["ingest", res.vods[0]!.id]]);
    expect(t.uploads.get(u.id).vodId).toBe(res.vods[0]!.id);
  });

  it("refuses without the tick, an unfinished upload, or another workspace's upload", async () => {
    const t = setup();
    expect((await add(t, { attested: false, link: "https://youtu.be/x" })).body.error).toBe("Tick “I own these videos, or have the owner's OK” first.");
    const half = await t.uploads.create(1, { fileName: "ep.mp4", sizeBytes: 3 });
    expect((await add(t, { uploadId: half.id })).body.error).toBe("ep.mp4 has not finished uploading.");
    const client = t.workspaces.create("Client A");
    await t.uploads.append(half.id, 0, Buffer.from("abc"));
    expect((await add(t, { uploadId: half.id }, client.id)).body.error).toBe("That upload belongs to another workspace.");
    expect(t.sources.list()).toEqual([]);
    expect(t.queue.list()).toEqual([]);
  });

  it("a video link is clipped now; a channel link is watched, in the right workspace, every new video", async () => {
    const t = setup();
    const client = t.workspaces.create("Client A");
    const video = (await add(t, { link: "https://www.youtube.com/watch?v=abc" }).expect(201)).body as { vods: Vod[] };
    expect(video.vods.map((v) => v.url)).toEqual(["https://www.youtube.com/watch?v=abc"]);

    const watched = (await add(t, { name: "Client Show", link: "https://www.twitch.tv/clientshow" }, client.id).expect(201)).body;
    expect(watched.watching).toMatchObject({ name: "Client Show", channels: [{ platform: "twitch", handle: "clientshow" }], games: ["*"], autoIngest: true, permissionState: "active", workspaceId: client.id });
    expect(t.polled).toEqual([watched.watching.id]);
    const list = async (ws: number) => ((await request(t.app).get("/api/watchlist").set("x-workspace", String(ws)).expect(200)).body.creators as { name: string }[]).map((c) => c.name);
    expect(await list(client.id)).toEqual(["Client Show"]);
    expect(await list(1)).toEqual([]);
  });

  it("a podcast feed queues its newest episode now and later episodes as they come out", async () => {
    const t = setup();
    feedXml = `<rss><channel><title>My Pod</title>
      <item><title>Ep 1</title><enclosure url="https://cdn.example.com/ep1.mp3"/><pubDate>Mon, 16 Nov 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
    const res = (await add(t, { link: "https://feeds.example.com/mypod" }).expect(201)).body;
    expect(res.feedTitle).toBe("My Pod");
    expect(res.vods.map((v: Vod) => v.url)).toEqual(["https://cdn.example.com/ep1.mp3"]);
    expect(await t.creator.checkFeeds()).toBe(0);
    feedXml = feedXml.replace("<item>", `<item><title>Ep 2</title><enclosure url="https://cdn.example.com/ep2.mp3"/><pubDate>Fri, 20 Nov 2026 10:00:00 GMT</pubDate></item><item>`);
    expect(await t.creator.checkFeeds()).toBe(1);
    expect(t.vods.list().map((v) => v.url).sort()).toEqual(["https://cdn.example.com/ep1.mp3", "https://cdn.example.com/ep2.mp3"]);
    expect(await t.creator.checkFeeds()).toBe(0);
  });
});
