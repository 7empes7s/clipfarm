import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const dir = new URL('../../ops/postiz/', import.meta.url);
const composeText = readFileSync(new URL('docker-compose.yml', dir), 'utf8');
const compose = parse(composeText) as {
  services: Record<string, Record<string, unknown>>;
  volumes?: unknown;
};
const services = Object.entries(compose.services);
const envExample = readFileSync(new URL('.env.example', dir), 'utf8');

/** Parses KEY=value lines, skipping comments and blanks. */
function envEntries(text: string): [string, string][] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const eq = line.indexOf('=');
      return [line.slice(0, eq), line.slice(eq + 1).replace(/^(["'])(.*)\1$/, '$2')];
    });
}

/** "1280m" / "1g" → MiB. */
function toMiB(limit: string): number {
  const m = /^(\d+(?:\.\d+)?)([mg])$/i.exec(limit);
  if (!m) throw new Error(`unreadable mem_limit ${limit}`);
  return Number(m[1]) * (m[2].toLowerCase() === 'g' ? 1024 : 1);
}

describe('ops/postiz/docker-compose.yml', () => {
  it('has the Postiz app, its Postgres, Redis and Temporal', () => {
    expect(Object.keys(compose.services).sort()).toEqual(
      ['postiz', 'postiz-postgres', 'postiz-redis', 'temporal', 'temporal-postgres'].sort(),
    );
  });

  it.each(services)('%s pins its image to a version (no latest)', (_name, svc) => {
    const image = String(svc.image);
    const tag = /:([^/:@]+)$/.exec(image)?.[1] ?? '';
    expect(tag, image).toMatch(/\d/);
    expect(tag, image).not.toMatch(/latest/i);
    expect(svc.pull_policy).not.toBe('always');
  });

  it.each(services)('%s has a memory limit', (_name, svc) => {
    expect(typeof svc.mem_limit).toBe('string');
    expect(toMiB(String(svc.mem_limit))).toBeGreaterThan(0);
  });

  it('keeps the total memory limit at or under 2.2 GB', () => {
    const total = services.reduce((sum, [, svc]) => sum + toMiB(String(svc.mem_limit)), 0);
    expect(total).toBeLessThanOrEqual(2200);
  });

  it.each(services)('%s publishes ports on 127.0.0.1 only', (_name, svc) => {
    expect(svc.network_mode).toBeUndefined();
    for (const port of (svc.ports as unknown[] | undefined) ?? []) {
      if (typeof port === 'string') expect(port).toMatch(/^127\.0\.0\.1:/);
      else expect((port as { host_ip?: string }).host_ip).toBe('127.0.0.1');
    }
  });

  it('publishes exactly one port: the Postiz web app', () => {
    const published = services.flatMap(([name, svc]) => ((svc.ports as string[] | undefined) ?? []).map((p) => `${name} ${p}`));
    expect(published).toEqual(['postiz 127.0.0.1:${POSTIZ_PORT:-5300}:5000']);
  });

  it.each(services)('%s restarts unless stopped', (_name, svc) => {
    expect(svc.restart).toBe('unless-stopped');
  });

  it.each(services)('%s keeps its data under /opt/postiz/ (not the repo, no named volumes)', (_name, svc) => {
    for (const volume of (svc.volumes as string[] | undefined) ?? []) {
      expect(volume).toMatch(/^\/opt\/postiz\/[a-z-]+:\//);
    }
  });

  it('declares no top-level named volumes', () => {
    expect(compose.volumes).toBeUndefined();
  });

  it('only uses variables that .env.example documents', () => {
    const documented = new Set(envEntries(envExample).map(([key]) => key));
    const used = [...composeText.matchAll(/\$\{([A-Z0-9_]+)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((key) => !documented.has(key))).toEqual([]);
  });

  it('refuses to start without the secrets (no default secrets)', () => {
    for (const key of ['JWT_SECRET', 'POSTIZ_DB_PASSWORD', 'TEMPORAL_DB_PASSWORD']) {
      expect(composeText).toContain(`\${${key}:?`);
    }
  });
});

describe('ops/postiz/.env.example', () => {
  const entries = envEntries(envExample);
  const get = (key: string) => entries.find(([k]) => k === key)?.[1];

  it('points every URL at postiz.techinsiderbytes.com', () => {
    expect(get('MAIN_URL')).toBe('https://postiz.techinsiderbytes.com');
    expect(get('FRONTEND_URL')).toBe('https://postiz.techinsiderbytes.com');
    expect(get('NEXT_PUBLIC_BACKEND_URL')).toBe('https://postiz.techinsiderbytes.com/api');
  });

  it('starts with registration open so the admin account can be made', () => {
    expect(get('DISABLE_REGISTRATION')).toBe('false');
  });

  it('leaves every secret, key, password and token empty', () => {
    const secretish = entries.filter(([key]) => /SECRET|PASSWORD|KEY|TOKEN|CLIENT_ID|APP_ID/.test(key));
    expect(secretish.length).toBeGreaterThan(5);
    expect(secretish.filter(([, value]) => value !== '')).toEqual([]);
  });

  it('has no real-looking secret anywhere (long random strings)', () => {
    const randomLooking = (envExample.match(/[A-Za-z0-9+_=-]{20,}/g) ?? []).filter(
      (token) => /\d/.test(token) && /[A-Za-z]/.test(token),
    );
    expect(randomLooking).toEqual([]);
  });
});
