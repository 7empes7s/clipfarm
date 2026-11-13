import type { Db } from "../db/index.js";
import type { WatchPlatform } from "../../shared/types.js";
import { NotFoundError } from "../errors.js";
import { DEFAULT_LAUNCH_AT, type LaunchSettings } from "./plan.js";

export interface Capture {
  id: number;
  /** The watchlist entry. */
  creatorId: number;
  sourceId: number;
  /** The stream's row in `vods`: its transcript, picks and clips hang off it like a VOD's. */
  vodId: number;
  platform: WatchPlatform;
  handle: string;
  url: string;
  title: string;
  game: string | null;
  /** Position on the watchlist when the recording began (0 is the biggest creator). */
  rank: number;
  streamOffsetSec: number;
  status: "recording" | "ended";
  endReason: string | null;
  startedAt: string;
  endedAt: string | null;
  firstClipAt: string | null;
}

export type SegmentStatus = "recording" | "queued" | "done" | "skipped" | "failed";

export interface Segment {
  id: number;
  captureId: number;
  idx: number;
  /** Seconds from the start of the recording. */
  startSec: number;
  durationSec: number | null;
  filePath: string | null;
  status: SegmentStatus;
  note: string | null;
  jobId: number | null;
  /** When recording this segment began, by the server's clock. */
  startedAt: string;
  deletedAt: string | null;
}

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

interface CaptureRow {
  id: number;
  creator_id: number;
  source_id: number;
  vod_id: number;
  platform: WatchPlatform;
  handle: string;
  url: string;
  title: string;
  game: string | null;
  rank: number;
  stream_offset_sec: number;
  status: Capture["status"];
  end_reason: string | null;
  started_at: string;
  ended_at: string | null;
  first_clip_at: string | null;
}

interface SegmentRow {
  id: number;
  capture_id: number;
  idx: number;
  start_sec: number;
  duration_sec: number | null;
  file_path: string | null;
  status: SegmentStatus;
  note: string | null;
  job_id: number | null;
  started_at: string;
  deleted_at: string | null;
}

function toCapture(r: CaptureRow): Capture {
  return {
    id: r.id,
    creatorId: r.creator_id,
    sourceId: r.source_id,
    vodId: r.vod_id,
    platform: r.platform,
    handle: r.handle,
    url: r.url,
    title: r.title,
    game: r.game,
    rank: r.rank,
    streamOffsetSec: r.stream_offset_sec,
    status: r.status,
    endReason: r.end_reason,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    firstClipAt: r.first_clip_at,
  };
}

function toSegment(r: SegmentRow): Segment {
  return {
    id: r.id,
    captureId: r.capture_id,
    idx: r.idx,
    startSec: r.start_sec,
    durationSec: r.duration_sec,
    filePath: r.file_path,
    status: r.status,
    note: r.note,
    jobId: r.job_id,
    startedAt: r.started_at,
    deletedAt: r.deleted_at,
  };
}

const LAUNCH_KEY = "launch";
const VAPID_KEY = "push_vapid_keys";

/** Live mode's records: the launch switch, recordings and their segments, and who gets notifications. */
export class LiveRepo {
  constructor(
    private db: Db,
    private defaultLaunchAt: string = DEFAULT_LAUNCH_AT,
  ) {}

  private setting<T>(key: string): T | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  }

  private saveSetting(key: string, value: unknown): void {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  }

  launch(): LaunchSettings {
    return { launchAt: this.defaultLaunchAt, manual: null, off: [], ...this.setting<Partial<LaunchSettings>>(LAUNCH_KEY) };
  }

  saveLaunch(s: LaunchSettings): void {
    this.saveSetting(LAUNCH_KEY, s);
  }

  createCapture(c: Omit<Capture, "id" | "status" | "endReason" | "endedAt" | "firstClipAt">): Capture {
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO live_captures (creator_id, source_id, vod_id, platform, handle, url, title, game, rank, stream_offset_sec,
           status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recording', ?)`,
      )
      .run(c.creatorId, c.sourceId, c.vodId, c.platform, c.handle, c.url, c.title, c.game, c.rank, c.streamOffsetSec, c.startedAt);
    return this.capture(Number(lastInsertRowid));
  }

  findCapture(id: number): Capture | null {
    const row = this.db.prepare("SELECT * FROM live_captures WHERE id = ?").get(id) as CaptureRow | undefined;
    return row ? toCapture(row) : null;
  }

  capture(id: number): Capture {
    const capture = this.findCapture(id);
    if (!capture) throw new NotFoundError("That live recording was not found.");
    return capture;
  }

  captureByVod(vodId: number): Capture | null {
    const row = this.db.prepare("SELECT * FROM live_captures WHERE vod_id = ?").get(vodId) as CaptureRow | undefined;
    return row ? toCapture(row) : null;
  }

  activeCaptures(): Capture[] {
    return (this.db.prepare("SELECT * FROM live_captures WHERE status = 'recording' ORDER BY rank, id").all() as CaptureRow[]).map(toCapture);
  }

  /** The creator's newest recording, running or not. */
  lastCapture(creatorId: number): Capture | null {
    const row = this.db.prepare("SELECT * FROM live_captures WHERE creator_id = ? ORDER BY id DESC LIMIT 1").get(creatorId) as CaptureRow | undefined;
    return row ? toCapture(row) : null;
  }

  endCapture(id: number, reason: string, at: Date): void {
    this.db
      .prepare("UPDATE live_captures SET status = 'ended', end_reason = ?, ended_at = ? WHERE id = ? AND status = 'recording'")
      .run(reason, at.toISOString(), id);
  }

  /** Forgets a recording that never got a segment, with its empty stream row. */
  removeCapture(id: number): void {
    const { vodId } = this.capture(id);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM live_captures WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM vods WHERE id = ?").run(vodId);
    })();
  }

  /** Marks the stream's first LIVE clip; false when it already had one. */
  markFirstClip(id: number, at: Date): boolean {
    return this.db.prepare("UPDATE live_captures SET first_clip_at = ? WHERE id = ? AND first_clip_at IS NULL").run(at.toISOString(), id).changes === 1;
  }

  addSegment(captureId: number, startSec: number, at: Date): Segment {
    const { next } = this.db.prepare("SELECT COALESCE(MAX(idx), -1) + 1 AS next FROM live_segments WHERE capture_id = ?").get(captureId) as { next: number };
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO live_segments (capture_id, idx, start_sec, status, started_at) VALUES (?, ?, ?, 'recording', ?)")
      .run(captureId, next, startSec, at.toISOString());
    return this.segment(Number(lastInsertRowid));
  }

  segment(id: number): Segment {
    const row = this.db.prepare("SELECT * FROM live_segments WHERE id = ?").get(id) as SegmentRow | undefined;
    if (!row) throw new NotFoundError("That live segment was not found.");
    return toSegment(row);
  }

  segments(captureId: number): Segment[] {
    return (this.db.prepare("SELECT * FROM live_segments WHERE capture_id = ? ORDER BY idx").all(captureId) as SegmentRow[]).map(toSegment);
  }

  segmentRecorded(id: number, filePath: string, durationSec: number): void {
    this.db.prepare("UPDATE live_segments SET file_path = ?, duration_sec = ?, status = 'queued' WHERE id = ?").run(filePath, durationSec, id);
  }

  setSegmentJob(id: number, jobId: number): void {
    this.db.prepare("UPDATE live_segments SET job_id = ? WHERE id = ?").run(jobId, id);
  }

  setSegmentStatus(id: number, status: SegmentStatus, note: string | null = null): void {
    this.db.prepare("UPDATE live_segments SET status = ?, note = ? WHERE id = ?").run(status, note, id);
  }

  segmentByJob(jobId: number): Segment | null {
    const row = this.db.prepare("SELECT * FROM live_segments WHERE job_id = ?").get(jobId) as SegmentRow | undefined;
    return row ? toSegment(row) : null;
  }

  /** Segments left "recording" by a crash or restart. */
  interruptedSegments(): Segment[] {
    return (this.db.prepare("SELECT * FROM live_segments WHERE status = 'recording'").all() as SegmentRow[]).map(toSegment);
  }

  /** Segments whose video is still on disk and no longer being recorded or waiting, with the clips still to be cut from each. */
  storedSegments(): (Segment & { filePath: string; pendingPicks: number })[] {
    const rows = this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM picks p WHERE p.vod_id = c.vod_id AND p.status IN ('picked', 'rendering')
             AND p.start_sec < s.start_sec + s.duration_sec AND p.end_sec > s.start_sec) AS pending
           FROM live_segments s JOIN live_captures c ON c.id = s.capture_id
          WHERE s.file_path IS NOT NULL AND s.deleted_at IS NULL AND s.status IN ('done', 'skipped', 'failed')`,
      )
      .all() as (SegmentRow & { pending: number })[];
    return rows.map((r) => ({ ...toSegment(r), filePath: r.file_path!, pendingPicks: r.pending }));
  }

  segmentDeleted(id: number, at: Date): void {
    this.db.prepare("UPDATE live_segments SET deleted_at = ? WHERE id = ?").run(at.toISOString(), id);
  }

  /** Recorded, skipped and LIVE clip counts of one recording, for the Launch day card. */
  counts(capture: Capture): { segments: number; skipped: number; clips: number } {
    const seg = this.db
      .prepare(
        `SELECT COALESCE(SUM(duration_sec IS NOT NULL), 0) AS segments, COALESCE(SUM(status = 'skipped'), 0) AS skipped
           FROM live_segments WHERE capture_id = ?`,
      )
      .get(capture.id) as { segments: number; skipped: number };
    const { clips } = this.db.prepare("SELECT COUNT(*) AS clips FROM clips WHERE vod_id = ?").get(capture.vodId) as { clips: number };
    return { ...seg, clips };
  }

  pushSubscriptions(): PushSubscriptionRecord[] {
    return (this.db.prepare("SELECT endpoint, keys FROM push_subscriptions ORDER BY created_at").all() as { endpoint: string; keys: string }[]).map(
      (r) => ({ endpoint: r.endpoint, keys: JSON.parse(r.keys) as PushSubscriptionRecord["keys"] }),
    );
  }

  addPushSubscription(sub: PushSubscriptionRecord, at: Date): void {
    this.db
      .prepare("INSERT INTO push_subscriptions (endpoint, keys, created_at) VALUES (?, ?, ?) ON CONFLICT (endpoint) DO UPDATE SET keys = excluded.keys")
      .run(sub.endpoint, JSON.stringify(sub.keys), at.toISOString());
  }

  removePushSubscription(endpoint: string): void {
    this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  }

  /** The server's own push key pair, made on first use. The private half never leaves the server. */
  vapidKeys(make: () => { publicKey: string; privateKey: string }): { publicKey: string; privateKey: string } {
    const saved = this.setting<{ publicKey: string; privateKey: string }>(VAPID_KEY);
    if (saved) return saved;
    const keys = make();
    this.saveSetting(VAPID_KEY, keys);
    return keys;
  }
}
