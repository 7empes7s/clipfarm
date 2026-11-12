import type { AccountRole, Permission, PermissionState, Platform } from "../../shared/types.js";
import { PLATFORM_LABELS } from "../../shared/types.js";
import { HttpError } from "../errors.js";

/** Thrown when an action needs a permission record the source does not have. */
export class PermissionError extends HttpError {
  constructor(message: string) {
    super(403, message);
  }
}

export function isActive(p: Permission, now: Date): boolean {
  return p.expiresAt === null || new Date(p.expiresAt).getTime() > now.getTime();
}

export function permissionState(perms: Permission[], now: Date): PermissionState {
  if (perms.length === 0) return "none";
  return perms.some((p) => isActive(p, now)) ? "active" : "expired";
}

/** True when the only records in force are experiments: the creator's clips go to burner accounts only. */
export function isExperimentOnly(perms: Permission[], now: Date): boolean {
  const active = perms.filter((p) => isActive(p, now));
  return active.length > 0 && active.every((p) => p.kind === "experiment");
}

/**
 * The gate for ingesting (and, later, publishing) anything from a source.
 * Returns the active permission that covers the action, or throws a PermissionError
 * with a plain-language reason. Ingest and render (no platform) take any kind. Posting names the
 * platform and the account's role: an experiment record covers burner accounts only, so a main
 * account, an export or anything else that leaves the role out needs a real permission.
 */
export function requireActivePermission(
  creatorName: string,
  perms: Permission[],
  now: Date,
  platform?: Platform,
  role: AccountRole = "main",
): Permission {
  if (perms.length === 0) {
    throw new PermissionError(
      `${creatorName} has no permission record. Add their campaign or written permission first.`,
    );
  }
  const active = perms.filter((p) => isActive(p, now));
  if (active.length === 0) {
    const latest = perms
      .map((p) => p.expiresAt!)
      .sort()
      .at(-1)!;
    throw new PermissionError(
      `The permission for ${creatorName} expired on ${latest.slice(0, 10)}. Add a current campaign first.`,
    );
  }
  if (platform) {
    const onPlatform = active.filter((p) => p.allowedPlatforms.includes(platform));
    if (onPlatform.length === 0) {
      throw new PermissionError(
        `The permission for ${creatorName} does not allow posting to ${PLATFORM_LABELS[platform]}.`,
      );
    }
    const covering = onPlatform.find((p) => p.kind !== "experiment") ?? (role === "burner" ? onPlatform[0] : undefined);
    if (!covering) {
      throw new PermissionError(
        `${creatorName} is an experiment: its clips go only to burner accounts, through Post. Nothing is exported or sent to a main account.`,
      );
    }
    return covering;
  }
  return active[0]!;
}
