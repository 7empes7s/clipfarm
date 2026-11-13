/**
 * Checks that clipfarm can talk to Postiz: calls the public API's list of connected
 * accounts (GET /api/public/v1/integrations) with POSTIZ_API_KEY and explains what is wrong.
 * That call goes through Postiz's backend, so the answer also says whether the backend is up:
 * the web page keeps loading while the backend is down, and only /api/ shows it (502).
 * API: https://docs.postiz.com/public-api/introduction (the key goes in the Authorization header as is).
 */

export interface PostizCheckOptions {
  /** POSTIZ_URL: the address you open Postiz at, e.g. https://postiz.techinsiderbytes.com */
  url: string | undefined;
  /** POSTIZ_API_KEY: from Postiz > Settings > Public API. */
  apiKey: string | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface PostizCheckResult {
  ok: boolean;
  lines: string[];
}

interface Integration {
  name?: string;
  identifier?: string;
  disabled?: boolean;
}

const PUBLIC_API_PATH = '/api/public/v1';

/** The public API base for a Postiz site URL (accepts a URL that already ends in /api/public/v1). */
export function postizApiBase(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  return trimmed.endsWith(PUBLIC_API_PATH) ? trimmed : trimmed + PUBLIC_API_PATH;
}

function notOk(reason: string, ...hints: string[]): PostizCheckResult {
  return { ok: false, lines: [`NOT OK: ${reason}`, ...hints] };
}

function networkReason(error: unknown, timeoutMs: number): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return `no answer within ${timeoutMs / 1000} s`;
  }
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  return cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error));
}

export async function checkPostiz(options: PostizCheckOptions): Promise<PostizCheckResult> {
  const { url, apiKey, fetch: doFetch = fetch, timeoutMs = 10_000 } = options;
  const missing = [!url?.trim() && 'POSTIZ_URL', !apiKey?.trim() && 'POSTIZ_API_KEY'].filter(Boolean);
  if (missing.length) {
    return notOk(
      `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set.`,
      'Put them in clipfarm\'s .env (see ops/postiz/RUNBOOK.md, "Connect clipfarm").',
    );
  }

  const site = url!.trim().replace(/\/+$/, '');
  const endpoint = `${postizApiBase(site)}/integrations`;
  let response: Response;
  try {
    response = await doFetch(endpoint, {
      headers: { Authorization: apiKey!.trim(), Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return notOk(
      `cannot reach Postiz at ${site} (${networkReason(error, timeoutMs)}).`,
      'Is it running (systemctl status postiz) and is the URL right?',
    );
  }

  const body = await response.text();
  if (response.status === 401 || response.status === 403) {
    let msg = body;
    try {
      msg = (JSON.parse(body) as { msg?: string }).msg ?? body;
    } catch {
      // not JSON: show the raw text
    }
    return notOk(
      `Postiz refused the API key (HTTP ${response.status}: ${msg}).`,
      'Copy the key again from Postiz > Settings > Public API into POSTIZ_API_KEY.',
    );
  }
  if (response.status >= 500) {
    return notOk(
      `the Postiz backend is down (HTTP ${response.status} at ${endpoint}).`,
      'The web page can still load while it is. See why: cd /opt/postiz && docker compose ps && docker compose logs --tail 100 postiz',
    );
  }
  if (!response.ok) {
    return notOk(`Postiz answered HTTP ${response.status} at ${endpoint}.`);
  }

  let integrations: Integration[];
  try {
    integrations = JSON.parse(body) as Integration[];
    if (!Array.isArray(integrations)) throw new Error('not a list');
  } catch {
    return notOk(
      `${endpoint} is not the Postiz public API (the answer is not a list of accounts).`,
      'POSTIZ_URL should be the address you open Postiz at, e.g. https://postiz.techinsiderbytes.com',
    );
  }

  const lines = [`OK: Postiz at ${site} answered with ${integrations.length} connected accounts.`, '  backend: up'];
  if (integrations.length === 0) {
    lines.push('  but no accounts are connected yet: add YouTube, TikTok, Instagram or X in Postiz.');
  }
  for (const integration of integrations) {
    const disabled = integration.disabled ? ' (disabled: reconnect it in Postiz)' : '';
    lines.push(`  ${integration.identifier ?? 'unknown'}: ${integration.name ?? '(no name)'}${disabled}`);
  }
  return { ok: true, lines };
}
