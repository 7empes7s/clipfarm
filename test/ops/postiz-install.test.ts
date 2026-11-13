import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = new URL('../../ops/postiz/install.sh', import.meta.url).pathname;

const SECRETS = ['JWT_SECRET', 'POSTIZ_DB_PASSWORD', 'TEMPORAL_DB_PASSWORD'];
const PLACEHOLDER = [
  'http://keel.techinsiderbytes.com {',
  '\treverse_proxy 127.0.0.1:3600',
  '}',
  '# Postiz placeholder: 503 until the containers run (the final block is: reverse_proxy 127.0.0.1:5300).',
  'http://postiz.techinsiderbytes.com {',
  '\trespond "Postiz is being installed" 503',
  '}',
  '',
].join('\n');

function envOf(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^'(.*)'$/, '$1');
  }
  return out;
}

describe('ops/postiz/install.sh', () => {
  let root: string;
  let bin: string;
  let postizDir: string;
  let envFile: string;
  let caddyfile: string;
  let clipfarmEnv: string;
  let calls: string;
  let state: string;

  /** A fake command: logs its arguments, then runs `body`. No container, unit or web server is touched. */
  function fake(name: string, body = '') {
    const path = join(bin, name);
    writeFileSync(path, `#!/usr/bin/env bash\necho "${name} $*" >> "${calls}"\n${body}\n`);
    chmodSync(path, 0o755);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'postiz-install-test-'));
    bin = join(root, 'bin');
    postizDir = join(root, 'opt-postiz');
    envFile = join(postizDir, '.env');
    caddyfile = join(root, 'Caddyfile');
    clipfarmEnv = join(root, 'clipfarm.env');
    calls = join(root, 'calls');
    state = join(root, 'state');
    for (const dir of [bin, state, join(root, 'systemd')]) mkdirSync(dir);
    writeFileSync(calls, '');
    writeFileSync(caddyfile, PLACEHOLDER);
    writeFileSync(join(root, 'meminfo'), 'MemTotal:        7931000 kB\nMemAvailable:    4158000 kB\n');

    // docker: "compose ps -q postiz" says whether our container runs; psql prints the stored API key.
    fake(
      'docker',
      `case "$*" in
  *"ps "*) [ -f "${state}/running" ] && echo c0ffee ;;
  *psql*) cat "${state}/apikey" 2>/dev/null ;;
esac
exit 0`,
    );
    // systemctl: is-active follows the state folder; enable/restart of postiz "starts" the containers.
    fake(
      'systemctl',
      `case "$1" in
  is-active) if [ -f "${state}/running" ]; then echo active; else echo inactive; exit 3; fi ;;
  enable|restart|start) case "$*" in *postiz.service*) touch "${state}/running" ;; esac ;;
esac`,
    );
    fake('caddy');
    fake('ss', `[ -f "${state}/port-taken" ] && echo 'LISTEN 0 4096 127.0.0.1:5300 0.0.0.0:*'; exit 0`);
    fake('curl', `[ -f "${state}/running" ] && printf 307 || printf 000`);
    fake('node', `echo "OK: Postiz at $POSTIZ_URL answered with 0 connected accounts."`);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function run(args: string[] = [], env: Record<string, string> = {}) {
    const result = spawnSync('bash', [script, ...args], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        POSTIZ_DIR: postizDir,
        SYSTEMD_DIR: join(root, 'systemd'),
        CADDYFILE: caddyfile,
        CLIPFARM_ENV_FILE: clipfarmEnv,
        MEMINFO: join(root, 'meminfo'),
        POSTIZ_NODE: join(bin, 'node'),
        MIN_DISK_MB: '1',
        HEALTH_TIMEOUT: '1',
        HEALTH_POLL: '1',
        ...env,
      },
      encoding: 'utf8',
    });
    return { status: result.status, output: result.stdout + result.stderr };
  }

  const dotenv = () => envOf(readFileSync(envFile, 'utf8'));
  const callLog = () => readFileSync(calls, 'utf8');

  it('a fresh install writes .env (mode 600) with every required value filled and starts Postiz', () => {
    const { status, output } = run();
    expect(output).toContain('Postiz is installed');
    expect(status).toBe(0);

    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    const env = dotenv();
    for (const key of SECRETS) expect(env[key], key).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(SECRETS.map((k) => env[k])).size).toBe(3);
    expect(env.MAIN_URL).toBe('https://postiz.techinsiderbytes.com');
    expect(env.FRONTEND_URL).toBe('https://postiz.techinsiderbytes.com');
    expect(env.NEXT_PUBLIC_BACKEND_URL).toBe('https://postiz.techinsiderbytes.com/api');
    expect(env.POSTIZ_PORT).toBe('5300');

    for (const file of ['docker-compose.yml', 'backup.sh']) expect(existsSync(join(postizDir, file)), file).toBe(true);
    for (const unit of ['postiz.service', 'postiz-backup.service', 'postiz-backup.timer']) {
      expect(existsSync(join(root, 'systemd', unit)), unit).toBe(true);
    }
    const log = callLog();
    expect(log).toContain('systemctl daemon-reload');
    expect(log).toContain('systemctl enable --now postiz.service');
    expect(log).toContain('systemctl enable --now postiz-backup.timer');
    expect(log.indexOf('systemctl daemon-reload')).toBeLessThan(log.indexOf('systemctl enable --now postiz.service'));

    expect(output).toContain('postiz.service: active');
    expect(output).toContain('Platform keys set: none');
    expect(output).toMatch(/connect channels in Postiz/i);
  });

  it('replaces the 503 placeholder in the Caddyfile with the proxy block and reloads Caddy', () => {
    run();
    const caddy = readFileSync(caddyfile, 'utf8');
    expect(caddy).not.toContain('503');
    expect(caddy).toContain('http://postiz.techinsiderbytes.com {\n\treverse_proxy 127.0.0.1:5300\n}');
    expect(caddy.match(/postiz\.techinsiderbytes\.com \{/g)).toHaveLength(1);
    expect(caddy).toContain('http://keel.techinsiderbytes.com {\n\treverse_proxy 127.0.0.1:3600\n}');
    expect(callLog()).toContain(`caddy validate --config ${caddyfile}`);
    expect(callLog()).toContain('systemctl reload caddy');
  });

  it('puts the old Caddyfile back and stops when Caddy refuses the new one', () => {
    fake('caddy', 'exit 1');
    const { status, output } = run();
    expect(status).not.toBe(0);
    expect(output).toMatch(/Caddy/);
    expect(readFileSync(caddyfile, 'utf8')).toBe(PLACEHOLDER);
    expect(callLog()).not.toContain('systemctl reload caddy');
  });

  it('a second run changes nothing: same secrets, same Caddyfile, no restart', () => {
    run();
    const envBefore = readFileSync(envFile, 'utf8');
    const caddyBefore = readFileSync(caddyfile, 'utf8');
    writeFileSync(calls, '');

    const { status } = run();
    expect(status).toBe(0);
    expect(readFileSync(envFile, 'utf8')).toBe(envBefore);
    expect(readFileSync(caddyfile, 'utf8')).toBe(caddyBefore);
    expect(callLog()).not.toContain('restart');
    expect(callLog()).not.toContain('systemctl reload caddy');
  });

  it('adds only the missing keys to an existing .env and keeps its values', () => {
    mkdirSync(postizDir);
    writeFileSync(envFile, 'JWT_SECRET=kept-jwt-value\nPOSTIZ_PORT=5300\nMAIN_URL=https://postiz.techinsiderbytes.com\n');
    chmodSync(envFile, 0o644);

    const { status, output } = run();
    expect(status).toBe(0);
    const env = dotenv();
    expect(env.JWT_SECRET).toBe('kept-jwt-value');
    expect(env.POSTIZ_DB_PASSWORD).toMatch(/^[0-9a-f]{64}$/);
    expect(env.TEMPORAL_DB_PASSWORD).toMatch(/^[0-9a-f]{64}$/);
    expect(env.FRONTEND_URL).toBe('https://postiz.techinsiderbytes.com');
    expect(env).toHaveProperty('YOUTUBE_CLIENT_ID', '');
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(output).not.toContain('kept-jwt-value');
  });

  it('--keys-from merges the platform keys, empties the source file and never prints a value', () => {
    const keys = join(root, 'keys.env');
    const more = join(root, 'more.env');
    writeFileSync(keys, '# from the manager\nYOUTUBE_CLIENT_ID=yt-id-111.apps\nexport YOUTUBE_CLIENT_SECRET="yt secret $222"\n\nX_API_KEY=x-key-333\r\n');
    writeFileSync(more, 'TIKTOK_CLIENT_ID=tt-id-444\n');

    const { status, output } = run(['--keys-from', keys, '--keys-from', more]);
    expect(status).toBe(0);
    const env = dotenv();
    expect(env.YOUTUBE_CLIENT_ID).toBe('yt-id-111.apps');
    expect(env.YOUTUBE_CLIENT_SECRET).toBe('yt secret $222');
    expect(env.X_API_KEY).toBe('x-key-333');
    expect(env.TIKTOK_CLIENT_ID).toBe('tt-id-444');
    expect(readFileSync(keys, 'utf8')).toBe('');
    expect(readFileSync(more, 'utf8')).toBe('');

    expect(output).toContain('Platform keys set: YOUTUBE_CLIENT_ID YOUTUBE_CLIENT_SECRET TIKTOK_CLIENT_ID X_API_KEY');
    for (const value of ['yt-id-111', '222', 'x-key-333', 'tt-id-444', ...SECRETS.map((k) => env[k])]) {
      expect(output).not.toContain(value);
      expect(callLog()).not.toContain(value);
    }
  });

  it('restarts a running Postiz when new platform keys were merged', () => {
    run();
    writeFileSync(calls, '');
    const keys = join(root, 'keys.env');
    writeFileSync(keys, 'INSTAGRAM_APP_ID=ig-555\n');
    expect(run(['--keys-from', keys]).status).toBe(0);
    expect(callLog()).toContain('systemctl restart postiz.service');
  });

  it('--keep-source leaves the keys file as it was', () => {
    const keys = join(root, 'keys.env');
    writeFileSync(keys, 'FACEBOOK_APP_ID=fb-666\n');
    expect(run(['--keys-from', keys, '--keep-source']).status).toBe(0);
    expect(dotenv().FACEBOOK_APP_ID).toBe('fb-666');
    expect(readFileSync(keys, 'utf8')).toBe('FACEBOOK_APP_ID=fb-666\n');
  });

  it('refuses unknown keys by name, without changing anything or printing a value', () => {
    const keys = join(root, 'keys.env');
    const text = 'YOUTUBE_CLIENT_ID=yt-id-111\nJWT_SECRET=evil-777\nOPENAI_API_KEY=sk-888\n';
    writeFileSync(keys, text);

    const { status, output } = run(['--keys-from', keys]);
    expect(status).not.toBe(0);
    expect(output).toContain('JWT_SECRET');
    expect(output).toContain('OPENAI_API_KEY');
    for (const value of ['yt-id-111', 'evil-777', 'sk-888']) expect(output).not.toContain(value);
    expect(readFileSync(keys, 'utf8')).toBe(text);
    expect(existsSync(envFile)).toBe(false);
    expect(callLog()).not.toContain('systemctl');
  });

  it('stops with a plain reason when less than 2.5 GB of memory is available', () => {
    writeFileSync(join(root, 'meminfo'), 'MemTotal:        7931000 kB\nMemAvailable:    1024000 kB\n');
    const { status, output } = run();
    expect(status).not.toBe(0);
    expect(output).toMatch(/1000 MB of memory is available.*2500 MB/);
    expect(existsSync(envFile)).toBe(false);
    expect(callLog()).not.toContain('systemctl enable');
  });

  it('stops when another program holds port 5300, and carries on when it is Postiz itself', () => {
    writeFileSync(join(state, 'port-taken'), '');
    const taken = run();
    expect(taken.status).not.toBe(0);
    expect(taken.output).toMatch(/port 5300 is taken/i);
    expect(callLog()).not.toContain('systemctl enable');

    writeFileSync(join(state, 'running'), '');
    expect(run().status).toBe(0);
  });

  it('stops when docker is not running', () => {
    fake('docker', 'exit 1');
    const { status, output } = run();
    expect(status).not.toBe(0);
    expect(output).toMatch(/docker is not running/i);
  });

  it('fails when Postiz does not answer in time', () => {
    fake('systemctl');
    const { status, output } = run();
    expect(status).not.toBe(0);
    expect(output).toMatch(/did not answer/i);
    expect(output).not.toContain('Postiz is installed');
  });

  describe('once the admin account exists in Postiz', () => {
    const apiKey = '9f3c0a77d1e2b4c5a6978877665544332211ffee';

    function withAccount() {
      run();
      writeFileSync(join(state, 'apikey'), apiKey + '\n');
      writeFileSync(calls, '');
    }

    it('checks the API key against Postiz, hands it to clipfarm and closes sign-ups', () => {
      writeFileSync(clipfarmEnv, 'PORT=5310\nPOSTIZ_URL=\nPOSTIZ_API_KEY=\n');
      chmodSync(clipfarmEnv, 0o600);
      fake('node', `[ "$POSTIZ_API_KEY" = "${apiKey}" ] && [ "$POSTIZ_URL" = http://127.0.0.1:5300 ] && echo "OK: Postiz answered" || { echo "NOT OK: key refused"; exit 1; }`);
      withAccount();

      const { status, output } = run();
      expect(status).toBe(0);
      expect(output).toContain('OK: Postiz answered');
      const clipfarm = envOf(readFileSync(clipfarmEnv, 'utf8'));
      expect(clipfarm.POSTIZ_API_KEY).toBe(apiKey);
      expect(clipfarm.POSTIZ_URL).toBe('http://127.0.0.1:5300');
      expect(clipfarm.PORT).toBe('5310');
      expect(statSync(clipfarmEnv).mode & 0o777).toBe(0o600);
      expect(dotenv().DISABLE_REGISTRATION).toBe('true');
      expect(callLog()).toContain('systemctl restart postiz.service');
      expect(callLog()).toContain('systemctl try-restart clipfarm.service');
      expect(output).not.toContain(apiKey);
      expect(callLog()).not.toContain(apiKey);

      // Nothing left to change: the next run restarts nothing.
      writeFileSync(calls, '');
      expect(run().status).toBe(0);
      expect(callLog()).not.toContain('restart');
    });

    it('does not hand over a key that Postiz refuses, and fails', () => {
      writeFileSync(clipfarmEnv, 'POSTIZ_API_KEY=\n');
      fake('node', 'echo "NOT OK: Postiz refused the API key."; exit 1');
      withAccount();

      const { status, output } = run();
      expect(status).not.toBe(0);
      expect(output).toContain('NOT OK: Postiz refused the API key.');
      expect(envOf(readFileSync(clipfarmEnv, 'utf8')).POSTIZ_API_KEY).toBe('');
      expect(output).not.toContain(apiKey);
    });
  });

  it('says what is still to do while nobody has signed up yet', () => {
    writeFileSync(clipfarmEnv, 'POSTIZ_API_KEY=\n');
    const { status, output } = run();
    expect(status).toBe(0);
    expect(output).toMatch(/sign up/i);
    expect(dotenv().DISABLE_REGISTRATION).toBe('false');
    expect(envOf(readFileSync(clipfarmEnv, 'utf8')).POSTIZ_API_KEY).toBe('');
  });
});
