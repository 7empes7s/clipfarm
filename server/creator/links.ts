import type { LinkKind } from "../../shared/creator.js";
import type { WatchChannel } from "../../shared/types.js";
import { normalizeHandle } from "../../shared/watchlist.js";
import { ValidationError } from "../errors.js";

/** A pasted link, sorted: one video to clip now, or a channel / feed to watch for new videos. */
export interface CreatorLink {
  kind: LinkKind;
  /** What the downloader is given (Dropbox and Drive links turned into their direct-download form). */
  url: string;
  /** A Twitch, Kick or YouTube channel, watched through the watchlist. */
  channel: WatchChannel | null;
}

const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac)$/i;

/** True when the link (or file name) is an audio file: a podcast episode, made into audiograms. */
export function isAudioUrl(url: string): boolean {
  try {
    return AUDIO_EXT.test(new URL(url).pathname);
  } catch {
    return AUDIO_EXT.test(url);
  }
}

function host(u: URL): string {
  return u.hostname.toLowerCase().replace(/^(www\.|m\.)/, "");
}

/**
 * Sorts a link the user owns: a YouTube, Twitch or Kick video or channel, a podcast RSS feed, a
 * Google Drive or Dropbox file, or any other video file link. Throws a plain ValidationError for
 * anything that is not a web link, or a channel link it cannot watch.
 */
export function classifyLink(raw: unknown): CreatorLink {
  const text = typeof raw === "string" ? raw.trim() : "";
  let u: URL;
  try {
    u = new URL(text);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
  } catch {
    throw new ValidationError("Paste a link to your video, channel or podcast feed (starting with https://).");
  }
  const h = host(u);
  const parts = u.pathname.split("/").filter(Boolean);
  const video = (kind: LinkKind, url = u.toString()): CreatorLink => ({ kind, url, channel: null });
  const channel = (kind: LinkKind, platform: WatchChannel["platform"], value: string): CreatorLink => {
    const handle = normalizeHandle(platform, value);
    if (!handle) throw new ValidationError("That channel link has no channel name in it.");
    return { kind, url: u.toString(), channel: { platform, handle } };
  };

  if (h === "youtu.be") return video("youtube-video");
  if (h === "youtube.com" || h === "music.youtube.com") {
    if (u.searchParams.has("v") || ["shorts", "live", "embed"].includes(parts[0] ?? "")) return video("youtube-video");
    if (parts[0]?.startsWith("@")) return channel("youtube-channel", "youtube", parts[0]);
    throw new ValidationError("Paste the channel's @name link (like youtube.com/@yourname) so new uploads can be watched.");
  }
  if (h === "twitch.tv") {
    if (parts[0] === "videos" || parts[1] === "video" || parts[1] === "clip") return video("twitch-vod");
    if (parts[0]) return channel("twitch-channel", "twitch", parts[0]);
  }
  if (h === "kick.com") {
    if (parts[0] === "video" || parts[1] === "videos" || parts[1] === "clips") return video("kick-vod");
    if (parts[0]) return channel("kick-channel", "kick", parts[0]);
  }
  if (h === "dropbox.com" || h === "dl.dropboxusercontent.com") {
    u.searchParams.delete("dl");
    u.searchParams.set("dl", "1");
    return video("dropbox", u.toString());
  }
  if (h === "drive.google.com") {
    const id = parts[0] === "file" && parts[1] === "d" ? parts[2] : u.searchParams.get("id");
    if (!id) throw new ValidationError("Paste the Drive file's share link (drive.google.com/file/d/…), set to anyone with the link.");
    return video("drive", `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`);
  }
  const path = u.pathname.toLowerCase();
  if (/\.(rss|xml)$/.test(path) || /(^|\/)(feed|rss|podcast\.xml)(\/|$)/.test(path) || /^(feeds?|rss)\./.test(h) || h === "anchor.fm") {
    return video("podcast-feed");
  }
  return video("file");
}

/** One episode of a podcast feed. */
export interface FeedEpisode {
  title: string;
  url: string;
  publishedAt: string | null;
}

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(block);
  if (!m) return null;
  return m[1]!.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim();
}

function decode(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
}

/** The episodes of an RSS feed that have an audio or video file, newest first. */
export function parseFeed(xml: string): { title: string | null; episodes: FeedEpisode[] } {
  const channelTitle = tag(xml.split(/<item[\s>]/i)[0] ?? "", "title");
  const episodes: FeedEpisode[] = [];
  for (const m of xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)) {
    const block = m[1]!;
    const enclosure = /<enclosure\b[^>]*\burl\s*=\s*["']([^"']+)["']/i.exec(block)?.[1];
    if (!enclosure) continue;
    const pub = tag(block, "pubDate");
    const t = pub ? new Date(pub) : null;
    episodes.push({
      title: decode(tag(block, "title") ?? "Episode"),
      url: decode(enclosure),
      publishedAt: t && !Number.isNaN(t.getTime()) ? t.toISOString() : null,
    });
  }
  episodes.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
  return { title: channelTitle ? decode(channelTitle) : null, episodes };
}

/** Reads a feed's text. Real: an HTTP GET; tests and demo mode: a fake. */
export type FeedFetcher = (url: string, signal?: AbortSignal) => Promise<string>;

export const httpFeedFetcher: FeedFetcher = async (url, signal) => {
  const res = await fetch(url, { signal: signal ?? AbortSignal.timeout(20_000), headers: { "User-Agent": "clipfarm feed reader" } });
  if (!res.ok) throw new ValidationError(`The feed answered ${res.status}. Check the link.`);
  return res.text();
};

/** Demo mode: a feed with two short episodes (the fake downloader makes test media for any link). */
export const fakeFeedFetcher: FeedFetcher = async (url) => `<?xml version="1.0"?><rss><channel><title>Demo podcast</title>
<item><title>Episode 2: the big one</title><enclosure url="${new URL("episode-2.mp3", url)}" type="audio/mpeg"/><pubDate>${new Date().toUTCString()}</pubDate></item>
<item><title>Episode 1</title><enclosure url="${new URL("episode-1.mp3", url)}" type="audio/mpeg"/><pubDate>${new Date(Date.now() - 7 * 86_400_000).toUTCString()}</pubDate></item>
</channel></rss>`;
