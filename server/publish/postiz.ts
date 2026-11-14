import { openAsBlob } from "node:fs";
import type { DailyPoint, Platform, PostingAccount, PostStatus } from "../../shared/types.js";
import type { PostMetrics } from "../../shared/growth.js";
import { callService, type ServiceVoice } from "./errors.js";
import type { AccountStats, PostingService, PostUpdate, PublishItem, PublishResult, TrackedPost, VideoFile } from "./types.js";

/**
 * Postiz (github.com/gitroomhq/postiz-app), self-hosted. Only its public API is called over HTTP
 * (https://docs.postiz.com/public-api/introduction), so no AGPL code is part of clipfarm.
 */

const IDENTIFIERS: Record<string, Platform> = {
  youtube: "youtube",
  tiktok: "tiktok",
  instagram: "instagram",
  "instagram-standalone": "instagram",
  x: "x",
};

interface PostizIntegration {
  id: string;
  name?: string;
  identifier: string;
  disabled?: boolean;
  picture?: string | null;
  profile?: string | null;
}

interface PostizMedia {
  id: string;
  path: string;
}

interface PostizPost {
  id: string;
  publishDate?: string;
  releaseURL?: string;
  state: "QUEUE" | "PUBLISHED" | "ERROR" | "DRAFT";
  error?: string | null;
}

export interface PostizAnalytics {
  label: string;
  data: { total: string; date: string }[];
}

/** Views of a post from Postiz's post analytics: the largest "Views" total, else "Impressions". */
export function viewsFromPostizAnalytics(metrics: PostizAnalytics[]): number | null {
  const pick = (re: RegExp) => metrics.find((m) => re.test(m.label.trim()));
  const metric = pick(/^(video )?views$/i) ?? pick(/^impressions$/i);
  if (!metric || metric.data.length === 0) return null;
  return Math.max(...metric.data.map((d) => Number(d.total) || 0));
}

/**
 * Everything else Postiz's post analytics names, by label. Postiz passes on what each platform's
 * own API gives for the connected account, so the labels differ per platform; a number that is
 * not in the answer is left out (shown as "not available"), never guessed.
 */
export function metricsFromPostizAnalytics(metrics: PostizAnalytics[]): Partial<PostMetrics> {
  const out: Partial<PostMetrics> = {};
  const labels: [keyof PostMetrics, RegExp, "max" | "last"][] = [
    ["likes", /^likes?$/i, "max"],
    ["comments", /^comments?$/i, "max"],
    ["shares", /^(shares?|reposts?|retweets?)$/i, "max"],
    ["saves", /^(saves?|saved|bookmarks?)$/i, "max"],
    ["reach", /^reach$/i, "max"],
    ["avgWatchPct", /^(average|avg\.?) (view|watch) percentage$/i, "last"],
    ["followsGained", /^(subscribers gained|new followers|follows)$/i, "max"],
    ["revenueUsd", /^(estimated )?revenue$/i, "max"],
  ];
  for (const [key, re, how] of labels) {
    const values = (metrics.find((m) => re.test(m.label.trim()))?.data ?? []).map((d) => Number(d.total)).filter(Number.isFinite);
    if (values.length > 0) out[key] = how === "max" ? Math.max(...values) : values.at(-1)!;
  }
  return out;
}

/**
 * Followers and views per day from Postiz's platform analytics (GET /analytics/{integration}).
 * Labels differ per platform: followers may be "Subscribers" (YouTube); views may be "Video Views"
 * or, where a platform has no views, "Impressions".
 */
export function accountStatsFromPostiz(accountId: string, metrics: PostizAnalytics[]): AccountStats {
  const pick = (...res: RegExp[]) => {
    for (const re of res) {
      const m = metrics.find((x) => re.test(x.label.trim()));
      if (m) return m;
    }
    return undefined;
  };
  const points = (m: PostizAnalytics | undefined): DailyPoint[] =>
    (m?.data ?? [])
      .map((d) => ({ date: d.date.slice(0, 10), value: Number(d.total) }))
      .filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date) && Number.isFinite(p.value))
      .sort((a, b) => a.date.localeCompare(b.date));
  return {
    accountId,
    followers: points(pick(/^(page )?followers$/i, /^subscribers$/i)),
    views: points(pick(/^(video )?views$/i, /^impressions$/i)),
    claims: points(pick(/^(copyright )?(claims|strikes)$/i)).at(-1)?.value ?? null,
  };
}

const DAY = 24 * 3600_000;
const PUBLIC_API_PATH = "/api/public/v1";

export interface PostizOptions {
  url: string;
  apiKey: string;
  fetch?: typeof fetch;
  /** Post analytics calls per refresh: the public API allows about 30 calls an hour. */
  maxAnalyticsCalls?: number;
}

export class PostizService implements PostingService {
  readonly name = "postiz";
  readonly label = "Postiz";
  readonly dailyCaps = {};
  // One call per account; post views already use most of the ~30 calls an hour.
  readonly maxStatsAccountsPerRead = 4;
  private base: string;
  private site: string;
  private doFetch: typeof fetch;
  private voice: ServiceVoice;
  private maxAnalyticsCalls: number;
  /** Postiz's provider id per account (instagram vs instagram-standalone need different settings). */
  private identifiers = new Map<string, string>();

  constructor(private opts: PostizOptions) {
    this.site = opts.url.trim().replace(/\/+$/, "");
    this.base = this.site.endsWith(PUBLIC_API_PATH) ? this.site : this.site + PUBLIC_API_PATH;
    this.doFetch = opts.fetch ?? fetch;
    this.maxAnalyticsCalls = opts.maxAnalyticsCalls ?? 20;
    this.voice = {
      label: "Postiz",
      secret: opts.apiKey,
      refusedKey: "Postiz refused the API key. Copy it again from Postiz > Settings > Public API and paste it in Settings.",
      limited: () => "Postiz's hourly limit was reached. Try again in an hour.",
      unreachable: (reason) => `Cannot reach Postiz at ${this.site} (${reason}). Is it running, and is its address in Settings right?`,
    };
  }

  private call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = { Authorization: this.opts.apiKey, Accept: "application/json" };
    if (typeof init.body === "string") headers["Content-Type"] = "application/json";
    return callService<T>(this.doFetch, `${this.base}${path}`, { ...init, headers }, this.voice);
  }

  async listAccounts(): Promise<PostingAccount[]> {
    const integrations = await this.call<PostizIntegration[]>("/integrations");
    const accounts: PostingAccount[] = [];
    for (const i of integrations) {
      const platform = IDENTIFIERS[i.identifier];
      if (!platform) continue;
      this.identifiers.set(i.id, i.identifier);
      accounts.push({
        id: i.id,
        platform,
        name: i.name ?? i.identifier,
        disabled: Boolean(i.disabled),
        handle: i.profile || null,
        avatarUrl: i.picture || null,
      });
    }
    return accounts;
  }

  private settings(item: PublishItem): Record<string, unknown> {
    const identifier = this.identifiers.get(item.account.id) ?? item.account.platform;
    switch (item.account.platform) {
      case "youtube":
        return { __type: "youtube", title: item.title.slice(0, 100), type: item.privacy ?? "public", selfDeclaredMadeForKids: "no", tags: [] };
      case "tiktok":
        return {
          __type: "tiktok",
          privacy_level: "PUBLIC_TO_EVERYONE",
          duet: false,
          stitch: false,
          comment: true,
          autoAddMusic: "no",
          brand_content_toggle: item.paidPromotion,
          brand_organic_toggle: false,
          video_made_with_ai: false,
          content_posting_method: "DIRECT_POST",
        };
      case "instagram":
        return { __type: identifier, post_type: "post", is_trial_reel: false, collaborators: [] };
      case "x":
        return { __type: "x", who_can_reply_post: "everyone" };
    }
  }

  async publish(video: VideoFile, items: PublishItem[]): Promise<PublishResult[]> {
    if (items.some((i) => !this.identifiers.has(i.account.id))) await this.listAccounts();
    const form = new FormData();
    form.append("file", await openAsBlob(video.path, { type: "video/mp4" }), video.fileName);
    const media = await this.call<PostizMedia>("/upload", { method: "POST", body: form });
    const image = [{ id: media.id, path: media.path }];

    // One create request per publish time (the request carries a single type and date).
    const groups = new Map<string, PublishItem[]>();
    for (const item of items) {
      const key = item.when ? item.when.toISOString() : "now";
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    const ids = new Map<string, string>();
    for (const [key, group] of groups) {
      const created = await this.call<{ postId: string; integration: string }[]>("/posts", {
        method: "POST",
        body: JSON.stringify({
          type: key === "now" ? "now" : "schedule",
          date: key === "now" ? new Date().toISOString() : key,
          shortLink: false,
          tags: [],
          posts: group.map((item) => ({
            integration: { id: item.account.id },
            value: [{ content: item.caption, image }],
            settings: this.settings(item),
          })),
        }),
      });
      for (const c of created) ids.set(c.integration, c.postId);
    }
    // Postiz posts in the background, even "now": the refresh picks up the URL.
    return items.map((item) => {
      const externalId = ids.get(item.account.id) ?? null;
      return {
        accountId: item.account.id,
        externalId,
        status: externalId ? "scheduled" : "failed",
        url: null,
        error: externalId ? null : "Postiz did not create this post. Check the account in Postiz.",
        postedAt: null,
      };
    });
  }

  async refresh(posts: TrackedPost[]): Promise<PostUpdate[]> {
    if (posts.length === 0) return [];
    const times = posts.map((p) => new Date(p.scheduledAt).getTime());
    const start = new Date(Math.min(...times) - DAY).toISOString();
    const end = new Date(Math.max(Date.now(), ...times) + DAY).toISOString();
    const listed = await this.call<{ posts: PostizPost[] }>(
      `/posts?${new URLSearchParams({ startDate: start, endDate: end })}`,
    );
    const byId = new Map(listed.posts.map((p) => [p.id, p]));

    const updates: PostUpdate[] = [];
    let analyticsCalls = 0;
    for (const tracked of posts) {
      const p = byId.get(tracked.externalId);
      if (!p) continue;
      const status: PostStatus = p.state === "PUBLISHED" ? "posted" : p.state === "ERROR" ? "failed" : "scheduled";
      const update: PostUpdate = {
        externalId: tracked.externalId,
        accountId: tracked.accountId,
        status,
        url: p.releaseURL ?? null,
        postedAt: status === "posted" ? (p.publishDate ?? null) : null,
        error: status === "failed" ? (p.error ?? "The platform refused the post.") : null,
      };
      if (status === "posted" && analyticsCalls < this.maxAnalyticsCalls) {
        analyticsCalls++;
        const metrics = await this.call<PostizAnalytics[]>(`/analytics/post/${encodeURIComponent(p.id)}?date=30`);
        const views = viewsFromPostizAnalytics(metrics);
        if (views !== null) update.views = views;
        const more = metricsFromPostizAnalytics(metrics);
        if (Object.keys(more).length > 0) update.metrics = more;
      }
      updates.push(update);
    }
    return updates;
  }

  async accountStats(accounts: PostingAccount[], days: number): Promise<AccountStats[]> {
    const out: AccountStats[] = [];
    for (const a of accounts) {
      const metrics = await this.call<PostizAnalytics[]>(`/analytics/${encodeURIComponent(a.id)}?date=${days}`);
      out.push(accountStatsFromPostiz(a.id, metrics));
    }
    return out;
  }
}
