// Which posting accounts take which clips: each account lists the permission kinds it takes, and a
// Whop campaign can be pinned to an account. Pure, so the server (the rule) and the gallery (the
// words on a clip) read it the same way.
import type { ChannelAccount, Permission } from "./types.js";
import { PERMISSION_KIND_LABELS } from "./types.js";

export type RoutingBlock = "brief" | "kind" | "pinned";

/** Why this account does not take clips posted under this permission, or null when it does. */
export function routingBlock(permission: Permission, account: ChannelAccount, accounts: ChannelAccount[]): RoutingBlock | null {
  if (!permission.allowedPlatforms.includes(account.platform)) return "brief";
  if (!account.takes.includes(permission.kind)) return "kind";
  // A pin holds per platform, and even while the pinned account is off: the campaign waits for it.
  const pinnedElsewhere =
    !account.pinnedCampaignIds.includes(permission.id) &&
    accounts.some((a) => a.platform === account.platform && a.pinnedCampaignIds.includes(permission.id));
  return pinnedElsewhere ? "pinned" : null;
}

/** The block in plain words, to follow the account's name ("gtavi.daily does not take …"). */
export function routingBlockText(block: RoutingBlock, permission: Permission): string {
  if (block === "brief") return "is not in the brief";
  if (block === "kind") return `does not take “${PERMISSION_KIND_LABELS[permission.kind]}” clips`;
  return "is not the account this campaign is pinned to";
}

/** The accounts a permission may post to: switched on, connected, and routed to by kind and pin. */
export function accountsAllowedFor(permission: Permission, accounts: ChannelAccount[]): ChannelAccount[] {
  return accounts.filter((a) => a.enabled && !a.disabled && routingBlock(permission, a, accounts) === null);
}

function isActive(p: Permission, now: Date): boolean {
  return p.reviewReason === null && (p.expiresAt === null || new Date(p.expiresAt).getTime() > now.getTime());
}

/**
 * "No account takes “Whop campaign” clips yet": said when accounts are connected but none that is
 * switched on takes the kind of any permission in force. Null when the clip has somewhere to go, or
 * when something else is missing (no accounts at all, no active permission).
 */
export function noAccountReason(permissions: Permission[], accounts: ChannelAccount[], now: Date): string | null {
  const active = permissions.filter((p) => isActive(p, now));
  const open = accounts.filter((a) => a.enabled && !a.disabled);
  if (active.length === 0 || accounts.length === 0) return null;
  if (active.some((p) => open.some((a) => a.takes.includes(p.kind)))) return null;
  const kinds = [...new Set(active.map((p) => `“${PERMISSION_KIND_LABELS[p.kind]}”`))];
  return `No account takes ${kinds.join(" or ")} clips yet. Tick it for an account in Dashboard, Posting accounts.`;
}
