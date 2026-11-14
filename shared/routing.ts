// Which posting accounts take which clips: each account lists the permission kinds it takes, and a
// Whop campaign can be pinned to an account. Pure, so the server (the rule) and the gallery (the
// words on a clip) read it the same way.
import type { ChannelAccount, Permission } from "./types.js";
import { PERMISSION_KIND_LABELS } from "./types.js";

export type RoutingBlock = "workspace" | "brief" | "burner" | "kind" | "pinned";

/** Why this account does not take clips posted under this permission, or null when it does. */
export function routingBlock(permission: Permission, account: ChannelAccount, accounts: ChannelAccount[]): RoutingBlock | null {
  // A workspace's clips go only to that workspace's accounts: a client's clip never lands on our channel.
  if ((permission.workspaceId ?? 1) !== (account.workspaceId ?? 1)) return "workspace";
  if (!permission.allowedPlatforms.includes(account.platform)) return "brief";
  // An experiment record is held to burner accounts, whatever kinds a main account is set to take.
  if (permission.kind === "experiment" && account.role !== "burner") return "burner";
  if (!account.takes.includes(permission.kind)) return "kind";
  // A pin holds per platform, and even while the pinned account is off: the campaign waits for it.
  const pinnedElsewhere =
    !account.pinnedCampaignIds.includes(permission.id) &&
    accounts.some((a) => a.platform === account.platform && a.pinnedCampaignIds.includes(permission.id));
  return pinnedElsewhere ? "pinned" : null;
}

/** The block in plain words, to follow the account's name ("gtavi.daily does not take …"). */
export function routingBlockText(block: RoutingBlock, permission: Permission): string {
  if (block === "workspace") return "belongs to another workspace";
  if (block === "brief") return "is not in the brief";
  if (block === "burner") return "is a main account, and experiment clips go to burner accounts only";
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
  // Only the accounts of the clip's workspace count.
  const ws = active[0]?.workspaceId ?? 1;
  accounts = accounts.filter((a) => (a.workspaceId ?? 1) === ws);
  const open = accounts.filter((a) => a.enabled && !a.disabled);
  if (active.length === 0 || accounts.length === 0) return null;
  if (active.every((p) => p.kind === "experiment") && !open.some((a) => a.role === "burner")) {
    return "Experiment clips post only to burner accounts, and none is switched on. Mark an account as Burner in Dashboard, Posting accounts.";
  }
  if (active.some((p) => open.some((a) => a.takes.includes(p.kind) && (p.kind !== "experiment" || a.role === "burner")))) return null;
  const kinds = [...new Set(active.map((p) => `“${PERMISSION_KIND_LABELS[p.kind]}”`))];
  return `No account takes ${kinds.join(" or ")} clips yet. Tick it for an account in Dashboard, Posting accounts.`;
}
