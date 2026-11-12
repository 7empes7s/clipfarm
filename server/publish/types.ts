import type { DailyPoint, Platform, PostFlag, PostingAccount, PostingServiceName, PostStatus } from "../../shared/types.js";

export interface PublishItem {
  account: PostingAccount;
  /** Short title (YouTube's video title). */
  title: string;
  caption: string;
  /** null posts now. */
  when: Date | null;
  /** A paid campaign: flagged as branded content where the platform asks (TikTok). */
  paidPromotion: boolean;
}

export interface PublishResult {
  accountId: string;
  /** The service's id for this post, used to look it up later. */
  externalId: string | null;
  status: PostStatus;
  url: string | null;
  error: string | null;
  postedAt: string | null;
}

export interface TrackedPost {
  externalId: string;
  accountId: string;
  platform: Platform;
  scheduledAt: string;
}

/** What the service now says about a post; fields left out are unknown and keep their value. */
export interface PostUpdate {
  externalId: string;
  accountId: string;
  status?: PostStatus;
  url?: string | null;
  error?: string | null;
  postedAt?: string | null;
  views?: number | null;
  /** Claims, removals or strikes the service knows of; most services say nothing, so they are also entered by hand. */
  flags?: PostFlag[];
}

/** What the service knows about an account: followers and views, one point per day. */
export interface AccountStats {
  accountId: string;
  followers: DailyPoint[];
  views: DailyPoint[];
  /** Claims or strikes on the account, when the service reports them. */
  claims?: number | null;
}

export interface VideoFile {
  path: string;
  fileName: string;
}

/**
 * A product that holds the connected accounts and does the posting (Postiz, Upload-Post).
 * clipfarm only talks to its public API; the permission gate runs before any call.
 */
export interface PostingService {
  readonly name: PostingServiceName;
  readonly label: string;
  /** Posts per platform per day the service allows; empty when it has none. */
  readonly dailyCaps: Partial<Record<Platform, number>>;
  listAccounts(): Promise<PostingAccount[]>;
  publish(video: VideoFile, items: PublishItem[]): Promise<PublishResult[]>;
  refresh(posts: TrackedPost[]): Promise<PostUpdate[]>;
  /** Account stats for the dashboard; left out by services that have none. */
  accountStats?(accounts: PostingAccount[], days: number): Promise<AccountStats[]>;
  /** Most accounts one stats read may ask about (each costs an API call on Postiz). */
  readonly maxStatsAccountsPerRead?: number;
}
