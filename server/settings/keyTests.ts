import type { IntegrationId, Platform } from "../../shared/types.js";
import { PLATFORMS } from "../../shared/types.js";
import { PostingServiceError } from "../publish/errors.js";
import { PostizService } from "../publish/postiz.js";
import { UploadPostService } from "../publish/uploadPost.js";
import { integration, isConfigured } from "./integrations.js";
import type { Settings } from "./store.js";

const OPENAI = "https://api.openai.com/v1";

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

type Tester = (get: (name: string) => string) => Promise<string>;

/** One cheap, read-only call per connection. Each returns what to show after "Works". */
const TESTERS: Record<IntegrationId, Tester> = {
  // Lists models (free). When picks use another provider or model, that one is asked too.
  async openai(get) {
    const bearer = (k: string) => ({ headers: { Authorization: `Bearer ${k}` } });
    await ask("OpenAI", `${OPENAI}/models`, bearer(get("OPENAI_API_KEY")));
    const base = (get("LLM_BASE_URL") || OPENAI).replace(/\/+$/, "");
    const model = get("LLM_MODEL") || "gpt-4o-mini";
    const label = base === OPENAI ? "OpenAI" : "The picking model";
    const list = await ask<{ data?: { id?: unknown }[] }>(label, `${base}/models`, bearer(get("LLM_API_KEY") || get("OPENAI_API_KEY")));
    const ids = (Array.isArray(list.data) ? list.data : []).map((m) => m?.id).filter((x) => typeof x === "string");
    if (ids.length > 0 && !ids.includes(model)) {
      throw new TestFailed(`The key works, but there is no model called "${model}" there. Check the picking model name.`);
    }
    return "Works.";
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
    result = { ok: false, message: `Not set yet: ${missing.join(", ")}.` };
  } else if (demo) {
    result = { ok: true, message: "Saved. Demo mode: nothing outside was called." };
  } else {
    try {
      result = { ok: true, message: await TESTERS[id]((name) => settings.get(name) ?? "") };
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
