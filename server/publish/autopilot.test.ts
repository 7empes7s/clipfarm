import { describe, expect, it } from "vitest";
import type { AutopilotRule } from "../../shared/publishing.js";
import { clipMatches, parseRule, planRule, type RuleAccount, type RuleClip } from "./autopilot.js";

const ACCOUNTS: RuleAccount[] = [
  { id: "yt-main", name: "GTA VI Moments", platform: "youtube", role: "main", enabled: true, disabled: false },
  { id: "tt-main", name: "gtavimoments", platform: "tiktok", role: "main", enabled: true, disabled: false },
  { id: "tt-burner", name: "burner.one", platform: "tiktok", role: "burner", enabled: true, disabled: false },
  { id: "yt-burner", name: "burner.two", platform: "youtube", role: "burner", enabled: true, disabled: false },
];

const rule = (over: Partial<AutopilotRule> = {}): AutopilotRule => ({
  id: 1,
  name: "TJR big moments",
  enabled: true,
  sourceId: 7,
  permissionId: 70,
  minScore: 80,
  needsQuality: true,
  accountIds: ["yt-main", "tt-main"],
  auto: false,
  burnerOnly: false,
  dailyCap: 3,
  dryRun: false,
  ...over,
});

const clip = (over: Partial<RuleClip> = {}): RuleClip => ({
  id: 1,
  title: "He called the top",
  sourceId: 7,
  score: 88,
  quality: { issues: [], fix: null },
  status: "approved",
  experiment: false,
  permissionIds: [70],
  ...over,
});

describe("autopilot rule matching", () => {
  it("matches a clip from the source and campaign that scores high enough and passed the quality check", () => {
    expect(clipMatches(rule(), clip())).toBeNull();
  });

  it("says why a clip does not match", () => {
    expect(clipMatches(rule(), clip({ sourceId: 8 }))).toBe("It is from another source.");
    expect(clipMatches(rule(), clip({ permissionIds: [71] }))).toBe("It is not under the rule's campaign.");
    expect(clipMatches(rule(), clip({ score: 79 }))).toBe("It scores 79; the rule needs 80.");
    expect(clipMatches(rule(), clip({ score: null }))).toBe("It has no score; the rule needs 80.");
    expect(clipMatches(rule(), clip({ quality: null }))).toBe("It has not passed the quality check.");
    expect(clipMatches(rule(), clip({ quality: { issues: [{ code: "black", reason: "Black frames" }], fix: null } }))).toBe("It has not passed the quality check.");
    expect(clipMatches(rule({ needsQuality: false }), clip({ quality: null }))).toBeNull();
    expect(clipMatches(rule(), clip({ status: "rejected" }))).toBe("It was rejected.");
    expect(clipMatches(rule({ sourceId: null, permissionId: null }), clip({ sourceId: 99, permissionIds: [5] }))).toBeNull();
  });
});

describe("planRule (what a run or a dry run does)", () => {
  it("posts an approved matching clip to each of the rule's accounts", () => {
    const steps = planRule({ rule: rule(), clips: [clip()], accounts: ACCOUNTS, doneToday: 0, handled: new Set() });
    expect(steps.map((s) => [s.accountId, s.action])).toEqual([
      ["yt-main", "post"],
      ["tt-main", "post"],
    ]);
    expect(steps[0]!.reason).toBe("It scores 88 (the rule needs 80) and passed the quality check.");
  });

  it("main accounts wait for the approve tap unless the rule says auto", () => {
    const pending = clip({ status: "pending" });
    const waits = planRule({ rule: rule(), clips: [pending], accounts: ACCOUNTS, doneToday: 0, handled: new Set() });
    expect(waits.every((s) => s.action === "wait-approval")).toBe(true);
    expect(waits[0]!.reason).toBe("Waits for your approve tap in the Inbox: GTA VI Moments is a main account.");
    const auto = planRule({ rule: rule({ auto: true }), clips: [pending], accounts: ACCOUNTS, doneToday: 0, handled: new Set() });
    expect(auto.every((s) => s.action === "post")).toBe(true);
  });

  it("burners never wait for a tap", () => {
    const steps = planRule({ rule: rule({ accountIds: ["tt-burner"], burnerOnly: true }), clips: [clip({ status: "pending" })], accounts: ACCOUNTS, doneToday: 0, handled: new Set() });
    expect(steps.map((s) => s.action)).toEqual(["post"]);
  });

  it("a mixed rule does not approve a waiting clip for its burners: they wait for the tap too", () => {
    const steps = planRule({ rule: rule({ accountIds: ["yt-main", "tt-burner"] }), clips: [clip({ status: "pending" })], accounts: ACCOUNTS, doneToday: 0, handled: new Set() });
    expect(steps.map((s) => s.action)).toEqual(["wait-approval", "wait-approval"]);
    expect(steps[1]!.reason).toBe("Waits for your approve tap in the Inbox: this rule also posts to main accounts.");
  });

  it("keeps the daily cap, counting what the rule already did today", () => {
    const clips = [clip({ id: 1, score: 90 }), clip({ id: 2, score: 95 }), clip({ id: 3, score: 85 })];
    const steps = planRule({ rule: rule({ accountIds: ["yt-main"], dailyCap: 3 }), clips, accounts: ACCOUNTS, doneToday: 1, handled: new Set() });
    // Best clips first; the third is over the cap.
    expect(steps.map((s) => [s.clipId, s.action])).toEqual([
      [2, "post"],
      [1, "post"],
      [3, "skip"],
    ]);
    expect(steps[2]!.reason).toBe("The rule's daily cap of 3 posts is reached.");
  });

  it("does not repeat what the rule already did", () => {
    const steps = planRule({ rule: rule(), clips: [clip()], accounts: ACCOUNTS, doneToday: 1, handled: new Set(["1:yt-main"]) });
    expect(steps.map((s) => s.accountId)).toEqual(["tt-main"]);
  });

  it("permission guard: a clip with no permission record in force never posts", () => {
    const steps = planRule({ rule: rule({ permissionId: null }), clips: [clip({ permissionIds: [] })], accounts: ACCOUNTS, doneToday: 0, handled: new Set() });
    expect(steps.map((s) => s.action)).toEqual(["skip"]);
    expect(steps[0]!.accountId).toBeNull();
    expect(steps[0]!.reason).toBe("It has no permission record in force, so it never posts.");
  });

  it("an experiment clip posts only to burners, whatever the rule says", () => {
    const steps = planRule({ rule: rule({ accountIds: ["yt-main", "tt-burner"], auto: true }), clips: [clip({ experiment: true })], accounts: ACCOUNTS, doneToday: 0, handled: new Set() });
    expect(steps.map((s) => [s.accountId, s.action])).toEqual([
      ["yt-main", "skip"],
      ["tt-burner", "post"],
    ]);
    expect(steps[0]!.reason).toBe("It is an experiment, which posts only to burner accounts.");
  });

  it("a burner rule skips an account that is no longer a burner", () => {
    const accounts = ACCOUNTS.map((a) => (a.id === "tt-burner" ? { ...a, role: "main" as const } : a));
    const steps = planRule({ rule: rule({ accountIds: ["tt-burner"], burnerOnly: true }), clips: [clip()], accounts, doneToday: 0, handled: new Set() });
    expect(steps.map((s) => s.action)).toEqual(["skip"]);
    expect(steps[0]!.reason).toBe("burner.one is no longer a burner, and this rule posts only to burners.");
  });

  it("skips accounts that are off or gone", () => {
    const accounts = ACCOUNTS.map((a) => (a.id === "tt-main" ? { ...a, enabled: false } : a)).filter((a) => a.id !== "yt-main");
    const steps = planRule({ rule: rule(), clips: [clip()], accounts, doneToday: 0, handled: new Set() });
    expect(steps.map((s) => s.reason)).toEqual(["The account is no longer connected.", "gtavimoments is switched off."]);
  });
});

describe("parseRule", () => {
  const body = { name: "TJR", minScore: 80, accountIds: ["yt-main"], dailyCap: 3 };
  it("takes a rule with defaults: off, approve taps, quality check on, dry run on", () => {
    expect(parseRule(body, ACCOUNTS)).toEqual({
      name: "TJR",
      enabled: false,
      sourceId: null,
      permissionId: null,
      minScore: 80,
      needsQuality: true,
      accountIds: ["yt-main"],
      auto: false,
      burnerOnly: false,
      dailyCap: 3,
      dryRun: true,
    });
  });

  it("refuses a burner rule with a main account, and other bad input", () => {
    expect(() => parseRule({ ...body, burnerOnly: true, accountIds: ["tt-burner", "yt-main"] }, ACCOUNTS)).toThrow(
      "A burner rule posts only to burner accounts: GTA VI Moments is a main account.",
    );
    expect(() => parseRule({ ...body, accountIds: [] }, ACCOUNTS)).toThrow("Pick at least one account.");
    expect(() => parseRule({ ...body, accountIds: ["nope"] }, ACCOUNTS)).toThrow("One of the accounts is no longer connected. Reload and pick again.");
    expect(() => parseRule({ ...body, minScore: 120 }, ACCOUNTS)).toThrow("The score must be a number from 0 to 100.");
    expect(() => parseRule({ ...body, dailyCap: 0 }, ACCOUNTS)).toThrow("The daily cap must be a whole number from 1 to 50.");
    expect(() => parseRule({ ...body, name: " " }, ACCOUNTS)).toThrow("Give the rule a name.");
  });
});
