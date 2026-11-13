import { describe, expect, it } from 'vitest';
import { checkPostiz, postizApiBase } from '../../ops/postiz/check.ts';

type FakeRoute = (req: { url: string; headers: Record<string, string> }) => Response;

/** A fake Postiz public API: answers like Postiz's PublicAuthMiddleware + integrations controller. */
function fakePostiz(validKey: string, integrations: unknown[]): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const route: FakeRoute = ({ url, headers }) => {
    calls.push(url);
    if (!url.endsWith('/api/public/v1/integrations')) return new Response('Not Found', { status: 404 });
    if (!headers.authorization) return Response.json({ msg: 'No API Key found' }, { status: 401 });
    if (headers.authorization !== validKey) return Response.json({ msg: 'Invalid API key' }, { status: 401 });
    return Response.json(integrations);
  };
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    return route({ url: String(input), headers });
  }) as typeof fetch;
  return { fetch: fakeFetch, calls };
}

const accounts = [
  { id: 'a1', name: 'GTA VI Moments', identifier: 'youtube', disabled: false },
  { id: 'a2', name: 'gtavimoments', identifier: 'tiktok', disabled: false },
  { id: 'a3', name: 'gtavi.moments', identifier: 'instagram-standalone', disabled: true },
];

describe('postizApiBase', () => {
  it('appends the public API path to the site URL', () => {
    expect(postizApiBase('https://postiz.example.com')).toBe('https://postiz.example.com/api/public/v1');
    expect(postizApiBase('https://postiz.example.com/')).toBe('https://postiz.example.com/api/public/v1');
  });

  it('keeps a URL that already points at the public API', () => {
    expect(postizApiBase('https://postiz.example.com/api/public/v1/')).toBe('https://postiz.example.com/api/public/v1');
  });
});

describe('checkPostiz', () => {
  it('reports OK and lists the connected accounts with a good key', async () => {
    const api = fakePostiz('good-key', accounts);
    const result = await checkPostiz({ url: 'https://postiz.example.com', apiKey: 'good-key', fetch: api.fetch });

    expect(result.ok).toBe(true);
    expect(api.calls).toEqual(['https://postiz.example.com/api/public/v1/integrations']);
    expect(result.lines[0]).toBe('OK: Postiz at https://postiz.example.com answered with 3 connected accounts.');
    expect(result.lines[1]).toBe('  backend: up');
    expect(result.lines).toContain('  youtube: GTA VI Moments');
    expect(result.lines).toContain('  instagram-standalone: gtavi.moments (disabled: reconnect it in Postiz)');
  });

  it('says OK but warns when no account is connected yet', async () => {
    const api = fakePostiz('good-key', []);
    const result = await checkPostiz({ url: 'https://postiz.example.com', apiKey: 'good-key', fetch: api.fetch });

    expect(result.ok).toBe(true);
    expect(result.lines.join('\n')).toMatch(/no accounts are connected yet/);
  });

  it('fails with a plain reason when the key is wrong', async () => {
    const api = fakePostiz('good-key', accounts);
    const result = await checkPostiz({ url: 'https://postiz.example.com', apiKey: 'wrong-key', fetch: api.fetch });

    expect(result.ok).toBe(false);
    expect(result.lines[0]).toBe('NOT OK: Postiz refused the API key (HTTP 401: Invalid API key).');
    expect(result.lines.join('\n')).toMatch(/Settings > Public API/);
  });

  it('fails with a plain reason when Postiz cannot be reached', async () => {
    const unreachable = (async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5300'), { code: 'ECONNREFUSED' }) });
    }) as typeof fetch;
    const result = await checkPostiz({ url: 'http://127.0.0.1:5300', apiKey: 'good-key', fetch: unreachable });

    expect(result.ok).toBe(false);
    expect(result.lines[0]).toBe('NOT OK: cannot reach Postiz at http://127.0.0.1:5300 (ECONNREFUSED).');
  });

  it('gives up after the timeout instead of hanging', async () => {
    const hangs = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;
    const result = await checkPostiz({ url: 'https://postiz.example.com', apiKey: 'k', fetch: hangs, timeoutMs: 20 });

    expect(result.ok).toBe(false);
    expect(result.lines[0]).toBe('NOT OK: cannot reach Postiz at https://postiz.example.com (no answer within 0.02 s).');
  });

  it('says the backend is down when the API answers 502 (the web page may still load)', async () => {
    const broken = (async () => new Response('Bad Gateway', { status: 502 })) as typeof fetch;
    const result = await checkPostiz({ url: 'https://postiz.example.com', apiKey: 'k', fetch: broken });

    expect(result.ok).toBe(false);
    expect(result.lines[0]).toBe(
      'NOT OK: the Postiz backend is down (HTTP 502 at https://postiz.example.com/api/public/v1/integrations).',
    );
    expect(result.lines.join('\n')).toMatch(/docker compose logs --tail 100 postiz/);
  });

  it('keeps the plain HTTP status for other errors', async () => {
    const missing = (async () => new Response('Not Found', { status: 404 })) as typeof fetch;
    const result = await checkPostiz({ url: 'https://postiz.example.com', apiKey: 'k', fetch: missing });

    expect(result.ok).toBe(false);
    expect(result.lines[0]).toBe('NOT OK: Postiz answered HTTP 404 at https://postiz.example.com/api/public/v1/integrations.');
  });

  it('fails when the answer is not the integrations list (wrong URL)', async () => {
    const htmlPage = (async () => new Response('<html>login</html>', { status: 200 })) as typeof fetch;
    const result = await checkPostiz({ url: 'https://postiz.example.com', apiKey: 'k', fetch: htmlPage });

    expect(result.ok).toBe(false);
    expect(result.lines[0]).toMatch(/^NOT OK: .* is not the Postiz public API/);
  });

  it('names the missing env variables without calling anything', async () => {
    const api = fakePostiz('good-key', accounts);
    const result = await checkPostiz({ url: '', apiKey: undefined, fetch: api.fetch });

    expect(result.ok).toBe(false);
    expect(result.lines[0]).toBe('NOT OK: POSTIZ_URL and POSTIZ_API_KEY are not set.');
    expect(api.calls).toEqual([]);
  });
});
