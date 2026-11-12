import type { Platform, PostingAccount } from "../../shared/types.js";
import { PostingServiceError } from "./errors.js";
import type { PostingService, PostUpdate, PublishItem, PublishResult, TrackedPost, VideoFile } from "./types.js";

export const FAKE_ACCOUNTS: PostingAccount[] = [
  { id: "fake-youtube", platform: "youtube", name: "GTA VI Moments", disabled: false },
  { id: "fake-tiktok", platform: "tiktok", name: "gtavimoments", disabled: false },
  { id: "fake-instagram", platform: "instagram", name: "gtavi.moments", disabled: false },
  { id: "fake-x", platform: "x", name: "GTA VI Moments", disabled: false },
];

/** Stands in for Postiz / Upload-Post in tests and demos: no network, posts "succeed" at once. */
export class FakePostingService implements PostingService {
  readonly name = "fake";
  readonly label = "Test posting service";
  dailyCaps: Partial<Record<Platform, number>> = {};
  /** Every call made, in order, so tests can check nothing was called. */
  calls: ("listAccounts" | "publish" | "refresh")[] = [];
  published: PublishItem[] = [];
  /** Views every posted post reports on refresh; null reports none. */
  views: number | null = 12_000;
  failWith: string | null = null;
  private n = 0;
  private postedIds = new Set<string>();

  constructor(private accounts: PostingAccount[] = FAKE_ACCOUNTS) {}

  listAccounts(): Promise<PostingAccount[]> {
    this.calls.push("listAccounts");
    return Promise.resolve(this.accounts);
  }

  publish(_video: VideoFile, items: PublishItem[]): Promise<PublishResult[]> {
    this.calls.push("publish");
    if (this.failWith) return Promise.reject(new PostingServiceError(this.failWith));
    this.published.push(...items);
    return Promise.resolve(
      items.map((item) => {
        const id = `fake-post-${++this.n}`;
        const now = item.when === null;
        if (now) this.postedIds.add(id);
        return {
          accountId: item.account.id,
          externalId: id,
          status: now ? "posted" : "scheduled",
          url: now ? `https://example.com/${item.account.platform}/${id}` : null,
          error: null,
          postedAt: now ? new Date().toISOString() : null,
        };
      }),
    );
  }

  refresh(posts: TrackedPost[]): Promise<PostUpdate[]> {
    this.calls.push("refresh");
    return Promise.resolve(
      posts.map((p) => {
        const update: PostUpdate = { externalId: p.externalId, accountId: p.accountId };
        // Scheduled posts stay scheduled; posted ones report views.
        if (this.postedIds.has(p.externalId) && this.views !== null) update.views = this.views;
        return update;
      }),
    );
  }
}

/** When no posting service is set up: accounts are empty and posting explains what to do. */
export class NoPostingService implements PostingService {
  readonly name = "none";
  readonly label = "No posting service";
  readonly dailyCaps = {};

  listAccounts(): Promise<PostingAccount[]> {
    return Promise.resolve([]);
  }

  publish(): Promise<PublishResult[]> {
    return Promise.reject(
      new PostingServiceError(
        "No posting service is set up. Use Export to post by hand, or set POSTIZ_URL and POSTIZ_API_KEY (or UPLOAD_POST_API_KEY) on the server.",
      ),
    );
  }

  refresh(): Promise<PostUpdate[]> {
    return Promise.resolve([]);
  }
}
