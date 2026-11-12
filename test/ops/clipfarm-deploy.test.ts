import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = new URL('../../ops/clipfarm/deploy.sh', import.meta.url).pathname;

/**
 * Runs the real deploy.sh against a throwaway git repo. npm, systemctl and curl are fakes on PATH:
 *  - npm "builds" by creating dist/ (and fails when the commit holds a file named BUILD_FAILS),
 *  - systemctl only logs what it was asked,
 *  - curl (the health check) fails while the live release holds a file named UNHEALTHY.
 */
describe('ops/clipfarm/deploy.sh', () => {
  let root: string;
  let repo: string;
  let live: string;
  let bin: string;
  let log: string;

  function git(...args: string[]): string {
    return execFileSync('git', ['-C', repo, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
      encoding: 'utf8',
    }).trim();
  }

  function commit(files: Record<string, string>, remove: string[] = []): string {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(repo, name), text);
    for (const name of remove) rmSync(join(repo, name));
    git('add', '-A');
    git('commit', '-q', '-m', `change ${Object.keys(files).join(' ')}`);
    return git('rev-parse', 'HEAD');
  }

  function fake(name: string, body: string) {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }

  function deploy(...args: string[]) {
    const result = spawnSync('bash', [script, ...args], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CLIPFARM_ROOT: live,
        CLIPFARM_USER: userInfo().username,
        CLIPFARM_ENV_FILE: join(root, 'clipfarm.env'),
        CLIPFARM_HEALTH_TRIES: '2',
        CLIPFARM_HEALTH_WAIT: '0',
      },
      encoding: 'utf8',
    });
    return { status: result.status, out: result.stdout + result.stderr };
  }

  const current = () => basename(readlinkSync(join(live, 'current')));
  const releases = () => readdirSync(join(live, 'releases')).sort();
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'clipfarm-deploy-test-'));
    live = join(root, 'live');
    repo = join(live, 'repo');
    bin = join(root, 'bin');
    log = join(root, 'calls.log');
    mkdirSync(repo, { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(root, 'clipfarm.env'), 'HOST=127.0.0.1\nPORT=5999\n');
    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);

    fake(
      'npm',
      `echo "npm $*" >> "${log}"
       [ ! -e BUILD_FAILS ] || { echo "build broke" >&2; exit 1; }
       if [ "$1 $2" = "run build" ]; then mkdir -p dist/server dist/client && echo "// server" > dist/server/index.js && echo "<html>" > dist/client/index.html; fi`,
    );
    fake('systemctl', `echo "systemctl $*" >> "${log}"`);
    fake(
      'curl',
      `echo "curl \${@: -1}" >> "${log}"
       [ ! -e "${live}/current/UNHEALTHY" ] || exit 22
       echo '{"ok":true}'`,
    );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('builds the commit into a fresh release, installs without dev packages, switches current, restarts and checks health', () => {
    const sha = commit({ 'package.json': '{}', 'app.txt': 'v1' });
    const { status, out } = deploy(sha);

    expect(out).toContain('is live');
    expect(status).toBe(0);
    expect(current()).toContain(sha.slice(0, 12));
    expect(readFileSync(join(live, 'current', 'app.txt'), 'utf8')).toBe('v1');
    expect(existsSync(join(live, 'current', 'dist', 'server', 'index.js'))).toBe(true);
    expect(calls()).toEqual([
      'npm ci',
      'npm run build',
      'npm ci --omit=dev',
      'systemctl restart clipfarm',
      'curl http://127.0.0.1:5999/api/health',
    ]);
  });

  it('goes back to the release that was live when the new one fails its health check', () => {
    const good = commit({ 'package.json': '{}', 'app.txt': 'v1' });
    expect(deploy(good).status).toBe(0);
    const before = current();

    const bad = commit({ UNHEALTHY: 'yes', 'app.txt': 'v2' });
    const { status, out } = deploy(bad);

    expect(status).not.toBe(0);
    expect(out).toContain('went back to');
    expect(current()).toBe(before);
    expect(readFileSync(join(live, 'current', 'app.txt'), 'utf8')).toBe('v1');
    expect(releases()).toEqual([before]);
    // Restarted on the new release, then again on the old one, and the old one answered.
    expect(calls().filter((c) => c.startsWith('systemctl'))).toEqual([
      'systemctl restart clipfarm',
      'systemctl restart clipfarm',
      'systemctl restart clipfarm',
    ]);
    expect(calls().at(-1)).toBe('curl http://127.0.0.1:5999/api/health');
  });

  it('stops the service when the very first release is unhealthy: there is nothing to go back to', () => {
    const bad = commit({ 'package.json': '{}', UNHEALTHY: 'yes' });
    const { status, out } = deploy(bad);

    expect(status).not.toBe(0);
    expect(out).toContain('no earlier release');
    expect(existsSync(join(live, 'current'))).toBe(false);
    expect(releases()).toEqual([]);
    expect(calls().at(-1)).toBe('systemctl stop clipfarm');
  });

  it('leaves the live release alone when the build fails: no switch, no restart', () => {
    const good = commit({ 'package.json': '{}', 'app.txt': 'v1' });
    expect(deploy(good).status).toBe(0);
    const before = current();
    const restarts = calls().filter((c) => c.startsWith('systemctl')).length;

    const broken = commit({ BUILD_FAILS: 'yes' });
    const { status, out } = deploy(broken);

    expect(status).not.toBe(0);
    expect(out).toContain('build broke');
    expect(current()).toBe(before);
    expect(releases()).toEqual([before]);
    expect(calls().filter((c) => c.startsWith('systemctl')).length).toBe(restarts);
  });

  it('keeps the last 2 releases', () => {
    const first = commit({ 'package.json': '{}', 'app.txt': 'v1' });
    const second = commit({ 'app.txt': 'v2' });
    const third = commit({ 'app.txt': 'v3' });
    for (const sha of [first, second, third]) expect(deploy(sha).status).toBe(0);

    expect(releases().map((r) => r.split('-').at(-1))).toEqual([second.slice(0, 12), third.slice(0, 12)]);
    expect(current()).toContain(third.slice(0, 12));
  });

  it('--rollback switches to the other kept release, and back again if that one is unhealthy', () => {
    const first = commit({ 'package.json': '{}', 'app.txt': 'v1' });
    const second = commit({ 'app.txt': 'v2' });
    for (const sha of [first, second]) expect(deploy(sha).status).toBe(0);

    expect(deploy('--rollback').status).toBe(0);
    expect(current()).toContain(first.slice(0, 12));
    expect(releases()).toHaveLength(2);

    // The other release (v2) turns unhealthy: a rollback to it must not stick.
    writeFileSync(join(live, 'releases', releases().find((r) => r.includes(second.slice(0, 12)))!, 'UNHEALTHY'), 'yes');
    const { status, out } = deploy('--rollback');
    expect(status).not.toBe(0);
    expect(out).toContain('went back to');
    expect(current()).toContain(first.slice(0, 12));
  });

  it('refuses something that is not a commit, and never runs it', () => {
    commit({ 'package.json': '{}' });
    for (const ref of ['--upload-pack=touch pwned', 'main; touch pwned', '$(touch pwned)', 'nope']) {
      const { status, out } = deploy(ref);
      expect(status).not.toBe(0);
      expect(out).toMatch(/not a commit|Usage/);
    }
    expect(existsSync(join(live, 'current'))).toBe(false);
    expect(calls()).toEqual([]);
    expect(existsSync(join(repo, 'pwned'))).toBe(false);
    expect(existsSync('pwned')).toBe(false);
  });
});
