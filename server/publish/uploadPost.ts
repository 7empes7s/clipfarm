import { randomUUID } from "node:crypto";
import { openAsBlob } from "node:fs";
import type { Platform, PostingAccount } from "../../shared/types.js";
import { PLATFORM_LABELS } from "../../shared/types.js";
import { callService, type ServiceVoice } from "./errors.js";
import type { PostingService, PostUpdate, PublishItem, PublishResult, TrackedPost, VideoFile } from "./types.js";

/** Upload-Post (hosted, paid): https://docs.upload-post.com */

const API = "https://api.upload-post.com/api";

/** Posts per platform per day on Upload-Post (docs: pricing and limits). */
export const UPLOAD_POST_DAILY_CAPS: Partial<Record<Platform, number>> = { youtube: 10, tiktok: 15, instagram: 50 };

interface UploadResponse {
  success: boolean;
  results?: Partial<Record<Platform, { success: boolean; url?: string; error?: string }>>;
  job_id?: string;
  request_id?: string;
}

interface PostAnalyticsResponse {
  platforms?: Partial<
    Record<Platform, { success: boolean; post_url?: string | null; error?: string; post_metrics?: { views?: number } }>
  >;
}

export interface UploadPostOptions {
  apiKey: string;
  /** The Upload-Post profile that holds the connected accounts. */
  user: string;
  /** Platforms connected on that profile. */
  platforms: Platform[];
  fetch?: typeof fetch;
  newId?: () => string;
}

export class UploadPostService implements PostingService {
  readonly name = "upload-post";
  readonly label = "Upload-Post";
  readonly dailyCaps = UPLOAD_POST_DAILY_CAPS;
  private doFetch: typeof fetch;
  private voice: ServiceVoice;

  constructor(private opts: UploadPostOptions) {
    this.doFetch = opts.fetch ?? fetch;
    this.voice = {
      label: "Upload-Post",
      secret: opts.apiKey,
      refusedKey: "Upload-Post refused the API key. Check UPLOAD_POST_API_KEY.",
      limited: (detail) => `Upload-Post's limit was reached: ${detail || "try again later."}`,
      unreachable: (reason) => `Cannot reach Upload-Post (${reason}). Try again in a few minutes.`,
    };
  }

  private call<T>(path: string, init: RequestInit = {}): Promise<T> {
    return callService<T>(this.doFetch, `${API}${path}`, { ...init, headers: { Authorization: `Apikey ${this.opts.apiKey}` } }, this.voice);
  }

  listAccounts(): Promise<PostingAccount[]> {
    const { user, platforms } = this.opts;
    return Promise.resolve(
      platforms.map((platform) => ({ id: `${user}:${platform}`, platform, name: `${user} (${PLATFORM_LABELS[platform]})`, disabled: false })),
    );
  }

  async publish(video: VideoFile, items: PublishItem[]): Promise<PublishResult[]> {
    const blob = await openAsBlob(video.path, { type: "video/mp4" });
    const groups = new Map<string, PublishItem[]>();
    for (const item of items) {
      const key = item.when ? item.when.toISOString() : "now";
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    const results: PublishResult[] = [];
    for (const [key, group] of groups) {
      // Our own request id, so the post can be found again even if the answer is lost.
      const requestId = (this.opts.newId ?? randomUUID)();
      const form = new FormData();
      form.append("user", this.opts.user);
      for (const item of group) form.append("platform[]", item.account.platform);
      form.append("title", group[0]!.title);
      for (const item of group) {
        if (item.account.platform === "youtube") {
          form.append("youtube_title", item.title.slice(0, 100));
          form.append("youtube_description", item.caption);
        } else {
          form.append(`${item.account.platform}_title`, item.caption);
        }
      }
      if (group.some((i) => i.account.platform === "tiktok")) {
        form.append("brand_content_toggle", String(group.some((i) => i.paidPromotion)));
      }
      form.append("request_id", requestId);
      if (key !== "now") form.append("scheduled_date", key);
      form.append("video", blob, video.fileName);

      const res = await this.call<UploadResponse>("/upload", { method: "POST", body: form });
      for (const item of group) {
        const r = res.results?.[item.account.platform];
        if (!r) {
          // Scheduled, or switched to the background: the refresh picks up the result.
          results.push({ accountId: item.account.id, externalId: requestId, status: "scheduled", url: null, error: null, postedAt: null });
        } else if (r.success) {
          results.push({ accountId: item.account.id, externalId: requestId, status: "posted", url: r.url ?? null, error: null, postedAt: new Date().toISOString() });
        } else {
          results.push({
            accountId: item.account.id,
            externalId: requestId,
            status: "failed",
            url: null,
            error: `${PLATFORM_LABELS[item.account.platform].split(" ")[0]} said: ${r.error ?? "the post was refused."}`,
            postedAt: null,
          });
        }
      }
    }
    return results;
  }

  async refresh(posts: TrackedPost[]): Promise<PostUpdate[]> {
    const updates: PostUpdate[] = [];
    const byRequest = new Map<string, TrackedPost[]>();
    for (const p of posts) byRequest.set(p.externalId, [...(byRequest.get(p.externalId) ?? []), p]);
    for (const [requestId, group] of byRequest) {
      const res = await this.call<PostAnalyticsResponse>(`/uploadposts/post-analytics/${encodeURIComponent(requestId)}`);
      for (const tracked of group) {
        const p = res.platforms?.[tracked.platform];
        if (!p) continue;
        const update: PostUpdate = {
          externalId: requestId,
          accountId: tracked.accountId,
          status: p.success ? "posted" : "failed",
          url: p.post_url ?? null,
          error: p.success ? null : (p.error ?? "The platform refused the post."),
        };
        if (typeof p.post_metrics?.views === "number") update.views = p.post_metrics.views;
        updates.push(update);
      }
    }
    return updates;
  }
}
