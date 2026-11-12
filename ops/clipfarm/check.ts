/**
 * Read-only check of the live clipfarm (npm run clipfarm:check, on the box): the service runs, its
 * port listens, Caddy routes the hostname to it, and the public URL sends visitors to the
 * Cloudflare Access login instead of showing the gallery. Changes nothing.
 */
import { execFile } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect } from 'node:net';

export interface HttpAnswer {
  status: number;
  /** Where a redirect points. */
  location?: string;
  /** The Server header: "cloudflare" when Cloudflare itself answered. */
  server?: string;
  body: string;
}

export interface ClipfarmProbes {
  /** `systemctl is-active <unit>`: active, inactive, failed, ... */
  serviceState(unit: string): Promise<string>;
  portOpen(host: string, port: number): Promise<boolean>;
  /** GET without following redirects; `host` overrides the Host header (to ask Caddy for a site). */
  httpGet(url: string, host?: string): Promise<HttpAnswer>;
}

export interface ClipfarmCheckOptions {
  /** PORT from /etc/clipfarm/clipfarm.env. */
  port: number;
  /** The public hostname, e.g. clip.techinsiderbytes.com. */
  hostname: string;
  unit?: string;
  /** Where Caddy listens on the box. */
  caddy?: string;
  probes?: ClipfarmProbes;
}

export interface ClipfarmCheckResult {
  ok: boolean;
  lines: string[];
}

const TIMEOUT_MS = 10_000;

export function serviceState(unit: string): Promise<string> {
  return new Promise((resolve) => {
    // is-active exits non-zero for anything but "active"; the word it prints is the answer.
    execFile('systemctl', ['is-active', unit], (error, stdout) => {
      resolve(stdout.trim() || (error ? `unknown (${error.message.trim()})` : 'unknown'));
    });
  });
}

export function portOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: TIMEOUT_MS });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

export function httpGet(url: string, host?: string): Promise<HttpAnswer> {
  return new Promise((resolve, reject) => {
    const send = url.startsWith('https:') ? httpsRequest : httpRequest;
    const req = send(url, { method: 'GET', headers: host ? { Host: host } : {}, timeout: TIMEOUT_MS }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        if (body.length < 4096) body += chunk;
      });
      res.on('end', () => {
        const server = res.headers.server === undefined ? undefined : String(res.headers.server);
        resolve({ status: res.statusCode ?? 0, location: res.headers.location, server, body });
      });
      res.on('error', reject);
    });
    req.once('timeout', () => req.destroy(new Error(`no answer within ${TIMEOUT_MS / 1000} s`)));
    req.once('error', reject);
    req.end();
  });
}

const realProbes: ClipfarmProbes = { serviceState, portOpen, httpGet };

function why(error: unknown): string {
  const code = (error as { code?: string })?.code;
  const message = error instanceof Error ? error.message : String(error);
  return code && !message.includes(code) ? `${code}: ${message}` : message;
}

function isAccessLogin(location: string | undefined): boolean {
  try {
    return new URL(location ?? '').hostname.endsWith('.cloudflareaccess.com');
  } catch {
    return false;
  }
}

function publicLine(hostname: string, answer: HttpAnswer): string {
  const url = `https://${hostname}/`;
  const { status } = answer;
  if (status >= 300 && status < 400 && isAccessLogin(answer.location)) {
    return `OK: ${url} sends visitors to the Cloudflare Access login.`;
  }
  if (status >= 200 && status < 300) {
    return `NOT OK: ${url} answers ${status} without a sign-in: the gallery is open to the internet. Add the Access application now (RUNBOOK.md step 7).`;
  }
  if (status === 403) {
    return `NOT OK: ${url} answers 403 instead of the Cloudflare login: the Access application is missing or does not cover this hostname (RUNBOOK.md step 7).`;
  }
  if (status === 404 && answer.server === 'cloudflare') {
    return `NOT OK: ${url} answers 404 from Cloudflare: the tunnel has no public hostname for it (RUNBOOK.md step 8).`;
  }
  if (status >= 500) {
    return `NOT OK: ${url} answers ${status}: Cloudflare cannot reach the box. Check cloudflared and Caddy (systemctl is-active cloudflared caddy).`;
  }
  return `NOT OK: ${url} answers ${status}${answer.location ? ` (to ${answer.location})` : ''}, not a redirect to the Cloudflare Access login (RUNBOOK.md steps 7 and 8).`;
}

export async function checkClipfarm(options: ClipfarmCheckOptions): Promise<ClipfarmCheckResult> {
  const { port, hostname, unit = 'clipfarm', caddy = '127.0.0.1:80', probes = realProbes } = options;
  const lines: string[] = [];

  const state = await probes.serviceState(unit);
  lines.push(
    state === 'active'
      ? `OK: the ${unit} service is active.`
      : `NOT OK: the ${unit} service is ${state}. See: journalctl -u ${unit} -n 50`,
  );

  lines.push(
    (await probes.portOpen('127.0.0.1', port))
      ? `OK: something listens on 127.0.0.1:${port}.`
      : `NOT OK: nothing listens on 127.0.0.1:${port}. Is PORT in /etc/clipfarm/clipfarm.env ${port}?`,
  );

  const viaCaddy = `http://${caddy}/api/health`;
  try {
    const health = await probes.httpGet(viaCaddy, hostname);
    lines.push(
      health.status === 200 && health.body.includes('"ok":true')
        ? `OK: Caddy routes ${hostname} to clipfarm (/api/health answers).`
        : `NOT OK: /api/health through Caddy (${viaCaddy}, Host: ${hostname}) answers ${health.status}. Check the site block in /etc/caddy/Caddyfile (RUNBOOK.md step 6).`,
    );
  } catch (error) {
    lines.push(`NOT OK: cannot reach Caddy at ${viaCaddy} (${why(error)}). Is it running (systemctl is-active caddy)?`);
  }

  try {
    lines.push(publicLine(hostname, await probes.httpGet(`https://${hostname}/`)));
  } catch (error) {
    lines.push(`NOT OK: cannot reach https://${hostname}/ (${why(error)}). Is the public hostname set in the tunnel (RUNBOOK.md step 8)?`);
  }

  return { ok: lines.every((line) => line.startsWith('OK: ')), lines };
}
