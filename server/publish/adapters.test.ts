import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PostingServiceError } from "./errors.js";
import { PostizService, viewsFromPostizAnalytics } from "./postiz.js";
import type { PublishItem } from "./types.js";
import { UploadPostService } from "./uploadPost.js";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "../../test/fixtures", name), "utf8");

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A stand-in for fetch: answers each URL pattern with a fixture and records every request. */
function fakeFetch(routes: [RegExp, number, string][]) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({
      method: init.method ?? "GET",
      url,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: init.body instanceof FormData ? init.body : init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const route = routes.find(([re]) => re.test(`${init.method ?? "GET"} ${url}`));
    if (!route) throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    return new Response(route[2], { status: route[1], headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { fn, calls };
}

const dir = mkdtempSync(join(tmpdir(), "clipfarm-adapters-"));
const video = { path: join(dir, "clip-1.mp4"), fileName: "clip-1.mp4" };
writeFileSync(video.path, "not really a video");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const yt = { id: "int-yt", platform: "youtube", name: "GTA VI Moments", disabled: false } as const;
const tt = { id: "int-tt", platform: "tiktok", name: "gtavimoments", disabled: false } as const;
const item = (account: PublishItem["account"], when: Date | null = null): PublishItem => ({
  account,
  title: "He actually landed the jump",
  caption: `He actually landed the jump\n\nCredit: Big Streamer`,
  when,
  paidPromotion: true,
});

describe("PostizService", () => {
  const base = "https://postiz.example.com";

  it("lists connected accounts on the platforms we post to, with the key sent as is", async () => {
    const { fn, calls } = fakeFetch([[/GET .*\/api\/public\/v1\/integrations$/, 200, fixture("postiz/integrations.json")]]);
    const service = new PostizService({ url: `${base}/`, apiKey: "secret-key", fetch: fn });
    expect(await service.listAccounts()).toEqual([
      { id: "int-yt", platform: "youtube", name: "GTA VI Moments", disabled: false, handle: "gtavimoments", avatarUrl: "https://uploads.postiz.com/a.jpg" },
      { id: "int-tt", platform: "tiktok", name: "gtavimoments", disabled: false, handle: "gtavimoments", avatarUrl: "https://uploads.postiz.com/b.jpg" },
      { id: "int-ig", platform: "instagram", name: "gtavi.moments", disabled: true, handle: "gtavi.moments", avatarUrl: "https://uploads.postiz.com/c.jpg" },
      { id: "int-x", platform: "x", name: "GTA VI Moments", disabled: false, handle: "gtavimoments", avatarUrl: "https://uploads.postiz.com/d.jpg" },
    ]);
    expect(calls[0]!.headers.authorization).toBe("secret-key");
  });

  it("uploads the MP4 once, then creates one post per account and maps the post ids", async () => {
    const { fn, calls } = fakeFetch([
      [/GET .*\/integrations$/, 200, fixture("postiz/integrations.json")],
      [/POST .*\/upload$/, 200, fixture("postiz/upload.json")],
      [/POST .*\/posts$/, 200, fixture("postiz/create-post.json")],
    ]);
    const service = new PostizService({ url: base, apiKey: "k", fetch: fn });
    const results = await service.publish(video, [item(yt), item(tt)]);

    expect(results).toEqual([
      { accountId: "int-yt", externalId: "post-yt-1", status: "scheduled", url: null, error: null, postedAt: null },
      { accountId: "int-tt", externalId: "post-tt-1", status: "scheduled", url: null, error: null, postedAt: null },
    ]);
    const upload = calls.find((c) => c.url.endsWith("/upload"))!;
    expect((upload.body as FormData).get("file")).toBeInstanceOf(Blob);
    const create = calls.filter((c) => c.url.endsWith("/posts"));
    expect(create).toHaveLength(1);
    const body = create[0]!.body as { type: string; posts: { integration: { id: string }; value: unknown[]; settings: Record<string, unknown> }[] };
    expect(body.type).toBe("now");
    expect(body.posts.map((p) => p.integration.id)).toEqual(["int-yt", "int-tt"]);
    expect(body.posts[0]!.value).toEqual([
      { content: item(yt).caption, image: [{ id: "e639003b-f727-4a1e-87bd-74a2c48ae41e", path: "https://postiz.example.com/uploads/clip-1.mp4" }] },
    ]);
    expect(body.posts[0]!.settings).toMatchObject({ __type: "youtube", title: "He actually landed the jump", type: "public" });
    expect(body.posts[1]!.settings).toMatchObject({ __type: "tiktok", content_posting_method: "DIRECT_POST", brand_content_toggle: true });
  });

  it("a private item goes to YouTube as a private video", async () => {
    const { fn, calls } = fakeFetch([
      [/GET .*\/integrations$/, 200, fixture("postiz/integrations.json")],
      [/POST .*\/upload$/, 200, fixture("postiz/upload.json")],
      [/POST .*\/posts$/, 200, JSON.stringify([{ postId: "p", integration: "int-yt" }])],
    ]);
    await new PostizService({ url: base, apiKey: "k", fetch: fn }).publish(video, [{ ...item(yt), privacy: "private" }]);
    const body = calls.find((c) => c.url.endsWith("/posts"))!.body as { posts: { settings: Record<string, unknown> }[] };
    expect(body.posts[0]!.settings).toMatchObject({ __type: "youtube", type: "private" });
  });

  it("sends scheduled posts at different times as separate requests", async () => {
    const { fn, calls } = fakeFetch([
      [/GET .*\/integrations$/, 200, fixture("postiz/integrations.json")],
      [/POST .*\/upload$/, 200, fixture("postiz/upload.json")],
      [/POST .*\/posts$/, 200, JSON.stringify([{ postId: "p", integration: "int-yt" }])],
    ]);
    const service = new PostizService({ url: base, apiKey: "k", fetch: fn });
    const t1 = new Date("2026-11-20T09:00:00.000Z");
    const t2 = new Date("2026-11-20T10:30:00.000Z");
    await service.publish(video, [item(yt, t1), item(tt, t2)]);
    const creates = calls.filter((c) => c.url.endsWith("/posts")).map((c) => c.body as { type: string; date: string });
    expect(creates).toEqual([
      expect.objectContaining({ type: "schedule", date: t1.toISOString() }),
      expect.objectContaining({ type: "schedule", date: t2.toISOString() }),
    ]);
  });

  it("maps published, failed and queued posts and reads views from the post analytics", async () => {
    const { fn, calls } = fakeFetch([
      [/GET .*\/posts\?/, 200, fixture("postiz/posts.json")],
      [/GET .*\/analytics\/post\/post-yt-1\?date=30$/, 200, fixture("postiz/analytics-post.json")],
    ]);
    const service = new PostizService({ url: base, apiKey: "k", fetch: fn });
    const updates = await service.refresh([
      { externalId: "post-yt-1", accountId: "int-yt", platform: "youtube", scheduledAt: "2026-11-19T12:00:00.000Z" },
      { externalId: "post-tt-1", accountId: "int-tt", platform: "tiktok", scheduledAt: "2026-11-19T12:00:00.000Z" },
      { externalId: "post-x-1", accountId: "int-x", platform: "x", scheduledAt: "2026-11-20T09:00:00.000Z" },
    ]);
    expect(updates).toEqual([
      { externalId: "post-yt-1", accountId: "int-yt", status: "posted", url: "https://www.youtube.com/shorts/abc123", postedAt: "2026-11-19T12:00:05.000Z", error: null, views: 12500, metrics: { likes: 175, comments: 25 } },
      { externalId: "post-tt-1", accountId: "int-tt", status: "failed", url: null, postedAt: null, error: "Account banned from posting, please check TikTok account status" },
      { externalId: "post-x-1", accountId: "int-x", status: "scheduled", url: null, postedAt: null, error: null },
    ]);
    const list = new URL(calls[0]!.url);
    expect(list.searchParams.get("startDate")).toBe("2026-11-18T12:00:00.000Z");
    // Only the published post costs an analytics call (the API allows 30 calls an hour).
    expect(calls.filter((c) => c.url.includes("/analytics/"))).toHaveLength(1);
  });

  it("reads views from the largest Views (or else Impressions) total", () => {
    expect(viewsFromPostizAnalytics(JSON.parse(fixture("postiz/analytics-post.json")))).toBe(12500);
    expect(viewsFromPostizAnalytics([{ label: "Impressions", data: [{ total: "80", date: "x" }] }])).toBe(80);
    expect(viewsFromPostizAnalytics([{ label: "Likes", data: [{ total: "3", date: "x" }] }])).toBeNull();
  });

  it("explains a refused key, the hourly limit and an unreachable server in plain words", async () => {
    const refused = new PostizService({ url: base, apiKey: "bad", fetch: fakeFetch([[/integrations/, 401, '{"msg":"Invalid API key"}']]).fn });
    await expect(refused.listAccounts()).rejects.toThrow(
      new PostingServiceError("Postiz refused the API key. Copy it again from Postiz > Settings > Public API and paste it in Settings."),
    );
    const limited = new PostizService({ url: base, apiKey: "k", fetch: fakeFetch([[/integrations/, 429, "{}"]]).fn });
    await expect(limited.listAccounts()).rejects.toThrow("Postiz's hourly limit was reached. Try again in an hour.");
    const down = new PostizService({ url: base, apiKey: "k", fetch: fakeFetch([]).fn });
    await expect(down.listAccounts()).rejects.toThrow("Cannot reach Postiz at https://postiz.example.com (ECONNREFUSED). Is it running, and is its address in Settings right?");
  });

  it("never puts the key in an error message", async () => {
    const service = new PostizService({ url: base, apiKey: "super-secret", fetch: fakeFetch([[/integrations/, 500, '{"msg":"bad super-secret"}']]).fn });
    const err = (await service.listAccounts().catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("HTTP 500");
    expect(err.message).not.toContain("super-secret");
  });
});

describe("UploadPostService", () => {
  const accounts = (s: UploadPostService) => s.listAccounts();

  it("offers one account per platform of the profile and shows its daily caps", async () => {
    const service = new UploadPostService({ apiKey: "k", user: "gtavimoments", platforms: ["youtube", "tiktok"], fetch: fakeFetch([]).fn });
    expect(await accounts(service)).toEqual([
      { id: "gtavimoments:youtube", platform: "youtube", name: "gtavimoments (YouTube Shorts)", disabled: false },
      { id: "gtavimoments:tiktok", platform: "tiktok", name: "gtavimoments (TikTok)", disabled: false },
    ]);
    expect(service.dailyCaps).toEqual({ youtube: 10, tiktok: 15, instagram: 50 });
  });

  it("posts now with per-platform captions and maps each platform's result", async () => {
    const { fn, calls } = fakeFetch([[/POST https:\/\/api\.upload-post\.com\/api\/upload$/, 200, fixture("upload-post/upload-now.json")]]);
    const service = new UploadPostService({ apiKey: "secret", user: "gtavimoments", platforms: ["youtube", "tiktok"], fetch: fn, newId: () => "req-1" });
    const [ytAcc, ttAcc] = await accounts(service);
    const results = await service.publish(video, [item(ytAcc!), item(ttAcc!)]);
    expect(results).toEqual([
      { accountId: "gtavimoments:youtube", externalId: "req-1", status: "posted", url: "https://youtube.com/watch?v=dQw4w9WgXcQ", error: null, postedAt: expect.any(String) },
      { accountId: "gtavimoments:tiktok", externalId: "req-1", status: "failed", url: null, error: "TikTok said: Expired access token", postedAt: null },
    ]);
    expect(calls[0]!.headers.authorization).toBe("Apikey secret");
    const form = calls[0]!.body as FormData;
    expect(form.get("user")).toBe("gtavimoments");
    expect(form.getAll("platform[]")).toEqual(["youtube", "tiktok"]);
    expect(form.get("request_id")).toBe("req-1");
    expect(form.get("youtube_title")).toBe("He actually landed the jump");
    expect(form.get("youtube_description")).toBe(item(yt).caption);
    expect(form.get("tiktok_title")).toBe(item(tt).caption);
    expect(form.get("brand_content_toggle")).toBe("true");
    expect(form.get("video")).toBeInstanceOf(Blob);
    expect(form.get("scheduled_date")).toBeNull();
  });

  it("schedules with scheduled_date and keeps the post waiting", async () => {
    const { fn, calls } = fakeFetch([[/POST .*\/api\/upload$/, 202, fixture("upload-post/upload-scheduled.json")]]);
    const service = new UploadPostService({ apiKey: "k", user: "gtavimoments", platforms: ["youtube"], fetch: fn, newId: () => "req-2" });
    const [ytAcc] = await accounts(service);
    const when = new Date("2026-11-20T10:00:00.000Z");
    const results = await service.publish(video, [item(ytAcc!, when)]);
    expect(results[0]).toMatchObject({ externalId: "req-2", status: "scheduled", url: null });
    expect((calls[0]!.body as FormData).get("scheduled_date")).toBe(when.toISOString());
  });

  it("reads URL and views from the post analytics, one call per upload", async () => {
    const { fn, calls } = fakeFetch([[/GET .*\/api\/uploadposts\/post-analytics\/req-1$/, 200, fixture("upload-post/post-analytics.json")]]);
    const service = new UploadPostService({ apiKey: "k", user: "gtavimoments", platforms: ["youtube", "tiktok"], fetch: fn });
    const updates = await service.refresh([
      { externalId: "req-1", accountId: "gtavimoments:youtube", platform: "youtube", scheduledAt: "2026-11-20T10:00:00.000Z" },
      { externalId: "req-1", accountId: "gtavimoments:tiktok", platform: "tiktok", scheduledAt: "2026-11-20T10:00:00.000Z" },
    ]);
    expect(updates).toEqual([
      { externalId: "req-1", accountId: "gtavimoments:youtube", status: "posted", url: "https://youtube.com/watch?v=dQw4w9WgXcQ", error: null, views: 5200 },
      { externalId: "req-1", accountId: "gtavimoments:tiktok", status: "posted", url: "https://tiktok.com/@user/video/7123456789", error: null },
    ]);
    expect(calls).toHaveLength(1);
  });

  it("explains a refused key and the monthly limit", async () => {
    const refused = new UploadPostService({ apiKey: "k", user: "u", platforms: ["youtube"], fetch: fakeFetch([[/upload$/, 401, '{"success":false,"error":"Unauthorized"}']]).fn });
    const [acc] = await refused.listAccounts();
    await expect(refused.publish(video, [item(acc!)])).rejects.toThrow("Upload-Post refused the API key. Paste it again in Settings.");
    const limited = new UploadPostService({ apiKey: "k", user: "u", platforms: ["youtube"], fetch: fakeFetch([[/upload$/, 429, '{"success":false,"error":"Monthly limit exceeded"}']]).fn });
    await expect(limited.publish(video, [item(acc!)])).rejects.toThrow("Upload-Post's limit was reached: Monthly limit exceeded");
  });
});
