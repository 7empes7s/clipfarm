import { createSign } from "node:crypto";

export interface GeminiMedia {
  mimeType: string;
  data: Buffer;
}

export interface GeminiJsonRequest {
  system: string;
  text: string;
  /** JSON schema of the answer. */
  schema: Record<string, unknown>;
  /** A short video (or image) to look at, sent inline. */
  media?: GeminiMedia;
}

export interface GeminiImageRequest {
  prompt: string;
  /** The frame to build the picture from. */
  image: GeminiMedia;
  aspectRatio: "9:16" | "16:9";
}

/** What a call used, for the spend guard. */
export interface GeminiUsage {
  model: string;
  inTokens: number;
  outTokens: number;
}

/** Gemini behind an interface: the real one calls Vertex AI, tests and demo mode use a fake. */
export interface GeminiClient {
  readonly flashModel: string;
  readonly imageModel: string;
  generateJson(req: GeminiJsonRequest, signal?: AbortSignal): Promise<{ text: string } & GeminiUsage>;
  generateImage(req: GeminiImageRequest, signal?: AbortSignal): Promise<{ image: Buffer; mimeType: string } & GeminiUsage>;
}

export const GOOGLE_LOCATIONS = ["global", "europe-west4", "us-central1"] as const;
/** The most cost-efficient Flash model that takes video (the model list on Google's docs, read 2026-11-13). */
export const DEFAULT_FLASH_MODEL = "gemini-3.1-flash-lite";
export const DEFAULT_IMAGE_MODEL = "gemini-2.5-flash-image";

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/** Reads a service account key file; null when the text is not one. */
export function parseServiceAccount(json: string): ServiceAccount | null {
  try {
    const p = JSON.parse(json) as Partial<ServiceAccount> | null;
    if (!p || typeof p.client_email !== "string" || typeof p.private_key !== "string" || !p.private_key.includes("PRIVATE KEY")) return null;
    return { client_email: p.client_email, private_key: p.private_key, token_uri: typeof p.token_uri === "string" ? p.token_uri : undefined };
  } catch {
    return null;
  }
}

export interface VertexOptions {
  project: string;
  /** "global" (the default), or a region. */
  location?: string;
  /** One of the two: an API key, or a service account key file's JSON. */
  apiKey?: string;
  serviceAccountJson?: string;
  flashModel?: string;
  imageModel?: string;
  /** Injected in tests so no real API is called. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/** Gemini's schema dialect has no `additionalProperties`; everything else our schemas use is supported. */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([k]) => k !== "additionalProperties")
      .map(([k, v]) => [k, toGeminiSchema(v)]),
  );
}

interface GenerateResponse {
  candidates?: { content?: { parts?: { text?: string; inlineData?: { mimeType?: string; data?: string } }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  error?: { message?: string };
}

/**
 * Gemini on Vertex AI over REST (`generateContent`), so its usage is paid from the Google Cloud
 * credit. Signs in with an API key, or with a service account (a signed JWT traded for a token
 * that is kept until shortly before it runs out).
 */
export class VertexGemini implements GeminiClient {
  readonly flashModel: string;
  readonly imageModel: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private token: { value: string; until: number } | null = null;

  constructor(private opts: VertexOptions) {
    this.flashModel = opts.flashModel || DEFAULT_FLASH_MODEL;
    this.imageModel = opts.imageModel || DEFAULT_IMAGE_MODEL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  async generateJson(req: GeminiJsonRequest, signal?: AbortSignal): Promise<{ text: string } & GeminiUsage> {
    const body = await this.call(
      this.flashModel,
      {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: "user", parts: [...(req.media ? [inline(req.media)] : []), { text: req.text }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
          responseSchema: toGeminiSchema(req.schema),
          // 1 frame a second at the low setting: a 40 s proxy costs a few thousand tokens.
          ...(req.media ? { mediaResolution: "MEDIA_RESOLUTION_LOW" } : {}),
        },
      },
      signal,
    );
    const text = (body.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
    if (!text) throw new Error("Google sent an empty answer.");
    return { text, ...this.usage(this.flashModel, body) };
  }

  async generateImage(req: GeminiImageRequest, signal?: AbortSignal): Promise<{ image: Buffer; mimeType: string } & GeminiUsage> {
    const body = await this.call(
      this.imageModel,
      {
        contents: [{ role: "user", parts: [inline(req.image), { text: req.prompt }] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: req.aspectRatio } },
      },
      signal,
    );
    const part = (body.candidates?.[0]?.content?.parts ?? []).find((p) => p.inlineData?.data);
    if (!part?.inlineData?.data) throw new Error("Google sent no picture.");
    const usage = this.usage(this.imageModel, body);
    return {
      image: Buffer.from(part.inlineData.data, "base64"),
      mimeType: part.inlineData.mimeType ?? "image/png",
      ...usage,
      // One picture is 1,290 tokens; counted even when the answer leaves the numbers out.
      outTokens: usage.outTokens || 1290,
    };
  }

  private usage(model: string, body: GenerateResponse): GeminiUsage {
    const u = body.usageMetadata ?? {};
    return { model, inTokens: u.promptTokenCount ?? 0, outTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) };
  }

  private async call(model: string, payload: unknown, signal?: AbortSignal): Promise<GenerateResponse> {
    const location = this.opts.location || "global";
    const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
    const url = `https://${host}/v1/projects/${encodeURIComponent(this.opts.project)}/locations/${location}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await this.authHeaders(signal)) },
      body: JSON.stringify(payload),
      signal,
    });
    const text = await res.text();
    let body: GenerateResponse = {};
    try {
      body = JSON.parse(text) as GenerateResponse;
    } catch {
      /* said below */
    }
    if (!res.ok) {
      const said = body.error?.message?.trim().replace(/\.$/, "").slice(0, 200);
      throw new Error(said ? `Google says: ${said}.` : `Google answered with an error (HTTP ${res.status}).`);
    }
    return body;
  }

  private async authHeaders(signal?: AbortSignal): Promise<Record<string, string>> {
    if (this.opts.serviceAccountJson) return { Authorization: `Bearer ${await this.accessToken(signal)}` };
    return { "x-goog-api-key": this.opts.apiKey ?? "" };
  }

  private async accessToken(signal?: AbortSignal): Promise<string> {
    if (this.token && this.now() < this.token.until) return this.token.value;
    const account = parseServiceAccount(this.opts.serviceAccountJson ?? "");
    if (!account) throw new Error("The Google service account JSON is not a key file. Paste it again in Settings.");
    const tokenUri = account.token_uri ?? "https://oauth2.googleapis.com/token";
    const iat = Math.floor(this.now() / 1000);
    const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
      JSON.stringify({ iss: account.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: tokenUri, iat, exp: iat + 3600 }),
    )}`;
    let assertion: string;
    try {
      assertion = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(account.private_key).toString("base64url")}`;
    } catch {
      // The signing error would quote the key.
      throw new Error("The Google service account key could not be used to sign in. Paste the JSON again in Settings.");
    }
    const res = await this.fetchImpl(tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      signal,
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !body.access_token) {
      throw new Error(body.error_description ? `Google says: ${body.error_description.slice(0, 200)}` : `Google did not accept the service account (HTTP ${res.status}).`);
    }
    this.token = { value: body.access_token, until: this.now() + Math.max(60, (body.expires_in ?? 3600) - 60) * 1000 };
    return this.token.value;
  }
}

function inline(media: GeminiMedia) {
  return { inlineData: { mimeType: media.mimeType, data: media.data.toString("base64") } };
}
