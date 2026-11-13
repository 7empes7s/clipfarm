import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = new URL('../../ops/clipfarm/ops.sh', import.meta.url).pathname;

/** Runs the real ops.sh against a throwaway "live release" whose CLI prints what it was given. */
describe('ops/clipfarm/ops.sh (installed as clipfarm-ops)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'clipfarm-ops-sh-'));
    mkdirSync(join(root, 'current/dist/server/ops'), { recursive: true });
    writeFileSync(
      join(root, 'current/dist/server/ops/cli.js'),
      'console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), dataDir: process.env.DATA_DIR })); process.exitCode = 7;',
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function ops(env: Record<string, string>, ...args: string[]) {
    const { DATA_DIR: _unset, ...base } = process.env;
    const result = spawnSync('bash', [script, ...args], {
      env: { ...base, CLIPFARM_ROOT: root, CLIPFARM_USER: userInfo().username, CLIPFARM_NODE: process.execPath, ...env },
      encoding: 'utf8',
    });
    return { status: result.status, out: result.stdout, err: result.stderr };
  }

  it('runs the CLI of the live release with the arguments, from the release folder, and passes its exit code on', () => {
    const run = ops({ DATA_DIR: '/var/lib/clipfarm' }, 'run', 'latest', 'kick.com/tjr', '--count', '5');
    expect(JSON.parse(run.out)).toEqual({
      args: ['run', 'latest', 'kick.com/tjr', '--count', '5'],
      cwd: join(root, 'current'),
      dataDir: '/var/lib/clipfarm',
    });
    expect(run.status).toBe(7);
  });

  it('refuses to run without the service settings, and prints the systemd-run line to use', () => {
    const run = ops({}, 'test-keys');
    expect(run.status).toBe(2);
    expect(run.out).toBe('');
    expect(run.err).toContain('DATA_DIR is not set');
    expect(run.err).toContain(`-p EnvironmentFile=/etc/clipfarm/clipfarm.env -p MemoryMax=3072M -p UMask=0027 -p PrivateTmp=true ${script} test-keys`);
  });

  it('refuses to run as another user than the service (root would leave files the service cannot read)', () => {
    const run = ops({ DATA_DIR: '/var/lib/clipfarm', CLIPFARM_USER: 'someone-else' }, 'status');
    expect(run.status).toBe(2);
    expect(run.out).toBe('');
    expect(run.err).toContain('run it as the someone-else user: systemd-run --uid=someone-else --gid=someone-else');
  });

  it('says to update when the live release is older than clipfarm-ops', () => {
    rmSync(join(root, 'current/dist'), { recursive: true });
    const run = ops({ DATA_DIR: '/var/lib/clipfarm' }, 'status');
    expect(run.status).toBe(2);
    expect(run.err).toContain('has no clipfarm-ops yet. Update first: clipfarm-deploy origin/main');
  });
});
