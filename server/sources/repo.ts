import type { Db } from "../db/index.js";
import type { CropRect, NewSourceInput, Permission, PermissionKind, Platform, Source } from "../../shared/types.js";
import { PERMISSION_KINDS, PLATFORMS } from "../../shared/types.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { permissionState, requireActivePermission } from "./permission.js";

interface PermissionRow {
  id: number;
  source_id: number;
  kind: PermissionKind;
  campaign_url: string | null;
  brief_rules: string;
  cpm_rate_usd: number | null;
  min_views: number | null;
  allowed_platforms: string;
  expires_at: string | null;
  created_at: string;
}

interface SourceRow {
  id: number;
  creator_name: string;
  channel_urls: string;
  banned_content: string;
  face_cam: string | null;
  frame_path: string | null;
  created_at: string;
}

function toPermission(r: PermissionRow): Permission {
  return {
    id: r.id,
    sourceId: r.source_id,
    kind: r.kind,
    campaignUrl: r.campaign_url,
    briefRules: r.brief_rules,
    cpmRateUsd: r.cpm_rate_usd,
    minViews: r.min_views,
    allowedPlatforms: JSON.parse(r.allowed_platforms) as Platform[],
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  };
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function optionalNumber(v: unknown, label: string): number | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new ValidationError(`${label} must be a number of zero or more.`);
  }
  return v;
}

/** Checks a face cam rectangle from a request: fractions of the frame, inside it, not tiny. Null clears it. */
export function parseCropRect(body: unknown): CropRect | null {
  if (body === null) return null;
  const b = (body ?? {}) as Record<string, unknown>;
  const [x, y, w, h] = [b.x, b.y, b.w, b.h];
  const nums = [x, y, w, h].every((v) => typeof v === "number" && Number.isFinite(v));
  if (!nums) throw new ValidationError("Draw the face cam box on the frame first.");
  const r = { x: x as number, y: y as number, w: w as number, h: h as number };
  if (r.x < 0 || r.y < 0 || r.w < 0.05 || r.h < 0.05 || r.x + r.w > 1.0001 || r.y + r.h > 1.0001) {
    throw new ValidationError("The face cam box must sit inside the frame and be at least a little bigger.");
  }
  return r;
}

/** Checks a request body and returns a clean NewSourceInput, or throws a plain ValidationError. */
export function parseNewSource(body: unknown): NewSourceInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const creatorName = typeof b.creatorName === "string" ? b.creatorName.trim() : "";
  if (!creatorName) throw new ValidationError("Enter the creator's name.");

  const channelUrls = Array.isArray(b.channelUrls)
    ? b.channelUrls.filter((u): u is string => typeof u === "string").map((u) => u.trim()).filter(Boolean)
    : [];
  const badChannel = channelUrls.find((u) => !isHttpUrl(u));
  if (badChannel) throw new ValidationError(`"${badChannel}" is not a web link.`);

  const p = (b.permission ?? {}) as Record<string, unknown>;
  const kind = p.kind as PermissionKind;
  if (!PERMISSION_KINDS.includes(kind)) throw new ValidationError("Choose what kind of permission this is.");

  const campaignUrl = typeof p.campaignUrl === "string" && p.campaignUrl.trim() ? p.campaignUrl.trim() : null;
  if (kind === "whop-campaign" && !campaignUrl) throw new ValidationError("Paste the Whop campaign link.");
  if (campaignUrl && !isHttpUrl(campaignUrl)) throw new ValidationError("The campaign link is not a web link.");

  const allowedPlatforms = Array.isArray(p.allowedPlatforms)
    ? PLATFORMS.filter((x) => (p.allowedPlatforms as unknown[]).includes(x))
    : [];
  if (allowedPlatforms.length === 0) throw new ValidationError("Pick at least one platform the campaign allows.");

  let expiresAt: string | null = null;
  if (typeof p.expiresAt === "string" && p.expiresAt) {
    const t = new Date(p.expiresAt);
    if (Number.isNaN(t.getTime())) throw new ValidationError("The end date is not a valid date.");
    expiresAt = t.toISOString();
  }

  return {
    creatorName,
    channelUrls,
    bannedContent: typeof b.bannedContent === "string" ? b.bannedContent.trim() : "",
    permission: {
      kind,
      campaignUrl,
      briefRules: typeof p.briefRules === "string" ? p.briefRules.trim() : "",
      cpmRateUsd: optionalNumber(p.cpmRateUsd, "The rate per 1,000 views"),
      minViews: optionalNumber(p.minViews, "Minimum views"),
      allowedPlatforms,
      expiresAt,
    },
  };
}

export class SourcesRepo {
  constructor(
    private db: Db,
    private now: () => Date = () => new Date(),
  ) {}

  create(input: NewSourceInput): Source {
    const createdAt = this.now().toISOString();
    const id = this.db.transaction(() => {
      const { lastInsertRowid } = this.db
        .prepare(
          "INSERT INTO sources (creator_name, channel_urls, banned_content, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(input.creatorName, JSON.stringify(input.channelUrls), input.bannedContent ?? "", createdAt);
      this.addPermission(Number(lastInsertRowid), input.permission, createdAt);
      return Number(lastInsertRowid);
    })();
    return this.get(id);
  }

  addPermission(sourceId: number, p: NewSourceInput["permission"], createdAt = this.now().toISOString()): void {
    this.db
      .prepare(
        `INSERT INTO permissions (source_id, kind, campaign_url, brief_rules, cpm_rate_usd, min_views,
           allowed_platforms, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sourceId,
        p.kind,
        p.campaignUrl ?? null,
        p.briefRules ?? "",
        p.cpmRateUsd ?? null,
        p.minViews ?? null,
        JSON.stringify(p.allowedPlatforms),
        p.expiresAt ?? null,
        createdAt,
      );
  }

  list(): Source[] {
    const rows = this.db.prepare("SELECT * FROM sources ORDER BY id DESC").all() as SourceRow[];
    return rows.map((r) => this.hydrate(r));
  }

  get(id: number): Source {
    const row = this.db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as SourceRow | undefined;
    if (!row) throw new NotFoundError("That creator was not found.");
    return this.hydrate(row);
  }

  /** Saves (or clears, with null) where the face cam sits in this creator's stream. */
  setFaceCam(id: number, rect: CropRect | null): Source {
    this.get(id);
    this.db.prepare("UPDATE sources SET face_cam = ? WHERE id = ?").run(rect ? JSON.stringify(rect) : null, id);
    return this.get(id);
  }

  /** Remembers a frame of the creator's stream, shown in the gallery to draw the face cam on. */
  setFramePath(id: number, path: string): void {
    this.db.prepare("UPDATE sources SET frame_path = ? WHERE id = ?").run(path, id);
  }

  framePath(id: number): string | null {
    return (this.db.prepare("SELECT frame_path FROM sources WHERE id = ?").get(id) as { frame_path: string | null } | undefined)
      ?.frame_path ?? null;
  }

  /** Throws a PermissionError unless the source may be used right now (optionally on one platform). */
  assertCanUse(sourceId: number, platform?: Platform): Permission {
    const source = this.get(sourceId);
    return requireActivePermission(source.creatorName, source.permissions, this.now(), platform);
  }

  private hydrate(r: SourceRow): Source {
    const permissions = (
      this.db.prepare("SELECT * FROM permissions WHERE source_id = ? ORDER BY id").all(r.id) as PermissionRow[]
    ).map(toPermission);
    return {
      id: r.id,
      creatorName: r.creator_name,
      channelUrls: JSON.parse(r.channel_urls) as string[],
      bannedContent: r.banned_content,
      faceCam: r.face_cam ? (JSON.parse(r.face_cam) as CropRect) : null,
      hasFrame: r.frame_path !== null,
      createdAt: r.created_at,
      permissions,
      permissionState: permissionState(permissions, this.now()),
    };
  }
}
