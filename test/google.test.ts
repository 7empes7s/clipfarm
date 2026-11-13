import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClipThumbs, GoogleStatus } from "../shared/google.js";
import type { SettingsInfo, Word } from "../shared/types.js";
import { createApp } from "../server/app.js";
import { openDb } from "../server/db/index.js";
import { proxyMaker, videoReranker } from "../server/google/rerank.js";
import { JobQueue } from "../server/jobs/queue.js";
import { PICKS_JOB, picksHandler } from "../server/pipeline/picks/job.js";
import { openRuntime, type Runtime } from "../server/runtime.js";
import { generateSample, probeVideo } from "../server/tools/ffmpeg.js";
import { campaignInput } from "./helpers.js";

// Made-up credentials, shaped like the real ones. None may ever show up in an answer or a log line.
const KEY = "AIzaSyClipfarmVertexKey000000000r3s4";
const BAD_KEY = "AIzaSyClipfarmWrongVertex0000000t5u6";
const PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const ACCOUNT = JSON.stringify({ type: "service_account", project_id: "leonida-clips", private_key_id: "abc123", private_key: PRIVATE_KEY, client_email: "clipfarm@leonida-clips.iam.gserviceaccount.com" }, null, 2);
const TOKEN = "ya29.clipfarm-test-access-token-0000";

const COPY = { hook: "GEMINI wrote this hook", title: "Test Streamer cannot believe it", flags: { spoiler: false, cutscene: false, ending: false, leak: false, breaks_brief: false } };
const VISUAL = { visual_intensity: 9, moment_type: "crash", opens_on_payoff: true, best_start: 3, best_end: 20, flags: { spoiler: false, leak: false, cutscene: false } };

/** Stands in for Google. A refusal repeats the key it was given, as real APIs sometimes do. */
function fakeGoogle() {
  const calls: { url: string; auth: string; kind: "token" | "video" | "image" | "text" }[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const doFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    if (url === "https://oauth2.googleapis.com/token") {
      calls.push({ url, auth: "", kind: "token" });
      return json({ access_token: TOKEN, expires_in: 3600 });
    }
    if (!url.includes("aiplatform.googleapis.com")) return new Response("not found", { status: 404 });
    const key = headers.get("x-goog-api-key");
    const body = JSON.parse(String(init.body)) as { contents: { parts: { inlineData?: { mimeType: string; data: string } }[] }[] };
    const media = body.contents[0]!.parts.find((p) => p.inlineData)?.inlineData;
    const kind = !media ? "text" : media.mimeType.startsWith("video/") ? "video" : "image";
    calls.push({ url, auth: key ?? headers.get("authorization") ?? "", kind });
    if (key !== KEY && headers.get("authorization") !== `Bearer ${TOKEN}`) {
      return json({ error: { code: 400, message: `API key not valid: ${key}. Please pass a valid API key.` } }, 400);
    }
    const usageMetadata = { promptTokenCount: 3000, candidatesTokenCount: 100 };
    // The "generated" picture is the frame it was sent.
    if (kind === "image") return json({ candidates: [{ content: { parts: [{ inlineData: media }] } }], usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 1290 } });
    const text = JSON.stringify(kind === "video" ? VISUAL : String(init.body).includes("on-screen hook") ? COPY : { ok: true });
    return json({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata });
  }) as typeof fetch;
  return { calls, doFetch };
}

let dir: string;
let google: ReturnType<typeof fakeGoogle>;
let seen: string[];
let runtime: Runtime | null;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "clipfarm-google-test-"));
  google = fakeGoogle();
  seen = [];
  runtime = null;
  vi.stubGlobal("fetch", google.doFetch);
  for (const level of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      seen.push(args.map((a) => (a instanceof Error ? `${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
});
afterEach(async () => {
  runtime?.queue.stop();
  await runtime?.queue.idle();
  runtime?.db.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

/** The app as index.ts wires it: the real Vertex adapter on the stand-in network, a stand-in for downloads only. */
function setup() {
  const env: NodeJS.ProcessEnv = { DATA_DIR: dir, MEDIA_DIR: join(dir, "media"), DOWNLOADER: "fake" };
  const rt = (runtime = openRuntime(env));
  const app = createApp({
    sources: rt.sources, vods: rt.vods, picks: rt.picks, queue: rt.queue, clips: rt.clips, posts: rt.posts, publisher: rt.publisher,
    engine: { engine: rt.config.engine, fake: false },
    google: { ai: rt.config.google, thumbs: rt.thumbs, auto: true },
    settings: { store: rt.settings, demo: false },
  });
  const call = async (method: "get" | "put" | "post" | "delete", path: string, body?: object) => {
    const res = await request(app)[method](path).send(body);
    seen.push(`${method} ${path} ${res.status} ${JSON.stringify(res.headers)} ${res.text}`);
    return res;
  };
  /** A transcribed 2-minute video with one loud, shouted moment: the local engine picks it without any model. */
  const vodWithMoment = () => {
    const source = rt.sources.create(campaignInput({ briefRules: "Credit the streamer." }));
    const vod = rt.vods.create(source.id, "https://www.twitch.tv/videos/1");
    const say = (text: string, at: number): Word[] => text.split(" ").map((w, i) => ({ word: w, startSec: at + i * 0.5, endSec: at + i * 0.5 + 0.4 }));
    const words = [...say("we are driving to the next mission now.", 5), ...say("NO WAY! He actually jumped off the roof! That was insane, clip it!", 40), ...say("okay calm down we still need to finish the delivery.", 80)];
    rt.vods.saveMeta(vod.id, { title: "GTA night", durationSec: 120, chapters: [] });
    rt.vods.saveTranscript(vod.id, words, "fake", 0);
    rt.vods.saveLoudness(vod.id, Array.from({ length: 120 }, (_, i) => (i >= 40 && i < 50 ? -8 : -30)));
    return { source, vod };
  };
  // The picks step as runtime.ts wires it, on a queue of its own so nothing is rendered afterwards.
  const picksQueue = new JobQueue(openDb(":memory:"), {
    handlers: {
      [PICKS_JOB]: picksHandler({
        sources: rt.sources, vods: rt.vods, picks: rt.picks, picker: rt.config.picker, maxPicks: rt.config.maxPicks,
        rerank: videoReranker({ google: rt.config.google, proxy: proxyMaker(rt.config.sectionDownloader) }),
      }),
    },
    tmpRoot: dir,
  });
  const runPicks = async (vodId: number) => {
    const job = picksQueue.enqueue(PICKS_JOB, { vodId }, { maxAttempts: 1 });
    await picksQueue.idle();
    return picksQueue.list(200).find((j) => j.id === job.id)!;
  };
  return { rt, call, vodWithMoment, runPicks };
}

const save = (values: Record<string, string>) => ["/api/settings/google", { values }] as const;
const row = (info: SettingsInfo) => info.integrations.find((i) => i.id === "google")!;

describe("Google (Vertex AI) in Settings", () => {
  it("needs a project and one credential; the values are never sent back; Test makes one tiny call", async () => {
    const { call } = setup();
    expect(row((await call("get", "/api/settings")).body).configured).toBe(false);
    expect((await call("post", "/api/settings/google/test")).body.message).toBe("Not set yet: Project ID, an API key or a service account JSON.");

    await call("put", ...save({ GOOGLE_CLOUD_PROJECT: "leonida-clips" }));
    expect((await call("get", "/api/health")).body.configured.google).toBe(false);
    const saved = await call("put", ...save({ GOOGLE_API_KEY: KEY }));
    const info = row(saved.body);
    expect(info.configured).toBe(true);
    expect(info.fields.find((f) => f.name === "GOOGLE_API_KEY")).toMatchObject({ set: true, value: null, ending: "r3s4" });
    expect(info.fields.find((f) => f.name === "GOOGLE_CLOUD_PROJECT")).toMatchObject({ value: "leonida-clips" });

    const test = await call("post", "/api/settings/google/test");
    expect(test.body).toMatchObject({ ok: true, message: "Works: gemini-3.1-flash-lite answered." });
    expect(google.calls).toEqual([
      { url: "https://aiplatform.googleapis.com/v1/projects/leonida-clips/locations/global/publishers/google/models/gemini-3.1-flash-lite:generateContent", auth: KEY, kind: "text" },
    ]);
    expect((await call("get", "/api/google")).body).toMatchObject({ configured: true, creditEur: 269, expiresAt: "2027-02-11", spentEur: 0 });
  });

  it("takes a service account key file pasted whole, signs in with it, and shows nothing of it", async () => {
    const { call } = setup();
    const saved = await call("put", ...save({ GOOGLE_CLOUD_PROJECT: "leonida-clips", GOOGLE_CLOUD_LOCATION: "europe-west4", GOOGLE_SERVICE_ACCOUNT_JSON: ACCOUNT }));
    expect(saved.status).toBe(200);
    expect(row(saved.body).fields.find((f) => f.name === "GOOGLE_SERVICE_ACCOUNT_JSON")).toMatchObject({ set: true, value: null, ending: null });
    expect((await call("post", "/api/settings/google/test")).body.ok).toBe(true);
    expect(google.calls.map((c) => [c.kind, c.auth])).toEqual([["token", ""], ["text", `Bearer ${TOKEN}`]]);
    expect(google.calls[1]!.url).toContain("https://europe-west4-aiplatform.googleapis.com/");
    // On disk it is one line in the same 600 file as the other keys.
    expect(JSON.parse(await readFile(join(dir, "secrets.json"), "utf8")).values.GOOGLE_SERVICE_ACCOUNT_JSON.value).not.toContain("\n");
  });

  it("refuses what cannot be right, without repeating it", async () => {
    const { call } = setup();
    const notAFile = await call("put", ...save({ GOOGLE_SERVICE_ACCOUNT_JSON: '{"client_email":"only-half-of-it-0000"}' }));
    expect(notAFile.status).toBe(400);
    expect(notAFile.body.error).toBe("Service account JSON (instead of an API key): that is not a service account key file. Copy the whole file again.");
    const where = await call("put", ...save({ GOOGLE_CLOUD_LOCATION: "mars-north1" }));
    expect(where.body.error).toBe("Location (optional): it must be one of global, europe-west4, us-central1.");
  });

  it("a refused key is said in Google's words, with the key taken out", async () => {
    const { call } = setup();
    await call("put", ...save({ GOOGLE_CLOUD_PROJECT: "leonida-clips", GOOGLE_API_KEY: BAD_KEY }));
    const test = await call("post", "/api/settings/google/test");
    expect(test.body).toMatchObject({ ok: false, message: "Google says: API key not valid: ***. Please pass a valid API key." });
  });
});

describe("Google in the pipeline, as the server wires it", () => {
  it("picks are watched, hooks come from Gemini, the spend shows up, and a refusing Google costs nothing but a log line", { timeout: 120_000 }, async () => {
    const { rt, call, vodWithMoment, runPicks } = setup();
    const { vod } = vodWithMoment();

    // A wrong key first: Google refuses (repeating the key), and the job finishes on the local engine alone.
    await call("put", ...save({ GOOGLE_CLOUD_PROJECT: "leonida-clips", GOOGLE_API_KEY: BAD_KEY }));
    expect((await runPicks(vod.id)).status).toBe("done");
    const local = rt.picks.listForVod(vod.id);
    expect(local.length).toBeGreaterThan(0);
    expect(local[0]!.hook).toBe("He actually jumped off the roof!");
    expect(local[0]!.reason).not.toContain("+visual");
    expect((await call("get", "/api/google")).body).toMatchObject({ spentEur: 0, calls: 0 });

    await call("put", ...save({ GOOGLE_API_KEY: KEY }));
    expect((await runPicks(vod.id)).status).toBe("done");
    const picks = rt.picks.listForVod(vod.id);
    expect(picks[0]!.hook).toBe("GEMINI wrote this hook");
    expect(picks[0]!.reason).toContain("+visual: crash, 9/10, opens on the payoff");
    expect(picks[0]!.costUsd).toBeGreaterThan(0);
    const status = (await call("get", "/api/google")).body as GoogleStatus;
    expect(status.calls).toBe(google.calls.filter((c) => c.auth === KEY).length);
    expect(seen.join("\n")).toMatch(/\[google\] rerank gemini-3\.1-flash-lite: 3000 tokens in, 100 out, about €0\.0008/);
  });

  it("an approved clip gets thumbnail options at both sizes, and the manager's pick is kept", { timeout: 120_000 }, async () => {
    const { rt, call } = setup();
    await call("put", ...save({ GOOGLE_CLOUD_PROJECT: "leonida-clips", GOOGLE_API_KEY: KEY }));
    const source = rt.sources.create(campaignInput());
    const video = join(dir, "clip.mp4");
    await generateSample(video, 3, undefined, "540x960");
    const clip = rt.clips.create({ sourceId: source.id, vodId: null, title: "Kai jumps", filePath: video, durationSec: 3, hook: "He actually JUMPED" });

    expect((await call("get", `/api/clips/${clip.id}/thumbnails`)).body).toEqual({ thumbs: [], making: false, ai: true });
    await call("post", `/api/clips/${clip.id}/approve`);
    expect((await call("get", `/api/clips/${clip.id}/thumbnails`)).body.making).toBe(true);
    await rt.queue.idle();
    const made = (await call("get", `/api/clips/${clip.id}/thumbnails`)).body as ClipThumbs;
    expect(made.thumbs.map((t) => [t.label, t.ai, t.chosen])).toEqual([["Option A", true, false], ["Option B", true, false]]);
    expect(google.calls.filter((c) => c.kind === "image")).toHaveLength(2);

    const picked = (await call("post", `/api/thumbnails/${made.thumbs[1]!.id}/choose`)).body as ClipThumbs;
    expect(picked.thumbs.map((t) => t.chosen)).toEqual([false, true]);
    const cover = await call("get", picked.thumbs[1]!.coverUrl);
    expect(cover.status).toBe(200);
    expect(cover.headers["content-type"]).toBe("image/jpeg");
    expect(await probeVideo(rt.thumbs.files(picked.thumbs[1]!.id).wide)).toMatchObject({ width: 1280, height: 720 });
    expect((await call("get", `/api/thumbnails/${picked.thumbs[1]!.id}/poster`)).status).toBe(404);
    // Two pictures at $0.039 each, in euros.
    expect((await call("get", "/api/google")).body.spentEur).toBeCloseTo(0.07, 2);
  });

  it("the Dashboard's switches and limits are saved, and nonsense is refused in plain words", async () => {
    const { call } = setup();
    const saved = await call("put", "/api/google/settings", { dailyCapEur: 1.5, weight: 50, rerank: false });
    expect(saved.body.settings).toMatchObject({ dailyCapEur: 1.5, weight: 50, rerank: false, thumbnails: true });
    const bad = await call("put", "/api/google/settings", { dailyCapEur: "lots" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("The daily limit must be a number of euros, zero or more.");
  });

  it("no Google credential is in any answer or log line", { timeout: 120_000 }, async () => {
    const { rt, call, vodWithMoment, runPicks } = setup();
    const { vod } = vodWithMoment();
    await call("put", ...save({ GOOGLE_CLOUD_PROJECT: "leonida-clips", GOOGLE_API_KEY: BAD_KEY }));
    await call("post", "/api/settings/google/test");
    await runPicks(vod.id);
    await call("put", ...save({ GOOGLE_API_KEY: KEY, GOOGLE_SERVICE_ACCOUNT_JSON: ACCOUNT }));
    await call("post", "/api/settings/google/test");
    await runPicks(vod.id);
    await call("put", ...save({ GOOGLE_SERVICE_ACCOUNT_JSON: `${ACCOUNT.slice(0, 400)} cut off` }));
    for (const path of ["/api/settings", "/api/setup", "/api/health", "/api/google", "/api/jobs", "/api/picks", "/api/engine", `/api/vods/${vod.id}`, "/api/nope"]) await call("get", path);
    await call("delete", "/api/settings/google");

    const everything = seen.join("\n");
    // The check is not empty-handed: the refusals, the failed video check and the key's ending are in there.
    expect(everything).toContain("Google says: API key not valid: ***");
    expect(everything).toContain("[google] the video check failed, keeping the local picks: Google says: API key not valid: ***");
    expect(everything).toContain('"ending":"r3s4"');
    const keyBody = PRIVATE_KEY.split("\n")[1]!;
    for (const secret of [KEY, BAD_KEY, keyBody, "BEGIN PRIVATE KEY", TOKEN, rt.settings.get("GOOGLE_SERVICE_ACCOUNT_JSON") ?? "never-set"]) {
      expect(everything.includes(secret), `a credential starting ${secret.slice(0, 6)} leaked`).toBe(false);
    }
  });
});
