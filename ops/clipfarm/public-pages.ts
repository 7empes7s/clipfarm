/**
 * Opens the public pages (/home, /privacy, /terms) to visitors who are not signed in: one
 * Cloudflare Access application named "clipfarm public pages" that covers exactly those paths of
 * the hostname, with one policy that lets everyone through (Bypass). Safe to run again: it only
 * adds what is missing. The rest of the hostname keeps its sign-in, and the server itself refuses
 * every other path without one (server/access.ts).
 */
import { PUBLIC_PAGE_PATHS } from './check.ts';

export const ACCESS_APP_NAME = 'clipfarm public pages';
/** The clipping service's client side, which has its own sign-in (server/access.ts, isClientServicePath). */
export const CLIENT_ACCESS_APP_NAME = 'clipfarm client portal';
export const CLIENT_SERVICE_PATHS = ['/service', '/pricing', '/service-terms', '/portal', '/portal/*', '/api/portal/*', '/api/stripe/webhook', '/assets/*'];
const API = 'https://api.cloudflare.com/client/v4';
const PER_PAGE = 100;

export interface PublicPagesOptions {
  /** The Cloudflare account that owns the Zero Trust team. */
  accountId: string;
  /** An API token with "Access: Apps and Policies" Edit. Never printed. */
  token: string;
  /** The public hostname, e.g. clip.techinsiderbytes.com. */
  hostname: string;
  fetch?: typeof fetch;
  /** Another Access application (the client portal): its name and paths. Default: the public pages. */
  name?: string;
  paths?: string[];
}

interface Destination {
  type?: string;
  uri?: string;
}

interface AccessPolicy {
  decision?: string;
  include?: Record<string, unknown>[];
}

interface AccessApp {
  id: string;
  name?: string;
  destinations?: Destination[];
  policies?: AccessPolicy[];
}

interface Envelope<T> {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: T;
}

export interface PublicPagesResult {
  ok: boolean;
  lines: string[];
}

/** Lets everyone through, and nothing narrower than that is needed for pages meant for anyone. */
function isBypassForAll(policy: AccessPolicy): boolean {
  return policy.decision === 'bypass' && (policy.include ?? []).some((rule) => 'everyone' in rule);
}

export async function openPublicPages(options: PublicPagesOptions): Promise<PublicPagesResult> {
  const { accountId, token, hostname, fetch: doFetch = fetch, name: appName = ACCESS_APP_NAME, paths = PUBLIC_PAGE_PATHS } = options;
  if (!/^[a-f0-9]{32}$/i.test(accountId)) return { ok: false, lines: ['NOT OK: CLOUDFLARE_ACCOUNT_ID is not a Cloudflare account ID (32 letters and digits).'] };
  if (!token) return { ok: false, lines: ['NOT OK: CLOUDFLARE_API_TOKEN is not set.'] };
  // A bare hostname as a destination would open the whole app, so nothing but a hostname gets in.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(hostname)) return { ok: false, lines: [`NOT OK: "${hostname}" is not a hostname.`] };

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${API}/accounts/${accountId}/access/apps${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const answer = (await res.json().catch(() => ({}))) as Envelope<T>;
    if (!res.ok || !answer.success || answer.result === undefined) {
      const said = (answer.errors ?? []).map((e) => e.message).filter(Boolean).join('; ');
      throw new Error(`Cloudflare answered ${res.status} to ${method} access/apps${path.replace(/\?.*$/, '')}${said ? `: ${said}` : ''}`);
    }
    return answer.result;
  }

  const wanted = paths.map((path) => `${hostname}${path}`);
  const app = { name: appName, type: 'self_hosted', domain: wanted[0], destinations: wanted.map((uri) => ({ type: 'public', uri })) };
  const lines: string[] = [];
  try {
    let found: AccessApp | undefined;
    for (let page = 1; !found; page += 1) {
      const apps = await call<AccessApp[]>('GET', `?page=${page}&per_page=${PER_PAGE}`);
      found = apps.find((a) => a.name === appName);
      if (apps.length < PER_PAGE) break;
    }

    if (!found) {
      found = await call<AccessApp>('POST', '', app);
      lines.push(`OK: made the Access application "${appName}" for ${wanted.join(', ')}.`);
    } else {
      const has = (found.destinations ?? []).map((d) => d.uri).sort();
      if (JSON.stringify(has) === JSON.stringify([...wanted].sort())) {
        lines.push(`OK: the Access application "${appName}" already covers ${wanted.join(', ')}.`);
      } else {
        const policies = found.policies;
        found = { ...(await call<AccessApp>('PUT', `/${found.id}`, app)), policies };
        lines.push(`OK: set the Access application "${appName}" to cover ${wanted.join(', ')} and nothing else.`);
      }
    }

    if ((found.policies ?? []).some(isBypassForAll)) {
      lines.push('OK: its policy already lets everyone read these pages.');
    } else {
      await call('POST', `/${found.id}/policies`, { name: 'Anyone may read the public pages', decision: 'bypass', include: [{ everyone: {} }] });
      lines.push('OK: added the policy that lets everyone read these pages.');
    }
  } catch (error) {
    // Cloudflare's own words only: the token is in a header and is never part of a message.
    lines.push(`NOT OK: ${error instanceof Error ? error.message : String(error)}.`);
  }
  return { ok: lines.every((line) => line.startsWith('OK: ')), lines };
}
