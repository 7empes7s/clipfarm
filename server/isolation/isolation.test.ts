import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChannelAccount, IsolationGroup, IsolationInfo, Post } from "../../shared/types.js";
import { BURNERS_GROUP_ID, MAIN_GROUP_ID, YOUTUBE_DAILY_UNITS } from "../../shared/types.js";
import { fakeAccess } from "../../test/accessToken.js";
import { campaignInput } from "../../test/helpers.js";
import { type FakeProxy, servePlatforms, startProxy } from "../../test/isolationLab.js";
import { createApp } from "../app.js";
import { ClipsRepo } from "../clips/repo.js";
import { openDb } from "../db/index.js";
import { JobQueue } from "../jobs/queue.js";
import { PicksRepo } from "../picks/repo.js";
import { HookLab } from "../hooklab/lab.js";
import { DirectPoster } from "../publish/direct/direct.js";
import { FakePlatforms } from "../publish/direct/fake.js";
import { FakePostingService } from "../publish/fake.js";
import { PostizService } from "../publish/postiz.js";
import { Publisher } from "../publish/publisher.js";
import { PostsRepo } from "../publish/repo.js";
import { openRuntime } from "../runtime.js";
import { buildChecklist } from "../settings/checklist.js";
import { Settings } from "../settings/store.js";
import { parsePermission, SourcesRepo } from "../sources/repo.js";
import { VodsRepo } from "../vods/repo.js";
import { Isolation } from "./isolation.js";
import { maskIp, nextPacificMidnight, pacificDay, parseProxyUrl } from "./rules.js";
import { undiciTransport } from "./net.js";

// Made-up secrets, shaped unlike real ones on purpose (GitHub refuses pushes that look like keys). None of them may ever show up in an answer or a log line.
const SECRETS = {
  mainYoutube: "main-youtube-app-secret-0000a1b2",
  burnerYoutube: "burner-youtube-app-secret-00c3d4",
  burnerTiktok: "tiktokBurnerClientSecret000000e5f6",
  burnerMeta: "metaBurnerAppSecret00000000000g7h8",
  proxyPass: "pr0xyPassw0rd-9z8y",
};
const APPS = {
  mainYoutube: "main-youtube-client-0001",
  burnerYoutube: "burner-youtube-client-0002",
  burnerTiktok: "awburnertiktokkey01",
  burnerMeta: "880000000000001",
};

const dir = mkdtempSync(join(tmpdir(), "clipfarm-isolation-"));
const videoPath = join(dir, "clip.mp4");
writeFileSync(videoPath, Buffer.alloc(4096, 7));

const fake = new FakePlatforms();
let proxy: FakeProxy;
let otherProxy: FakeProxy;
let platforms: { close(): Promise<void> };
const transport = undiciTransport();

beforeAll(async () => {
  proxy = await startProxy({ user: "clipfarm", pass: SECRETS.proxyPass });
  otherProxy = await startProxy();
  platforms = await servePlatforms(fake, () => [proxy, otherProxy]);
});
afterEach(() => {
  fake.reset();
  proxy.connects.length = 0;
  otherProxy.connects.length = 0;
  vi.restoreAllMocks();
});
afterAll(async () => {
  await transport.close();
  await platforms.close();
  await proxy.close();
  await otherProxy.close();
  rmSync(dir, { recursive: true, force: true });
});

const NOON = new Date("2026-11-19T20:00:00.000Z"); // 12:00 in Los Angeles

function setup(opts: { service?: FakePostingService | PostizService } = {}) {
  let now = NOON;
  const clock = () => now;
  const db = openDb(":memory:");
  const settings = new Settings(null, {}, clock);
  const sources = new SourcesRepo(db, clock);
  const vods = new VodsRepo(db, clock);
  const clips = new ClipsRepo(db, clock);
  const posts = new PostsRepo(db, clock);
  const service = opts.service ?? new FakePostingService([{ id: "postiz-yt", platform: "youtube", name: "Linked in Postiz", disabled: false }]);
  const isolation = new Isolation({ db, settings, transport: transport.fetch, ipEchoUrl: fake.endpoints().ipEcho, publicUrl: "https://clip.example", now: clock });
  const publisher = new Publisher({ sources, clips, posts, service, isolation, now: clock });
  const direct = new DirectPoster({
    isolation,
    accounts: publisher.accounts,
    posts,
    clips,
    sources,
    settings,
    endpoints: fake.endpoints(),
    now: clock,
    sleep: () => Promise.resolve(),
  });
  publisher.useDirect(direct);
  const queue = new JobQueue(db, { handlers: {} });
  queue.stop();
  const app = createApp({ sources, vods, picks: new PicksRepo(db), queue, clips, posts, publisher, isolation: { isolation, direct, demo: false } });

  // Two creators: one with a real permission (main accounts), one experiment (burner accounts only).
  const real = sources.create(campaignInput({ allowedPlatforms: ["tiktok", "youtube", "instagram"] }));
  const experiment = sources.create({
    creatorName: "Big Streamer",
    channelUrls: [],
    permission: parsePermission({ kind: "experiment", note: "What does a claim do?", allowedPlatforms: ["tiktok", "youtube", "instagram"] }, now),
  });
  const newClip = (sourceId: number, title = "He actually landed the jump") => {
    const clip = clips.create({ sourceId, vodId: null, title, filePath: videoPath, durationSec: 24 });
    clips.setStatus(clip.id, "approved");
    return clip;
  };

  const groups = async () => ((await request(app).get("/api/groups").expect(200)).body as IsolationInfo).groups;
  const group = async (id: number) => (await groups()).find((g) => g.id === id)!;
  const setApp = (groupId: number, platform: string, id: string, secret: string) =>
    request(app).put(`/api/groups/${groupId}/apps/${platform}`).send({ id, secret });
  const setProxy = (groupId: number, url: string) => request(app).put(`/api/groups/${groupId}/proxy`).send({ url });
  const testProxy = (groupId: number) => request(app).post(`/api/groups/${groupId}/proxy/test`);
  /** The whole "Connect channel" round trip: our link, then the platform sending the browser back with a code. */
  const connect = async (groupId: number, platform: string, channel: string) => {
    const started = await request(app).post(`/api/groups/${groupId}/connect/${platform}`);
    if (started.status !== 200) return started;
    const state = new URL(started.body.url as string).searchParams.get("state")!;
    return request(app).get(`/oauth/${platform}/callback`).query({ code: channel, state });
  };
  const account = (id: string) => publisher.accounts.list().find((a) => a.id === id) as ChannelAccount | undefined;
  const fastPace = (id: string) => publisher.accounts.update(id, { ...account(id)!, maxPerDay: 50, minGapMinutes: 0 });
  const post = (clipId: number, accountIds: string[], when?: string) => request(app).post(`/api/clips/${clipId}/posts`).send({ accountIds, when });

  /** Burners with a working proxy and a YouTube app; Main with its own YouTube app and no proxy. */
  const ready = async () => {
    await setApp(MAIN_GROUP_ID, "youtube", APPS.mainYoutube, SECRETS.mainYoutube).expect(200);
    await setApp(BURNERS_GROUP_ID, "youtube", APPS.burnerYoutube, SECRETS.burnerYoutube).expect(200);
    await setProxy(BURNERS_GROUP_ID, proxy.url).expect(200);
    expect((await testProxy(BURNERS_GROUP_ID)).body.check).toMatchObject({ ok: true });
    expect((await connect(MAIN_GROUP_ID, "youtube", "mainchan")).status).toBe(302);
    expect((await connect(BURNERS_GROUP_ID, "youtube", "burnerchan")).status).toBe(302);
  };

  return {
    app, db, settings, sources, clips, isolation, direct, publisher, posts, clock, real, experiment, newClip, groups, group, setApp, setProxy, testProxy, connect, account,
    fastPace, post, ready, setNow: (d: Date) => (now = d),
  };
}

const MAIN_YT = "direct-youtube-UC-mainchan";
const BURNER_YT = "direct-youtube-UC-burnerchan";
const paths = (viaProxy: boolean) => fake.calls.filter((c) => c.viaProxy === viaProxy).map((c) => c.path);

describe("isolation groups", () => {
  it("start as Main (no proxy) and Burners (proxy required, so blocked until one works)", async () => {
    const t = setup();
    const [main, burners] = await t.groups();
    expect(main).toMatchObject({ id: MAIN_GROUP_ID, name: "Main", kind: "main", builtIn: true, blocked: null });
    expect(burners).toMatchObject({ id: BURNERS_GROUP_ID, name: "Burners", kind: "burner", builtIn: true });
    expect(burners!.blocked).toBe("No proxy is set. Burner accounts cannot post until one is added and tested.");
    expect(main!.apps.map((a) => [a.platform, a.set, a.redirectUri])).toEqual([
      ["youtube", false, "https://clip.example/oauth/youtube/callback"],
      ["tiktok", false, "https://clip.example/oauth/tiktok/callback"],
      ["instagram", false, "https://clip.example/oauth/instagram/callback"],
    ]);
  });

  it("keep app keys and the proxy password out of every answer", async () => {
    const t = setup();
    const saved = await t.setApp(BURNERS_GROUP_ID, "youtube", APPS.burnerYoutube, SECRETS.burnerYoutube).expect(200);
    const set = await t.setProxy(BURNERS_GROUP_ID, proxy.url).expect(200);
    const burners = (set.body as IsolationInfo).groups.find((g) => g.id === BURNERS_GROUP_ID)!;
    expect(burners.apps[0]).toMatchObject({ platform: "youtube", set: true, idEnding: "0002" });
    expect(burners.proxy).toMatchObject({ set: true, address: new URL(proxy.url).host, signIn: true, check: null });
    for (const body of [saved.text, set.text]) {
      expect(body).not.toContain(SECRETS.burnerYoutube);
      expect(body).not.toContain(SECRETS.proxyPass);
      expect(body).not.toContain(APPS.burnerYoutube);
    }
  });

  it("refuse a proxy address that is not http, https or socks5, without repeating it", async () => {
    const t = setup();
    const res = await t.setProxy(BURNERS_GROUP_ID, `ftp://clipfarm:${SECRETS.proxyPass}@proxy.example:21`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("The proxy address must start with http://, https:// or socks5://, like http://user:password@host:8080.");
    expect(parseProxyUrl("socks5://u:p@proxy.example:1080")).toMatchObject({ address: "proxy.example:1080", signIn: true });
  });

  it("never put a main account in a group with burners (and the other way round)", async () => {
    const t = setup();
    await t.publisher.syncAccounts();
    const res = await request(t.app).put("/api/accounts/postiz-yt/group").send({ groupId: BURNERS_GROUP_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Linked in Postiz is a main account, and “Burners” is a group for burner accounts. A main account never shares a group with burners.");
    expect(t.account("postiz-yt")!.groupId).toBe(MAIN_GROUP_ID);

    // Another main group (a second Google project) takes it; marking it burner moves it to Burners.
    const made = await request(t.app).post("/api/groups").send({ name: "Whop channels", kind: "main" }).expect(201);
    const whop = (made.body as IsolationInfo).groups.find((g) => g.name === "Whop channels")!;
    await request(t.app).put("/api/accounts/postiz-yt/group").send({ groupId: whop.id }).expect(200);
    expect(t.account("postiz-yt")!.groupId).toBe(whop.id);
    t.publisher.accounts.update("postiz-yt", { ...t.account("postiz-yt")!, role: "burner" });
    expect(t.account("postiz-yt")!.groupId).toBe(BURNERS_GROUP_ID);

    // A group with accounts in it, or a built-in one, is not removed.
    expect((await request(t.app).delete(`/api/groups/${BURNERS_GROUP_ID}`)).body.error).toBe("“Burners” is a built-in group and stays.");
    await request(t.app).delete(`/api/groups/${whop.id}`).expect(200);
  });
});

describe("the proxy check", () => {
  it("shows the exit address (masked) and country, and passes when it differs from the server's own", async () => {
    const t = setup();
    await t.setProxy(BURNERS_GROUP_ID, proxy.url).expect(200);
    const res = await t.testProxy(BURNERS_GROUP_ID).expect(200);
    expect(res.body.check).toEqual({ ok: true, message: "Works: traffic leaves from 203.0.113.x (NL).", exitIp: "203.0.113.x", country: "NL", at: NOON.toISOString() });
    expect(res.text).not.toContain(fake.exitIp);
    expect((await t.group(BURNERS_GROUP_ID)).blocked).toBeNull();
    // One call through the proxy, one straight out to learn the server's own address.
    expect(paths(true)).toEqual(["/ip"]);
    expect(paths(false)).toEqual(["/ip"]);
  });

  it("blocks the group when the proxy leaves from the server's own address", async () => {
    const t = setup();
    await t.ready();
    fake.exitIp = fake.ownIp;
    const res = await t.testProxy(BURNERS_GROUP_ID).expect(200);
    const reason = "The proxy sends traffic out from this server's own address (198.51.100.x), so it hides nothing. Use another proxy.";
    expect(res.body.check).toMatchObject({ ok: false, message: reason });
    expect((await t.group(BURNERS_GROUP_ID)).blocked).toBe(reason);

    const before = fake.calls.length;
    const refused = await t.post(t.newClip(t.experiment.id).id, [BURNER_YT]);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe(`Channel burnerchan cannot post: ${reason} Nothing was posted.`);
    expect(fake.calls.length).toBe(before);
  });

  it("blocks the group when the proxy does not answer or refuses the sign-in", async () => {
    const t = setup();
    await t.setProxy(BURNERS_GROUP_ID, proxy.url.replace(SECRETS.proxyPass, "wrong-password-123")).expect(200);
    const res = await t.testProxy(BURNERS_GROUP_ID).expect(200);
    expect(res.body.check.ok).toBe(false);
    expect(res.body.check.message).toMatch(/^The proxy did not let the call through \(.+\)\. Check its address, user name and password\.$/);
    expect(res.text).not.toContain("wrong-password-123");
    expect(paths(true)).toEqual([]);
  });

  it("is run again before a post once it is a day old", async () => {
    const t = setup();
    await t.ready();
    t.fastPace(BURNER_YT);
    t.setNow(new Date(NOON.getTime() + 25 * 3600_000));
    fake.reset();
    const res = await t.post(t.newClip(t.experiment.id).id, [BURNER_YT]).expect(201);
    expect((res.body.posts as Post[])[0]).toMatchObject({ status: "posted" });
    expect(fake.calls.filter((c) => c.path === "/ip").length).toBe(2);
    expect((await t.group(BURNERS_GROUP_ID)).proxy.check!.at).toBe(new Date(NOON.getTime() + 25 * 3600_000).toISOString());
  });
});

describe("posting through a group", () => {
  it("sends a burner's upload through its group's proxy with its group's app, and records the group and exit address", async () => {
    const t = setup();
    await t.ready();
    fake.reset();
    const res = await t.post(t.newClip(t.experiment.id).id, [BURNER_YT]).expect(201);
    const made = (res.body.posts as Post[])[0]!;
    expect(made).toMatchObject({ status: "posted", service: "direct", accountId: BURNER_YT, groupName: "Burners", exitIp: "203.0.113.x", error: null });
    expect(made.url).toMatch(/^https:\/\/www\.youtube\.com\/shorts\/vid-/);

    // Every call left through the proxy, and carried a token the burner app was given.
    expect(fake.calls.length).toBeGreaterThan(0);
    expect(fake.calls.every((c) => c.viaProxy)).toBe(true);
    expect(fake.calls.filter((c) => c.app !== null).map((c) => c.app)).toEqual(expect.arrayContaining([APPS.burnerYoutube]));
    expect(fake.calls.some((c) => c.app === APPS.mainYoutube)).toBe(false);
    expect(fake.uploads).toEqual([expect.objectContaining({ platform: "youtube", channel: "burnerchan", bytes: 4096, title: "He actually landed the jump" })]);
    expect(res.text).not.toContain(fake.exitIp);
  });

  it("never sends a main account's upload through the burner proxy or app", async () => {
    const t = setup();
    await t.ready();
    fake.reset();
    proxy.connects.length = 0;
    const res = await t.post(t.newClip(t.real.id).id, [MAIN_YT]).expect(201);
    expect((res.body.posts as Post[])[0]).toMatchObject({ status: "posted", service: "direct", groupName: "Main", exitIp: "198.51.100.x" });
    expect(fake.calls.length).toBeGreaterThan(0);
    expect(fake.calls.every((c) => !c.viaProxy)).toBe(true);
    expect(fake.calls.some((c) => c.app === APPS.burnerYoutube)).toBe(false);
    expect(proxy.connects).toEqual([]);
    expect(fake.uploads[0]).toMatchObject({ channel: "mainchan" });
  });

  it("keeps a main group's own proxy apart from the burners' proxy", async () => {
    const t = setup();
    await t.ready();
    await t.setProxy(MAIN_GROUP_ID, otherProxy.url).expect(200);
    expect((await t.testProxy(MAIN_GROUP_ID)).body.check).toMatchObject({ ok: true });
    proxy.connects.length = 0;
    otherProxy.connects.length = 0;
    await t.post(t.newClip(t.real.id).id, [MAIN_YT]).expect(201);
    expect(otherProxy.connects.length).toBeGreaterThan(0);
    expect(proxy.connects).toEqual([]);
  });

  it("refuses a burner whose group has no proxy, with the reason, and calls nothing", async () => {
    const t = setup();
    await t.ready();
    await request(t.app).delete(`/api/groups/${BURNERS_GROUP_ID}/proxy`).expect(200);
    fake.reset();
    const res = await t.post(t.newClip(t.experiment.id).id, [BURNER_YT]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "Channel burnerchan cannot post: No proxy is set. Burner accounts cannot post until one is added and tested. Nothing was posted.",
    );
    expect(fake.calls).toEqual([]);
    expect(t.posts.list()).toEqual([]);
    // The picker says so before anything is tapped.
    const choices = (await request(t.app).get(`/api/clips/${t.newClip(t.experiment.id).id}/accounts`).expect(200)).body as { account: ChannelAccount; canPost: boolean; note: string }[];
    expect(choices.find((c) => c.account.id === BURNER_YT)).toMatchObject({ canPost: false, note: "No proxy is set. Burner accounts cannot post until one is added and tested." });
  });

  it("refuses a burner whose proxy stopped working, even though it was fine yesterday", async () => {
    const t = setup();
    await t.ready();
    t.setNow(new Date(NOON.getTime() + 25 * 3600_000));
    await proxy.close();
    try {
      fake.reset();
      const res = await t.post(t.newClip(t.experiment.id).id, [BURNER_YT]);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/^Channel burnerchan cannot post: The proxy did not let the call through /);
      expect(fake.uploads).toEqual([]);
    } finally {
      proxy = await startProxy({ user: "clipfarm", pass: SECRETS.proxyPass });
    }
  });

  it("refuses a burner that is linked in the posting service, which has one address and one app", async () => {
    const service = new PostizService({ url: "http://postiz.invalid", apiKey: "k", fetch: () => Promise.reject(new Error("must not be called")) });
    const t = setup({ service });
    vi.spyOn(service, "listAccounts").mockResolvedValue([{ id: "postiz-tt", platform: "tiktok", name: "gta.testing", disabled: false }]);
    await t.publisher.syncAccounts();
    t.publisher.accounts.update("postiz-tt", { ...t.account("postiz-tt")!, role: "burner" });
    await t.setProxy(BURNERS_GROUP_ID, proxy.url).expect(200);
    await t.testProxy(BURNERS_GROUP_ID).expect(200);
    const res = await t.post(t.newClip(t.experiment.id).id, ["postiz-tt"]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "gta.testing cannot post: It is a burner linked in Postiz, which posts from this server's own address with one shared app. Connect it in Settings, Accounts instead. Nothing was posted.",
    );
  });

  it("posts a main account linked in the posting service as before, with its group on the post", async () => {
    const t = setup();
    const res = await t.post(t.newClip(t.real.id).id, ["postiz-yt"]).expect(201);
    expect((res.body.posts as Post[])[0]).toMatchObject({ status: "posted", service: "fake", groupName: "Main", exitIp: null });
    expect(fake.calls).toEqual([]);
  });

  it("uploads to TikTok and Instagram through the burners' proxy with the burners' apps", async () => {
    const t = setup();
    await t.setProxy(BURNERS_GROUP_ID, proxy.url).expect(200);
    await t.testProxy(BURNERS_GROUP_ID).expect(200);
    await t.setApp(BURNERS_GROUP_ID, "tiktok", APPS.burnerTiktok, SECRETS.burnerTiktok).expect(200);
    await t.setApp(BURNERS_GROUP_ID, "instagram", APPS.burnerMeta, SECRETS.burnerMeta).expect(200);
    expect((await t.connect(BURNERS_GROUP_ID, "tiktok", "ttburner")).status).toBe(302);
    expect((await t.connect(BURNERS_GROUP_ID, "instagram", "igburner")).status).toBe(302);
    fake.reset();
    const made: Post[] = [];
    for (const id of ["direct-tiktok-open-ttburner", "direct-instagram-ig-igburner"]) {
      const res = await t.post(t.newClip(t.experiment.id, `Clip for ${id}`).id, [id]).expect(201);
      made.push((res.body.posts as Post[])[0]!);
    }
    expect(made.map((p) => [p.platform, p.status, p.groupName, p.exitIp])).toEqual([
      ["tiktok", "posted", "Burners", "203.0.113.x"],
      ["instagram", "posted", "Burners", "203.0.113.x"],
    ]);
    expect(made[1]!.url).toBe("https://www.instagram.com/reel/fake-igburner/");
    expect(fake.calls.every((c) => c.viaProxy)).toBe(true);
    expect(fake.uploads.map((u) => [u.platform, u.channel, u.bytes])).toEqual([
      ["tiktok", "ttburner", 4096],
      ["instagram", "igburner", 4096],
    ]);
    expect(new Set(fake.calls.map((c) => c.app).filter(Boolean))).toEqual(new Set([APPS.burnerTiktok, APPS.burnerMeta]));
  });

  it("sends a scheduled direct post when it is due, not before", async () => {
    const t = setup();
    await t.ready();
    fake.reset();
    const due = new Date(NOON.getTime() + 2 * 3600_000);
    const res = await t.post(t.newClip(t.experiment.id).id, [BURNER_YT], due.toISOString()).expect(201);
    expect((res.body.posts as Post[])[0]).toMatchObject({ status: "scheduled", scheduledAt: due.toISOString() });
    expect(await t.direct.runDue()).toBe(0);
    expect(fake.uploads).toEqual([]);
    // A second one waits too, and its account is switched off before it is due: it never goes out.
    const second = await t.post(t.newClip(t.experiment.id, "Second").id, [BURNER_YT], new Date(due.getTime() + 4 * 3600_000).toISOString()).expect(201);
    t.setNow(new Date(due.getTime() + 60_000));
    expect(await t.direct.runDue()).toBe(1);
    t.publisher.accounts.update(BURNER_YT, { ...t.account(BURNER_YT)!, enabled: false });
    t.setNow(new Date(due.getTime() + 5 * 3600_000));
    expect(await t.direct.runDue()).toBe(0);
    expect(t.posts.get((second.body.posts as Post[])[0]!.id)).toMatchObject({ status: "failed", error: "Channel burnerchan is switched off, so this post was not sent." });
    t.setNow(new Date(due.getTime() + 60_000));
    expect(t.posts.list().find((p) => p.clipTitle !== "Second")).toMatchObject({ status: "posted", exitIp: "203.0.113.x" });
    expect(fake.uploads.length).toBe(1);
  });
});

describe("Connect channel (OAuth)", () => {
  it("stores the tokens per account and group, never in an answer, and names the channel", async () => {
    const t = setup();
    await t.ready();
    expect(t.account(MAIN_YT)).toMatchObject({ platform: "youtube", name: "Channel mainchan", role: "main", groupId: MAIN_GROUP_ID, direct: true, disabled: false });
    expect(t.account(BURNER_YT)).toMatchObject({ name: "Channel burnerchan", role: "burner", groupId: BURNERS_GROUP_ID, direct: true });
    // The codes were traded with each group's own app: the burner's through the proxy, the main one straight.
    const trades = fake.calls.filter((c) => c.path === "/google/token");
    expect(trades.map((c) => [c.app, c.viaProxy])).toEqual([[APPS.mainYoutube, false], [APPS.burnerYoutube, true]]);
    expect(t.settings.secret(`account.${BURNER_YT}.refresh`)).toBe(`rt.${APPS.burnerYoutube}.burnerchan`);
    expect(t.settings.secret(`account.${MAIN_YT}.refresh`)).toBe(`rt.${APPS.mainYoutube}.mainchan`);
    const info = await request(t.app).get("/api/groups").expect(200);
    expect(info.text).not.toMatch(/rt\.|at\./);
    expect((info.body as IsolationInfo).lastConnect).toMatchObject({ ok: true, message: "Channel burnerchan is connected to “Burners”." });
    // A sync with the posting service keeps the channels connected here.
    await t.publisher.syncAccounts();
    expect(t.account(BURNER_YT)).toBeDefined();
  });

  it("gives the exact address to send the browser to, with this group's app and our callback", async () => {
    const t = setup();
    await t.ready();
    const res = await request(t.app).post(`/api/groups/${BURNERS_GROUP_ID}/connect/youtube`).expect(200);
    const url = new URL(res.body.url as string);
    expect(`${url.origin}${url.pathname}`).toBe(fake.endpoints().googleAuth);
    expect(url.searchParams.get("client_id")).toBe(APPS.burnerYoutube);
    expect(url.searchParams.get("redirect_uri")).toBe("https://clip.example/oauth/youtube/callback");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(res.text).not.toContain(SECRETS.burnerYoutube);
  });

  it("refreshes an old token through the group's proxy with the group's app", async () => {
    const t = setup();
    await t.ready();
    t.fastPace(BURNER_YT);
    t.fastPace(MAIN_YT);
    t.setNow(new Date(NOON.getTime() + 2 * 3600_000));
    fake.reset();
    await t.post(t.newClip(t.experiment.id).id, [BURNER_YT]).expect(201);
    await t.post(t.newClip(t.real.id).id, [MAIN_YT]).expect(201);
    const refreshes = fake.calls.filter((c) => c.path === "/google/token");
    expect(refreshes.map((c) => [c.app, c.viaProxy, c.grant])).toEqual([
      [APPS.burnerYoutube, true, "refresh_token"],
      [APPS.mainYoutube, false, "refresh_token"],
    ]);
    expect(fake.uploads.map((u) => u.channel)).toEqual(["burnerchan", "mainchan"]);
  });

  it("refuses a made-up or reused state, and a group without app keys or a working proxy", async () => {
    const t = setup();
    const noApp = await request(t.app).post(`/api/groups/${MAIN_GROUP_ID}/connect/youtube`);
    expect(noApp.status).toBe(400);
    expect(noApp.body.error).toBe("Paste the YouTube app keys of “Main” first.");

    await t.setApp(BURNERS_GROUP_ID, "youtube", APPS.burnerYoutube, SECRETS.burnerYoutube).expect(200);
    const noProxy = await request(t.app).post(`/api/groups/${BURNERS_GROUP_ID}/connect/youtube`);
    expect(noProxy.body.error).toBe("“Burners” cannot connect a channel yet: No proxy is set. Burner accounts cannot post until one is added and tested.");

    const bad = await request(t.app).get("/oauth/youtube/callback").query({ code: "x", state: "made-up" }).expect(302);
    expect(bad.headers.location).toBe("/?connect=failed#settings/accounts");
    expect(fake.calls).toEqual([]);

    await t.ready();
    const started = await request(t.app).post(`/api/groups/${MAIN_GROUP_ID}/connect/youtube`).expect(200);
    const state = new URL(started.body.url as string).searchParams.get("state")!;
    await request(t.app).get("/oauth/youtube/callback").query({ code: "mainchan", state }).expect(302);
    const again = await request(t.app).get("/oauth/youtube/callback").query({ code: "mainchan", state }).expect(302);
    expect(again.headers.location).toBe("/?connect=failed#settings/accounts");
  });

  it("does not let a main channel be connected into a burner group", async () => {
    const t = setup();
    await t.ready();
    const res = await t.connect(BURNERS_GROUP_ID, "youtube", "mainchan");
    expect(res.headers.location).toBe("/?connect=failed#settings/accounts");
    expect(t.account(MAIN_YT)).toMatchObject({ role: "main", groupId: MAIN_GROUP_ID });
    expect(((await request(t.app).get("/api/groups")).body as IsolationInfo).lastConnect).toMatchObject({
      ok: false,
      message: "Channel mainchan is a main account, and “Burners” is a group for burner accounts. A main account never shares a group with burners.",
    });
  });

  it("leaves the callback open to the platforms while everything else needs the Access sign-in", async () => {
    const t = setup();
    const access = await fakeAccess();
    const gated = createApp({ ...appDeps(t), access: access.verifier });
    expect((await request(gated).get("/oauth/youtube/callback").query({ code: "x", state: "nope" })).status).toBe(302);
    expect((await request(gated).get("/oauth/youtube/other")).status).toBe(403);
    expect((await request(gated).get("/api/groups")).status).toBe(403);
    expect((await request(gated).post(`/api/groups/${MAIN_GROUP_ID}/connect/youtube`)).status).toBe(403);
  });
});

function appDeps(t: ReturnType<typeof setup>) {
  const db = t.db;
  const queue = new JobQueue(db, { handlers: {} });
  queue.stop();
  return {
    sources: new SourcesRepo(db),
    vods: new VodsRepo(db),
    picks: new PicksRepo(db),
    queue,
    clips: new ClipsRepo(db),
    posts: t.posts,
    publisher: t.publisher,
    isolation: { isolation: t.isolation, direct: t.direct, demo: false },
  };
}

describe("hook variants on channels connected here", () => {
  it("uploads the variant's own video and title, now and when a waiting post is picked up later", async () => {
    const t = setup();
    await t.ready();
    t.fastPace(BURNER_YT);
    fake.reset();
    const variantPath = join(dir, "variant-b.mp4");
    writeFileSync(variantPath, Buffer.alloc(9000, 3));
    const variant = { title: "VARIANT B TITLE", hook: "Wait for it", filePath: variantPath };

    const now = await t.publisher.post(t.newClip(t.experiment.id).id, [BURNER_YT], null, variant);
    expect(now.posts[0]).toMatchObject({ status: "posted", service: "direct" });
    expect(fake.uploads).toEqual([expect.objectContaining({ channel: "burnerchan", title: "VARIANT B TITLE", bytes: 9000 })]);

    const due = new Date(NOON.getTime() + 2 * 3600_000);
    const later = await t.publisher.post(t.newClip(t.experiment.id, "Second").id, [BURNER_YT], due, variant);
    expect(later.posts[0]).toMatchObject({ status: "scheduled" });
    t.setNow(new Date(due.getTime() + 60_000));
    expect(await t.direct.runDue()).toBe(1);
    expect(fake.uploads[1]).toMatchObject({ title: "VARIANT B TITLE", bytes: 9000 });

    // The video is gone by the time the post is due: it fails, the clip's own video is not sent in its place.
    const third = await t.publisher.post(t.newClip(t.experiment.id, "Third").id, [BURNER_YT], new Date(due.getTime() + 2 * 3600_000), variant);
    rmSync(variantPath);
    t.setNow(new Date(due.getTime() + 3 * 3600_000));
    expect(await t.direct.runDue()).toBe(0);
    expect(t.posts.get(third.posts[0]!.id)).toMatchObject({ status: "failed", error: "The video of this hook variant is gone, so this post was not sent." });
    expect(fake.uploads.length).toBe(2);
  });

  it("sends the hook lab's winner to a main channel as the variant, also when it has to wait for the quota", async () => {
    const t = setup();
    await t.ready();
    expect((await t.connect(BURNERS_GROUP_ID, "youtube", "burnertwo")).status).toBe(302);
    const BURNER_TWO = "direct-youtube-UC-burnertwo";
    for (const id of [BURNER_YT, BURNER_TWO, MAIN_YT]) t.fastPace(id);
    const queued: number[] = [];
    const lab = new HookLab({ db: t.db, clips: t.clips, sources: t.sources, posts: t.posts, publisher: t.publisher, enqueueRender: (id) => queued.push(id), now: t.clock });
    lab.saveSettings({ on: true });
    const clip = t.clips.create({ sourceId: t.real.id, vodId: null, title: "He actually landed the jump", hook: "No way", filePath: videoPath, durationSec: 24 });
    t.clips.setStatus(clip.id, "approved");
    fake.reset();

    await lab.tick();
    const [b] = lab.variantsToRender(queued[0]!);
    const variantPath = join(dir, "variant-winner.mp4");
    writeFileSync(variantPath, Buffer.alloc(7000, 5));
    lab.setVariantFile(b!.id, variantPath);
    await lab.tick();
    const variants = lab.info().tests[0]!.variants;
    expect(variants.map((v) => v.label)).toEqual(["A", "B"]);
    // Each burner gets its own variant: A is the clip as approved; B has its own title and video,
    // and goes out a little later (accounts post the same clip some time apart).
    const bPost = t.posts.get(variants[1]!.postId!);
    expect(bPost.status).toBe("scheduled");
    const bAt = new Date(bPost.scheduledAt);
    expect(bAt.getTime()).toBeGreaterThan(NOON.getTime());
    t.setNow(bAt);
    expect(await t.direct.runDue()).toBe(1);
    expect(fake.uploads.map((u) => [u.title, u.bytes])).toEqual([
      ["He actually landed the jump", 4096],
      [variants[1]!.title, 7000],
    ]);

    // B wins while the main app's quota is used up: its post waits, and so does its video.
    t.db.prepare("UPDATE posts SET views = 900 WHERE id = ?").run(bPost.id);
    fake.quotaExceeded = true;
    t.setNow(new Date(bAt.getTime() + 6 * 3600_000 + 60_000));
    await lab.tick();
    // Two main channels: the one connected here, and the one linked in the posting service.
    expect(lab.info().tests[0]).toMatchObject({ status: "done", mainPosts: 2 });
    const waiting = t.posts.list().find((p) => p.accountId === MAIN_YT)!;
    expect(waiting).toMatchObject({ status: "scheduled", scheduledAt: "2026-11-20T08:00:00.000Z" });
    expect(existsSync(variantPath)).toBe(true);

    fake.quotaExceeded = false;
    t.setNow(new Date("2026-11-20T08:00:30.000Z"));
    expect(await t.direct.runDue()).toBe(1);
    expect(fake.uploads[2]).toMatchObject({ channel: "mainchan", title: variants[1]!.title, bytes: 7000 });
    // Sent: the lab tidies the video away on its next look.
    await lab.tick();
    expect(existsSync(variantPath)).toBe(false);
    expect(existsSync(videoPath)).toBe(true);
  });
});

describe("YouTube quota per app", () => {
  it("counts units per group, stops at the limit and goes on after the reset", async () => {
    const t = setup();
    await t.ready();
    t.fastPace(BURNER_YT);
    t.fastPace(MAIN_YT);
    const used = async (id: number) => (await t.group(id)).youtubeQuota;
    // Connecting read each channel once: 1 unit per group.
    expect(await used(BURNERS_GROUP_ID)).toEqual({ used: 1, limit: YOUTUBE_DAILY_UNITS, fullUntil: null });

    // Six uploads fit in 10,000 units (1,600 each); the seventh waits for midnight Pacific time.
    const statuses: Post[] = [];
    for (let i = 1; i <= 7; i++) {
      const res = await t.post(t.newClip(t.experiment.id, `Clip ${i}`).id, [BURNER_YT]).expect(201);
      statuses.push((res.body.posts as Post[])[0]!);
    }
    expect(statuses.slice(0, 6).every((p) => p.status === "posted")).toBe(true);
    const reset = "2026-11-20T08:00:00.000Z";
    expect(statuses[6]).toMatchObject({ status: "scheduled", scheduledAt: reset, note: "YouTube quota full until midnight Pacific time, so it goes out then." });
    expect(fake.uploads.length).toBe(6);
    expect(await used(BURNERS_GROUP_ID)).toEqual({ used: 9601, limit: YOUTUBE_DAILY_UNITS, fullUntil: reset });
    // The other group's app has its own quota.
    expect(await used(MAIN_GROUP_ID)).toEqual({ used: 1, limit: YOUTUBE_DAILY_UNITS, fullUntil: null });
    await t.post(t.newClip(t.real.id).id, [MAIN_YT]).expect(201);
    expect(fake.uploads.length).toBe(7);

    // Nothing more goes out before the reset; after it, the waiting post does.
    t.setNow(new Date("2026-11-20T07:59:00.000Z"));
    expect(await t.direct.runDue()).toBe(0);
    t.setNow(new Date("2026-11-20T08:00:30.000Z"));
    expect(await t.direct.runDue()).toBe(1);
    expect(fake.uploads.length).toBe(8);
    expect(t.posts.get(statuses[6]!.id)).toMatchObject({ status: "posted", note: null });
    expect(await used(BURNERS_GROUP_ID)).toEqual({ used: 1600, limit: YOUTUBE_DAILY_UNITS, fullUntil: null });
  });

  it("moves a due post to the reset when YouTube itself says the quota is used up", async () => {
    const t = setup();
    await t.ready();
    fake.quotaExceeded = true;
    const res = await t.post(t.newClip(t.experiment.id).id, [BURNER_YT]).expect(201);
    expect((res.body.posts as Post[])[0]).toMatchObject({ status: "scheduled", scheduledAt: "2026-11-20T08:00:00.000Z", error: null });
    expect((await t.group(BURNERS_GROUP_ID)).youtubeQuota).toMatchObject({ used: YOUTUBE_DAILY_UNITS, fullUntil: "2026-11-20T08:00:00.000Z" });
  });

  it("uploads a post once when the timer runs while Post now is still sending it", async () => {
    const t = setup();
    await t.ready();
    fake.reset();
    let release!: () => void;
    fake.holdUploads = new Promise<void>((resolve) => (release = resolve));
    const posting = t.post(t.newClip(t.experiment.id).id, [BURNER_YT]).then((res) => res);
    await vi.waitFor(() => expect(fake.calls.some((c) => c.path === "/upload/youtube/v3/videos")).toBe(true));
    expect(await t.direct.runDue()).toBe(0);
    release();
    const res = await posting;
    expect((res.body.posts as Post[])[0]).toMatchObject({ status: "posted" });
    expect(await t.direct.runDue()).toBe(0);
    expect(fake.uploads.length).toBe(1);
    // 1 unit for reading the channel when it was connected, 1,600 for the one upload.
    expect((await t.group(BURNERS_GROUP_ID)).youtubeQuota.used).toBe(1601);
  });

  it("does not upload a post that waited for the quota reset once its permission has run out", async () => {
    const t = setup();
    await t.ready();
    const expiring = t.sources.create({ ...campaignInput({ allowedPlatforms: ["youtube"], expiresAt: "2026-11-20T02:00:00.000Z" }), creatorName: "Short Deal" });
    fake.quotaExceeded = true;
    const res = await t.post(t.newClip(expiring.id).id, [MAIN_YT]).expect(201);
    const waiting = (res.body.posts as Post[])[0]!;
    expect(waiting).toMatchObject({ status: "scheduled", scheduledAt: "2026-11-20T08:00:00.000Z" });
    fake.reset();
    t.setNow(new Date("2026-11-20T08:00:30.000Z"));
    expect(await t.direct.runDue()).toBe(0);
    expect(t.posts.get(waiting.id)).toMatchObject({ status: "failed", error: "The permission for Short Deal expired on 2026-11-20. Add a current campaign first." });
    expect(fake.calls).toEqual([]);
    expect(fake.uploads).toEqual([]);
  });

  it("knows the Pacific day and its midnight, across the clock change", () => {
    expect(pacificDay(new Date("2026-11-20T07:59:59Z"))).toBe("2026-11-19");
    expect(pacificDay(new Date("2026-11-20T08:00:00Z"))).toBe("2026-11-20");
    expect(nextPacificMidnight(new Date("2026-11-19T20:00:00Z")).toISOString()).toBe("2026-11-20T08:00:00.000Z");
    // 1 November 2026: clocks go back in Los Angeles, so that day has 25 hours.
    expect(nextPacificMidnight(new Date("2026-11-01T07:00:00Z")).toISOString()).toBe("2026-11-02T08:00:00.000Z");
    expect(nextPacificMidnight(new Date("2026-03-08T08:00:00Z")).toISOString()).toBe("2026-03-09T07:00:00.000Z");
  });
});

describe("secrets", () => {
  it("never puts an app secret, a token or the proxy password in an answer or a log line", async () => {
    const t = setup();
    const logged: string[] = [];
    for (const level of ["log", "error", "warn", "info"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    }
    const bodies: string[] = [];
    const keep = <T extends { text: string }>(res: T) => (bodies.push(res.text), res);
    await t.ready();
    await t.setApp(BURNERS_GROUP_ID, "tiktok", APPS.burnerTiktok, SECRETS.burnerTiktok);
    await t.setApp(BURNERS_GROUP_ID, "instagram", APPS.burnerMeta, SECRETS.burnerMeta);
    keep(await request(t.app).get("/api/groups"));
    keep(await t.post(t.newClip(t.experiment.id).id, [BURNER_YT]));
    // Platforms that repeat what they were sent in their refusals.
    fake.refuseWith = (req) => `invalid request: ${req}`;
    keep(await t.post(t.newClip(t.experiment.id, "Second").id, [BURNER_YT]));
    keep(await t.connect(BURNERS_GROUP_ID, "tiktok", "ttburner"));
    keep(await request(t.app).get("/api/groups"));
    keep(await request(t.app).get("/api/posts"));
    fake.refuseWith = null;
    // A proxy that is down: the error names the proxy, never its password.
    await t.setProxy(BURNERS_GROUP_ID, `http://clipfarm:${SECRETS.proxyPass}@127.0.0.1:9`);
    keep(await t.testProxy(BURNERS_GROUP_ID));
    keep(await request(t.app).get("/api/posting"));
    keep(await request(t.app).get("/api/health"));

    const everything = [...bodies, ...logged].join("\n");
    expect(logged.some((l) => l.includes("Burners"))).toBe(true);
    for (const secret of [...Object.values(SECRETS), `rt.${APPS.burnerYoutube}`, `at.${APPS.burnerYoutube}`, fake.exitIp]) {
      expect(everything).not.toContain(secret);
    }
    expect(everything).not.toContain(encodeURIComponent(SECRETS.proxyPass));
  });

  it("keeps group keys in the secrets file (mode 600), and they are in use after a restart", async () => {
    const file = join(dir, "secrets.json");
    const first = new Settings(file, {});
    first.setSecret("group.2.proxy", `http://clipfarm:${SECRETS.proxyPass}@proxy.example:8080`);
    first.setSecret("group.2.youtube.secret", SECRETS.burnerYoutube);
    const again = new Settings(file, {});
    expect(again.secret("group.2.youtube.secret")).toBe(SECRETS.burnerYoutube);
    expect(again.scrub(`connect to http://clipfarm:${SECRETS.proxyPass}@proxy.example:8080 failed, ${SECRETS.proxyPass}`)).toBe("connect to *** failed, ***");
    again.setSecret("group.2.youtube.secret", null);
    expect(new Settings(file, {}).secret("group.2.youtube.secret")).toBeUndefined();
  });

  it("masks addresses to their network", () => {
    expect(maskIp("203.0.113.57")).toBe("203.0.113.x");
    expect(maskIp("2001:db8:85a3:8d3:1319:8a2e:370:7348")).toBe("2001:db8:85a3:x");
    expect(maskIp(null)).toBeNull();
  });
});

describe("the running server", () => {
  it("is built with the groups in force: a burner on the stand-in service is refused until its proxy works", async () => {
    const data = mkdtempSync(join(dir, "runtime-"));
    const rt = openRuntime({ DATA_DIR: data, MEDIA_DIR: join(data, "media"), CLIPFARM_FAKES: "1" }, { pollMs: 3_600_000 });
    try {
      const source = rt.sources.create({
        creatorName: "Big Streamer",
        channelUrls: [],
        permission: parsePermission({ kind: "experiment", note: "test", allowedPlatforms: ["x"] }, new Date()),
      });
      const clip = rt.clips.create({ sourceId: source.id, vodId: null, title: "A clip", filePath: videoPath, durationSec: 20 });
      rt.clips.setStatus(clip.id, "approved");
      const [x] = (await rt.publisher.syncAccounts()).filter((a) => a.id === "fake-x");
      rt.publisher.accounts.update("fake-x", { ...x!, role: "burner" });
      await expect(rt.publisher.post(clip.id, ["fake-x"], null)).rejects.toThrow(
        "GTA VI Moments cannot post: No proxy is set. Burner accounts cannot post until one is added and tested. Nothing was posted.",
      );
      rt.isolation.setProxy(BURNERS_GROUP_ID, "http://user:secret-pass@proxy.example:8080");
      expect(await rt.isolation.check(BURNERS_GROUP_ID)).toMatchObject({ ok: true });
      const outcome = await rt.publisher.post(clip.id, ["fake-x"], null);
      expect(outcome.posts[0]).toMatchObject({ status: "posted", groupName: "Burners" });
    } finally {
      rt.queue.stop();
      rt.db.close();
    }
  });
});

describe("Settings, Accounts for the screen", () => {
  it("has a setup step that says what to buy and which redirect addresses to paste, until the burners can post", async () => {
    const t = setup();
    const item = async () =>
      buildChecklist({ integrations: [], postingAccounts: 1, postingLabel: "Postiz", activePermissions: 1, clips: 1, posted: 1, groups: await t.groups() }).items.find(
        (i) => i.id === "isolation",
      )!;
    expect(await item()).toEqual({
      id: "isolation",
      label: "Burner accounts kept apart",
      done: false,
      line: "Buy one residential or ISP proxy with a fixed address (any provider) and paste it under Burners, then tap Test. Each group also needs its own developer apps; the redirect addresses to paste in them: https://clip.example/oauth/youtube/callback, https://clip.example/oauth/tiktok/callback, https://clip.example/oauth/instagram/callback.",
      href: "#settings/accounts",
      action: "Open Accounts",
    });
    await t.ready();
    expect(await item()).toMatchObject({ done: true, line: "Burners leave from their own address (203.0.113.x) with their own apps." });
  });

  it("lists each group's accounts and says which need connecting here", async () => {
    const t = setup();
    await t.ready();
    await t.publisher.syncAccounts();
    const groups = await t.groups();
    const names = (g: IsolationGroup) => g.accounts.map((a) => [a.name, a.direct]);
    expect(names(groups[0]!)).toEqual([["Channel mainchan", true], ["Linked in Postiz", false]]);
    expect(names(groups[1]!)).toEqual([["Channel burnerchan", true]]);
  });
});
