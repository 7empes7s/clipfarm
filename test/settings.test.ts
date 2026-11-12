import { chmodSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsInfo, SetupChecklist, Watchlist } from "../shared/types.js";
import { createApp } from "../server/app.js";
import { ClipsRepo } from "../server/clips/repo.js";
import { loadConfig, openSettings } from "../server/config.js";
import { openDb } from "../server/db/index.js";
import { JobQueue } from "../server/jobs/queue.js";
import { PicksRepo } from "../server/picks/repo.js";
import { INGEST_JOB, ingestHandler, onIngestFinished } from "../server/pipeline/ingest/ingest.js";
import { Publisher } from "../server/publish/publisher.js";
import { PostsRepo } from "../server/publish/repo.js";
import { SourcesRepo } from "../server/sources/repo.js";
import { WatchlistPoller } from "../server/sources/watchlist/poller.js";
import { WatchlistRepo } from "../server/sources/watchlist/repo.js";
import { VodsRepo } from "../server/vods/repo.js";
import { campaignInput } from "./helpers.js";

// Made-up keys, shaped like the real ones. None of them may ever show up in an answer or a log line.
const KEYS = {
  openai: "sk-proj-clipfarmTestKey0000000000a1b2",
  openaiBad: "sk-proj-clipfarmWrongKey111111111c3d4",
  twitchId: "twitchclientid0000000000e5f6",
  twitchSecret: "twitchclientsecret00000000g7h8",
  twitchBadSecret: "twitchwrongsecret000000000i9j0",
  youtube: "AIzaSyClipfarmTestKey00000000000k1l2",
  postiz: "postizpublicapikey000000000000m3n4",
};
const JWT = "header.payload.signature";

/** Stands in for OpenAI, Twitch, YouTube and Postiz. Refusals repeat the key, as some real APIs do. */
function fakeOutside() {
  const calls: { url: string; auth: string | null }[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const doFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const auth = new Headers(init.headers).get("authorization");
    calls.push({ url, auth });
    if (url.startsWith("https://api.openai.com/v1/")) {
      if (auth !== `Bearer ${KEYS.openai}`) return json({ error: { message: `Incorrect API key provided: ${auth?.slice(7)}.` } }, 401);
      if (url.endsWith("/models")) return json({ data: [{ id: "whisper-1" }, { id: "gpt-4o-mini" }] });
      if (url.endsWith("/audio/transcriptions")) return json({ words: [{ word: " hello", start: 0, end: 0.4 }, { word: " chat", start: 0.5, end: 0.9 }] });
    }
    if (url.startsWith("https://id.twitch.tv/oauth2/token")) {
      const q = new URL(url).searchParams;
      if (q.get("client_secret") !== KEYS.twitchSecret) return json({ status: 403, message: "invalid client secret" }, 403);
      return json({ access_token: "app-token", expires_in: 3600 });
    }
    if (url.includes("/helix/streams")) {
      return json({ data: [{ id: "s1", user_login: "teststreamer", game_name: "Grand Theft Auto VI", title: "DAY 1", started_at: "2026-11-19T18:00:00Z", type: "live" }] });
    }
    if (url.includes("/helix/users")) return json({ data: [{ id: "42", login: "teststreamer" }] });
    if (url.includes("/helix/videos")) return json({ data: [] });
    if (url.startsWith("https://www.googleapis.com/youtube/v3/videos")) {
      if (new URL(url).searchParams.get("key") !== KEYS.youtube) return json({ error: { message: "API key not valid. Please pass a valid API key." } }, 400);
      return json({ items: [] });
    }
    if (url.startsWith("http://postiz.test/api/public/v1/integrations")) {
      if (auth !== KEYS.postiz) return json({ msg: "Invalid API key" }, 401);
      return json([{ id: "yt1", name: "GTA VI Moments", identifier: "youtube", disabled: false }]);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { calls, doFetch };
}

let dir: string;
let outside: ReturnType<typeof fakeOutside>;
/** Every answer body and header the app sent, and every console line, for the leak check. */
let seen: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "clipfarm-settings-test-"));
  outside = fakeOutside();
  seen = [];
  vi.stubGlobal("fetch", outside.doFetch);
  for (const level of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      seen.push(args.map((a) => (a instanceof Error ? `${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

/** The app as index.ts wires it, with real adapters (no fakes mode) on the stand-in network. */
function setup(extraEnv: NodeJS.ProcessEnv = {}, requireAccess = false) {
  const env: NodeJS.ProcessEnv = { DATA_DIR: dir, MEDIA_DIR: join(dir, "media"), DOWNLOADER: "fake", FAKE_VOD_SEC: "10", ...extraEnv };
  const settings = openSettings(env);
  const config = loadConfig(env, settings);
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db);
  const vods = new VodsRepo(db);
  const clips = new ClipsRepo(db);
  const posts = new PostsRepo(db);
  const queue = new JobQueue(db, {
    handlers: { [INGEST_JOB]: ingestHandler({ sources, vods, downloader: config.downloader, transcriber: config.transcriber }) },
    tmpRoot: dir,
    onFinished: onIngestFinished(vods),
  });
  const repo = new WatchlistRepo(db, sources);
  const poller = new WatchlistPoller({ repo, sources, vods, queue, clients: config.watchClients });
  settings.onChange(() => poller.retryNow());
  const app = createApp({
    sources,
    vods,
    picks: new PicksRepo(db),
    queue,
    clips,
    posts,
    publisher: new Publisher({ sources, clips, posts, service: config.postingService }),
    watchlist: { repo, poller },
    settings: { store: settings, demo: config.fakes },
    requireAccess,
  });
  const call = async (method: "get" | "put" | "post" | "delete", path: string, body?: object) => {
    const res = await request(app)[method](path).send(body);
    seen.push(`${method} ${path} ${res.status} ${JSON.stringify(res.headers)} ${res.text}`);
    return res;
  };
  return { app, call, config, sources, vods, queue, repo, poller, secretsFile: join(dir, "secrets.json") };
}

const save = (id: string, values: Record<string, string>) => [`/api/settings/${id}`, { values }] as const;
const row = (info: SettingsInfo, id: string) => info.integrations.find((i) => i.id === id)!;

describe("Settings: keys pasted in the app", () => {
  it("keeps the keys in DATA_DIR/secrets.json, mode 600, and never sends a value back", async () => {
    const { call, secretsFile } = setup();
    const res = await call("put", ...save("openai", { OPENAI_API_KEY: `  ${KEYS.openai}\n` }));
    expect(res.status).toBe(200);
    const field = row(res.body as SettingsInfo, "openai").fields[0]!;
    expect(field).toMatchObject({ name: "OPENAI_API_KEY", set: true, source: "settings", ending: "a1b2", value: null });
    expect(field.savedAt).toMatch(/^\d{4}-\d\d-\d\dT/);

    expect(statSync(secretsFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(secretsFile, "utf8")).toContain(KEYS.openai);
    // Written to a temp file and renamed: nothing else is left in the folder.
    expect(readdirSync(dir).filter((f) => f.includes("secrets"))).toEqual(["secrets.json"]);

    // A replaced key keeps the file private, even if it was opened up in between.
    chmodSync(secretsFile, 0o644);
    await call("put", ...save("youtube", { YOUTUBE_API_KEY: KEYS.youtube }));
    expect(statSync(secretsFile).mode & 0o777).toBe(0o600);
  });

  it("survives a restart, and Remove falls back to the server's env", async () => {
    const env = { YOUTUBE_API_KEY: "AIzaSyFromTheEnvFile0000000000000zzzz" };
    const first = setup(env);
    await first.call("put", ...save("youtube", { YOUTUBE_API_KEY: KEYS.youtube }));

    const second = setup(env);
    const saved = (await second.call("get", "/api/settings")).body as SettingsInfo;
    expect(row(saved, "youtube").fields[0]).toMatchObject({ source: "settings", ending: "k1l2" });

    const removed = (await second.call("delete", "/api/settings/youtube")).body as SettingsInfo;
    expect(row(removed, "youtube")).toMatchObject({ configured: true, test: null });
    expect(row(removed, "youtube").fields[0]).toMatchObject({ source: "env", ending: "zzzz", savedAt: null });
    expect(readFileSync(second.secretsFile, "utf8")).not.toContain(KEYS.youtube);
  });

  it("shows addresses and names, since they are not keys, and an empty one goes back to the default", async () => {
    const { call } = setup();
    const res = await call("put", ...save("openai", { LLM_BASE_URL: "https://openrouter.ai/api/v1", LLM_MODEL: "meta/llama" }));
    const fields = row(res.body as SettingsInfo, "openai").fields;
    expect(fields.find((f) => f.name === "LLM_BASE_URL")).toMatchObject({ value: "https://openrouter.ai/api/v1", ending: null });
    const cleared = await call("put", ...save("openai", { LLM_BASE_URL: "", OPENAI_API_KEY: "" }));
    expect(row(cleared.body as SettingsInfo, "openai").fields.find((f) => f.name === "LLM_BASE_URL")).toMatchObject({ set: false, value: null });
  });

  it("refuses what cannot be a key, without repeating it", async () => {
    const { call } = setup();
    const spaced = await call("put", ...save("twitch", { TWITCH_CLIENT_SECRET: "two words-of-secret" }));
    expect(spaced.status).toBe(400);
    expect(spaced.body.error).toBe("Client Secret: it has a space or line break in it. Copy it again.");
    expect((await call("put", ...save("postiz", { POSTIZ_URL: "postiz.local" }))).body.error).toBe("Postiz address: it must start with https:// or http://.");
    expect((await call("put", ...save("twitch", { CLIPFARM_REQUIRE_ACCESS: "0" }))).status).toBe(400);
    expect((await call("put", ...save("twitch", {}))).body.error).toBe("Paste a value first.");
    expect((await call("put", ...save("nope", { X: "y" }))).status).toBe(404);
  });

  it("ignores settings in the file that this screen does not own", async () => {
    writeFileSync(join(dir, "secrets.json"), JSON.stringify({ values: { CLIPFARM_FAKES: { value: "1", savedAt: "x" }, YOUTUBE_API_KEY: { value: KEYS.youtube, savedAt: "x" } } }));
    const { config } = setup();
    expect(config.settings.env().CLIPFARM_FAKES).toBeUndefined();
    expect(config.settings.get("YOUTUBE_API_KEY")).toBe(KEYS.youtube);
  });
});

describe("Settings: Test", () => {
  it("OpenAI: lists models with the saved key and says Works", async () => {
    const { call } = setup();
    await call("put", ...save("openai", { OPENAI_API_KEY: KEYS.openai }));
    const res = await call("post", "/api/settings/openai/test");
    expect(res.body).toMatchObject({ ok: true, message: "Works." });
    expect(row(res.body.settings as SettingsInfo, "openai").test).toMatchObject({ ok: true, message: "Works." });
    expect(outside.calls.map((c) => c.url)).toEqual(["https://api.openai.com/v1/models", "https://api.openai.com/v1/models"]);
  });

  it("OpenAI: a refused key is said in OpenAI's words, with the key taken out", async () => {
    const { call } = setup();
    await call("put", ...save("openai", { OPENAI_API_KEY: KEYS.openaiBad }));
    const res = await call("post", "/api/settings/openai/test");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: false, message: "OpenAI says: Incorrect API key provided: ***." });
  });

  it("OpenAI: says when the picking model is not there", async () => {
    const { call } = setup();
    await call("put", ...save("openai", { OPENAI_API_KEY: KEYS.openai, LLM_MODEL: "gpt-nope" }));
    expect((await call("post", "/api/settings/openai/test")).body.message).toBe(
      'The key works, but there is no model called "gpt-nope" there. Check the picking model name.',
    );
  });

  it("Twitch: a token and one streams call; a bad secret gives Twitch's own words", async () => {
    const { call } = setup();
    await call("put", ...save("twitch", { TWITCH_CLIENT_ID: KEYS.twitchId, TWITCH_CLIENT_SECRET: KEYS.twitchBadSecret }));
    expect((await call("post", "/api/settings/twitch/test")).body).toMatchObject({ ok: false, message: "Twitch says: invalid client secret." });

    await call("put", ...save("twitch", { TWITCH_CLIENT_SECRET: KEYS.twitchSecret }));
    outside.calls.length = 0;
    expect((await call("post", "/api/settings/twitch/test")).body).toMatchObject({ ok: true, message: "Works." });
    expect(outside.calls.map((c) => c.url.split("?")[0])).toEqual(["https://id.twitch.tv/oauth2/token", "https://api.twitch.tv/helix/streams"]);
  });

  it("YouTube and Postiz: one read each", async () => {
    const { call } = setup();
    await call("put", ...save("youtube", { YOUTUBE_API_KEY: "AIzaSyNotTheRightKey000000000000" }));
    expect((await call("post", "/api/settings/youtube/test")).body.message).toBe("YouTube says: API key not valid. Please pass a valid API key.");
    await call("put", ...save("youtube", { YOUTUBE_API_KEY: KEYS.youtube }));
    expect((await call("post", "/api/settings/youtube/test")).body).toMatchObject({ ok: true });

    await call("put", ...save("postiz", { POSTIZ_URL: "http://postiz.test", POSTIZ_API_KEY: KEYS.postiz }));
    expect((await call("post", "/api/settings/postiz/test")).body).toMatchObject({ ok: true, message: "Works: 1 account linked." });
    await call("put", ...save("postiz", { POSTIZ_URL: "http://postiz-down.test" }));
    expect((await call("post", "/api/settings/postiz/test")).body).toMatchObject({ ok: false, message: "Postiz answered with an error (HTTP 404): not found" });
  });

  it("says what is missing instead of calling anything", async () => {
    const { call } = setup();
    expect((await call("post", "/api/settings/twitch/test")).body).toMatchObject({ ok: false, message: "Not set yet: Client ID, Client Secret." });
    expect(outside.calls).toEqual([]);
  });

  it("a saved change forgets the old test result", async () => {
    const { call } = setup();
    await call("put", ...save("youtube", { YOUTUBE_API_KEY: KEYS.youtube }));
    await call("post", "/api/settings/youtube/test");
    const res = await call("put", ...save("youtube", { YOUTUBE_API_KEY: "AIzaSyAnotherKey0000000000000000" }));
    expect(row(res.body as SettingsInfo, "youtube").test).toBeNull();
  });
});

describe("Settings: a saved key is in use at once, with no restart", () => {
  it("the next transcription job uses an OpenAI key saved while the env has none", async () => {
    const { call, sources, vods, queue } = setup({ OPENAI_API_KEY: "" });
    const source = sources.create(campaignInput());

    const before = vods.create(source.id, "https://www.twitch.tv/videos/1");
    const failed = queue.enqueue(INGEST_JOB, { vodId: before.id }, { vodId: before.id, maxAttempts: 1 });
    await queue.idle();
    expect(queue.get(failed.id)).toMatchObject({ status: "failed", error: "Add your OpenAI key in Settings, so audio can be transcribed." });
    expect(outside.calls).toEqual([]);

    await call("put", ...save("openai", { OPENAI_API_KEY: KEYS.openai }));
    const after = vods.create(source.id, "https://www.twitch.tv/videos/2");
    const job = queue.enqueue(INGEST_JOB, { vodId: after.id }, { vodId: after.id, maxAttempts: 1 });
    await queue.idle();
    expect(queue.get(job.id)).toMatchObject({ status: "done", error: null });
    expect(outside.calls).toEqual([{ url: "https://api.openai.com/v1/audio/transcriptions", auth: `Bearer ${KEYS.openai}` }]);
    expect(vods.detail(after.id)).toMatchObject({ status: "ready", wordCount: 2 });
  });

  it("the watchlist lists Twitch live streams once the key is saved; a bad key is a plain line, not a crash", async () => {
    const { call, repo } = setup();
    repo.create({ name: "Test Streamer", channels: [{ platform: "twitch", handle: "teststreamer" }], language: "en", games: ["Grand Theft Auto VI"], program: "none", programUrl: null, note: "", sourceId: null });

    const unset = (await call("post", "/api/watchlist/poll")).body as Watchlist;
    expect(unset.platforms.find((p) => p.platform === "twitch")).toMatchObject({ configured: false, note: "Add your Twitch key in Settings." });
    expect(unset.creators[0]!.live).toBeNull();

    await call("put", ...save("twitch", { TWITCH_CLIENT_ID: KEYS.twitchId, TWITCH_CLIENT_SECRET: KEYS.twitchBadSecret }));
    const bad = await call("post", "/api/watchlist/poll");
    expect(bad.status).toBe(200);
    const twitch = (bad.body as Watchlist).platforms.find((p) => p.platform === "twitch")!;
    expect(twitch.configured).toBe(true);
    expect(twitch.note).toBe("Twitch refused the request (HTTP 403). Check its keys. Trying again later.");

    // Saving the right secret also ends the wait the bad one caused.
    await call("put", ...save("twitch", { TWITCH_CLIENT_SECRET: KEYS.twitchSecret }));
    const good = (await call("post", "/api/watchlist/poll")).body as Watchlist;
    expect(good.platforms.find((p) => p.platform === "twitch")).toMatchObject({ configured: true, note: null });
    expect(good.creators[0]!.live).toMatchObject({ platform: "twitch", game: "Grand Theft Auto VI", title: "DAY 1" });
  });

  it("posting switches to Postiz when its key is saved", async () => {
    const { call } = setup();
    expect((await call("get", "/api/posting")).body).toMatchObject({ service: "none", accounts: [] });
    await call("put", ...save("postiz", { POSTIZ_URL: "http://postiz.test", POSTIZ_API_KEY: KEYS.postiz }));
    expect((await call("get", "/api/posting")).body).toMatchObject({ service: "postiz", accounts: [{ id: "yt1", platform: "youtube" }] });
  });
});

describe("Settings: who may see what", () => {
  it("no saved value is in any answer or log line", async () => {
    const { call, sources, vods, queue, repo } = setup();
    repo.create({ name: "Test Streamer", channels: [{ platform: "twitch", handle: "teststreamer" }], language: "en", games: [], program: "none", programUrl: null, note: "", sourceId: null });
    const source = sources.create(campaignInput());
    const everyKey = Object.values(KEYS);

    // Wrong keys first: the stand-in services repeat them in their refusals, as real ones may.
    await call("put", ...save("openai", { OPENAI_API_KEY: KEYS.openaiBad }));
    await call("put", ...save("twitch", { TWITCH_CLIENT_ID: KEYS.twitchId, TWITCH_CLIENT_SECRET: KEYS.twitchBadSecret }));
    await call("put", ...save("postiz", { POSTIZ_URL: "http://postiz.test", POSTIZ_API_KEY: "wrongpostizkey0000000000000000o5p6" }));
    for (const id of ["openai", "twitch", "youtube", "postiz", "upload-post"]) await call("post", `/api/settings/${id}/test`);
    const vod = vods.create(source.id, "https://www.twitch.tv/videos/1");
    queue.enqueue(INGEST_JOB, { vodId: vod.id }, { vodId: vod.id, maxAttempts: 1 });
    await queue.idle();
    await call("post", "/api/watchlist/poll");

    // Then the right ones, and every screen that could show something about them.
    await call("put", ...save("openai", { OPENAI_API_KEY: KEYS.openai, LLM_API_KEY: KEYS.openaiBad }));
    await call("put", ...save("twitch", { TWITCH_CLIENT_SECRET: KEYS.twitchSecret }));
    await call("put", ...save("youtube", { YOUTUBE_API_KEY: KEYS.youtube }));
    await call("put", ...save("postiz", { POSTIZ_API_KEY: KEYS.postiz }));
    for (const id of ["openai", "twitch", "youtube", "postiz"]) await call("post", `/api/settings/${id}/test`);
    for (const path of ["/api/settings", "/api/setup", "/api/health", "/api/jobs", "/api/vods", `/api/vods/${vod.id}`, "/api/watchlist", "/api/posting", "/api/sources", "/api/nope"]) {
      await call("get", path);
    }
    await call("post", "/api/watchlist/poll");
    await call("put", ...save("openai", { OPENAI_API_KEY: "has a space" }));
    for (const id of ["openai", "twitch", "youtube", "postiz"]) await call("delete", `/api/settings/${id}`);

    const everything = seen.join("\n");
    // The check is not empty-handed: the failed job, the refusals and the key endings are in there.
    expect(everything).toContain("OpenAI transcription failed (401)");
    expect(everything).toContain("Twitch says: invalid client secret.");
    expect(everything).toContain('"ending":"a1b2"');
    for (const key of everyKey) expect(everything.includes(key), `a key ending in ${key.slice(-4)} leaked`).toBe(false);
  });

  it("a service's error that repeats the key is cleaned, message and stack, before anyone can log it", async () => {
    const { call, config } = setup();
    await call("put", ...save("openai", { OPENAI_API_KEY: KEYS.openaiBad }));
    const audio = join(dir, "a.mp3");
    writeFileSync(audio, "small");
    const err = await config.transcriber.transcribe(audio, { durationSec: 1, tmpDir: dir }).catch((e: Error) => e);
    expect((err as Error).message).toContain("Incorrect API key provided: ***");
    expect(`${(err as Error).stack}`).not.toContain(KEYS.openaiBad);
  });

  it("the settings routes sit behind the same access gate as the rest; health stays open and says only yes or no", async () => {
    const { app, call } = setup({}, true);
    for (const [method, path] of [
      ["get", "/api/settings"],
      ["put", "/api/settings/openai"],
      ["post", "/api/settings/openai/test"],
      ["delete", "/api/settings/openai"],
      ["get", "/api/setup"],
    ] as const) {
      expect((await call(method, path, { values: { OPENAI_API_KEY: KEYS.openai } })).status, `${method} ${path}`).toBe(403);
    }
    expect(outside.calls).toEqual([]);

    const saved = await request(app).put("/api/settings/openai").set("Cf-Access-Jwt-Assertion", JWT).send({ values: { OPENAI_API_KEY: KEYS.openai } });
    expect(saved.status).toBe(200);
    const health = await call("get", "/api/health");
    expect(health.body).toEqual({ ok: true, configured: { openai: true, twitch: false, youtube: false, postiz: false, "upload-post": false } });
  });
});

describe("Setup checklist", () => {
  it("starts with everything open and ticks off as the keys are saved and tested", async () => {
    const { call, sources } = setup();
    const start = (await call("get", "/api/setup")).body as SetupChecklist;
    expect(start.done).toBe(false);
    expect(start.items.map((i) => [i.id, i.done])).toEqual([["keys", false], ["accounts", false], ["permission", false], ["clip", false], ["post", false]]);
    expect(start.items[0]!.line).toBe("Paste each key, then tap Test. Still open: OpenAI (not set), Twitch (not set), YouTube (not set), Postiz (not set).");

    await call("put", ...save("openai", { OPENAI_API_KEY: KEYS.openai }));
    await call("put", ...save("twitch", { TWITCH_CLIENT_ID: KEYS.twitchId, TWITCH_CLIENT_SECRET: KEYS.twitchSecret }));
    await call("put", ...save("youtube", { YOUTUBE_API_KEY: KEYS.youtube }));
    await call("put", ...save("postiz", { POSTIZ_URL: "http://postiz.test", POSTIZ_API_KEY: KEYS.postiz }));
    for (const id of ["openai", "twitch", "youtube"]) await call("post", `/api/settings/${id}/test`);
    const untested = (await call("get", "/api/setup")).body as SetupChecklist;
    expect(untested.items[0]).toMatchObject({ done: false, line: "Paste each key, then tap Test. Still open: Postiz (not tested)." });

    await call("post", "/api/settings/postiz/test");
    sources.create(campaignInput());
    const later = (await call("get", "/api/setup")).body as SetupChecklist;
    expect(later.items.map((i) => [i.id, i.done])).toEqual([["keys", true], ["accounts", true], ["permission", true], ["clip", false], ["post", false]]);
    expect(later.items[1]!.line).toBe("1 account linked in Postiz.");
  });
});
