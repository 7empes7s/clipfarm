import { chmodSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsInfo, SetupChecklist, Watchlist } from "../shared/types.js";
import type { AccessVerifier } from "../server/access.js";
import { createApp } from "../server/app.js";
import { ClipsRepo } from "../server/clips/repo.js";
import { loadConfig, openSettings } from "../server/config.js";
import { openDb } from "../server/db/index.js";
import { JobQueue } from "../server/jobs/queue.js";
import { PicksRepo } from "../server/picks/repo.js";
import { INGEST_JOB, ingestHandler, onIngestFinished } from "../server/pipeline/ingest/ingest.js";
import type { PickInput } from "../server/pipeline/picks/types.js";
import { Publisher } from "../server/publish/publisher.js";
import { PostsRepo } from "../server/publish/repo.js";
import { SourcesRepo } from "../server/sources/repo.js";
import { WatchlistPoller } from "../server/sources/watchlist/poller.js";
import { WatchlistRepo } from "../server/sources/watchlist/repo.js";
import { VodsRepo } from "../server/vods/repo.js";
import { fakeAccess } from "./accessToken.js";
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

/** What the stand-in OpenAI lists: text models in no order, and things that are not text models. */
const OPENAI_MODELS = ["text-embedding-9", "gpt-6-astra", "whisper-1", "gpt-6-luna", "gpt-transcribe", "gpt-6.1-sol", "gpt-4o-mini", "tts-2"];

const aPick = {
  candidate: 0,
  start: 115,
  end: 140,
  hook: "He did NOT expect that",
  title: "Test Streamer gets launched across the map",
  score: 88,
  reason: "Huge reaction in the first second",
  layout: "center",
  flags: { spoiler: false, cutscene: false, ending: false, leak: false, breaks_brief: false },
};

/** Stands in for OpenAI, OpenRouter, Twitch, YouTube and Postiz. Refusals repeat the key, as some real APIs do. */
function fakeOutside() {
  const calls: { url: string; auth: string | null }[] = [];
  /** Each model call, e.g. "responses gpt-6-luna" or "transcriptions whisper-1". */
  const asked: string[] = [];
  /** How the stand-in OpenAI behaves; a test changes these. */
  const openai = { wordTimingsFrom: ["whisper-1"], responsesDown: false, transcriptionDown: false };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const doFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const auth = new Headers(init.headers).get("authorization");
    calls.push({ url, auth });
    if (url.startsWith("https://api.openai.com/v1/")) {
      if (auth !== `Bearer ${KEYS.openai}`) return json({ error: { message: `Incorrect API key provided: ${auth?.slice(7)}.` } }, 401);
      if (url.endsWith("/models")) return json({ data: OPENAI_MODELS.map((id) => ({ id })) });
      if (url.endsWith("/responses")) {
        const body = JSON.parse(String(init.body)) as { model: string; text: { format: { name: string } } };
        asked.push(`responses ${body.model}`);
        if (openai.responsesDown) return json({ error: { message: "You do not have access to this model." } }, 403);
        const text = JSON.stringify(body.text.format.name === "clip_picks" ? { picks: [aPick] } : { ok: true });
        return json({ output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { input_tokens: 100, output_tokens: 10 } });
      }
      if (url.endsWith("/audio/transcriptions")) {
        const model = String((init.body as FormData).get("model"));
        asked.push(`transcriptions ${model}`);
        if (openai.transcriptionDown) return json({ error: { message: "The server had an error." } }, 500);
        if (!openai.wordTimingsFrom.includes(model)) return json({ text: "hello chat" });
        return json({ words: [{ word: " hello", start: 0, end: 0.4 }, { word: " chat", start: 0.5, end: 0.9 }] });
      }
    }
    if (url.startsWith("https://openrouter.ai/api/v1/")) {
      if (url.endsWith("/models")) return json({ data: [{ id: "meta/llama" }] });
      if (url.endsWith("/chat/completions")) {
        asked.push(`chat/completions ${(JSON.parse(String(init.body)) as { model: string }).model}`);
        return json({ choices: [{ message: { content: '{"ok":true}' } }] });
      }
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
  return { calls, asked, openai, doFetch };
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
function setup(extraEnv: NodeJS.ProcessEnv = {}, access?: AccessVerifier) {
  const env: NodeJS.ProcessEnv = { DATA_DIR: dir, MEDIA_DIR: join(dir, "media"), DOWNLOADER: "fake", FAKE_VOD_SEC: "10", ...extraEnv };
  const settings = openSettings(env);
  const config = loadConfig(env, settings);
  const db = openDb(":memory:");
  config.engine.bind(db);
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
    access,
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
const field = (info: SettingsInfo, name: string) => row(info, "openai").fields.find((f) => f.name === name)!;

/** Four minutes of speech with one loud second, so the picker has a moment to offer. */
function pickInput(): PickInput {
  const words = Array.from({ length: 480 }, (_, i) => ({ word: (i + 1) % 10 === 0 ? "okay." : "so", startSec: i * 0.5, endSec: i * 0.5 + 0.4 }));
  const loudness = new Array<number>(240).fill(-30);
  loudness[120] = -5;
  return { title: "GTA VI day one", durationSec: 240, chapters: [], words, signals: { loudness, chat: null }, creatorName: "Test Streamer", briefRules: "", bannedContent: "", maxPicks: 5 };
}

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
  it("OpenAI: checks the key, the picking model and a 2-second sample, and fills the two dropdowns", async () => {
    const { call } = setup();
    await call("put", ...save("openai", { OPENAI_API_KEY: KEYS.openai }));
    outside.calls.length = 0;
    outside.asked.length = 0;
    const res = await call("post", "/api/settings/openai/test");
    const message = "Works: key valid, picks with gpt-6-luna, transcription with whisper-1.";
    expect(res.body).toMatchObject({ ok: true, message });
    const info = res.body.settings as SettingsInfo;
    expect(row(info, "openai").test).toMatchObject({ ok: true, message });
    // One model list (free), one tiny answer from the Responses API, and the sample: gpt-transcribe first.
    expect(outside.calls.map((c) => c.url.replace("https://api.openai.com/v1/", ""))).toEqual(["models", "responses", "audio/transcriptions", "audio/transcriptions"]);
    expect(outside.asked).toEqual(["responses gpt-6-luna", "transcriptions gpt-transcribe", "transcriptions whisper-1"]);

    // Text models only, the recommended one first; then speech-to-text models.
    expect(field(info, "LLM_MODEL")).toMatchObject({ set: false, source: null, fallback: "gpt-6-luna", options: ["gpt-6-luna", "gpt-4o-mini", "gpt-6-astra", "gpt-6.1-sol"] });
    expect(field(info, "OPENAI_TRANSCRIBE_MODEL")).toMatchObject({ set: false, fallback: "gpt-transcribe", options: ["gpt-transcribe", "whisper-1"] });
    expect(field(info, "LLM_BASE_URL")).toMatchObject({ set: false, fallback: "https://api.openai.com/v1", options: null });
    expect(row(info, "openai").note).toBe(
      "Transcription uses whisper-1 for word timings because gpt-transcribe does not send word timings yet. whisper-1 retires on 26 Feb 2027.",
    );
  });

  it("OpenAI: once gpt-transcribe sends word timings it is the one used, and the whisper-1 note goes away", async () => {
    const { call, config, sources, vods, queue } = setup();
    outside.openai.wordTimingsFrom = ["whisper-1", "gpt-transcribe"];
    const saved = await call("put", ...save("openai", { OPENAI_API_KEY: KEYS.openai }));
    expect(row(saved.body as SettingsInfo, "openai")).toMatchObject({
      note: null,
      test: { ok: true, message: "Works: key valid, picks with gpt-6-luna, transcription with gpt-transcribe." },
    });
    config.engine.saveSettings({ cloud: true });
    outside.asked.length = 0;
    const vod = vods.create(sources.create(campaignInput()).id, "https://www.twitch.tv/videos/1");
    queue.enqueue(INGEST_JOB, { vodId: vod.id }, { vodId: vod.id, maxAttempts: 1 });
    await queue.idle();
    expect(outside.asked).toEqual(["transcriptions gpt-transcribe"]);
  });

  it("OpenAI: a save is tested at once, with no tap on Test", async () => {
    const { call } = setup();
    const saved = await call("put", ...save("openai", { OPENAI_API_KEY: KEYS.openai }));
    expect(row(saved.body as SettingsInfo, "openai").test).toMatchObject({ ok: true });
    const wrong = await call("put", ...save("openai", { OPENAI_API_KEY: KEYS.openaiBad }));
    expect(row(wrong.body as SettingsInfo, "openai").test).toMatchObject({ ok: false, message: "OpenAI says: Incorrect API key provided: ***." });
    // Nothing to test without a key.
    await call("delete", "/api/settings/openai");
    outside.calls.length = 0;
    const noKey = await call("put", ...save("openai", { LLM_MODEL: "gpt-6-astra" }));
    expect(row(noKey.body as SettingsInfo, "openai")).toMatchObject({ configured: false, test: null });
    expect(outside.calls).toEqual([]);
  });

  it("OpenAI: Failed says which part failed, in plain words", async () => {
    const { call } = setup();
    outside.openai.responsesDown = true;
    const noPicks = await call("put", ...save("openai", { OPENAI_API_KEY: KEYS.openai }));
    expect(row(noPicks.body as SettingsInfo, "openai").test).toMatchObject({
      ok: false,
      message: 'The key works, but the picking model "gpt-6-luna" did not answer: You do not have access to this model.',
    });
    // The lists were read before it failed, so another model can be picked from the dropdown.
    expect(field(noPicks.body as SettingsInfo, "LLM_MODEL").options).toContain("gpt-6-astra");

    outside.openai.responsesDown = false;
    outside.openai.transcriptionDown = true;
    expect((await call("post", "/api/settings/openai/test")).body).toMatchObject({
      ok: false,
      message: "Picks work, but the 2-second transcription sample failed: The server had an error.",
    });
  });

  it("OpenAI: another address is asked the Chat Completions way, with its own model list", async () => {
    const { call } = setup();
    const res = await call("put", ...save("openai", { OPENAI_API_KEY: KEYS.openai, LLM_BASE_URL: "https://openrouter.ai/api/v1", LLM_MODEL: "meta/llama" }));
    expect(row(res.body as SettingsInfo, "openai").test).toMatchObject({ ok: true, message: "Works: key valid, picks with meta/llama, transcription with whisper-1." });
    expect(outside.asked[0]).toBe("chat/completions meta/llama");
    expect(field(res.body as SettingsInfo, "LLM_MODEL")).toMatchObject({ value: "meta/llama", source: "settings", options: ["meta/llama"] });
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
      'The key works, but there is no model called "gpt-nope" there. Pick another picking model.',
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
    const { call, config, sources, vods, queue } = setup({ OPENAI_API_KEY: "" });
    const source = sources.create(campaignInput());
    // Cloud AI is the option here ("Use cloud AI for speed"); it was switched on, then the key was removed.
    await call("put", ...save("openai", { OPENAI_API_KEY: KEYS.openai }));
    config.engine.saveSettings({ cloud: true });
    await call("delete", "/api/settings/openai");
    outside.calls.length = 0;

    const before = vods.create(source.id, "https://www.twitch.tv/videos/1");
    const failed = queue.enqueue(INGEST_JOB, { vodId: before.id }, { vodId: before.id, maxAttempts: 1 });
    await queue.idle();
    expect(queue.get(failed.id)).toMatchObject({
      status: "failed",
      error: "Cloud AI is switched on, but there is no OpenAI key. Add it in Settings, or switch cloud AI off on the Dashboard to use the local engine.",
    });
    expect(outside.calls).toEqual([]);

    await call("put", ...save("openai", { OPENAI_API_KEY: KEYS.openai }));
    // The save's own test found that whisper-1 is the one with word timings: the job asks it straight away.
    outside.calls.length = 0;
    const after = vods.create(source.id, "https://www.twitch.tv/videos/2");
    const job = queue.enqueue(INGEST_JOB, { vodId: after.id }, { vodId: after.id, maxAttempts: 1 });
    await queue.idle();
    expect(queue.get(job.id)).toMatchObject({ status: "done", error: null });
    expect(outside.calls).toEqual([{ url: "https://api.openai.com/v1/audio/transcriptions", auth: `Bearer ${KEYS.openai}` }]);
    expect(vods.detail(after.id)).toMatchObject({ status: "ready", wordCount: 2 });
    // Which model transcribed is on the job's engine report.
    expect(config.engine.reportsFor(after.id)[0]).toMatchObject({ summary: "Cloud (OpenAI) 100% (whisper-1)", uses: [{ step: "cloud", note: "whisper-1" }] });
  });

  it("the next picks job uses the model chosen from the dropdown, through the Responses API", async () => {
    const { call, config } = setup();
    await call("put", ...save("openai", { OPENAI_API_KEY: KEYS.openai }));
    config.engine.saveSettings({ cloud: true });
    outside.asked.length = 0;
    await config.picker.pick(pickInput());
    expect(outside.asked).toEqual(["responses gpt-6-luna"]);

    const chosen = await call("put", ...save("openai", { LLM_MODEL: "gpt-6.1-sol" }));
    expect(field(chosen.body as SettingsInfo, "LLM_MODEL")).toMatchObject({ value: "gpt-6.1-sol", set: true, source: "settings" });
    outside.asked.length = 0;
    const result = await config.picker.pick(pickInput());
    expect(outside.asked).toEqual(["responses gpt-6.1-sol"]);
    expect(result.picks.map((p) => p.hook)).toEqual(["He did NOT expect that"]);
  });

  it("an old model left in the server env is not used: the default is, until a model is chosen", async () => {
    const { call, config } = setup({ OPENAI_API_KEY: KEYS.openai, LLM_MODEL: "gpt-4o-mini" });
    config.engine.saveSettings({ cloud: true });
    const before = (await call("get", "/api/settings")).body as SettingsInfo;
    expect(field(before, "LLM_MODEL")).toMatchObject({ set: false, source: null, value: null, fallback: "gpt-6-luna" });
    expect(row(before, "openai").note).toBe("Old model in server env (gpt-4o-mini), replaced by gpt-6-luna.");
    await config.picker.pick(pickInput());
    expect(outside.asked).toEqual(["responses gpt-6-luna"]);

    const chosen = (await call("put", ...save("openai", { LLM_MODEL: "gpt-6-astra" }))).body as SettingsInfo;
    expect(row(chosen, "openai").note).toContain("Old model in server env (gpt-4o-mini), replaced by your choice.");
    expect(field(chosen, "LLM_MODEL")).toMatchObject({ value: "gpt-6-astra", source: "settings" });
  });

  it("a model named in the server env that is not a retired default is used, and the card says where it is from", async () => {
    const { call, config } = setup({ OPENAI_API_KEY: KEYS.openai, LLM_MODEL: "gpt-6-astra" });
    config.engine.saveSettings({ cloud: true });
    const info = (await call("get", "/api/settings")).body as SettingsInfo;
    expect(field(info, "LLM_MODEL")).toMatchObject({ value: "gpt-6-astra", source: "env" });
    expect(row(info, "openai").note).toBeNull();
    await config.picker.pick(pickInput());
    expect(outside.asked).toEqual(["responses gpt-6-astra"]);
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
    const { call, config, sources, vods, queue, repo } = setup();
    repo.create({ name: "Test Streamer", channels: [{ platform: "twitch", handle: "teststreamer" }], language: "en", games: [], program: "none", programUrl: null, note: "", sourceId: null });
    const source = sources.create(campaignInput());
    const everyKey = Object.values(KEYS);

    // Wrong keys first: the stand-in services repeat them in their refusals, as real ones may.
    await call("put", ...save("openai", { OPENAI_API_KEY: KEYS.openaiBad }));
    config.engine.saveSettings({ cloud: true });
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
    config.engine.saveSettings({ cloud: true });
    const audio = join(dir, "a.mp3");
    writeFileSync(audio, "small");
    const err = await config.transcriber.transcribe(audio, { durationSec: 1, tmpDir: dir }).catch((e: Error) => e);
    expect((err as Error).message).toContain("Incorrect API key provided: ***");
    expect(`${(err as Error).stack}`).not.toContain(KEYS.openaiBad);
  });

  it("the settings routes sit behind the same access gate as the rest; health stays open and says only yes or no", async () => {
    const signIn = fakeAccess();
    const { app, call } = setup({}, signIn.verifier);
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

    const saved = await request(app).put("/api/settings/openai").set("Cf-Access-Jwt-Assertion", signIn.token()).send({ values: { OPENAI_API_KEY: KEYS.openai } });
    expect(saved.status).toBe(200);
    const health = await call("get", "/api/health");
    expect(health.body).toEqual({ ok: true, configured: { openai: true, google: false, twitch: false, youtube: false, postiz: false, "upload-post": false } });
  });
});

describe("Setup checklist", () => {
  it("starts with everything open and ticks off as the keys are saved and tested", async () => {
    const { call, sources } = setup();
    const start = (await call("get", "/api/setup")).body as SetupChecklist;
    expect(start.done).toBe(false);
    expect(start.items.map((i) => [i.id, i.done])).toEqual([["keys", false], ["accounts", false], ["permission", false], ["clip", false], ["post", false]]);
    expect(start.items[0]!.line).toBe("Paste each key, then tap Test. Still open: Twitch (not set), YouTube (not set), Postiz (not set).");

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
