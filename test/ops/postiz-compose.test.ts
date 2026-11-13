import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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
  it('has the Postiz app, its Postgres, Redis, Temporal and Temporal\'s Postgres and Elasticsearch', () => {
    expect(Object.keys(compose.services).sort()).toEqual(
      ['postiz', 'postiz-postgres', 'postiz-redis', 'temporal', 'temporal-elasticsearch', 'temporal-postgres'].sort(),
    );
  });

  // Postiz registers more Text search attributes than Temporal's SQL store allows (3): without
  // Elasticsearch its backend does not start (issue #67).
  it('runs Temporal on Elasticsearch, and waits for it to be healthy', () => {
    const temporal = compose.services.temporal as {
      environment: Record<string, string>;
      depends_on: Record<string, { condition: string }>;
    };
    expect(temporal.environment.ENABLE_ES).toBe('true');
    expect(temporal.environment.ES_SEEDS).toBe('temporal-elasticsearch');
    expect(temporal.environment.ES_VERSION).toBe('v7');
    expect(temporal.depends_on['temporal-elasticsearch']).toEqual({ condition: 'service_healthy' });
  });

  it('runs Elasticsearch 7.17 as a single node with a capped heap, a memory limit and a health check', () => {
    const es = compose.services['temporal-elasticsearch'] as {
      image: string;
      mem_limit: string;
      environment: Record<string, string>;
      volumes: string[];
      healthcheck: { test: string[] };
      ports?: unknown;
    };
    expect(es.image).toMatch(/^elasticsearch:7\.17\.\d+$/);
    expect(es.environment['discovery.type']).toBe('single-node');
    expect(es.environment['xpack.security.enabled']).toBe('false');
    expect(es.environment.ES_JAVA_OPTS).toBe('-Xms256m -Xmx256m');
    // Room for the heap plus what the JVM uses outside it, and no more than the box can spare.
    expect(toMiB(es.mem_limit)).toBeGreaterThanOrEqual(512);
    expect(toMiB(es.mem_limit)).toBeLessThanOrEqual(700);
    expect(es.volumes).toEqual(['/opt/postiz/temporal-es:/usr/share/elasticsearch/data']);
    expect(es.healthcheck.test.join(' ')).toContain('_cluster/health');
    expect(es.ports).toBeUndefined();
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

  it('keeps the total memory limit at or under 2.85 GB', () => {
    const total = services.reduce((sum, [, svc]) => sum + toMiB(String(svc.mem_limit)), 0);
    expect(total).toBeLessThanOrEqual(2850);
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

// Runs the postiz container's real health check command against a fake Postiz: one port, like the
// container's port 5000, where / is the web page and /api/ is the backend behind it.
describe('the postiz container health check', () => {
  const { test: command } = compose.services.postiz.healthcheck as { test: string[] };

  async function healthy(statusOf: { page: number; backend: number } | 'nothing listens'): Promise<boolean> {
    const server = createServer((req, res) => {
      if (statusOf === 'nothing listens') return;
      res.writeHead(req.url?.startsWith('/api/') ? statusOf.backend : statusOf.page).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    if (statusOf === 'nothing listens') await new Promise((resolve) => server.close(resolve));
    try {
      const script = command[3].replaceAll('http://localhost:5000', `http://127.0.0.1:${port}`);
      expect(script).not.toBe(command[3]);
      return await new Promise<boolean>((resolve) => {
        execFile(process.execPath, ['-e', script], (error) => resolve(error === null));
      });
    } finally {
      if (statusOf !== 'nothing listens') await new Promise((resolve) => server.close(resolve));
    }
  }

  it('is a node one-liner that asks port 5000 for the page and the backend', () => {
    expect(command.slice(0, 3)).toEqual(['CMD', 'node', '-e']);
    expect(command[3]).toContain("up('/api/')");
  });

  it('is healthy when the page and the backend answer', async () => {
    expect(await healthy({ page: 307, backend: 200 })).toBe(true);
    expect(await healthy({ page: 200, backend: 404 })).toBe(true);
  });

  it('is unhealthy when the backend gives 502, even though the page answers 200', async () => {
    expect(await healthy({ page: 200, backend: 502 })).toBe(false);
  });

  it('is unhealthy when the page gives 502 or nothing listens', async () => {
    expect(await healthy({ page: 502, backend: 200 })).toBe(false);
    expect(await healthy('nothing listens')).toBe(false);
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
