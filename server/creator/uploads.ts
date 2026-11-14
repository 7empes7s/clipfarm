import { appendFile, mkdir, stat, truncate } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Db } from "../db/index.js";
import type { Upload } from "../../shared/creator.js";
import { UPLOAD_CHUNK_BYTES, UPLOAD_MAX_BYTES } from "../../shared/creator.js";
import { HttpError, NotFoundError, ValidationError } from "../errors.js";

interface Row {
  id: number;
  workspace_id: number;
  file_name: string;
  size_bytes: number;
  received_bytes: number;
  path: string;
  status: Upload["status"];
  vod_id: number | null;
}

const MEDIA_EXT = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".mp3", ".m4a", ".aac", ".wav", ".ogg", ".opus", ".flac"]);

/** The pretend link an uploaded file's video is stored under ("clipfarm-upload:12"). */
export const UPLOAD_SCHEME = "clipfarm-upload:";

export function uploadUrl(id: number): string {
  return `${UPLOAD_SCHEME}${id}`;
}

export function uploadIdOf(url: string): number | null {
  if (!url.startsWith(UPLOAD_SCHEME)) return null;
  const id = Number(url.slice(UPLOAD_SCHEME.length));
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Checks a new upload's name and size. */
export function parseNewUpload(body: unknown): { fileName: string; sizeBytes: number } {
  const b = (body ?? {}) as Record<string, unknown>;
  const fileName = typeof b.fileName === "string" ? b.fileName.trim().slice(0, 200) : "";
  if (!fileName) throw new ValidationError("Pick a video or audio file.");
  if (!MEDIA_EXT.has(extname(fileName).toLowerCase())) throw new ValidationError("That is not a video or audio file (MP4, MOV, MKV, WEBM, MP3, M4A, WAV…).");
  const sizeBytes = Number(b.sizeBytes);
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) throw new ValidationError("The file is empty.");
  if (sizeBytes > UPLOAD_MAX_BYTES) throw new ValidationError("The file is over 20 GB. Trim it or send a link instead.");
  return { fileName, sizeBytes };
}

function toUpload(r: Row): Upload {
  return { id: r.id, fileName: r.file_name, sizeBytes: r.size_bytes, receivedBytes: r.received_bytes, status: r.status, vodId: r.vod_id };
}

/**
 * Resumable uploads: the file comes in pieces of at most 8 MB, each saying where it starts. A piece
 * that does not start where the last one ended is refused with where to carry on, so a phone that
 * lost its connection asks and resumes instead of starting over.
 */
export class UploadsRepo {
  constructor(
    private db: Db,
    private dir: string,
    private now: () => Date = () => new Date(),
  ) {}

  async create(workspaceId: number, input: { fileName: string; sizeBytes: number }): Promise<Upload> {
    await mkdir(this.dir, { recursive: true });
    const id = this.db.transaction(() => {
      const { lastInsertRowid } = this.db
        .prepare("INSERT INTO uploads (workspace_id, file_name, size_bytes, path, created_at) VALUES (?, ?, ?, '', ?)")
        .run(workspaceId, input.fileName, input.sizeBytes, this.now().toISOString());
      const id = Number(lastInsertRowid);
      this.db.prepare("UPDATE uploads SET path = ? WHERE id = ?").run(join(this.dir, `upload-${id}${extname(input.fileName).toLowerCase()}`), id);
      return id;
    })();
    return this.get(id);
  }

  private row(id: number): Row {
    const row = this.db.prepare("SELECT * FROM uploads WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new NotFoundError("That upload was not found. Start it again.");
    return row;
  }

  get(id: number): Upload {
    return toUpload(this.row(id));
  }

  /** The file of a finished upload, its name and workspace (server-side only). */
  file(id: number): { path: string; fileName: string; workspaceId: number } {
    const r = this.row(id);
    if (r.status !== "done") throw new ValidationError(`${r.file_name} has not finished uploading.`);
    return { path: r.path, fileName: r.file_name, workspaceId: r.workspace_id };
  }

  /** Adds a piece that starts at `offset`. Returns the upload with what has arrived so far. */
  async append(id: number, offset: number, chunk: Buffer): Promise<Upload> {
    const r = this.row(id);
    if (r.status === "done") return toUpload(r);
    if (!Number.isInteger(offset) || offset !== r.received_bytes) {
      throw new UploadOffsetError(r.received_bytes);
    }
    if (chunk.length === 0) throw new ValidationError("That piece of the file was empty.");
    if (chunk.length > UPLOAD_CHUNK_BYTES) throw new ValidationError("That piece is too big: send at most 8 MB at a time.");
    if (offset + chunk.length > r.size_bytes) throw new ValidationError("The file is bigger than it said it would be. Start the upload again.");
    // A piece the server took but whose answer was lost is cut off and taken again.
    const onDisk = await stat(r.path).then((s) => s.size, () => 0);
    if (onDisk > offset) await truncate(r.path, offset);
    await appendFile(r.path, chunk);
    const received = offset + chunk.length;
    this.db.prepare("UPDATE uploads SET received_bytes = ?, status = ? WHERE id = ?").run(received, received === r.size_bytes ? "done" : "receiving", id);
    return this.get(id);
  }

  setVod(id: number, vodId: number): void {
    this.db.prepare("UPDATE uploads SET vod_id = ? WHERE id = ?").run(vodId, id);
  }
}

/** 409: the piece does not start where the upload stands; the answer says where to carry on. */
export class UploadOffsetError extends HttpError {
  constructor(readonly receivedBytes: number) {
    super(409, `Carry on from byte ${receivedBytes}.`);
  }
}
