import { AUTO_PAUSE_BUDGET_LEFT, type AutoPlanRow } from "../../shared/scout.js";

export interface JoinedCampaign {
  permissionId: number;
  name: string;
  score: number;
  budgetLeftUsd: number | null;
  budgetTotalUsd: number | null;
  /** Why the campaign is not in force (ended, on hold), in plain words. */
  stopped: string | null;
}

/**
 * Auto mode's plan for a day: the clips the accounts can carry (`slots`) are shared out over the
 * joined campaigns in proportion to their scores (largest remainders first, the better score winning
 * a tie). A campaign that has ended, or has under 10% of its budget left, is paused and gets none.
 */
export function planAuto(campaigns: JoinedCampaign[], slots: number): AutoPlanRow[] {
  const rows = campaigns.map((c): AutoPlanRow => {
    const left = c.budgetLeftUsd !== null && c.budgetTotalUsd !== null && c.budgetTotalUsd > 0 ? c.budgetLeftUsd / c.budgetTotalUsd : null;
    return {
      permissionId: c.permissionId,
      name: c.name,
      score: c.score,
      slots: 0,
      budgetUsedPct: left === null ? null : Math.round((1 - Math.min(1, left)) * 100),
      paused:
        c.stopped ?? (left !== null && left < AUTO_PAUSE_BUDGET_LEFT ? `Under ${AUTO_PAUSE_BUDGET_LEFT * 100}% of its budget is left (${Math.round(left * 100)}%).` : null),
    };
  });
  const open = rows.filter((r) => r.paused === null).sort((a, b) => b.score - a.score || a.permissionId - b.permissionId);
  const total = open.reduce((sum, r) => sum + r.score, 0);
  // No score to go by: equal shares.
  const share = (r: AutoPlanRow) => (total > 0 ? (r.score / total) * slots : slots / open.length);
  for (const r of open) r.slots = Math.floor(share(r));
  let spare = Math.max(0, Math.floor(slots)) - open.reduce((sum, r) => sum + r.slots, 0);
  const byRemainder = [...open].sort((a, b) => share(b) - Math.floor(share(b)) - (share(a) - Math.floor(share(a))));
  for (const r of byRemainder) {
    if (spare <= 0) break;
    // A campaign with no score gets clips only when none has one.
    if (total > 0 && r.score <= 0) continue;
    r.slots += 1;
    spare -= 1;
  }
  return rows.sort((a, b) => b.slots - a.slots || b.score - a.score || a.permissionId - b.permissionId);
}
