import type { Permission, PermissionState, Platform } from "../../shared/types.js";
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

/**
 * The gate for ingesting (and, later, publishing) anything from a source.
 * Returns the active permission that covers the action, or throws a PermissionError
 * with a plain-language reason.
 */
export function requireActivePermission(
  creatorName: string,
  perms: Permission[],
  now: Date,
  platform?: Platform,
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
    const covering = active.find((p) => p.allowedPlatforms.includes(platform));
    if (!covering) {
      throw new PermissionError(
        `The permission for ${creatorName} does not allow posting to ${PLATFORM_LABELS[platform]}.`,
      );
    }
    return covering;
  }
  return active[0]!;
}
