import type { WatchPlatform } from "../../../../shared/types.js";
import { channelUrl } from "../../../../shared/watchlist.js";
import type { ChannelCheck, PlatformClient } from "./types.js";

/**
 * No network: every channel has one GTA VI VOD from two hours ago (the same broadcast on each
 * platform, like a simulcast) and an older off-topic one. Handles starting with a–f are live.
 */
export class FakePlatformClient implements PlatformClient {
  readonly missing = null;

  constructor(
    readonly platform: WatchPlatform,
    private now: () => Date = () => new Date(),
  ) {}

  check(handle: string): Promise<ChannelCheck> {
    const h = handle.toLowerCase();
    const t = this.now().getTime();
    // Rounded to the hour so every platform reports the same start for the same broadcast.
    const start = new Date(Math.floor(t / 3600_000) * 3600_000 - 2 * 3600_000).toISOString();
    const url = channelUrl({ platform: this.platform, handle: h });
    return Promise.resolve({
      vods: [
        {
          platform: this.platform,
          externalId: `fake-${this.platform}-${h}-gta6`,
          url: `${url}/videos/fake-gta6`,
          title: `GTA VI launch night with ${handle}`,
          category: "Grand Theft Auto VI",
          publishedAt: start,
          durationSec: 3600,
        },
        {
          platform: this.platform,
          externalId: `fake-${this.platform}-${h}-chat`,
          url: `${url}/videos/fake-chat`,
          title: "Just chatting with chat",
          category: "Just Chatting",
          publishedAt: new Date(t - 26 * 3600_000).toISOString(),
          durationSec: 5400,
        },
      ],
      live: /^[a-f]/.test(h) ? { platform: this.platform, title: `${handle} live`, game: "Grand Theft Auto VI", startedAt: start, url } : null,
    });
  }
}
