import type { IntegrationId, Platform } from "../../shared/types.js";
import { PLATFORMS } from "../../shared/types.js";
import { VertexGemini } from "../google/client.js";
import { PostingServiceError } from "../publish/errors.js";
import { PostizService } from "../publish/postiz.js";
import { UploadPostService } from "../publish/uploadPost.js";
import { ChatFailedError, chatFor } from "../pipeline/picks/llm.js";
import { OPENAI_BASE_URL, OpenAiTranscriber, TranscriptionFailedError } from "../pipeline/transcript/openai.js";
import { integration, isConfigured } from "./integrations.js";
import { DEMO_FACTS, openAiSetup, pickChatOptions } from "./openai.js";
import type { Settings } from "./store.js";

/** A test that failed for a reason worth showing as it is. */
class TestFailed extends Error {}

/** What a service said went wrong, from the usual places in its JSON answer. */
function saidBy(body: string): string | null {
  try {
    const p = JSON.parse(body) as { message?: unknown; msg?: unknown; error_description?: unknown; error?: unknown };
    const nested = (p.error as { message?: unknown } | null)?.message;
    const said = [nested, p.message, p.error_description, p.msg, p.error].find((x) => typeof x === "string" && x.trim());
    return typeof said === "string" ? said.trim().replace(/\.$/, "").slice(0, 200) : null;
  } catch {
    return null;
  }
}

/** One read-only call. A refusal comes back in the service's own words: "Twitch says: invalid client secret". */
async function ask<T>(label: string, url: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    const cause = (err as { cause?: { code?: string } })?.cause?.code;
    const reason = err instanceof DOMException && err.name === "TimeoutError" ? "no answer in time" : (cause ?? "no connection");
    throw new TestFailed(`${label} could not be reached (${reason}).`);
  }
  const body = await res.text();
  if (!res.ok) {
    const said = saidBy(body);
    throw new TestFailed(said ? `${label} says: ${said}.` : `${label} answered with an error (HTTP ${res.status}).`);
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new TestFailed(`${label} sent an answer that is not JSON. Is the address right?`);
  }
}

/** Why a call to a model failed, in the service's own words where it gave any. */
function whyFailed(err: unknown): string {
  if (err instanceof ChatFailedError || err instanceof TranscriptionFailedError) return saidBy(err.body) ?? `HTTP ${err.status}`;
  if (err instanceof DOMException && err.name === "TimeoutError") return "no answer in time";
  if (err instanceof TypeError) return "no connection";
  return (err instanceof Error ? err.message : String(err)).replace(/\.$/, "");
}

/** Two seconds of a quiet tone as a WAV file (16 kHz, mono), made in memory: no ffmpeg job, no temp file. */
function sampleWav(seconds = 2): Uint8Array<ArrayBuffer> {
  const rate = 16000;
  const samples = rate * seconds;
  const wav = new DataView(new ArrayBuffer(44 + samples * 2));
  const text = (at: number, s: string) => [...s].forEach((c, i) => wav.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  wav.setUint32(4, 36 + samples * 2, true);
  text(8, "WAVEfmt ");
  wav.setUint32(16, 16, true);
  wav.setUint16(20, 1, true);
  wav.setUint16(22, 1, true);
  wav.setUint32(24, rate, true);
  wav.setUint32(28, rate * 2, true);
  wav.setUint16(32, 2, true);
  wav.setUint16(34, 16, true);
  text(36, "data");
  wav.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) wav.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 3000), true);
  return new Uint8Array(wav.buffer);
}

const PING_SCHEMA = { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } };

type Tester = (get: (name: string) => string, settings: Settings) => Promise<string>;

/** One cheap call per connection (OpenAI: three small ones). Each returns what to show under "Working". */
const TESTERS: Record<IntegrationId, Tester> = {
  // The key (a free model list), the picking model (one tiny answer), and a 2-second transcription sample.
  async openai(get, settings) {
    const models = async (label: string, base: string, key: string) => {
      const list = await ask<{ data?: { id?: unknown }[] }>(label, `${base}/models`, { headers: { Authorization: `Bearer ${key}` } });
      return (Array.isArray(list.data) ? list.data : []).map((m) => m?.id).filter((x): x is string => typeof x === "string");
    };
    const key = get("OPENAI_API_KEY");
    const openAiModels = await models("OpenAI", OPENAI_BASE_URL, key);
    const setup = openAiSetup(settings);
    const chat = pickChatOptions(settings)!;
    const label = setup.official ? "OpenAI" : "The picking model";
    const sameList = setup.baseUrl === OPENAI_BASE_URL && chat.apiKey === key;
    const pickModels = sameList ? openAiModels : await models(label, setup.baseUrl, chat.apiKey);
    // The dropdowns fill from these lists, whatever the rest of the test finds.
    settings.setOpenAiFacts({ pickModels, openAiModels, probe: null });
    if (pickModels.length > 0 && !pickModels.includes(setup.model)) {
      throw new TestFailed(`The key works, but there is no model called "${setup.model}" there. Pick another picking model.`);
    }
    try {
      await chatFor(chat).complete(
        { system: "You answer in JSON.", user: "Set ok to true.", schemaName: "ping", schema: PING_SCHEMA },
        AbortSignal.timeout(30_000),
      );
    } catch (err) {
      throw new TestFailed(`The key works, but the picking model "${setup.model}" did not answer: ${whyFailed(err)}.`);
    }
    let used: string;
    try {
      const transcriber = new OpenAiTranscriber({ apiKey: key, model: setup.transcribeChoice });
      used = (await transcriber.sample(sampleWav(), "sample.wav", AbortSignal.timeout(30_000))).model;
    } catch (err) {
      throw new TestFailed(`Picks work, but the 2-second transcription sample failed: ${whyFailed(err)}.`);
    }
    settings.setOpenAiFacts({ pickModels, openAiModels, probe: { model: setup.transcribeChoice, wordTimings: used === setup.transcribeChoice } });
    return `Works: key valid, picks with ${setup.model}, transcription with ${used}.`;
  },

  // One tiny generateContent call (a fraction of a cent), signed in exactly as the pipeline will be.
  async google(get) {
    const gemini = new VertexGemini({
      project: get("GOOGLE_CLOUD_PROJECT"),
      location: get("GOOGLE_CLOUD_LOCATION"),
      apiKey: get("GOOGLE_API_KEY"),
      serviceAccountJson: get("GOOGLE_SERVICE_ACCOUNT_JSON"),
      flashModel: get("GOOGLE_FLASH_MODEL"),
      imageModel: get("GOOGLE_IMAGE_MODEL"),
    });
    try {
      await gemini.generateJson(
        { system: "Answer in JSON.", text: "Is this a test? Answer ok: true.", schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } } },
        AbortSignal.timeout(20_000),
      );
    } catch (err) {
      const said = err instanceof Error && /^(The )?Google /.test(err.message) ? err.message : "Google could not be reached.";
      throw new TestFailed(said);
    }
    return `Works: ${gemini.flashModel} answered.`;
  },

  // The same two calls the watchlist makes: an app token, then one page of live streams.
  async twitch(get) {
    const q = new URLSearchParams({ client_id: get("TWITCH_CLIENT_ID"), client_secret: get("TWITCH_CLIENT_SECRET"), grant_type: "client_credentials" });
    const token = await ask<{ access_token: string }>("Twitch", `https://id.twitch.tv/oauth2/token?${q}`, { method: "POST" });
    await ask("Twitch", "https://api.twitch.tv/helix/streams?first=1", {
      headers: { "Client-Id": get("TWITCH_CLIENT_ID"), Authorization: `Bearer ${token.access_token}` },
    });
    return "Works.";
  },

  // videos.list for one id: 1 of the 10,000 free quota units a day.
  async youtube(get) {
    const q = new URLSearchParams({ part: "id", id: "jNQXAC9IVRw", key: get("YOUTUBE_API_KEY") });
    await ask("YouTube", `https://www.googleapis.com/youtube/v3/videos?${q}`);
    return "Works.";
  },

  async postiz(get) {
    const accounts = await new PostizService({ url: get("POSTIZ_URL"), apiKey: get("POSTIZ_API_KEY") }).listAccounts();
    if (accounts.length === 0) return "Works, but no account is linked in Postiz yet.";
    return `Works: ${accounts.length} account${accounts.length === 1 ? "" : "s"} linked.`;
  },

  async "upload-post"(get) {
    const platforms = (get("UPLOAD_POST_PLATFORMS") || "tiktok,youtube,instagram")
      .split(",")
      .map((p) => p.trim())
      .filter((p): p is Platform => PLATFORMS.includes(p as Platform));
    const service = new UploadPostService({ apiKey: get("UPLOAD_POST_API_KEY"), user: get("UPLOAD_POST_USER"), platforms });
    await service.accountStats(await service.listAccounts());
    return "Works.";
  },
};

/**
 * Tests the keys in use for one connection and remembers the result. Never throws for a bad key:
 * the answer is a plain line, with every key scrubbed out of it.
 */
export async function testIntegration(id: IntegrationId, settings: Settings, demo: boolean): Promise<{ ok: boolean; message: string }> {
  const def = integration(id);
  let result: { ok: boolean; message: string };
  if (!isConfigured(settings, id)) {
    const missing = def.fields.filter((f) => f.required && settings.get(f.name) === undefined).map((f) => f.label);
    if (def.oneOf && !def.oneOf.some((name) => settings.get(name) !== undefined)) missing.push("an API key or a service account JSON");
    result = { ok: false, message: `Not set yet: ${missing.join(", ")}.` };
  } else if (demo) {
    if (id === "openai") settings.setOpenAiFacts(DEMO_FACTS);
    result = { ok: true, message: "Saved. Demo mode: nothing outside was called." };
  } else {
    try {
      result = { ok: true, message: await TESTERS[id]((name) => settings.get(name) ?? "", settings) };
    } catch (err) {
      // Our own plain messages (and the posting services') are shown; anything else is a bug to log.
      const known = err instanceof TestFailed || err instanceof PostingServiceError;
      if (!known) console.error(`Testing ${def.label} failed:`, settings.scrub(err instanceof Error ? err.message : String(err)));
      result = { ok: false, message: known ? settings.scrub((err as Error).message) : `${def.label} could not be tested. Try again.` };
    }
  }
  settings.setTestResult(id, { ...result, at: new Date().toISOString() });
  return result;
}
