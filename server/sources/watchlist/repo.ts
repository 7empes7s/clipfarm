import type { Db } from "../../db/index.js";
import type {
  ClipProgram,
  DetectedVod,
  DetectedVodStatus,
  LiveNow,
  Source,
  WatchChannel,
  WatchedCreator,
  WatchedCreatorInput,
  WatchPlatform,
} from "../../../shared/types.js";
import { CLIP_PROGRAMS, WATCH_PLATFORMS } from "../../../shared/types.js";
import { normalizeHandle } from "../../../shared/watchlist.js";
import { NotFoundError, ValidationError } from "../../errors.js";
import type { SourcesRepo } from "../repo.js";
import type { RemoteVod } from "./platforms/types.js";

interface CreatorRow {
  id: number;
  name: string;
  channels: string;
  language: string;
  games: string;
  program: ClipProgram;
  program_url: string | null;
  note: string;
  source_id: number | null;
  auto_ingest: number;
  live: string | null;
  workspace_id: number;
  created_at: string;
}

interface DetectedRow {
  id: number;
  creator_id: number;
  platform: WatchPlatform;
  external_id: string;
  url: string;
  title: string;
  category: string | null;
  published_at: string;
  duration_sec: number | null;
  status: DetectedVodStatus;
  skip_reason: string | null;
  vod_id: number | null;
}

export interface DetectedVodRecord extends DetectedVod {
  creatorId: number;
  durationSec: number | null;
}

function toDetected(r: DetectedRow): DetectedVodRecord {
  return {
    id: r.id,
    creatorId: r.creator_id,
    platform: r.platform,
    url: r.url,
    title: r.title,
    category: r.category,
    publishedAt: r.published_at,
    durationSec: r.duration_sec,
    status: r.status,
    skipReason: r.skip_reason,
    vodId: r.vod_id,
  };
}

/** Checks a watchlist entry from the app (or the seed file) and returns it clean. */
export function parseWatchedCreator(body: unknown): WatchedCreatorInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name) throw new ValidationError("Enter the creator's name.");
  const channels: WatchChannel[] = [];
  for (const c of Array.isArray(b.channels) ? (b.channels as Record<string, unknown>[]) : []) {
    const platform = c?.platform as WatchPlatform;
    if (!WATCH_PLATFORMS.includes(platform) || typeof c.handle !== "string" || !c.handle.trim()) continue;
    const handle = normalizeHandle(platform, c.handle);
    if (!handle) throw new ValidationError(`"${c.handle}" is not a channel name or link on that platform.`);
    if (!channels.some((x) => x.platform === platform)) channels.push({ platform, handle });
  }
  if (channels.length === 0) throw new ValidationError("Add their channel on Twitch, Kick or YouTube.");
  const program = (b.program ?? "none") as ClipProgram;
  if (!CLIP_PROGRAMS.includes(program)) throw new ValidationError("Choose their clipping program, or none known.");
  let programUrl: string | null = null;
  if (typeof b.programUrl === "string" && b.programUrl.trim()) {
    try {
      const u = new URL(b.programUrl.trim());
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
      programUrl = u.toString();
    } catch {
      throw new ValidationError("The program link is not a web link.");
    }
  }
  const games = (Array.isArray(b.games) ? b.games : [])
    .filter((g): g is string => typeof g === "string")
    .map((g) => g.trim())
    .filter(Boolean);
  const sourceId = b.sourceId === null || b.sourceId === undefined || b.sourceId === "" ? null : Number(b.sourceId);
  if (sourceId !== null && (!Number.isInteger(sourceId) || sourceId <= 0)) throw new ValidationError("Pick a campaign from the list.");
  return {
    name,
    channels,
    language: typeof b.language === "string" ? b.language.trim().toLowerCase().slice(0, 10) : "",
    games: games.length ? [...new Set(games)] : ["GTA VI"],
    program,
    programUrl,
    note: typeof b.note === "string" ? b.note.trim() : "",
    sourceId,
  };
}

const SEEDED_KEY = "watchlist_seeded";

export class WatchlistRepo {
  constructor(
    private db: Db,
    private sources: SourcesRepo,
    private now: () => Date = () => new Date(),
  ) {}

  /** Fills an empty watchlist from the seed file once; after that the manager edits it in the app. */
  seedOnce(seed: unknown[]): number {
    if (this.db.prepare("SELECT 1 FROM settings WHERE key = ?").get(SEEDED_KEY)) return 0;
    let added = 0;
    this.db.transaction(() => {
      for (const entry of seed) {
        this.insert(parseWatchedCreator(entry));
        added++;
      }
      this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(SEEDED_KEY, this.now().toISOString());
    })();
    return added;
  }

  create(input: WatchedCreatorInput): WatchedCreator {
    if (input.sourceId !== null) this.sources.get(input.sourceId);
    return this.get(this.insert(input));
  }

  private insert(input: WatchedCreatorInput): number {
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO watchlist (name, channels, language, games, program, program_url, note, source_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name,
        JSON.stringify(input.channels),
        input.language,
        JSON.stringify(input.games),
        input.program,
        input.programUrl,
        input.note,
        input.sourceId,
        this.now().toISOString(),
      );
    return Number(lastInsertRowid);
  }

  update(id: number, input: WatchedCreatorInput): WatchedCreator {
    this.row(id);
    if (input.sourceId !== null) this.sources.get(input.sourceId);
    this.db
      .prepare(
        `UPDATE watchlist SET name = ?, channels = ?, language = ?, games = ?, program = ?, program_url = ?, note = ?,
           source_id = ? WHERE id = ?`,
      )
      .run(
        input.name,
        JSON.stringify(input.channels),
        input.language,
        JSON.stringify(input.games),
        input.program,
        input.programUrl,
        input.note,
        input.sourceId,
        id,
      );
    return this.get(id);
  }

  remove(id: number): void {
    this.row(id);
    this.db.prepare("DELETE FROM watchlist WHERE id = ?").run(id);
  }

  /** Creator mode: the channel belongs to a workspace (me, or a client). */
  setWorkspace(id: number, workspaceId: number): void {
    this.row(id);
    this.db.prepare("UPDATE watchlist SET workspace_id = ? WHERE id = ?").run(workspaceId, id);
  }

  setAutoIngest(id: number, on: boolean): void {
    this.row(id);
    this.db.prepare("UPDATE watchlist SET auto_ingest = ? WHERE id = ?").run(on ? 1 : 0, id);
  }

  setLive(id: number, live: LiveNow | null): void {
    this.db.prepare("UPDATE watchlist SET live = ? WHERE id = ?").run(live ? JSON.stringify(live) : null, id);
  }

  /** Records a VOD seen on a platform; a VOD already seen keeps its id and status. */
  upsertDetected(creatorId: number, v: RemoteVod): DetectedVodRecord {
    this.db
      .prepare(
        `INSERT INTO detected_vods (creator_id, platform, external_id, url, title, category, published_at, duration_sec,
           status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'skipped', ?)
         ON CONFLICT (platform, external_id) DO UPDATE SET title = excluded.title, category = COALESCE(excluded.category, category),
           duration_sec = excluded.duration_sec`,
      )
      .run(creatorId, v.platform, v.externalId, v.url, v.title, v.category, v.publishedAt, v.durationSec, this.now().toISOString());
    const row = this.db
      .prepare("SELECT * FROM detected_vods WHERE platform = ? AND external_id = ?")
      .get(v.platform, v.externalId) as DetectedRow;
    return toDetected(row);
  }

  markQueued(detectedId: number, vodId: number): void {
    this.db.prepare("UPDATE detected_vods SET status = 'queued', skip_reason = NULL, vod_id = ? WHERE id = ?").run(vodId, detectedId);
  }

  markSkipped(detectedId: number, reason: string): void {
    this.db.prepare("UPDATE detected_vods SET status = 'skipped', skip_reason = ? WHERE id = ? AND status <> 'queued'").run(reason, detectedId);
  }

  queuedFor(creatorId: number): DetectedVodRecord[] {
    return (
      this.db.prepare("SELECT * FROM detected_vods WHERE creator_id = ? AND status = 'queued'").all(creatorId) as DetectedRow[]
    ).map(toDetected);
  }

  /** The campaign whose permission records cover this creator: the linked one, else one with the same name. */
  sourceFor(creator: { name: string; sourceId: number | null }, all: Source[] = this.sources.list()): Source | null {
    if (creator.sourceId !== null) return all.find((s) => s.id === creator.sourceId) ?? null;
    const name = creator.name.trim().toLowerCase();
    return all.find((s) => s.creatorName.trim().toLowerCase() === name) ?? null;
  }

  list(): WatchedCreator[] {
    const all = this.sources.list();
    return (this.db.prepare("SELECT * FROM watchlist ORDER BY id").all() as CreatorRow[]).map((r) => this.hydrate(r, all));
  }

  get(id: number): WatchedCreator {
    return this.hydrate(this.row(id), this.sources.list());
  }

  private row(id: number): CreatorRow {
    const row = this.db.prepare("SELECT * FROM watchlist WHERE id = ?").get(id) as CreatorRow | undefined;
    if (!row) throw new NotFoundError("That creator is not on the watchlist.");
    return row;
  }

  private hydrate(r: CreatorRow, all: Source[]): WatchedCreator {
    const last = this.db
      .prepare("SELECT * FROM detected_vods WHERE creator_id = ? ORDER BY published_at DESC, status = 'queued' DESC, id LIMIT 1")
      .get(r.id) as DetectedRow | undefined;
    const source = this.sourceFor({ name: r.name, sourceId: r.source_id }, all);
    return {
      id: r.id,
      name: r.name,
      channels: JSON.parse(r.channels) as WatchChannel[],
      language: r.language,
      games: JSON.parse(r.games) as string[],
      program: r.program,
      programUrl: r.program_url,
      note: r.note,
      sourceId: source?.id ?? null,
      permissionState: source?.permissionState ?? "none",
      autoIngest: r.auto_ingest === 1,
      live: r.live ? (JSON.parse(r.live) as LiveNow) : null,
      lastVod: last ? toDetected(last) : null,
      workspaceId: r.workspace_id ?? 1,
    };
  }
}
