import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';

const repo = new URL('../..', import.meta.url).pathname;
const read = (path: string) => readFileSync(join(repo, path), 'utf8');

/** Every env variable the server and the ops scripts read (env.NAME / process.env.NAME). */
function variablesRead(): string[] {
  const names = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(repo, dir), { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        for (const match of read(path).matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) names.add(match[1]!);
      }
    }
  };
  walk('server');
  names.add('MEDIA_KEEP_REJECTED_DAYS'); // ops/clipfarm/media-cleanup-cli.ts
  return [...names].sort();
}

describe('ops/clipfarm files', () => {
  const env = parseEnv(read('ops/clipfarm/.env.example'));
  const unit = read('ops/clipfarm/clipfarm.service');

  it('.env.example names every variable the server reads, and holds no secret', () => {
    expect(Object.keys(env).sort()).toEqual(variablesRead());
    for (const [name, value] of Object.entries(env)) {
      if (/KEY|SECRET|TOKEN|PASSWORD/.test(name)) expect(value, name).toBe('');
    }
  });

  it('.env.example binds to 127.0.0.1, turns the Access gate on and keeps data outside the releases', () => {
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.CLIPFARM_REQUIRE_ACCESS).toBe('1');
    expect(env.CLIPFARM_FAKES).toBe('');
    expect(env.DATA_DIR).toBe('/var/lib/clipfarm');
    expect(env.MEDIA_DIR).toBe('/var/lib/clipfarm/media');
  });

  it('the Caddy block and deploy.sh use the port from .env.example, and the checker defaults to it', () => {
    expect(env.PORT).toMatch(/^\d+$/);
    expect(read('ops/clipfarm/Caddyfile.snippet')).toContain(`reverse_proxy 127.0.0.1:${env.PORT}\n`);
    expect(read('ops/clipfarm/deploy.sh')).toContain(`\${port:-${env.PORT}}`);
    expect(read('ops/clipfarm/check-cli.ts')).toContain(`fileEnv.PORT ?? ${env.PORT})`);
  });

  it('the unit runs the built server as its own user, restarts, caps memory and can only write the data folder', () => {
    const settings = unit.split('\n').filter((line) => /^[A-Z][A-Za-z]*=/.test(line));
    expect(settings).toEqual(
      expect.arrayContaining([
        'User=clipfarm',
        'WorkingDirectory=/opt/clipfarm-live/current',
        'EnvironmentFile=/etc/clipfarm/clipfarm.env',
        'ExecStart=/usr/bin/node dist/server/index.js',
        'Restart=always',
        'NoNewPrivileges=true',
        'ProtectSystem=strict',
        `ReadWritePaths=${env.DATA_DIR}`,
      ]),
    );
    expect(unit).toMatch(/^MemoryMax=\d+M$/m);
    // Keys come from the env file only, never from the unit.
    expect(unit).not.toMatch(/KEY=|SECRET=/);
  });
});
