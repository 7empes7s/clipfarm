import type { LiveNow, WatchPlatform } from "../../../../shared/types.js";

export interface RemoteVod {
  platform: WatchPlatform;
  externalId: string;
  url: string;
  title: string;
  category: string | null;
  /** When the broadcast started (or the upload went up). */
  publishedAt: string;
  durationSec: number | null;
}

export interface ChannelCheck {
  /** Finished VODs, newest first. */
  vods: RemoteVod[];
  live: LiveNow | null;
}

/** One streaming platform. Real ones call its API; tests and CLIPFARM_FAKES use the fake. */
export interface PlatformClient {
  platform: WatchPlatform;
  /** What to add in Settings when keys are missing; null when it can be called. */
  missing: string | null;
  check(handle: string, signal?: AbortSignal): Promise<ChannelCheck>;
}

/**
 * A platform call failed; `retryAfterSec` comes from a 429 answer. `channelMissing` means the
 * handle does not exist (the entry is wrong, the platform is fine). Messages never contain keys.
 */
export class PlatformError extends Error {
  readonly retryAfterSec?: number;
  readonly channelMissing: boolean;

  constructor(message: string, opts: { retryAfterSec?: number; channelMissing?: boolean } = {}) {
    super(message);
    this.retryAfterSec = opts.retryAfterSec;
    this.channelMissing = opts.channelMissing ?? false;
  }
}

/** GETs (or POSTs) JSON, turning HTTP and network failures into a plain PlatformError. */
export async function fetchJson<T>(doFetch: typeof fetch, label: string, url: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await doFetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(20_000) });
  } catch (error) {
    throw new PlatformError(`${label} could not be reached (${error instanceof Error ? error.message : String(error)}).`);
  }
  if (res.status === 429) {
    const retry = Number(res.headers.get("retry-after"));
    throw new PlatformError(`${label} asked us to slow down.`, { retryAfterSec: Number.isFinite(retry) && retry > 0 ? retry : undefined });
  }
  if (res.status === 401 || res.status === 403) throw new PlatformError(`${label} refused the request (HTTP ${res.status}). Check its keys.`);
  if (res.status === 404) throw new PlatformError(`${label} has no such channel.`, { channelMissing: true });
  if (!res.ok) throw new PlatformError(`${label} answered with an error (HTTP ${res.status}).`);
  try {
    return (await res.json()) as T;
  } catch {
    throw new PlatformError(`${label} sent an answer that is not JSON.`);
  }
}
