// Settings for `npm run e2e:live`, read from env. Kept pure so the live-safe rules are unit tested
// (test/e2e-live.test.ts): the suite never posts for real outside a local preview.

/** The 30-minute goal in O1: a link becomes clips in under half an hour. */
export const LINK_TO_CLIPS_GOAL_MS = 30 * 60_000;

export interface LiveSettings {
  baseUrl: string;
  /** localhost, 127.0.0.1 or ::1: a preview on this machine. */
  local: boolean;
  /** Posting stops at the server's dry run and the export pack; nothing is sent to a posting service. */
  dryRun: boolean;
  /** The link the suite submits. */
  videoUrl: string;
  /** Where the permission for that video is written down, if it is not our own. */
  permissionUrl: string | null;
  /** Cloudflare Access service-token headers, when set. */
  headers: Record<string, string>;
  /** How long the link-to-clips step may take before it fails. */
  pipelineTimeoutMs: number;
}

function webLink(raw: string, name: string): URL {
  let url: URL | null = null;
  try {
    url = new URL(raw);
  } catch {
    /* handled below */
  }
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
    throw new Error(`${name} is not a web link: "${raw}". It must start with https:// or http://.`);
  }
  return url;
}

export function liveSettings(env: Record<string, string | undefined>): LiveSettings {
  if (!env.BASE_URL) throw new Error("Set BASE_URL to the site to test, e.g. BASE_URL=http://localhost:3000 npm run e2e:live.");
  const base = webLink(env.BASE_URL, "BASE_URL");
  const baseUrl = base.origin;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);

  const dryRun = env.E2E_DRY_RUN !== "0";
  if (!dryRun && !local) {
    throw new Error(
      `Refusing to run against ${baseUrl} without the dry run: real posting is only tried on a local preview. Remove E2E_DRY_RUN=0.`,
    );
  }

  if (!local && !env.E2E_VIDEO_URL) {
    throw new Error(
      "Set E2E_VIDEO_URL to a short video we made ourselves or have written permission for. The suite never picks a video on a live site by itself.",
    );
  }
  // A local preview runs the fake downloader, which makes its own test pattern whatever the link.
  const videoUrl = webLink(env.E2E_VIDEO_URL || "https://example.com/clipfarm-e2e/test-video", "E2E_VIDEO_URL").toString();
  const permissionUrl = env.E2E_PERMISSION_URL ? webLink(env.E2E_PERMISSION_URL, "E2E_PERMISSION_URL").toString() : null;

  const id = env.CF_ACCESS_CLIENT_ID;
  const secret = env.CF_ACCESS_CLIENT_SECRET;
  if (Boolean(id) !== Boolean(secret)) {
    throw new Error("Set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET, or neither.");
  }
  if (id && base.protocol !== "https:") {
    throw new Error(`The Cloudflare Access service token is only sent over https, and ${baseUrl} is not.`);
  }

  const minutes = Number(env.E2E_PIPELINE_MINUTES) || (local ? 5 : 30);
  return {
    baseUrl,
    local,
    dryRun,
    videoUrl,
    permissionUrl,
    headers: id && secret ? { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret } : {},
    pipelineTimeoutMs: minutes * 60_000,
  };
}

/**
 * The last check before the suite asks a server to post: only outside a dry run (so only on a local
 * preview) and only when that server posts through the test posting service.
 */
export function assertMayPost(settings: LiveSettings, postingService: string): void {
  if (settings.dryRun) throw new Error("Refusing to post: this is a dry run.");
  if (!settings.local) throw new Error(`Refusing to post: ${settings.baseUrl} is not a local preview.`);
  if (postingService !== "fake") {
    throw new Error(`Refusing to post: this server posts through ${postingService}, a real posting service.`);
  }
}
