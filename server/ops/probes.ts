import type { OpsLevel } from "../../shared/ops.js";
import type { ServiceProbe } from "./operations.js";

type Fetch = typeof fetch;

async function reach(url: string, init: RequestInit, doFetch: Fetch): Promise<{ status: number } | { error: string }> {
  try {
    const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(8_000) });
    await res.body?.cancel();
    return { status: res.status };
  } catch (err) {
    const cause = (err as { cause?: { code?: string } })?.cause?.code;
    return { error: err instanceof DOMException && err.name === "TimeoutError" ? "no answer in time" : (cause ?? "no connection") };
  }
}

/**
 * Postiz's web page and its backend. The page keeps loading while the backend is down, and only
 * /api/ shows it (see ops/postiz/check.ts), so they are two rows. One cheap read each; no key is sent
 * to the web page, and the answer never holds the key.
 */
export function postizProbes(get: () => { url?: string; apiKey?: string }, doFetch: Fetch = fetch): ServiceProbe[] {
  const site = () => get().url?.trim().replace(/\/+$/, "") ?? "";
  return [
    {
      id: "postiz",
      label: "Postiz",
      async check() {
        if (!site()) return { level: "off" as OpsLevel, detail: "Not set up" };
        const r = await reach(site(), {}, doFetch);
        if ("error" in r) return { level: "down" as OpsLevel, detail: `Not reachable (${r.error})` };
        return r.status < 500 ? { level: "ok" as OpsLevel, detail: "Up" } : { level: "down" as OpsLevel, detail: `Answers with an error (HTTP ${r.status})` };
      },
    },
    {
      id: "postiz-backend",
      label: "Postiz backend",
      async check() {
        const key = get().apiKey?.trim();
        if (!site() || !key) return { level: "off" as OpsLevel, detail: "Not set up" };
        const base = site().endsWith("/api/public/v1") ? site() : `${site()}/api/public/v1`;
        const r = await reach(`${base}/integrations`, { headers: { Authorization: key, Accept: "application/json" } }, doFetch);
        if ("error" in r) return { level: "down" as OpsLevel, detail: `Not reachable (${r.error})` };
        if (r.status >= 500) return { level: "down" as OpsLevel, detail: `Down (HTTP ${r.status})` };
        if (r.status === 401 || r.status === 403) return { level: "down" as OpsLevel, detail: "Up, but it refuses the API key" };
        return r.status < 400 ? { level: "ok" as OpsLevel, detail: "Up" } : { level: "warn" as OpsLevel, detail: `Answers HTTP ${r.status}` };
      },
    },
  ];
}

/**
 * Demo mode's stand-ins: up, unless CLIPFARM_FAKE_DOWN names them (e.g. "postiz-backend"), so the
 * red state can be seen in the preview without breaking anything real.
 */
export function fakeProbes(down: Set<string>): ServiceProbe[] {
  return [
    { id: "postiz", label: "Postiz" },
    { id: "postiz-backend", label: "Postiz backend" },
  ].map((p) => ({
    ...p,
    check: async () => (down.has(p.id) ? { level: "down" as OpsLevel, detail: "Down (demo)" } : { level: "ok" as OpsLevel, detail: "Up (demo)" }),
  }));
}

/** CLIPFARM_FAKE_DOWN: comma-separated probe or key ids that demo mode shows as failing. */
export function fakeDown(env: NodeJS.ProcessEnv): Set<string> {
  return new Set((env.CLIPFARM_FAKE_DOWN ?? "").split(",").map((s) => s.trim()).filter(Boolean));
}
