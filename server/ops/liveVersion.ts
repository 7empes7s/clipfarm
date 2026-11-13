import { readFileSync } from "node:fs";
import type { LiveVersion } from "../../shared/types.js";

const RESULTS: readonly LiveVersion["result"][] = ["live", "rolled back", "failed"];
const KEY_STATES: readonly LiveVersion["keys"][number]["state"][] = ["Working", "Failed", "Not set"];
const POSTIZ_STATES: readonly LiveVersion["postiz"]["state"][] = ["healthy", "not healthy", "not installed"];

const text = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * What the box's auto-deploy last did, from the file ops/clipfarm/autodeploy.sh writes.
 * Null when there is none (auto-deploy is not set up, or this is not the box) or it cannot be read.
 */
export function readLiveVersion(file: string): LiveVersion | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const result = RESULTS.find((r) => r === raw?.result);
  if (!result || !/^[0-9a-f]{7,40}$/.test(text(raw.sha)) || Number.isNaN(Date.parse(text(raw.at)))) return null;
  const check = (raw.check ?? {}) as Record<string, unknown>;
  const postiz = (raw.postiz ?? {}) as Record<string, unknown>;
  const keys = Array.isArray(raw.keys) ? (raw.keys as Record<string, unknown>[]) : [];
  return {
    sha: text(raw.sha),
    at: text(raw.at),
    result,
    reason: text(raw.reason),
    keys: keys.flatMap((k) => {
      const state = KEY_STATES.find((s) => s === k?.state);
      return state && text(k.name) ? [{ name: text(k.name), state }] : [];
    }),
    check: { ok: check.ok === true, problems: Array.isArray(check.problems) ? check.problems.filter((p) => typeof p === "string") : [] },
    postiz: { state: POSTIZ_STATES.find((s) => s === postiz.state) ?? "not installed", detail: text(postiz.detail) },
  };
}
