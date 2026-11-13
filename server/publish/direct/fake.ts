import type { DirectPlatform } from "../../../shared/types.js";
import type { Fetch } from "../../isolation/net.js";
import type { Endpoints } from "./platforms.js";

export interface FakeCall {
  path: string;
  /** Whether the call arrived through a proxy. */
  viaProxy: boolean;
  /** The developer app the call was made for: its ID in a token trade, or the app its token was given to. */
  app: string | null;
  grant: string | null;
}

export interface FakeUpload {
  platform: DirectPlatform;
  channel: string;
  bytes: number;
  title: string;
}

/**
 * Stands in for Google/YouTube, TikTok, Meta/Instagram and the IP-echo service: in tests (served
 * over HTTP, so calls can go through a proxy) and in demo mode (in-process). The code a sign-in
 * comes back with names the channel, and every token remembers the app it was given to, so a test
 * can see which app and which way out each call used.
 */
export class FakePlatforms {
  calls: FakeCall[] = [];
  uploads: FakeUpload[] = [];
  /** What the IP-echo answers through a proxy, and straight from the server. */
  exitIp = "203.0.113.7";
  ownIp = "198.51.100.20";
  /** YouTube refuses uploads the way it does when the day's units are gone. */
  quotaExceeded = false;
  /** Makes every platform refuse, repeating what it was sent (as some real APIs do). */
  refuseWith: ((sent: string) => string) | null = null;
  /** A slow upload: YouTube answers the upload only once this settles. */
  holdUploads: Promise<void> | null = null;
  private tokens = new Map<string, { app: string; channel: string }>();
  private pending = new Map<string, { channel: string; title: string }>();
  private n = 0;

  constructor(public base = "http://direct.fake") {}

  /** Forgets what was seen and every switch; tokens handed out stay good. */
  reset(): void {
    this.calls = [];
    this.uploads = [];
    this.exitIp = "203.0.113.7";
    this.ownIp = "198.51.100.20";
    this.quotaExceeded = false;
    this.refuseWith = null;
    this.holdUploads = null;
  }

  endpoints(): Endpoints {
    const b = this.base;
    return {
      googleAuth: `${b}/google/auth`,
      googleToken: `${b}/google/token`,
      youtubeApi: `${b}/youtube/v3`,
      youtubeUpload: `${b}/upload/youtube/v3`,
      tiktokAuth: `${b}/tiktok/auth`,
      tiktokApi: `${b}/tiktok/v2`,
      facebookAuth: `${b}/meta/auth`,
      graph: `${b}/graph`,
      ipEcho: `${b}/ip`,
    };
  }

  /** In-process: what a group's way out is in demo mode. */
  fetch(viaProxy: boolean): Fetch {
    return ((input: string | URL, init?: RequestInit) => this.handle(new Request(String(input), init), viaProxy)) as Fetch;
  }

  private mint(app: string, channel: string): string {
    const token = `at.${app}.${channel}.${++this.n}`;
    this.tokens.set(token, { app, channel });
    return token;
  }

  async handle(req: Request, viaProxy: boolean): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const raw = req.method === "GET" ? new ArrayBuffer(0) : await req.arrayBuffer();
    const text = raw.byteLength < 100_000 ? Buffer.from(raw).toString("utf8") : "";
    const type = req.headers.get("content-type") ?? "";
    const sent = type.includes("x-www-form-urlencoded") ? new URLSearchParams(text) : new URLSearchParams();
    const auth = req.headers.get("authorization") ?? "";
    const holder = this.tokens.get(auth.replace(/^(Bearer|OAuth) /, "")) ?? null;
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

    if (path === "/ip") {
      this.calls.push({ path, viaProxy, app: null, grant: null });
      return json(viaProxy ? { ip: this.exitIp, country: "NL" } : { ip: this.ownIp, country: "DE" });
    }
    const app = sent.get("client_id") ?? sent.get("client_key") ?? holder?.app ?? null;
    this.calls.push({ path, viaProxy, app, grant: sent.get("grant_type") });
    if (this.refuseWith) return json({ error: { message: this.refuseWith(`${auth} ${text} ${req.url}`) } }, 400);
    const signedIn = (): { app: string; channel: string } | Response => holder ?? json({ error: { message: "Invalid Credentials" } }, 401);
    const jsonBody = (): Record<string, unknown> => (type.includes("json") && text ? (JSON.parse(text) as Record<string, unknown>) : {});

    // Google and TikTok: both the first trade and a renewal come here. A refresh token only works for its own app.
    if (path === "/google/token" || path === "/tiktok/v2/oauth/token/") {
      const grant = sent.get("grant_type");
      let channel = sent.get("code");
      if (grant === "refresh_token") {
        const known = this.tokens.get(sent.get("refresh_token") ?? "");
        if (!known || known.app !== app) return json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);
        channel = known.channel;
      }
      if (!app || !channel) return json({ error: "invalid_request" }, 400);
      const refresh = `rt.${app}.${channel}`;
      this.tokens.set(refresh, { app, channel });
      return json({ access_token: this.mint(app, channel), refresh_token: refresh, expires_in: 3600, open_id: `open-${channel}` });
    }
    if (path === "/graph/oauth/access_token") {
      const channel = sent.get("code") ?? this.tokens.get(sent.get("fb_exchange_token") ?? "")?.channel;
      if (!app || !channel) return json({ error: { message: "Invalid verification code format." } }, 400);
      return json({ access_token: this.mint(app, channel), expires_in: 60 * 24 * 3600 });
    }

    // The upload addresses carry their own permission, as the real ones do: no token is asked for.
    const received = (platform: DirectPlatform, id: string): void => {
      const meta = this.pending.get(id);
      this.uploads.push({ platform, channel: meta?.channel ?? "", bytes: raw.byteLength, title: meta?.title ?? "" });
    };
    const sentTo = /^\/(?:upload\/youtube\/v3\/session|tiktok\/upload|graph\/upload)\/([\w-]+)$/.exec(path);
    if (sentTo) {
      received(path.startsWith("/upload/youtube") ? "youtube" : path.startsWith("/tiktok") ? "tiktok" : "instagram", sentTo[1]!);
      return json(path.startsWith("/upload/youtube") ? { id: sentTo[1] } : { success: true }, path.startsWith("/tiktok") ? 201 : 200);
    }

    const who = signedIn();
    if (who instanceof Response) return who;
    const { channel } = who;

    if (path === "/youtube/v3/channels") {
      return json({ items: [{ id: `UC-${channel}`, snippet: { title: `Channel ${channel}`, customUrl: `@${channel}`, thumbnails: { default: { url: `https://img.example/${channel}.jpg` } } } }] });
    }
    if (path === "/upload/youtube/v3/videos") {
      if (this.quotaExceeded) {
        return json({ error: { code: 403, message: "The request cannot be completed because you have exceeded your quota.", errors: [{ reason: "quotaExceeded" }] } }, 403);
      }
      await this.holdUploads;
      const id = `vid-${++this.n}`;
      this.pending.set(id, { channel, title: String((jsonBody().snippet as { title?: string } | undefined)?.title ?? "") });
      return json({}, 200, { location: `${this.base}/upload/youtube/v3/session/${id}` });
    }
    if (path === "/tiktok/v2/user/info/") return json({ data: { user: { open_id: `open-${channel}`, display_name: `Channel ${channel}`, avatar_url: null } }, error: { code: "ok" } });
    if (path === "/tiktok/v2/post/publish/creator_info/query/") return json({ data: { privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"] }, error: { code: "ok" } });
    if (path === "/tiktok/v2/post/publish/video/init/") {
      const id = `pub-${++this.n}`;
      this.pending.set(id, { channel, title: String((jsonBody().post_info as { title?: string } | undefined)?.title ?? "") });
      return json({ data: { publish_id: id, upload_url: `${this.base}/tiktok/upload/${id}` }, error: { code: "ok" } });
    }
    if (path === "/tiktok/v2/post/publish/status/fetch/") return json({ data: { status: "PUBLISH_COMPLETE" }, error: { code: "ok" } });

    if (path === "/graph/me/accounts") {
      return json({ data: [{ name: `Page ${channel}`, instagram_business_account: { id: `ig-${channel}`, username: channel, profile_picture_url: null } }] });
    }
    const graph = /^\/graph\/([\w-]+)(?:\/(media|media_publish))?$/.exec(path);
    if (graph?.[2] === "media") {
      const id = `container-${++this.n}`;
      this.pending.set(id, { channel, title: sent.get("caption") ?? "" });
      return json({ id, uri: `${this.base}/graph/upload/${id}` });
    }
    if (graph?.[2] === "media_publish") return json({ id: `media-${channel}` });
    if (graph && url.searchParams.get("fields")?.startsWith("status_code")) return json({ status_code: "FINISHED" });
    if (graph && url.searchParams.get("fields") === "permalink") return json({ permalink: `https://www.instagram.com/reel/fake-${channel}/` });

    return json({ error: { message: `The stand-in has no ${req.method} ${path}.` } }, 404);
  }
}

/** Demo mode: the "sign-in page" is our own callback, which comes straight back with a code. */
export function demoEndpoints(fake: FakePlatforms): Endpoints {
  const back = (platform: DirectPlatform) => `/oauth/${platform}/callback?code=demo`;
  return { ...fake.endpoints(), googleAuth: back("youtube"), tiktokAuth: back("tiktok"), facebookAuth: back("instagram") };
}
