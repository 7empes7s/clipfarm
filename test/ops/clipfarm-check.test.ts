import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { checkClipfarm, type ClipfarmProbes, type HttpAnswer, httpGet, portOpen } from '../../ops/clipfarm/check.ts';

const LOGIN = 'https://tib.cloudflareaccess.com/cdn-cgi/access/login/clip.techinsiderbytes.com?kid=abc';

/** Everything healthy; each test breaks one thing. */
function probes(overrides: Partial<ClipfarmProbes> = {}): ClipfarmProbes {
  return {
    serviceState: async () => 'active',
    portOpen: async () => true,
    httpGet: async (url): Promise<HttpAnswer> =>
      url.startsWith('https://')
        ? { status: 302, location: LOGIN, server: 'cloudflare', body: '' }
        : { status: 200, body: '{"ok":true}' },
    ...overrides,
  };
}

const check = (overrides?: Partial<ClipfarmProbes>) =>
  checkClipfarm({ port: 5310, hostname: 'clip.techinsiderbytes.com', probes: probes(overrides) });

describe('ops/clipfarm/check.ts', () => {
  it('says OK for each of the four checks when everything is up and behind Access', async () => {
    const result = await check();
    expect(result.ok).toBe(true);
    expect(result.lines).toHaveLength(4);
    for (const line of result.lines) expect(line).toMatch(/^OK: /);
    expect(result.lines[3]).toContain('Cloudflare Access');
  });

  it('asks Caddy for /api/health with the public hostname, and the public URL over https', async () => {
    const asked: { url: string; host?: string }[] = [];
    await check({
      httpGet: async (url, host) => {
        asked.push({ url, host });
        return probes().httpGet(url, host);
      },
    });
    expect(asked).toEqual([
      { url: 'http://127.0.0.1:80/api/health', host: 'clip.techinsiderbytes.com' },
      { url: 'https://clip.techinsiderbytes.com/', host: undefined },
    ]);
  });

  it('reports a stopped service and a closed port', async () => {
    const result = await check({ serviceState: async () => 'failed', portOpen: async () => false });
    expect(result.ok).toBe(false);
    expect(result.lines[0]).toMatch(/^NOT OK: .*clipfarm.*failed/);
    expect(result.lines[1]).toMatch(/^NOT OK: .*127\.0\.0\.1:5310/);
  });

  it('reports Caddy not routing the hostname', async () => {
    const result = await check({
      httpGet: async (url, host) => (host ? { status: 502, body: '' } : probes().httpGet(url, host)),
    });
    expect(result.ok).toBe(false);
    expect(result.lines[2]).toMatch(/^NOT OK: .*Caddy.*502/);
  });

  it('fails loudly when the public URL answers without a sign-in: the gallery is open to the internet', async () => {
    const result = await check({
      httpGet: async (url, host) => (host ? probes().httpGet(url, host) : { status: 200, server: 'cloudflare', body: '<html>' }),
    });
    expect(result.ok).toBe(false);
    expect(result.lines[3]).toMatch(/^NOT OK: .*open to the internet/);
  });

  it("is not fooled by the app's own 403 (the gate works, but the Access application is missing)", async () => {
    const result = await check({
      httpGet: async (url, host) => (host ? probes().httpGet(url, host) : { status: 403, server: 'cloudflare', body: '{}' }),
    });
    expect(result.ok).toBe(false);
    expect(result.lines[3]).toMatch(/^NOT OK: .*Access application/);
  });

  it('tells a missing tunnel hostname (404 from Cloudflare) from a broken tunnel or Caddy (502)', async () => {
    const answer = (status: number) =>
      check({ httpGet: async (url, host) => (host ? probes().httpGet(url, host) : { status, server: 'cloudflare', body: '' }) });
    expect((await answer(404)).lines[3]).toMatch(/^NOT OK: .*public hostname/);
    expect((await answer(502)).lines[3]).toMatch(/^NOT OK: .*502.*(cloudflared|Caddy)/);
  });

  it('does not accept a redirect that goes somewhere other than the Cloudflare login', async () => {
    const result = await check({
      httpGet: async (url, host) =>
        host ? probes().httpGet(url, host) : { status: 302, location: 'https://evil.example/cloudflareaccess.com', body: '' },
    });
    expect(result.ok).toBe(false);
  });

  it('reports a probe that throws (nothing listening, DNS missing) instead of crashing', async () => {
    const result = await check({
      httpGet: async () => {
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      },
    });
    expect(result.ok).toBe(false);
    expect(result.lines[2]).toMatch(/^NOT OK: .*ECONNREFUSED/);
    expect(result.lines[3]).toMatch(/^NOT OK: .*ECONNREFUSED/);
  });

  describe('the real probes', () => {
    let server: Server | undefined;
    afterEach(() => server?.close());

    it('httpGet sends the given Host header, does not follow redirects, and portOpen sees the listener', async () => {
      server = createServer((req, res) => {
        if (req.url === '/login') res.writeHead(302, { location: LOGIN, server: 'cloudflare' }).end();
        else res.end(`host=${req.headers.host}`);
      });
      await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
      const port = (server.address() as AddressInfo).port;

      expect(await httpGet(`http://127.0.0.1:${port}/api/health`, 'clip.techinsiderbytes.com')).toMatchObject({
        status: 200,
        body: 'host=clip.techinsiderbytes.com',
      });
      expect(await httpGet(`http://127.0.0.1:${port}/login`)).toMatchObject({ status: 302, location: LOGIN, server: 'cloudflare' });
      expect(await portOpen('127.0.0.1', port)).toBe(true);

      await new Promise((done) => server!.close(done));
      server = undefined;
      expect(await portOpen('127.0.0.1', port)).toBe(false);
    });
  });
});
