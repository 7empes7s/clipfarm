import { openAsBlob } from "node:fs";
import type { DirectPlatform } from "../../../shared/types.js";
import { YOUTUBE_UPLOAD_UNITS } from "../../../shared/types.js";
import type { AppKeys } from "../../isolation/isolation.js";
import { type Fetch, networkReason } from "../../isolation/net.js";
import { PostingServiceError } from "../errors.js";

/** Where each platform's API lives. Tests and demo mode point these at stand-ins. */
export interface Endpoints {
  googleAuth: string;
  googleToken: string;
  youtubeApi: string;
  youtubeUpload: string;
  tiktokAuth: string;
  tiktokApi: string;
  facebookAuth: string;
  graph: string;
  ipEcho: string;
}

export const REAL_ENDPOINTS: Endpoints = {
  googleAuth: "https://accounts.google.com/o/oauth2/v2/auth",
  googleToken: "https://oauth2.googleapis.com/token",
  youtubeApi: "https://www.googleapis.com/youtube/v3",
  youtubeUpload: "https://www.googleapis.com/upload/youtube/v3",
  tiktokAuth: "https://www.tiktok.com/v2/auth/authorize/",
  tiktokApi: "https://open.tiktokapis.com/v2",
  facebookAuth: "https://www.facebook.com/v21.0/dialog/oauth",
  graph: "https://graph.facebook.com/v21.0",
  ipEcho: "https://ipinfo.io/json",
};

export interface Tokens {
  access: string;
  /** Google and TikTok give one; Meta's long-lived token is renewed with itself. */
  refresh: string | null;
  expiresAt: string | null;
}

/** A channel the sign-in gave access to. */
export interface Channel {
  id: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  tokens: Tokens;
}

export interface Upload {
  path: string;
  title: string;
  caption: string;
  /** A paid campaign: flagged where the platform has a flag for it. */
  paidPromotion: boolean;
}

export interface Uploaded {
  externalId: string;
  url: string | null;
}

/** Everything a call needs: the group's way out, the group's app, and the clock. */
export interface Ctx {
  fetch: Fetch;
  endpoints: Endpoints;
  app: AppKeys;
  redirectUri: string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** Counts YouTube units against the group's app. */
  spend: (units: number) => void;
}

/** YouTube said the app's units for the day are gone: the post waits for the reset instead of failing. */
export class QuotaExceeded extends Error {}

/** The platform no longer accepts the channel's sign-in: it has to be connected again. */
export class SignInRefused extends PostingServiceError {}

export interface PlatformClient {
  label: string;
  /** Renew the token when it has less than this left. */
  renewBeforeMs: number;
  authorizeUrl(ctx: Ctx, state: string): string;
  /** Trades the code from the sign-in for tokens and reads which channels they are for. */
  connect(ctx: Ctx, code: string): Promise<Channel[]>;
  renew(ctx: Ctx, tokens: Tokens): Promise<Tokens>;
  upload(ctx: Ctx, channel: { id: string; handle: string | null }, access: string, upload: Upload): Promise<Uploaded>;
}

interface Answer {
  status: number;
  headers: Headers;
  body: Record<string, unknown>;
  text: string;
}

function said(body: Record<string, unknown>): string | null {
  const error = body.error as { message?: unknown; code?: unknown } | string | undefined;
  const found = [
    typeof error === "object" ? error?.message : null,
    body.error_description,
    body.message,
    typeof error === "string" ? error : null,
  ].find((x) => typeof x === "string" && x.trim());
  return typeof found === "string" ? found.trim().replace(/\.$/, "").slice(0, 300) : null;
}

/** One call. Errors are in plain words and never hold the address called (it may carry a key). */
async function call(ctx: Ctx, label: string, url: string, init: RequestInit = {}, okStatuses: number[] = []): Promise<Answer> {
  let res: Response;
  try {
    res = await ctx.fetch(url, { ...init, signal: AbortSignal.timeout(600_000) });
  } catch (err) {
    throw new PostingServiceError(`${label} could not be reached (${networkReason(err)}).`);
  }
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // An empty or non-JSON answer: only the status counts.
  }
  if (!res.ok && !okStatuses.includes(res.status)) {
    if (res.status === 403 && /quotaExceeded|dailyLimitExceeded/.test(text)) throw new QuotaExceeded();
    const detail = said(body);
    const message = detail ? `${label} says: ${detail}.` : `${label} answered with an error (HTTP ${res.status}).`;
    throw /invalid_grant|invalid_token|access_token_invalid/i.test(text) || res.status === 401 ? new SignInRefused(message) : new PostingServiceError(message);
  }
  return { status: res.status, headers: res.headers, body, text };
}

const form = (values: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(values).toString(),
});
const json = (access: string, body: unknown, extra: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json; charset=UTF-8", ...extra },
  body: JSON.stringify(body),
});
const bearer = (access: string): RequestInit => ({ headers: { Authorization: `Bearer ${access}` } });

function withQuery(base: string, params: Record<string, string>): string {
  return `${base}${base.includes("?") ? "&" : "?"}${new URLSearchParams(params).toString()}`;
}

function expiry(ctx: Ctx, seconds: unknown): string | null {
  return typeof seconds === "number" && seconds > 0 ? new Date(ctx.now().getTime() + seconds * 1000).toISOString() : null;
}

function need(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new PostingServiceError(`${label} sent an answer without what was asked for.`);
  return value;
}

/** YouTube Data API v3: Google sign-in, then a resumable upload (1,600 units of the project's 10,000 a day). */
const youtube: PlatformClient = {
  label: "YouTube",
  renewBeforeMs: 5 * 60_000,
  authorizeUrl: (ctx, state) =>
    withQuery(ctx.endpoints.googleAuth, {
      client_id: ctx.app.id,
      redirect_uri: ctx.redirectUri,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
      // offline + consent: Google only hands out a refresh token when asked like this.
      access_type: "offline",
      prompt: "consent",
      state,
    }),
  async connect(ctx, code) {
    const { body } = await call(
      ctx,
      "Google",
      ctx.endpoints.googleToken,
      form({ code, client_id: ctx.app.id, client_secret: ctx.app.secret, redirect_uri: ctx.redirectUri, grant_type: "authorization_code" }),
    );
    const access = need(body.access_token, "Google");
    const mine = await call(ctx, "YouTube", `${ctx.endpoints.youtubeApi}/channels?part=snippet&mine=true`, bearer(access));
    ctx.spend(1);
    type Item = { id?: string; snippet?: { title?: string; customUrl?: string; thumbnails?: { default?: { url?: string } } } };
    const item = (mine.body.items as Item[] | undefined)?.[0];
    if (!item?.id) throw new PostingServiceError("That Google sign-in has no YouTube channel. Sign in with the channel's own account.");
    return [
      {
        id: item.id,
        name: item.snippet?.title ?? item.id,
        handle: item.snippet?.customUrl ?? null,
        avatarUrl: item.snippet?.thumbnails?.default?.url ?? null,
        tokens: { access, refresh: need(body.refresh_token, "Google"), expiresAt: expiry(ctx, body.expires_in) },
      },
    ];
  },
  async renew(ctx, tokens) {
    const { body } = await call(
      ctx,
      "Google",
      ctx.endpoints.googleToken,
      form({ refresh_token: tokens.refresh ?? "", client_id: ctx.app.id, client_secret: ctx.app.secret, grant_type: "refresh_token" }),
    );
    return { access: need(body.access_token, "Google"), refresh: tokens.refresh, expiresAt: expiry(ctx, body.expires_in) };
  },
  async upload(ctx, _channel, access, upload) {
    const video = await openAsBlob(upload.path, { type: "video/mp4" });
    const parts = ["snippet", "status", ...(upload.paidPromotion ? ["paidProductPlacementDetails"] : [])];
    const started = await call(
      ctx,
      "YouTube",
      `${ctx.endpoints.youtubeUpload}/videos?uploadType=resumable&part=${parts.join(",")}`,
      json(
        access,
        {
          snippet: { title: upload.title.slice(0, 100), description: upload.caption, categoryId: "20" },
          status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
          ...(upload.paidPromotion ? { paidProductPlacementDetails: { hasPaidProductPlacement: true } } : {}),
        },
        { "X-Upload-Content-Type": "video/mp4", "X-Upload-Content-Length": String(video.size) },
      ),
    );
    ctx.spend(YOUTUBE_UPLOAD_UNITS);
    const session = need(started.headers.get("location"), "YouTube");
    const done = await call(ctx, "YouTube", session, { method: "PUT", headers: { "Content-Type": "video/mp4" }, body: video });
    const id = need(done.body.id, "YouTube");
    return { externalId: id, url: `https://www.youtube.com/shorts/${id}` };
  },
};

const TIKTOK_ONE_CHUNK_MAX = 64 * 1024 * 1024;
const TIKTOK_CHUNK = 32 * 1024 * 1024;

/** TikTok says "ok" inside a 200 answer; anything else is the error. */
function tiktokOk(answer: Answer): Record<string, unknown> {
  const error = answer.body.error as { code?: string; message?: string } | undefined;
  if (error?.code && error.code !== "ok") throw new PostingServiceError(`TikTok says: ${(error.message || error.code).slice(0, 300)}.`);
  return (answer.body.data ?? {}) as Record<string, unknown>;
}

/** TikTok Content Posting API, Direct Post: the file is sent to TikTok in one or more chunks. */
const tiktok: PlatformClient = {
  label: "TikTok",
  renewBeforeMs: 5 * 60_000,
  authorizeUrl: (ctx, state) =>
    withQuery(ctx.endpoints.tiktokAuth, {
      client_key: ctx.app.id,
      redirect_uri: ctx.redirectUri,
      response_type: "code",
      scope: "user.info.basic,video.publish",
      state,
    }),
  async connect(ctx, code) {
    const { body } = await call(
      ctx,
      "TikTok",
      `${ctx.endpoints.tiktokApi}/oauth/token/`,
      form({ client_key: ctx.app.id, client_secret: ctx.app.secret, code, grant_type: "authorization_code", redirect_uri: ctx.redirectUri }),
    );
    const access = need(body.access_token, "TikTok");
    const info = tiktokOk(await call(ctx, "TikTok", `${ctx.endpoints.tiktokApi}/user/info/?fields=open_id,display_name,avatar_url`, bearer(access)));
    const user = (info.user ?? {}) as { open_id?: string; display_name?: string; avatar_url?: string };
    const id = need(user.open_id ?? body.open_id, "TikTok");
    return [
      {
        id,
        name: user.display_name || id,
        handle: null,
        avatarUrl: user.avatar_url ?? null,
        tokens: { access, refresh: need(body.refresh_token, "TikTok"), expiresAt: expiry(ctx, body.expires_in) },
      },
    ];
  },
  async renew(ctx, tokens) {
    const { body } = await call(
      ctx,
      "TikTok",
      `${ctx.endpoints.tiktokApi}/oauth/token/`,
      form({ client_key: ctx.app.id, client_secret: ctx.app.secret, grant_type: "refresh_token", refresh_token: tokens.refresh ?? "" }),
    );
    // TikTok hands out a new refresh token with each renewal.
    const refresh = typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : tokens.refresh;
    return { access: need(body.access_token, "TikTok"), refresh, expiresAt: expiry(ctx, body.expires_in) };
  },
  async upload(ctx, _channel, access, upload) {
    const api = ctx.endpoints.tiktokApi;
    const video = await openAsBlob(upload.path, { type: "video/mp4" });
    const creator = tiktokOk(await call(ctx, "TikTok", `${api}/post/publish/creator_info/query/`, json(access, {})));
    const levels = Array.isArray(creator.privacy_level_options) ? (creator.privacy_level_options as string[]) : [];
    const chunk = video.size <= TIKTOK_ONE_CHUNK_MAX ? video.size : TIKTOK_CHUNK;
    const chunks = Math.max(1, Math.floor(video.size / chunk));
    const started = tiktokOk(
      await call(
        ctx,
        "TikTok",
        `${api}/post/publish/video/init/`,
        json(access, {
          post_info: {
            title: upload.caption.slice(0, 2200),
            // An app TikTok has not reviewed yet may only post privately: take what the account allows.
            privacy_level: levels.includes("PUBLIC_TO_EVERYONE") ? "PUBLIC_TO_EVERYONE" : (levels[0] ?? "SELF_ONLY"),
            disable_duet: false,
            disable_comment: false,
            disable_stitch: false,
            brand_content_toggle: upload.paidPromotion,
            brand_organic_toggle: false,
          },
          source_info: { source: "FILE_UPLOAD", video_size: video.size, chunk_size: chunk, total_chunk_count: chunks },
        }),
      ),
    );
    const publishId = need(started.publish_id, "TikTok");
    const uploadUrl = need(started.upload_url, "TikTok");
    for (let i = 0; i < chunks; i++) {
      const from = i * chunk;
      // The last chunk carries what is left over.
      const to = i === chunks - 1 ? video.size - 1 : from + chunk - 1;
      await call(ctx, "TikTok", uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "video/mp4", "Content-Range": `bytes ${from}-${to}/${video.size}` },
        body: video.slice(from, to + 1),
      });
    }
    // TikTok works on the video for a moment: ask a few times whether it is out.
    for (let tries = 0; tries < 5; tries++) {
      const state = tiktokOk(await call(ctx, "TikTok", `${api}/post/publish/status/fetch/`, json(access, { publish_id: publishId })));
      if (state.status === "FAILED") throw new PostingServiceError(`TikTok could not publish the video (${String(state.fail_reason ?? "no reason given")}).`);
      if (state.status === "PUBLISH_COMPLETE") break;
      await ctx.sleep(3000);
    }
    // The basic sign-in does not tell the @handle, so there is no link to build.
    return { externalId: publishId, url: null };
  },
};

/** Instagram Graph content publishing: a Reel, sent with Meta's resumable upload (no public video link needed). */
const instagram: PlatformClient = {
  label: "Instagram",
  // Meta's long-lived token lasts about 60 days and is renewed with itself.
  renewBeforeMs: 7 * 24 * 3600_000,
  authorizeUrl: (ctx, state) =>
    withQuery(ctx.endpoints.facebookAuth, {
      client_id: ctx.app.id,
      redirect_uri: ctx.redirectUri,
      response_type: "code",
      scope: "instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement,business_management",
      state,
    }),
  async connect(ctx, code) {
    const token = `${ctx.endpoints.graph}/oauth/access_token`;
    const short = await call(ctx, "Meta", token, form({ client_id: ctx.app.id, client_secret: ctx.app.secret, redirect_uri: ctx.redirectUri, code }));
    const tokens = await instagram.renew(ctx, { access: need(short.body.access_token, "Meta"), refresh: null, expiresAt: null });
    const pages = await call(
      ctx,
      "Meta",
      `${ctx.endpoints.graph}/me/accounts?fields=${encodeURIComponent("name,instagram_business_account{id,username,profile_picture_url}")}&limit=100`,
      bearer(tokens.access),
    );
    type Page = { instagram_business_account?: { id?: string; username?: string; profile_picture_url?: string } };
    const channels = ((pages.body.data as Page[] | undefined) ?? [])
      .map((p) => p.instagram_business_account)
      .filter((ig): ig is { id: string; username?: string; profile_picture_url?: string } => typeof ig?.id === "string")
      .map((ig) => ({ id: ig.id, name: ig.username ?? ig.id, handle: ig.username ? `@${ig.username}` : null, avatarUrl: ig.profile_picture_url ?? null, tokens }));
    if (channels.length === 0) {
      throw new PostingServiceError("That sign-in has no Instagram Business or Creator account linked to a Facebook page. Link one in Instagram first.");
    }
    return channels;
  },
  async renew(ctx, tokens) {
    const { body } = await call(
      ctx,
      "Meta",
      `${ctx.endpoints.graph}/oauth/access_token`,
      form({ grant_type: "fb_exchange_token", client_id: ctx.app.id, client_secret: ctx.app.secret, fb_exchange_token: tokens.access }),
    );
    return { access: need(body.access_token, "Meta"), refresh: null, expiresAt: expiry(ctx, body.expires_in) };
  },
  async upload(ctx, channel, access, upload) {
    const graph = ctx.endpoints.graph;
    const video = await openAsBlob(upload.path, { type: "video/mp4" });
    const container = await call(ctx, "Instagram", `${graph}/${channel.id}/media`, {
      ...form({ media_type: "REELS", upload_type: "resumable", caption: upload.caption.slice(0, 2200) }),
      headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/x-www-form-urlencoded" },
    });
    const containerId = need(container.body.id, "Instagram");
    await call(ctx, "Instagram", need(container.body.uri, "Instagram"), {
      method: "POST",
      headers: { Authorization: `OAuth ${access}`, offset: "0", file_size: String(video.size), "Content-Type": "application/octet-stream" },
      body: video,
    });
    // Instagram works on the video before it can be published.
    for (let tries = 0; ; tries++) {
      const state = await call(ctx, "Instagram", `${graph}/${containerId}?fields=status_code,status`, bearer(access));
      if (state.body.status_code === "FINISHED") break;
      if (state.body.status_code === "ERROR" || tries >= 20) {
        throw new PostingServiceError(`Instagram could not take the video (${String(state.body.status ?? "it is still working on it")}).`);
      }
      await ctx.sleep(3000);
    }
    const published = await call(ctx, "Instagram", `${graph}/${channel.id}/media_publish`, {
      ...form({ creation_id: containerId }),
      headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/x-www-form-urlencoded" },
    });
    const mediaId = need(published.body.id, "Instagram");
    const link = await call(ctx, "Instagram", `${graph}/${mediaId}?fields=permalink`, bearer(access)).catch(() => null);
    return { externalId: mediaId, url: typeof link?.body.permalink === "string" ? link.body.permalink : null };
  },
};

export const PLATFORM_CLIENTS: Record<DirectPlatform, PlatformClient> = { youtube, tiktok, instagram };
