import type { AccountRole, ClipQuality, ClipStatus, Platform } from "../../shared/types.js";
import type { AutopilotAction, AutopilotRule } from "../../shared/publishing.js";
import { ValidationError } from "../errors.js";

/** What a rule needs to know about a clip. */
export interface RuleClip {
  id: number;
  title: string;
  sourceId: number;
  score: number | null;
  quality: ClipQuality | null;
  status: ClipStatus;
  /** Only an experiment record is in force: burner accounts only. */
  experiment: boolean;
  /** The source's permission records in force now. */
  permissionIds: number[];
}

export interface RuleAccount {
  id: string;
  name: string;
  platform: Platform;
  role: AccountRole;
  enabled: boolean;
  disabled: boolean;
}

export interface PlannedStep {
  clipId: number;
  clipTitle: string;
  accountId: string | null;
  accountName: string | null;
  action: AutopilotAction;
  reason: string;
}

export interface RulePlanInput {
  rule: AutopilotRule;
  clips: RuleClip[];
  accounts: RuleAccount[];
  /** Posts the rule made today. */
  doneToday: number;
  /** "<clipId>:<accountId>" pairs the rule already handled: never done twice. */
  handled: Set<string>;
}

/** Why a clip does not fit the rule, or null when it does. */
export function clipMatches(rule: AutopilotRule, clip: RuleClip): string | null {
  if (clip.status === "rejected") return "It was rejected.";
  if (clip.status === "rendering") return "It is still being made.";
  if (rule.sourceId !== null && clip.sourceId !== rule.sourceId) return "It is from another source.";
  if (rule.permissionId !== null && !clip.permissionIds.includes(rule.permissionId)) return "It is not under the rule's campaign.";
  if (clip.score === null) return `It has no score; the rule needs ${rule.minScore}.`;
  if (clip.score < rule.minScore) return `It scores ${Math.round(clip.score)}; the rule needs ${rule.minScore}.`;
  if (rule.needsQuality && (clip.quality === null || clip.quality.issues.length > 0)) return "It has not passed the quality check.";
  return null;
}

/**
 * What a rule does now, best-scoring clips first: post a matching clip to each of its accounts, wait
 * for the approve tap on a main account (unless the rule says auto), or skip with the reason. A clip
 * without a permission record in force never posts, an experiment clip only goes to burners, and
 * a burner rule only to accounts that are still burners. The publisher checks it all again.
 */
export function planRule({ rule, clips, accounts, doneToday, handled }: RulePlanInput): PlannedStep[] {
  const steps: PlannedStep[] = [];
  let posts = doneToday;
  const ranked = clips.filter((c) => clipMatches(rule, c) === null).sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.id - b.id);
  for (const clip of ranked) {
    const base = { clipId: clip.id, clipTitle: clip.title };
    if (clip.permissionIds.length === 0) {
      if (!handled.has(`${clip.id}:`)) steps.push({ ...base, accountId: null, accountName: null, action: "skip", reason: "It has no permission record in force, so it never posts." });
      continue;
    }
    // Posting approves a waiting clip, so it needs the manager's tap unless only burners can ever get it.
    const tapNeeded = clip.status !== "approved" && !rule.auto && !rule.burnerOnly && !clip.experiment;
    const why = `It scores ${Math.round(clip.score!)} (the rule needs ${rule.minScore})${rule.needsQuality ? " and passed the quality check" : ""}.`;
    for (const accountId of rule.accountIds) {
      if (handled.has(`${clip.id}:${accountId}`)) continue;
      const account = accounts.find((a) => a.id === accountId);
      const step = (action: AutopilotAction, reason: string) =>
        steps.push({ ...base, accountId, accountName: account?.name ?? null, action, reason });
      if (!account || account.disabled) step("skip", "The account is no longer connected.");
      else if (!account.enabled) step("skip", `${account.name} is switched off.`);
      else if (rule.burnerOnly && account.role !== "burner") step("skip", `${account.name} is no longer a burner, and this rule posts only to burners.`);
      else if (clip.experiment && account.role !== "burner") step("skip", "It is an experiment, which posts only to burner accounts.");
      else if (tapNeeded) {
        step(
          "wait-approval",
          account.role === "main" ? `Waits for your approve tap in the Inbox: ${account.name} is a main account.` : "Waits for your approve tap in the Inbox: this rule also posts to main accounts.",
        );
      } else if (posts >= rule.dailyCap) step("skip", `The rule's daily cap of ${rule.dailyCap} posts is reached.`);
      else {
        posts++;
        step("post", why);
      }
    }
  }
  return steps;
}

/** A rule as the form sends it, checked; a new rule starts switched off and in dry run. */
export function parseRule(body: unknown, accounts: RuleAccount[]): Omit<AutopilotRule, "id"> {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name) throw new ValidationError("Give the rule a name.");
  const minScore = Number(b.minScore);
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 100) throw new ValidationError("The score must be a number from 0 to 100.");
  const dailyCap = Number(b.dailyCap);
  if (!Number.isInteger(dailyCap) || dailyCap < 1 || dailyCap > 50) throw new ValidationError("The daily cap must be a whole number from 1 to 50.");
  const ids = Array.isArray(b.accountIds) ? [...new Set(b.accountIds.map(String))] : [];
  if (ids.length === 0) throw new ValidationError("Pick at least one account.");
  const picked = ids.map((id) => {
    const account = accounts.find((a) => a.id === id);
    if (!account) throw new ValidationError("One of the accounts is no longer connected. Reload and pick again.");
    return account;
  });
  const burnerOnly = b.burnerOnly === true;
  const main = picked.find((a) => a.role !== "burner");
  if (burnerOnly && main) throw new ValidationError(`A burner rule posts only to burner accounts: ${main.name} is a main account.`);
  const optionalId = (v: unknown, what: string): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new ValidationError(`Pick a ${what} from the list.`);
    return n;
  };
  return {
    name: name.slice(0, 80),
    enabled: b.enabled === true,
    sourceId: optionalId(b.sourceId, "source"),
    permissionId: optionalId(b.permissionId, "campaign"),
    minScore,
    needsQuality: b.needsQuality !== false,
    accountIds: ids,
    auto: b.auto === true,
    burnerOnly,
    dailyCap,
    dryRun: b.dryRun !== false,
  };
}
