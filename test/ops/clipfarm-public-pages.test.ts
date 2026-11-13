import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PUBLIC_PAGE_PATHS } from '../../ops/clipfarm/check.ts';
import { ACCESS_APP_NAME, openPublicPages } from '../../ops/clipfarm/public-pages.ts';

const ACCOUNT = 'a'.repeat(32);
const TOKEN = 'cf-secret-token-value';
const HOST = 'clip.techinsiderbytes.com';
const WANTED = [`${HOST}/home`, `${HOST}/privacy`, `${HOST}/terms`];
const BYPASS = { decision: 'bypass', include: [{ everyone: {} }] };

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

/** A stand-in for Cloudflare's API holding `apps`; records what was asked. */
function cloudflare(apps: Record<string, unknown>[], fail?: { status: number; message: string }) {
  const calls: Call[] = [];
  const doFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const prefix = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/access/apps`;
    expect(String(url).startsWith(prefix)).toBe(true);
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    const call: Call = { method: init?.method ?? 'GET', path: String(url).slice(prefix.length), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    if (fail) return Response.json({ success: false, errors: [{ code: 10000, message: fail.message }] }, { status: fail.status });
    let result: unknown = {};
    if (call.method === 'GET') result = apps;
    else if (call.method === 'POST' && call.path === '') result = { id: 'new-app', ...call.body };
    else if (call.method === 'PUT') result = { id: call.path.slice(1), ...call.body };
    return Response.json({ success: true, errors: [], result });
  }) as typeof fetch;
  return { calls, doFetch };
}

const run = (cf: ReturnType<typeof cloudflare>, hostname = HOST) => openPublicPages({ accountId: ACCOUNT, token: TOKEN, hostname, fetch: cf.doFetch });

describe('ops/clipfarm/public-pages.ts', () => {
  it('opens and checks the same paths the server and the service worker leave open', () => {
    const list = JSON.stringify(PUBLIC_PAGE_PATHS).replaceAll(',', ', ');
    expect(list).toBe('["/home", "/privacy", "/terms"]');
    const root = join(import.meta.dirname, '..', '..');
    expect(readFileSync(join(root, 'server/access.ts'), 'utf8')).toContain(`PUBLIC_PAGE_PATHS = ${list} as const`);
    expect(readFileSync(join(root, 'client/public/sw.js'), 'utf8')).toContain(`${list}.includes(url.pathname)`);
  });

  it('makes one Access application for exactly /home, /privacy and /terms, with a bypass for everyone', async () => {
    const cf = cloudflare([{ id: 'main', name: 'clipfarm', destinations: [{ type: 'public', uri: HOST }] }]);
    const result = await run(cf);
    expect(result.ok).toBe(true);
    expect(cf.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET ?page=1&per_page=100', 'POST ', 'POST /new-app/policies']);
    expect(cf.calls[1]!.body).toEqual({
      name: ACCESS_APP_NAME,
      type: 'self_hosted',
      domain: `${HOST}/home`,
      destinations: WANTED.map((uri) => ({ type: 'public', uri })),
    });
    expect(cf.calls[2]!.body).toMatchObject(BYPASS);
    // The app itself is left alone.
    expect(cf.calls.some((c) => c.path.includes('main'))).toBe(false);
  });

  it('changes nothing when it is already there', async () => {
    const cf = cloudflare([{ id: 'pub', name: ACCESS_APP_NAME, destinations: WANTED.map((uri) => ({ type: 'public', uri })), policies: [BYPASS] }]);
    const result = await run(cf);
    expect(result.ok).toBe(true);
    expect(cf.calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('puts back the three paths when the application covers anything else, and adds a missing policy', async () => {
    const cf = cloudflare([{ id: 'pub', name: ACCESS_APP_NAME, destinations: [{ type: 'public', uri: HOST }], policies: [{ decision: 'allow', include: [{ everyone: {} }] }] }]);
    const result = await run(cf);
    expect(result.ok).toBe(true);
    expect(cf.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET ?page=1&per_page=100', 'PUT /pub', 'POST /pub/policies']);
    expect((cf.calls[1]!.body!.destinations as { uri: string }[]).map((d) => d.uri)).toEqual(WANTED);
  });

  it("says what Cloudflare refused, without the token, and asks nothing when the settings are missing", async () => {
    const cf = cloudflare([], { status: 403, message: 'Authentication error' });
    const result = await run(cf);
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toMatch(/^NOT OK: Cloudflare answered 403.*Authentication error/);
    expect(result.lines.join('\n')).not.toContain(TOKEN);

    const none = cloudflare([]);
    expect((await openPublicPages({ accountId: '', token: TOKEN, hostname: HOST, fetch: none.doFetch })).ok).toBe(false);
    expect((await openPublicPages({ accountId: ACCOUNT, token: '', hostname: HOST, fetch: none.doFetch })).ok).toBe(false);
    // A hostname with a path (or none at all) could open more than the three pages.
    expect((await run(none, `${HOST}/`)).ok).toBe(false);
    expect((await run(none, '')).ok).toBe(false);
    expect(none.calls).toEqual([]);
  });
});
