import type { WatchChannel, WatchPlatform } from "./types.js";

const HOSTS: Record<WatchPlatform, RegExp> = {
  twitch: /(^|\.)twitch\.tv$/i,
  kick: /(^|\.)kick\.com$/i,
  youtube: /(^|\.)youtube\.com$/i,
};

/** The channel's page on its platform. */
export function channelUrl({ platform, handle }: WatchChannel): string {
  if (platform === "twitch") return `https://www.twitch.tv/${handle}`;
  if (platform === "kick") return `https://kick.com/${handle}`;
  return `https://www.youtube.com/@${handle}`;
}

/**
 * A handle from what the manager typed: "xqc", "@IShowSpeed" or a channel link on that platform.
 * Returns null when it is not a handle.
 */
export function normalizeHandle(platform: WatchPlatform, raw: string): string | null {
  let s = raw.trim();
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (!HOSTS[platform].test(u.hostname)) return null;
      s = u.pathname.split("/").filter(Boolean)[0] ?? "";
    } catch {
      return null;
    }
  }
  s = s.replace(/^@/, "");
  return /^[A-Za-z0-9_.-]{2,40}$/.test(s) ? s : null;
}
