import type { ClipStatus, Permission, Platform } from "../../shared/types.js";
import { ValidationError } from "../errors.js";
import { requireActivePermission } from "../sources/permission.js";

export interface PostGateInput {
  clipStatus: ClipStatus;
  creatorName: string;
  permissions: Permission[];
  platforms: Platform[];
  now: Date;
}

/**
 * The gate every post passes before any posting service is called: the clip is approved and the
 * source has an active permission whose brief allows each platform. Returns the covering
 * permission per platform (stored on each Post), or throws a plain-language error.
 */
export function assertCanPost({ clipStatus, creatorName, permissions, platforms, now }: PostGateInput): Partial<Record<Platform, Permission>> {
  if (clipStatus !== "approved") throw new ValidationError("Approve the clip before posting it.");
  // Even with no platform picked yet, the source needs an active record.
  requireActivePermission(creatorName, permissions, now);
  const covering: Partial<Record<Platform, Permission>> = {};
  for (const platform of platforms) {
    covering[platform] = requireActivePermission(creatorName, permissions, now, platform);
  }
  return covering;
}
