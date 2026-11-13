import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseServiceAccount, toGeminiSchema, VertexGemini } from "./client.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function recorder(answer: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; headers: Headers; body: string }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), headers: new Headers(init.headers), body: String(init.body ?? "") });
    return answer(String(input), init);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const answer = (text: string) => json({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 2900, candidatesTokenCount: 60, thoughtsTokenCount: 40 } });

describe("Gemini on Vertex AI", () => {
  it("sends a video inline with the schema to generateContent, signed with the API key, and reads the answer and its token counts", async () => {
    const { calls, fetchImpl } = recorder(() => answer('{"ok":true}'));
    const gemini = new VertexGemini({ project: "leonida-clips", apiKey: "AIzaSyVertexTestKey0000000000000q1w2", fetchImpl });
    const res = await gemini.generateJson({
      system: "Watch.",
      text: "Score it.",
      schema: { type: "object", additionalProperties: false, properties: { flags: { type: "object", additionalProperties: false, properties: { leak: { type: "boolean" } } } } },
      media: { mimeType: "video/mp4", data: Buffer.from("video") },
    });
    expect(res).toEqual({ text: '{"ok":true}', model: "gemini-3.1-flash-lite", inTokens: 2900, outTokens: 100 });
    expect(calls[0]!.url).toBe(
      "https://aiplatform.googleapis.com/v1/projects/leonida-clips/locations/global/publishers/google/models/gemini-3.1-flash-lite:generateContent",
    );
    expect(calls[0]!.headers.get("x-goog-api-key")).toBe("AIzaSyVertexTestKey0000000000000q1w2");
    const body = JSON.parse(calls[0]!.body) as {
      contents: { parts: unknown[] }[];
      systemInstruction: unknown;
      generationConfig: { responseSchema: { properties: { flags: { properties: { leak: unknown } } } } };
    };
    expect(body.contents[0]!.parts).toEqual([{ inlineData: { mimeType: "video/mp4", data: Buffer.from("video").toString("base64") } }, { text: "Score it." }]);
    expect(body.systemInstruction).toEqual({ parts: [{ text: "Watch." }] });
    expect(body.generationConfig).toMatchObject({ responseMimeType: "application/json", mediaResolution: "MEDIA_RESOLUTION_LOW" });
    // Gemini's schema dialect has no additionalProperties.
    expect(JSON.stringify(body.generationConfig.responseSchema)).not.toContain("additionalProperties");
    expect(body.generationConfig.responseSchema.properties.flags.properties.leak).toEqual({ type: "boolean" });
  });

  it("uses the region's own address when one is set, and the chosen models", async () => {
    const { calls, fetchImpl } = recorder(() => answer("{}"));
    await new VertexGemini({ project: "p", location: "europe-west4", apiKey: "k", flashModel: "gemini-3.5-flash-lite", fetchImpl }).generateJson({ system: "s", text: "t", schema: {} });
    expect(calls[0]!.url).toBe("https://europe-west4-aiplatform.googleapis.com/v1/projects/p/locations/europe-west4/publishers/google/models/gemini-3.5-flash-lite:generateContent");
  });

  it("asks the image model for a 9:16 picture from a frame and returns its bytes", async () => {
    const { calls, fetchImpl } = recorder(() =>
      json({ candidates: [{ content: { parts: [{ text: "Here you go" }, { inlineData: { mimeType: "image/png", data: Buffer.from("picture").toString("base64") } }] } }] }),
    );
    const gemini = new VertexGemini({ project: "p", apiKey: "k", fetchImpl });
    const res = await gemini.generateImage({ prompt: "Make a thumbnail", image: { mimeType: "image/jpeg", data: Buffer.from("frame") }, aspectRatio: "9:16" });
    expect(res.image.toString()).toBe("picture");
    // No token counts in the answer: one picture is still counted (1,290 tokens).
    expect(res).toMatchObject({ mimeType: "image/png", model: "gemini-2.5-flash-image", outTokens: 1290 });
    expect(calls[0]!.url).toContain("/models/gemini-2.5-flash-image:generateContent");
    const body = JSON.parse(calls[0]!.body) as { generationConfig: unknown; contents: { parts: { inlineData: { mimeType: string } }[] }[] };
    expect(body.generationConfig).toEqual({ responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "9:16" } });
    expect(body.contents[0]!.parts[0]!.inlineData.mimeType).toBe("image/jpeg");
  });

  it("signs in with a service account: a signed token request, then Bearer, and the token is reused until it runs out", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const account = JSON.stringify({ type: "service_account", client_email: "clipfarm@leonida-clips.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
    let now = 1_800_000_000_000;
    const { calls, fetchImpl } = recorder((url) => (url.includes("oauth2") ? json({ access_token: "ya29.token", expires_in: 3600 }) : answer("{}")));
    const gemini = new VertexGemini({ project: "p", serviceAccountJson: account, fetchImpl, now: () => now });
    await gemini.generateJson({ system: "s", text: "t", schema: {} });
    await gemini.generateJson({ system: "s", text: "t", schema: {} });
    expect(calls.map((c) => new URL(c.url).host)).toEqual(["oauth2.googleapis.com", "aiplatform.googleapis.com", "aiplatform.googleapis.com"]);
    expect(calls[1]!.headers.get("authorization")).toBe("Bearer ya29.token");
    expect(calls[1]!.headers.get("x-goog-api-key")).toBeNull();
    const assertion = new URLSearchParams(calls[0]!.body).get("assertion")!;
    const [head, claims, signature] = assertion.split(".");
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toMatchObject({
      iss: "clipfarm@leonida-clips.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: "https://oauth2.googleapis.com/token",
    });
    expect(createVerify("RSA-SHA256").update(`${head}.${claims}`).verify(publicKey, signature!, "base64url")).toBe(true);
    now += 3600_000;
    await gemini.generateJson({ system: "s", text: "t", schema: {} });
    expect(calls.filter((c) => c.url.includes("oauth2"))).toHaveLength(2);
  });

  it("says what Google said when it refuses, and never quotes a key file that cannot sign", async () => {
    const { fetchImpl } = recorder(() => json({ error: { message: "Publisher model was not found." } }, 404));
    await expect(new VertexGemini({ project: "p", apiKey: "k", fetchImpl }).generateJson({ system: "s", text: "t", schema: {} })).rejects.toThrow(
      "Google says: Publisher model was not found.",
    );
    const broken = JSON.stringify({ client_email: "a@b.c", private_key: "-----BEGIN PRIVATE KEY-----\nnotakey\n-----END PRIVATE KEY-----\n" });
    const err = await new VertexGemini({ project: "p", serviceAccountJson: broken, fetchImpl }).generateJson({ system: "s", text: "t", schema: {} }).catch((e: Error) => e);
    expect((err as Error).message).toBe("The Google service account key could not be used to sign in. Paste the JSON again in Settings.");
  });

  it("knows a service account key file from anything else", () => {
    expect(parseServiceAccount('{"client_email":"a@b.c","private_key":"-----BEGIN PRIVATE KEY-----\\nx\\n-----END PRIVATE KEY-----\\n"}')).not.toBeNull();
    expect(parseServiceAccount('{"client_email":"a@b.c"}')).toBeNull();
    expect(parseServiceAccount("AIzaSyNotJson")).toBeNull();
    expect(toGeminiSchema({ type: "array", items: { additionalProperties: false, type: "object" } })).toEqual({ type: "array", items: { type: "object" } });
  });
});
