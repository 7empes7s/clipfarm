import type { Source, Vod, WatchedCreator } from "../../shared/types.js";
import { PLATFORMS } from "../../shared/types.js";
import type { JobQueue } from "../jobs/queue.js";
import { INGEST_JOB } from "../pipeline/ingest/ingest.js";
import { ValidationError } from "../errors.js";
import { isActive } from "../sources/permission.js";
import type { SourcesRepo } from "../sources/repo.js";
import { ANY_VIDEO } from "../sources/watchlist/match.js";
import type { WatchlistRepo } from "../sources/watchlist/repo.js";
import type { VodsRepo } from "../vods/repo.js";
import { classifyLink, type CreatorLink, type FeedFetcher, parseFeed } from "./links.js";
import { uploadUrl, type UploadsRepo } from "./uploads.js";

export interface CreatorDeps {
  sources: SourcesRepo;
  vods: VodsRepo;
  queue: JobQueue;
  uploads: UploadsRepo;
  readFeed: FeedFetcher;
  /** Watching a channel needs the watchlist (and its platform keys); without it only single videos are taken. */
  watchlist?: WatchlistRepo;
  /** Checks a newly watched channel right away, in the background. */
  pollCreator?: (id: number) => void;
  now?: () => Date;
}

/** What "Add your video" sends: a new creator (or one of ours), and a link or a finished upload. */
export interface CreatorAddInput {
  sourceId: number | null;
  name: string;
  ownerName: string;
  attested: boolean;
  link: string | null;
  uploadId: number | null;
}

export interface CreatorAddResult {
  source: Source;
  vods: Vod[];
  watching: WatchedCreator | null;
  /** A podcast feed: its name, read from the feed. */
  feedTitle: string | null;
}

export function parseCreatorAdd(body: unknown): CreatorAddInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const sourceId = b.sourceId === null || b.sourceId === undefined || b.sourceId === "" ? null : Number(b.sourceId);
  if (sourceId !== null && (!Number.isInteger(sourceId) || sourceId <= 0)) throw new ValidationError("Pick one of your creators, or add a new one.");
  const uploadId = b.uploadId === null || b.uploadId === undefined ? null : Number(b.uploadId);
  if (uploadId !== null && (!Number.isInteger(uploadId) || uploadId <= 0)) throw new ValidationError("That upload was not found. Send the file again.");
  const link = text(b.link) || null;
  if (!link && uploadId === null) throw new ValidationError("Upload a video file or paste a link.");
  if (link && uploadId !== null) throw new ValidationError("Send a file or a link, not both at once.");
  const name = text(b.name).slice(0, 120);
  if (sourceId === null && !name) throw new ValidationError("Enter the name of the channel or show.");
  return { sourceId, name, ownerName: text(b.ownerName).slice(0, 120), attested: b.attested === true, link, uploadId };
}

/** True when the source has an own-content record in force: creator mode (and its extra formats) is on for it. */
export function isOwnContent(source: Source, now: Date): boolean {
  return source.permissions.some((p) => p.kind === "own-content" && isActive(p, now));
}

/**
 * Creator mode: your own (or a client's) long videos. Each comes with an "own content" permission
 * record: who owns it and the dated tick "I own these videos or have the owner's OK", which is what
 * lets its clips post. A video link or upload is clipped now; a channel or podcast feed is watched,
 * and new videos are clipped as they come out, waiting in the Inbox.
 */
export class Creator {
  private readonly now: () => Date;

  constructor(private deps: CreatorDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async add(workspaceId: number, input: CreatorAddInput): Promise<CreatorAddResult> {
    if (!input.attested) throw new ValidationError("Tick “I own these videos, or have the owner's OK” first.");
    const owner = input.ownerName || input.name;
    if (!owner) throw new ValidationError("Say who owns the videos.");
    const link = input.link ? classifyLink(input.link) : null;
    if (link?.channel && !this.deps.watchlist) throw new ValidationError("Watching a channel is not set up on this server. Paste a video link instead.");
    const upload = input.uploadId !== null ? this.deps.uploads.file(input.uploadId) : null;
    if (upload && upload.workspaceId !== workspaceId) throw new ValidationError("That upload belongs to another workspace.");
    // Read the feed before anything is saved: a feed that cannot be read adds nothing.
    const feed = link?.kind === "podcast-feed" ? parseFeed(await this.deps.readFeed(link.url)) : null;
    if (feed && feed.episodes.length === 0) throw new ValidationError("That feed has no episodes with an audio or video file.");

    const source = this.sourceFor(workspaceId, input, owner, link);
    const vods: Vod[] = [];
    let watching: WatchedCreator | null = null;
    if (upload) {
      const vod = this.queueVideo(source.id, uploadUrl(input.uploadId!));
      this.deps.uploads.setVod(input.uploadId!, vod.id);
      vods.push(vod);
    } else if (feed) {
      // The newest episode now; later ones as they come out (checkFeeds).
      vods.push(this.queueVideo(source.id, feed.episodes[0]!.url));
    } else if (link?.channel) {
      watching = this.watch(workspaceId, source, link);
    } else if (link) {
      vods.push(this.queueVideo(source.id, link.url));
    }
    return { source: this.deps.sources.get(source.id), vods, watching, feedTitle: feed?.title ?? null };
  }

  /**
   * Podcast feeds of own-content sources: episodes that came out after the feed was added and are
   * not clipped yet are queued. Runs with every watchlist check. Returns how many were queued.
   */
  async checkFeeds(): Promise<number> {
    const now = this.now();
    let queued = 0;
    for (const source of this.deps.sources.list()) {
      if (!isOwnContent(source, now)) continue;
      const known = new Set(this.deps.vods.list().filter((v) => v.sourceId === source.id).map((v) => v.url));
      for (const url of source.channelUrls) {
        let link: CreatorLink;
        try {
          link = classifyLink(url);
        } catch {
          continue;
        }
        if (link.kind !== "podcast-feed") continue;
        let episodes;
        try {
          episodes = parseFeed(await this.deps.readFeed(link.url)).episodes;
        } catch (err) {
          console.warn(`[creator] feed of ${source.creatorName} could not be read: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        for (const e of episodes) {
          if (known.has(e.url) || !e.publishedAt || e.publishedAt <= source.createdAt) continue;
          this.queueVideo(source.id, e.url);
          known.add(e.url);
          queued++;
        }
      }
    }
    return queued;
  }

  private sourceFor(workspaceId: number, input: CreatorAddInput, owner: string, link: CreatorLink | null): Source {
    const watched = link && (link.channel || link.kind === "podcast-feed") ? [link.url] : [];
    if (input.sourceId === null) {
      return this.deps.sources.create(
        {
          creatorName: input.name,
          channelUrls: watched,
          permission: { kind: "own-content", ownerName: owner, attestedAt: this.now().toISOString(), allowedPlatforms: [...PLATFORMS] },
        },
        workspaceId,
      );
    }
    const source = this.deps.sources.get(input.sourceId);
    if (source.workspaceId !== workspaceId) throw new ValidationError("That creator belongs to another workspace.");
    const own = source.permissions.find((p) => p.kind === "own-content" && isActive(p, this.now()));
    if (!own) throw new ValidationError(`${source.creatorName} is not your own content. Add it as a new creator.`);
    this.deps.sources.attest(own.id, owner);
    if (watched.length > 0) this.deps.sources.addChannels(source.id, watched);
    return this.deps.sources.get(source.id);
  }

  private queueVideo(sourceId: number, url: string): Vod {
    // The same gate the "Add link" form uses.
    this.deps.sources.assertCanUse(sourceId);
    const known = this.deps.vods.list().find((v) => v.sourceId === sourceId && v.url === url);
    if (known) return known;
    const vod = this.deps.vods.create(sourceId, url);
    this.deps.queue.enqueue(INGEST_JOB, { vodId: vod.id }, { vodId: vod.id });
    return vod;
  }

  private watch(workspaceId: number, source: Source, link: CreatorLink): WatchedCreator {
    const repo = this.deps.watchlist!;
    const channel = link.channel!;
    const existing = repo.list().find((c) => c.channels.some((x) => x.platform === channel.platform && x.handle.toLowerCase() === channel.handle.toLowerCase()));
    const input = {
      name: source.creatorName,
      channels: [channel],
      language: "",
      games: [ANY_VIDEO],
      program: "own" as const,
      programUrl: null,
      note: "Your own channel: every new video is clipped.",
      sourceId: source.id,
    };
    const entry = existing ? repo.update(existing.id, { ...input, channels: existing.channels }) : repo.create(input);
    repo.setWorkspace(entry.id, workspaceId);
    repo.setAutoIngest(entry.id, true);
    this.deps.pollCreator?.(entry.id);
    return repo.get(entry.id);
  }
}
