import { rmSync } from "node:fs";
import type { Db } from "../db/index.js";
import type { FaceCam, NewPermissionInput, NewSourceInput, Permission, PermissionKind, Platform, Source } from "../../shared/types.js";
import { ALLOWANCE_VALID_DAYS, EXPERIMENT_DAYS, PERMISSION_KINDS, PLATFORMS } from "../../shared/types.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { permissionState, requireActivePermission } from "./permission.js";

interface PermissionRow {
  id: number;
  source_id: number;
  kind: PermissionKind;
  campaign_url: string | null;
  brief_rules: string;
  note: string;
  cpm_rate_usd: number | null;
  min_views: number | null;
  allowed_platforms: string;
  expires_at: string | null;
  proof_url: string | null;
  proof_quote: string | null;
  proof_checked_at: string | null;
  review_reason: string | null;
  created_at: string;
}

interface SourceRow {
  id: number;
  creator_name: string;
  channel_urls: string;
  banned_content: string;
  face_cam: string | null;
  created_at: string;
}

function toPermission(r: PermissionRow): Permission {
  return {
    id: r.id,
    sourceId: r.source_id,
    kind: r.kind,
    campaignUrl: r.campaign_url,
    briefRules: r.brief_rules,
    note: r.note,
    cpmRateUsd: r.cpm_rate_usd,
    minViews: r.min_views,
    allowedPlatforms: JSON.parse(r.allowed_platforms) as Platform[],
    expiresAt: r.expires_at,
    proofUrl: r.proof_url,
    proofQuote: r.proof_quote,
    proofCheckedAt: r.proof_checked_at,
    reviewReason: r.review_reason,
    createdAt: r.created_at,
  };
}

/** When a public allowance last seen on `checkedAt` runs out unless it is checked again. */
export function allowanceExpiry(checkedAt: Date): string {
  return new Date(checkedAt.getTime() + ALLOWANCE_VALID_DAYS * 86_400_000).toISOString();
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

/**
 * Checks a permission record and returns a clean one, or throws a plain ValidationError. An
 * experiment needs no proof, only a note on what is being tested, and always ends: 30 days from
 * `now` unless a date is given.
 */
export function parsePermission(body: unknown, now: Date = new Date()): NewPermissionInput {
  const p = (body ?? {}) as Record<string, unknown>;
  const kind = p.kind as PermissionKind;
  if (!PERMISSION_KINDS.includes(kind)) throw new ValidationError("Choose what kind of permission this is.");
  const experiment = kind === "experiment";

  const campaignUrl = !experiment && typeof p.campaignUrl === "string" && p.campaignUrl.trim() ? p.campaignUrl.trim() : null;
  if (kind === "whop-campaign" && !campaignUrl) throw new ValidationError("Paste the Whop campaign link.");
  if (campaignUrl && !isHttpUrl(campaignUrl)) throw new ValidationError("The campaign link is not a web link.");

  const note = experiment && typeof p.note === "string" ? p.note.trim() : "";
  if (experiment && !note) throw new ValidationError("Add a short note on what this experiment tests.");
  if (note.length > 280) throw new ValidationError("Keep the note under 280 characters.");

  const allowedPlatforms = Array.isArray(p.allowedPlatforms)
    ? PLATFORMS.filter((x) => (p.allowedPlatforms as unknown[]).includes(x))
    : [];
  if (allowedPlatforms.length === 0) throw new ValidationError("Pick at least one platform the campaign allows.");

  let expiresAt: string | null = experiment ? new Date(now.getTime() + EXPERIMENT_DAYS * 86_400_000).toISOString() : null;
  if (typeof p.expiresAt === "string" && p.expiresAt) {
    const t = new Date(p.expiresAt);
    if (Number.isNaN(t.getTime())) throw new ValidationError("The end date is not a valid date.");
    expiresAt = t.toISOString();
  }

  // A public allowance is only as good as its proof: where they say it, their words, and when we read them.
  let proof: { proofUrl: string; proofQuote: string; proofCheckedAt: string } | null = null;
  if (kind === "public-allowance") {
    const proofUrl = typeof p.proofUrl === "string" ? p.proofUrl.trim() : "";
    if (!proofUrl) throw new ValidationError("Paste the link to where the creator says clipping is allowed.");
    if (!isHttpUrl(proofUrl)) throw new ValidationError("The proof link is not a web link.");
    const proofQuote = typeof p.proofQuote === "string" ? p.proofQuote.trim().replace(/\s+/g, " ") : "";
    if (!proofQuote) throw new ValidationError("Copy the creator's words that allow clipping from that page.");
    if (proofQuote.length > 300) throw new ValidationError("Keep the quote short: 300 letters at most.");
    const checked = typeof p.proofCheckedAt === "string" && p.proofCheckedAt ? new Date(p.proofCheckedAt) : null;
    if (!checked || Number.isNaN(checked.getTime())) throw new ValidationError("Enter the date you checked the proof.");
    if (checked.getTime() > now.getTime() + 86_400_000) throw new ValidationError("The check date cannot be in the future.");
    proof = { proofUrl, proofQuote, proofCheckedAt: checked.toISOString() };
  }

  return {
    kind,
    campaignUrl,
    briefRules: typeof p.briefRules === "string" ? p.briefRules.trim() : "",
    note,
    // An experiment earns nothing: it is never part of a paid campaign.
    cpmRateUsd: experiment ? null : optionalNumber(p.cpmRateUsd, "The rate per 1,000 views"),
    minViews: experiment ? null : optionalNumber(p.minViews, "Minimum views"),
    allowedPlatforms,
    expiresAt,
    proofUrl: proof?.proofUrl ?? null,
    proofQuote: proof?.proofQuote ?? null,
    proofCheckedAt: proof?.proofCheckedAt ?? null,
  };
}

/** Checks a request body and returns a clean NewSourceInput, or throws a plain ValidationError. */
export function parseNewSource(body: unknown, now: Date = new Date()): NewSourceInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const creatorName = typeof b.creatorName === "string" ? b.creatorName.trim() : "";
  if (!creatorName) throw new ValidationError("Enter the creator's name.");

  const channelUrls = Array.isArray(b.channelUrls)
    ? b.channelUrls.filter((u): u is string => typeof u === "string").map((u) => u.trim()).filter(Boolean)
    : [];
  const badChannel = channelUrls.find((u) => !isHttpUrl(u));
  if (badChannel) throw new ValidationError(`"${badChannel}" is not a web link.`);

  return {
    creatorName,
    channelUrls,
    bannedContent: typeof b.bannedContent === "string" ? b.bannedContent.trim() : "",
    permission: parsePermission(b.permission, now),
  };
}

/** Checks a face cam rectangle (fractions of the frame) and rounds it; throws a plain ValidationError. */
export function parseFaceCam(body: unknown): FaceCam {
  const b = (body ?? {}) as Record<string, unknown>;
  const [x, y, w, h] = [b.x, b.y, b.w, b.h].map((v) => (typeof v === "number" && Number.isFinite(v) ? v : NaN)) as [
    number,
    number,
    number,
    number,
  ];
  if ([x, y, w, h].some(Number.isNaN)) throw new ValidationError("Drag a box around the face cam first.");
  const round = (v: number) => Math.round(v * 10000) / 10000;
  if (x < 0 || y < 0 || x + w > 1.0001 || y + h > 1.0001) throw new ValidationError("The face cam box must stay inside the frame.");
  if (w < 0.05 || h < 0.05) throw new ValidationError("The face cam box is too small. Drag a bigger box.");
  return { x: round(x), y: round(y), w: round(Math.min(w, 1 - x)), h: round(Math.min(h, 1 - y)) };
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

  addPermission(sourceId: number, p: NewPermissionInput, createdAt = this.now().toISOString()): void {
    const isAllowance = p.kind === "public-allowance";
    if (isAllowance && !(p.proofUrl && p.proofQuote && p.proofCheckedAt)) {
      throw new ValidationError("A public clipping allowance needs its proof: the link, their words and the date it was checked.");
    }
    const proofCheckedAt = isAllowance ? new Date(p.proofCheckedAt!).toISOString() : null;
    // Without an end date of its own, a public allowance runs out unless its proof is seen again.
    const expiresAt = p.expiresAt ?? (isAllowance ? allowanceExpiry(new Date(proofCheckedAt!)) : null);
    this.db
      .prepare(
        `INSERT INTO permissions (source_id, kind, campaign_url, brief_rules, note, cpm_rate_usd, min_views,
           allowed_platforms, expires_at, proof_url, proof_quote, proof_checked_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sourceId,
        p.kind,
        p.campaignUrl ?? null,
        p.briefRules ?? "",
        p.note ?? "",
        p.cpmRateUsd ?? null,
        p.minViews ?? null,
        JSON.stringify(p.allowedPlatforms),
        expiresAt,
        isAllowance ? p.proofUrl! : null,
        isAllowance ? p.proofQuote! : null,
        proofCheckedAt,
        createdAt,
      );
  }

  permission(id: number): Permission {
    const row = this.db.prepare("SELECT * FROM permissions WHERE id = ?").get(id) as PermissionRow | undefined;
    if (!row) throw new NotFoundError("That permission record was not found.");
    return toPermission(row);
  }

  /** Public allowances in good standing whose proof was last seen on or before `before`. */
  allowancesCheckedBefore(before: Date): Permission[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM permissions WHERE kind = 'public-allowance' AND review_reason IS NULL
             AND proof_checked_at <= ? ORDER BY proof_checked_at, id`,
        )
        .all(before.toISOString()) as PermissionRow[]
    ).map(toPermission);
  }

  /**
   * The proof was seen again: the record is in force again, and its 90 days start over.
   * An end date the manager set by hand (a campaign that closes on a day) is kept.
   */
  confirmProof(permissionId: number, at: Date): void {
    const p = this.permission(permissionId);
    const hadDefaultEnd = p.proofCheckedAt !== null && p.expiresAt === allowanceExpiry(new Date(p.proofCheckedAt));
    this.db
      .prepare("UPDATE permissions SET proof_checked_at = ?, expires_at = ?, review_reason = NULL WHERE id = ?")
      .run(at.toISOString(), hadDefaultEnd ? allowanceExpiry(at) : p.expiresAt, permissionId);
  }

  /** The proof is gone: the record is put on hold, which stops ingest and posting for its source. */
  flagForReview(permissionId: number, reason: string): void {
    this.db.prepare("UPDATE permissions SET review_reason = ? WHERE id = ?").run(reason, permissionId);
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

  setFaceCam(id: number, faceCam: FaceCam | null): Source {
    this.get(id);
    this.db.prepare("UPDATE sources SET face_cam = ? WHERE id = ?").run(faceCam ? JSON.stringify(faceCam) : null, id);
    return this.get(id);
  }

  /**
   * Removes a source with its permission records, videos, transcripts, picks, clips, reviews, finished
   * jobs and media files. Refused while a job is working on it, and for good once one of its clips
   * went out through a real posting service.
   */
  remove(id: number): { videos: number; clips: number } {
    const { creatorName } = this.get(id);
    const ofSource = "(SELECT id FROM clips WHERE source_id = @id)";
    const jobsOfSource = `(vod_id IN (SELECT id FROM vods WHERE source_id = @id) OR clip_id IN ${ofSource})`;
    const count = (sql: string) => (this.db.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get({ id }) as { n: number }).n;
    if (count(`posts WHERE service != 'fake' AND clip_id IN ${ofSource}`) > 0) {
      throw new ValidationError(`${creatorName} has clips that were posted, so it stays: the posts are the record of what went out.`);
    }
    if (count(`jobs WHERE status IN ('queued', 'running') AND ${jobsOfSource}`) > 0) {
      throw new ValidationError(`A job is still working on ${creatorName}. Cancel it in Jobs or wait for it, then try again.`);
    }
    const files = (
      this.db
        .prepare(
          `SELECT file_path AS f FROM clips WHERE source_id = @id UNION SELECT master_path FROM clips WHERE source_id = @id
           UNION SELECT file_path FROM picks WHERE source_id = @id UNION SELECT thumb_path FROM picks WHERE source_id = @id`,
        )
        .all({ id }) as { f: string | null }[]
    ).flatMap((r) => (r.f ? [r.f] : []));
    const removed = this.db.transaction(() => {
      const run = (sql: string) => this.db.prepare(sql).run({ id }).changes;
      run(`DELETE FROM posts WHERE clip_id IN ${ofSource}`);
      run(`DELETE FROM clip_reviews WHERE clip_id IN ${ofSource}`);
      run(`DELETE FROM jobs WHERE ${jobsOfSource}`);
      run("DELETE FROM picks WHERE source_id = @id");
      // The watchlist keeps what it detected, so the same video is not queued again.
      run("UPDATE detected_vods SET vod_id = NULL WHERE vod_id IN (SELECT id FROM vods WHERE source_id = @id)");
      const clips = run("DELETE FROM clips WHERE source_id = @id");
      const videos = run("DELETE FROM vods WHERE source_id = @id");
      run("DELETE FROM sources WHERE id = @id");
      return { videos, clips };
    })();
    for (const f of files) rmSync(f, { force: true });
    return removed;
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
      faceCam: r.face_cam ? (JSON.parse(r.face_cam) as FaceCam) : null,
      createdAt: r.created_at,
      permissions,
      permissionState: permissionState(permissions, this.now()),
    };
  }
}
