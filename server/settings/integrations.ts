import type { IntegrationId, IntegrationStatus, SettingsInfo } from "../../shared/types.js";
import { INTEGRATION_IDS } from "../../shared/types.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { DEFAULT_FLASH_MODEL, DEFAULT_IMAGE_MODEL, GOOGLE_LOCATIONS, parseServiceAccount } from "../google/client.js";
import type { Settings } from "./store.js";

interface FieldDef {
  name: string;
  label: string;
  secret: boolean;
  required: boolean;
  placeholder: string;
  /** An address: must start with http:// or https://. */
  url?: boolean;
  /** The only values it takes. */
  options?: readonly string[];
  /** A Google service account key file, pasted whole: checked, and kept on one line. */
  serviceAccount?: boolean;
}

interface IntegrationDef {
  id: IntegrationId;
  label: string;
  purpose: string;
  fields: FieldDef[];
  /** Besides the required fields, one of these must be set (two ways to sign in). */
  oneOf?: string[];
}

const key = (name: string, label: string, placeholder = "Paste it here", required = true): FieldDef => ({
  name,
  label,
  secret: true,
  required,
  placeholder,
});
const plain = (name: string, label: string, placeholder: string, required: boolean, url = false): FieldDef => ({
  name,
  label,
  secret: false,
  required,
  placeholder,
  url,
});

/**
 * Every key and connection the server reads (see config.ts), by the env name it has always had.
 * What is left to the env file on purpose: where the server listens, its folders, the access gate
 * and demo mode. Those are the box's business, and a web form must not be able to open the gate.
 */
export const INTEGRATIONS: IntegrationDef[] = [
  {
    id: "openai",
    label: "OpenAI",
    purpose: "Optional speed-up. clipfarm transcribes and picks on its own server; with this key you can switch on \"Use cloud AI for speed\" on the Dashboard.",
    fields: [
      key("OPENAI_API_KEY", "API key", "sk-…"),
      plain("LLM_BASE_URL", "Picking model address (optional)", "https://api.openai.com/v1", false, true),
      plain("LLM_MODEL", "Picking model name (optional)", "gpt-4o-mini", false),
      key("LLM_API_KEY", "Picking model key (optional, when it is not OpenAI)", "Leave empty to use the OpenAI key", false),
    ],
  },
  {
    id: "google",
    label: "Google (Gemini)",
    purpose:
      "Optional, paid from the Google Cloud credit. Gemini watches the best picks to score what a transcript cannot show, writes hooks when the local writer cannot, and makes thumbnail options for approved clips. Its spend and limits are on the Dashboard.",
    fields: [
      plain("GOOGLE_CLOUD_PROJECT", "Project ID", "leonida-clips", true),
      { ...plain("GOOGLE_CLOUD_LOCATION", "Location (optional)", GOOGLE_LOCATIONS.join(", "), false), options: GOOGLE_LOCATIONS },
      key("GOOGLE_API_KEY", "API key (or use the service account below)", "Paste it here", false),
      { ...key("GOOGLE_SERVICE_ACCOUNT_JSON", "Service account JSON (instead of an API key)", "Paste the whole key file", false), serviceAccount: true },
      plain("GOOGLE_FLASH_MODEL", "Video and text model (optional)", DEFAULT_FLASH_MODEL, false),
      plain("GOOGLE_IMAGE_MODEL", "Thumbnail model (optional)", DEFAULT_IMAGE_MODEL, false),
    ],
    oneOf: ["GOOGLE_API_KEY", "GOOGLE_SERVICE_ACCOUNT_JSON"],
  },
  {
    id: "twitch",
    label: "Twitch",
    purpose: "Shows who on the watchlist is live and finds their new streams.",
    fields: [key("TWITCH_CLIENT_ID", "Client ID"), key("TWITCH_CLIENT_SECRET", "Client Secret")],
  },
  {
    id: "youtube",
    label: "YouTube",
    purpose: "Finds new streams and live channels on YouTube.",
    fields: [key("YOUTUBE_API_KEY", "YouTube Data API key", "AIza…")],
  },
  {
    id: "postiz",
    label: "Postiz",
    purpose: "Posts approved clips to the accounts linked in Postiz.",
    fields: [
      plain("POSTIZ_URL", "Postiz address", "http://127.0.0.1:5300", true, true),
      key("POSTIZ_API_KEY", "API key"),
    ],
  },
  {
    id: "upload-post",
    label: "Upload-Post",
    purpose: "Another way to post, instead of Postiz.",
    fields: [
      key("UPLOAD_POST_API_KEY", "API key"),
      plain("UPLOAD_POST_USER", "Profile name", "gtavimoments", true),
      plain("UPLOAD_POST_PLATFORMS", "Platforms on that profile (optional)", "tiktok,youtube,instagram", false),
    ],
  },
];

/** Every setting this screen owns → whether it is a key (never shown, scrubbed from messages). */
export const SETTING_NAMES: ReadonlyMap<string, boolean> = new Map(
  INTEGRATIONS.flatMap((i) => i.fields.map((f) => [f.name, f.secret] as const)),
);

export function integration(id: unknown): IntegrationDef {
  const def = INTEGRATIONS.find((i) => i.id === id);
  if (!def) throw new NotFoundError("There is no such connection.");
  return def;
}

export function isConfigured(settings: Settings, id: IntegrationId): boolean {
  const def = integration(id);
  if (def.oneOf && !def.oneOf.some((name) => settings.get(name) !== undefined)) return false;
  return def.fields.every((f) => !f.required || settings.get(f.name) !== undefined);
}

/** For /api/health, which is open: yes or no per connection, nothing else. */
export function configuredMap(settings: Settings): Record<IntegrationId, boolean> {
  return Object.fromEntries(INTEGRATION_IDS.map((id) => [id, isConfigured(settings, id)])) as Record<IntegrationId, boolean>;
}

/** Keys shorter than this show no ending: 4 characters would be too much of them. */
const MIN_LENGTH_FOR_ENDING = 12;

/** What the Settings screen gets. A key's value is never in here, only "set" and its last 4 characters. */
export function settingsInfo(settings: Settings, opts: { demo: boolean; posting: string }): SettingsInfo {
  const both = isConfigured(settings, "postiz") && isConfigured(settings, "upload-post");
  const integrations: IntegrationStatus[] = INTEGRATIONS.map((def) => {
    let note: string | null = null;
    if (both && (def.id === "postiz" || def.id === "upload-post")) {
      note = opts.posting === def.id ? "In use for posting." : "Not in use: posting goes through the other one while both are set.";
    }
    return {
      id: def.id,
      label: def.label,
      purpose: def.purpose,
      configured: isConfigured(settings, def.id),
      test: settings.testResult(def.id),
      note,
      fields: def.fields.map((f) => {
        const value = settings.get(f.name);
        return {
          name: f.name,
          label: f.label,
          secret: f.secret,
          required: f.required,
          placeholder: f.placeholder,
          set: value !== undefined,
          source: settings.source(f.name),
          // A key file ends in a bracket, which tells nothing apart.
          ending: f.secret && !f.serviceAccount && value && value.length >= MIN_LENGTH_FOR_ENDING ? value.slice(-4) : null,
          value: f.secret ? null : (value ?? null),
          savedAt: settings.savedAt(f.name),
        };
      }),
    };
  });
  return { integrations, demo: opts.demo };
}

/**
 * Reads a Save from the screen. An empty key field means "keep the one that is set" (the screen
 * never has the value to send back); an empty address or name removes the saved one.
 */
export function parseSettingsInput(def: IntegrationDef, body: unknown): Record<string, string | null> {
  const values = (body as { values?: unknown } | null)?.values;
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new ValidationError("Paste a value first.");
  const known = new Map(def.fields.map((f) => [f.name, f]));
  const out: Record<string, string | null> = {};
  for (const [name, raw] of Object.entries(values)) {
    const field = known.get(name);
    if (!field) throw new ValidationError(`${def.label} has no setting called that.`);
    if (typeof raw !== "string") throw new ValidationError(`${field.label}: paste it as text.`);
    const value = raw.trim();
    if (value === "") {
      if (!field.secret) out[name] = null;
      continue;
    }
    // The message never repeats what was pasted.
    if (field.serviceAccount) {
      if (value.length > 10_000 || !parseServiceAccount(value)) {
        throw new ValidationError(`${field.label}: that is not a service account key file. Copy the whole file again.`);
      }
      // One line, as the settings file keeps every other key.
      out[name] = JSON.stringify(JSON.parse(value));
      continue;
    }
    if (value.length > 500) throw new ValidationError(`${field.label}: that is too long to be right. Copy it again.`);
    if (/[\s\p{Cc}]/u.test(value)) throw new ValidationError(`${field.label}: it has a space or line break in it. Copy it again.`);
    if (field.url) {
      let ok = false;
      try {
        ok = ["http:", "https:"].includes(new URL(value).protocol);
      } catch {
        /* handled below */
      }
      if (!ok) throw new ValidationError(`${field.label}: it must start with https:// or http://.`);
    }
    if (field.options && !field.options.includes(value)) throw new ValidationError(`${field.label}: it must be one of ${field.options.join(", ")}.`);
    out[name] = value;
  }
  if (Object.keys(out).length === 0) throw new ValidationError("Paste a value first.");
  return out;
}
