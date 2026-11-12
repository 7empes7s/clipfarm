import type { AccountRole, ClipStatus, Permission, Platform } from "../../shared/types.js";
import { ValidationError } from "../errors.js";
import { requireActivePermission } from "../sources/permission.js";

/** Where a post would go: the platform, and whether the account is main or burner. */
export interface PostTarget {
  platform: Platform;
  role: AccountRole;
}

export interface PostGateInput {
  clipStatus: ClipStatus;
  creatorName: string;
  permissions: Permission[];
  targets: PostTarget[];
  now: Date;
}

/**
 * The gate every post passes before any posting service is called: the clip is approved and the
 * source has an active permission whose brief allows each platform, and an experiment record only
 * ever covers a burner account. Returns the covering permission per target, in order (stored on
 * each Post), or throws a plain-language error.
 */
export function assertCanPost({ clipStatus, creatorName, permissions, targets, now }: PostGateInput): Permission[] {
  if (clipStatus !== "approved") throw new ValidationError("Approve the clip before posting it.");
  // Even with no target picked yet, the source needs an active record.
  requireActivePermission(creatorName, permissions, now);
  return targets.map((t) => requireActivePermission(creatorName, permissions, now, t.platform, t.role));
}
