import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const opsDir = new URL('../../ops/clipfarm', import.meta.url).pathname;

// Made up, shaped like the real ones. Neither may show up in anything auto-deploy prints or writes.
const GH_TOKEN = 'ghp_clipfarmAutodeployTestToken0000a1b2c3';
const API_KEY = 'sk-proj-clipfarmAutodeployTestKey0000d4e5';

/**
 * Runs the real autodeploy.sh (and through it the real deploy.sh and install-autodeploy.sh) against
 * a throwaway "GitHub" (a bare git repo) and a throwaway box. gh, npm, systemctl, systemd-run, curl
 * and node are fakes on PATH, steered by files in the state folder:
 *  - gh prints the check runs in state/ci (and refuses a wrong token),
 *  - npm "builds" by creating dist/,
 *  - curl (the health check) fails while the live release holds a file named UNHEALTHY,
 *  - systemd-run stands in for clipfarm-ops: status counts state/busy down, notify is logged,
 *  - ops/postiz/install.sh in the test commits is a stub that logs its arguments.
 */
describe('ops/clipfarm/autodeploy.sh', () => {
  let root: string;
  let origin: string;
  let work: string;
  let live: string;
  let bin: string;
  let state: string;
  let log: string;
  let statusFile: string;
  let pending: string;

  function git(dir: string, ...args: string[]): string {
    return execFileSync('git', ['-C', dir, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8' }).trim();
  }

  /** A new commit on "GitHub"'s main. */
  function push(files: Record<string, string>): string {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(work, name, '..'), { recursive: true });
      writeFileSync(join(work, name), text);
    }
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', `change ${Object.keys(files).join(' ')}`);
    git(work, 'push', '-q', 'origin', 'main');
    return git(work, 'rev-parse', 'HEAD');
  }

  function fake(name: string, body: string) {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }

  const ci = (...runs: string[]) => writeFileSync(join(state, 'ci'), runs.map((r) => `${r}\n`).join(''));
  const GREEN = ['completed\tsuccess\tcheck', 'completed\tsuccess\tcompose-and-scripts'];

  function autodeploy(env: Record<string, string> = {}) {
    const result = spawnSync('bash', [join(opsDir, 'autodeploy.sh')], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CLIPFARM_ROOT: live,
        CLIPFARM_USER: userInfo().username,
        CLIPFARM_ENV_FILE: join(root, 'clipfarm.env'),
        CLIPFARM_HEALTH_TRIES: '2',
        CLIPFARM_HEALTH_WAIT: '0',
        CLIPFARM_GH_TOKEN_FILE: join(root, 'gh.env'),
        CLIPFARM_AUTODEPLOY_STATE: join(root, 'autodeploy-state'),
        CLIPFARM_AUTODEPLOY_LOCK: join(root, 'autodeploy.lock'),
        CLIPFARM_OPS_LIB: join(root, 'lib', 'ops'),
        CLIPFARM_SBIN: join(root, 'sbin'),
        CLIPFARM_DEPLOY_STATUS: statusFile,
        CLIPFARM_PENDING_KEYS: pending,
        CLIPFARM_NODE: join(bin, 'node'),
        CLIPFARM_IDLE_POLL: '0',
        SYSTEMD_DIR: join(root, 'systemd'),
        POSTIZ_DIR: join(root, 'postiz'),
        STATE_DIR: state,
        ...env,
      },
      encoding: 'utf8',
    });
    return { status: result.status, out: result.stdout + result.stderr };
  }

  const current = () => (existsSync(join(live, 'current')) ? basename(readlinkSync(join(live, 'current'))) : '');
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  const status = () => JSON.parse(readFileSync(statusFile, 'utf8'));
  const notices = () => calls().filter((c) => c.startsWith('ops notify'));
  const postizRuns = () => calls().filter((c) => c.startsWith('postiz-install'));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'clipfarm-autodeploy-test-'));
    origin = join(root, 'origin.git');
    work = join(root, 'work');
    live = join(root, 'live');
    bin = join(root, 'bin');
    state = join(root, 'state');
    log = join(root, 'calls.log');
    statusFile = join(root, 'data', 'deploy-status.json');
    pending = join(root, 'pending-keys');
    for (const dir of [bin, state, live, pending, join(root, 'data'), join(root, 'systemd'), join(root, 'sbin')]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, 'clipfarm.env'), 'HOST=127.0.0.1\nPORT=5999\n');
    writeFileSync(join(root, 'gh.env'), `GH_TOKEN=${GH_TOKEN}\n`);

    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['init', '-q', '-b', 'main', work]);
    git(work, 'remote', 'add', 'origin', origin);
    // The commits carry the real ops/clipfarm, and a stand-in for the Postiz installer.
    cpSync(opsDir, join(work, 'ops', 'clipfarm'), { recursive: true });
    mkdirSync(join(work, 'ops', 'postiz'));
    writeFileSync(
      join(work, 'ops', 'postiz', 'install.sh'),
      `#!/usr/bin/env bash
echo "postiz-install $*" >> "${log}"
if [ -f "$STATE_DIR/postiz-fails" ]; then echo "postiz-install: only 900 MB of memory is available" >&2; exit 1; fi
mkdir -p "$POSTIZ_DIR" && touch "$POSTIZ_DIR/.env"
[ ! -f "$STATE_DIR/account" ] || echo "POSTIZ_API_KEY=${API_KEY}" >> "$CLIPFARM_ENV_FILE"
while [ $# -gt 0 ]; do [ "$1" != --keys-from ] || : > "$2"; shift; done
echo "Postiz is installed."
`,
    );

    fake(
      'gh',
      `[ "$GH_TOKEN" = "${GH_TOKEN}" ] || { echo "gh: bad credentials" >&2; exit 1; }
       echo "gh \${*:1:3}" | sed 's#commits/[0-9a-f]*#commits/SHA#; s#?.*##' >> "${log}"
       cat "${state}/ci"`,
    );
    fake(
      'npm',
      `echo "npm $*" >> "${log}"
       [ ! -e BUILD_FAILS ] || { echo "build broke" >&2; exit 1; }
       if [ "$1 $2" = "run build" ]; then mkdir -p dist/server dist/client && echo "// server" > dist/server/index.js && echo "<html>" > dist/client/index.html; fi`,
    );
    fake('systemctl', `echo "systemctl $*" >> "${log}"`);
    fake(
      'curl',
      `case "$*" in *http_code*) printf 200; exit 0 ;; esac
       [ ! -e "${live}/current/UNHEALTHY" ] || exit 22
       echo '{"ok":true}'`,
    );
    // clipfarm-ops through systemd-run: the words after the program are the command.
    fake(
      'systemd-run',
      `while [ $# -gt 0 ] && [ "$1" != /usr/local/sbin/clipfarm-ops ]; do shift; done; shift
       case "$1" in
         status)
           busy="$(cat "${state}/busy" 2>/dev/null || echo 0)"
           echo "ops status" >> "${log}"
           if [ "$busy" -gt 0 ]; then echo $((busy - 1)) > "${state}/busy"; echo "Queue: 1 running, 0 waiting, 0 failed."; else echo "Queue: 0 running, 0 waiting, 0 failed."; fi ;;
         test-keys)
           echo "OpenAI: Working"; echo "Twitch: Failed the service said no to ${API_KEY}"; echo "YouTube: Not set"
           echo "clipfarm-ops: 1 of 2 connections failed." >&2; exit 1 ;;
         notify) echo "ops notify $2 | $3" >> "${log}" ;;
       esac`,
    );
    fake('node', `case "$1" in -e) exit 0 ;; esac; echo "OK: the clipfarm service is active."; [ ! -f "${state}/check-fails" ] || { echo "NOT OK: nothing listens on 127.0.0.1:5999."; exit 1; }`);

    push({ 'package.json': '{}', 'app.txt': 'v1' });
    execFileSync('git', ['clone', '-q', origin, join(live, 'repo')]);
    ci(...GREEN);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('a green head goes live, the scripts and units are installed from it, and the status file says so', () => {
    const sha = git(work, 'rev-parse', 'HEAD');
    const { status: code, out } = autodeploy();

    expect(out).toContain(`${sha.slice(0, 12)} is live.`);
    expect(code).toBe(0);
    expect(current()).toContain(sha.slice(0, 12));
    expect(calls()).toContain('gh api --paginate repos/7empes7s/clipfarm/commits/SHA/check-runs');
    expect(status()).toMatchObject({
      sha,
      result: 'live',
      reason: '',
      keys: [
        { name: 'OpenAI', state: 'Working' },
        { name: 'Twitch', state: 'Failed' },
        { name: 'YouTube', state: 'Not set' },
      ],
      check: { ok: true, problems: [] },
      postiz: { state: 'healthy', detail: '' },
    });
    expect(Date.parse(status().at)).not.toBeNaN();
    expect(notices()).toEqual([]);
    // Bootstrapped by the deploy itself: root-owned copies, both timers on.
    expect(readdirSync(join(root, 'sbin')).sort()).toEqual(['clipfarm-backup', 'clipfarm-deploy', 'clipfarm-ops']);
    expect(existsSync(join(root, 'lib', 'ops', 'clipfarm', 'autodeploy.sh'))).toBe(true);
    expect(existsSync(join(root, 'systemd', 'clipfarm-autodeploy.timer'))).toBe(true);
    expect(calls()).toContain('systemctl enable --now clipfarm-autodeploy.timer clipfarm-ytdlp-update.timer');
  });

  it('a red or pending head is not deployed, and nothing is written', () => {
    for (const runs of [
      ['completed\tsuccess\tcheck', 'completed\tfailure\tcompose-and-scripts'],
      ['completed\tsuccess\tcheck', 'in_progress\tnone\tcompose-and-scripts'],
      ['queued\tnone\tcheck'],
      [], // CI has not started on the commit yet
    ]) {
      ci(...runs);
      const { status: code } = autodeploy();
      expect(code, runs.join()).toBe(0);
      expect(current()).toBe('');
      expect(existsSync(statusFile)).toBe(false);
      expect(calls().some((c) => c.startsWith('npm') || c.startsWith('systemctl restart'))).toBe(false);
    }
    // Once the checks turn green, the same commit goes live.
    ci(...GREEN);
    expect(autodeploy().status).toBe(0);
    expect(current()).not.toBe('');
  });

  it('does nothing without a readable token, and says so without the token', () => {
    writeFileSync(join(root, 'gh.env'), 'GH_TOKEN=ghp_wrong\n');
    const { status: code, out } = autodeploy();
    expect(code).not.toBe(0);
    expect(out).toContain('could not read the checks');
    expect(out).not.toContain('ghp_wrong');
    expect(current()).toBe('');
  });

  it('waits for a running job, then deploys', () => {
    expect(autodeploy().status).toBe(0); // before the first release nothing can be running
    const before = calls().length;
    const sha = push({ 'app.txt': 'v2' });
    writeFileSync(join(state, 'busy'), '2');
    const { status: code, out } = autodeploy();
    expect(code).toBe(0);
    expect(out).toContain('a job is running: waiting for it');
    // Asked three times (busy, busy, idle) before anything was built.
    const mine = calls().slice(before);
    expect(mine.slice(0, mine.indexOf('npm ci')).filter((c) => c === 'ops status')).toHaveLength(3);
    expect(current()).toContain(sha.slice(0, 12));
  });

  it('goes anyway when the job is still running after the longest wait', () => {
    expect(autodeploy().status).toBe(0);
    const sha = push({ 'app.txt': 'v2' });
    writeFileSync(join(state, 'busy'), '1000');
    const { status: code, out } = autodeploy({ CLIPFARM_IDLE_POLL: '1', CLIPFARM_IDLE_WAIT_MAX: '1' });
    expect(out).toContain('deploying anyway');
    expect(code).toBe(0);
    expect(current()).toContain(sha.slice(0, 12));
  });

  it('a failed health check rolls back, writes "rolled back" and notifies with the reason', () => {
    expect(autodeploy().status).toBe(0);
    const before = current();
    const bad = push({ UNHEALTHY: 'yes', 'app.txt': 'v2' });

    const { status: code, out } = autodeploy();
    expect(code).not.toBe(0);
    expect(out).toContain('went back to');
    expect(current()).toBe(before);
    expect(readFileSync(join(live, 'current', 'app.txt'), 'utf8')).toBe('v1');
    expect(status()).toMatchObject({ sha: bad, result: 'rolled back' });
    expect(status().reason).toContain(`Update ${bad.slice(0, 7)} did not start`);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toContain('ops notify clipfarm update rolled back | Update');

    // The same commit is not tried again every 5 minutes, and nobody is told twice.
    const builds = calls().filter((c) => c === 'npm run build').length;
    expect(autodeploy().status).toBe(0);
    expect(calls().filter((c) => c === 'npm run build')).toHaveLength(builds);
    expect(notices()).toHaveLength(1);

    // The fix goes live.
    const fixed = push({ 'app.txt': 'v3' });
    rmSync(join(work, 'UNHEALTHY'));
    const good = push({ 'app.txt': 'v4' });
    expect(good).not.toBe(fixed);
    expect(autodeploy().status).toBe(0);
    expect(status()).toMatchObject({ sha: good, result: 'live' });
  });

  it('a build that fails leaves the live version alone, writes "failed" and notifies', () => {
    expect(autodeploy().status).toBe(0);
    const before = current();
    const bad = push({ BUILD_FAILS: 'yes' });

    expect(autodeploy().status).not.toBe(0);
    expect(current()).toBe(before);
    expect(status()).toMatchObject({ sha: bad, result: 'failed' });
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toContain('clipfarm update failed');
  });

  it('a run with nothing new does nothing', () => {
    expect(autodeploy().status).toBe(0);
    const before = { calls: calls(), status: readFileSync(statusFile, 'utf8'), current: current() };

    const { status: code, out } = autodeploy();
    expect(code).toBe(0);
    expect(out).toBe('');
    expect(readFileSync(statusFile, 'utf8')).toBe(before.status);
    expect(current()).toBe(before.current);
    // It only looked: no check read from GitHub, no build, no restart, no installer, no notice.
    const added = calls().slice(before.calls.length);
    expect(added.filter((c) => !c.startsWith('systemctl is-active'))).toEqual([]);
  });

  it('the Postiz installer runs on the first deploy, again when ops/postiz changed, and not for other changes', () => {
    expect(autodeploy().status).toBe(0);
    expect(postizRuns()).toEqual(['postiz-install ']);

    push({ 'app.txt': 'v2' });
    expect(autodeploy().status).toBe(0);
    expect(postizRuns()).toHaveLength(1);

    push({ 'ops/postiz/docker-compose.yml': 'services: {}\n' });
    const { status: code, out } = autodeploy();
    expect(code).toBe(0);
    expect(out).toContain('ops/postiz changed: running the Postiz installer');
    expect(postizRuns()).toHaveLength(2);
    // The copy root runs is the new commit's.
    expect(existsSync(join(root, 'lib', 'ops', 'postiz', 'docker-compose.yml'))).toBe(true);
  });

  it('key files dropped in pending-keys are handed to the installer and removed once merged, with no deploy needed', () => {
    expect(autodeploy().status).toBe(0);
    const keys = join(pending, 'youtube.env');
    writeFileSync(keys, 'YOUTUBE_CLIENT_SECRET=GOCSPX-clipfarmTestSecret0000\n');

    const { status: code, out } = autodeploy();
    expect(code).toBe(0);
    expect(postizRuns().at(-1)).toBe(`postiz-install --keys-from ${keys}`);
    expect(readdirSync(pending)).toEqual([]);
    expect(out).not.toContain('GOCSPX');
    expect(readFileSync(statusFile, 'utf8')).not.toContain('GOCSPX');
  });

  it('asks the installer for the Postiz API key again later, until clipfarm has it', () => {
    expect(autodeploy().status).toBe(0);
    expect(autodeploy().status).toBe(0);
    expect(postizRuns()).toHaveLength(1); // not on every run

    // Half an hour later, still no account: it asks again. Then the manager signs up.
    expect(autodeploy({ CLIPFARM_POSTIZ_KEY_RETRY_SEC: '0' }).status).toBe(0);
    expect(postizRuns()).toHaveLength(2);
    writeFileSync(join(state, 'account'), '');
    const { out } = autodeploy({ CLIPFARM_POSTIZ_KEY_RETRY_SEC: '0' });
    expect(out).toContain('clipfarm has no Postiz API key yet: running the Postiz installer');
    expect(postizRuns()).toHaveLength(3);

    // clipfarm has its key: the installer is left alone.
    expect(autodeploy({ CLIPFARM_POSTIZ_KEY_RETRY_SEC: '0' }).status).toBe(0);
    expect(postizRuns()).toHaveLength(3);
  });

  it('a Postiz installer that stops is shown on the status and told once, not every 5 minutes', () => {
    writeFileSync(join(state, 'postiz-fails'), '');
    expect(autodeploy().status).toBe(0);
    expect(status()).toMatchObject({ result: 'live', postiz: { state: 'not installed', detail: 'only 900 MB of memory is available' } });
    expect(notices()).toEqual(['ops notify Postiz needs a look | The Postiz installer stopped: only 900 MB of memory is available']);

    expect(autodeploy().status).toBe(0);
    expect(postizRuns()).toHaveLength(1);
    expect(notices()).toHaveLength(1);

    // Later (the retry wait is over) it works: the status follows.
    rmSync(join(state, 'postiz-fails'));
    expect(autodeploy({ CLIPFARM_POSTIZ_RETRY_SEC: '0' }).status).toBe(0);
    expect(postizRuns()).toHaveLength(2);
    expect(status().postiz).toEqual({ state: 'healthy', detail: '' });
  });

  it('a failed site check after a deploy is on the status and sends a notification', () => {
    writeFileSync(join(state, 'check-fails'), '');
    expect(autodeploy().status).toBe(0);
    expect(status()).toMatchObject({ result: 'live', check: { ok: false, problems: ['NOT OK: nothing listens on 127.0.0.1:5999.'] } });
    expect(notices()).toEqual(['ops notify clipfarm is live, but a check failed | NOT OK: nothing listens on 127.0.0.1:5999.']);
  });

  it('no secret is in the output, the status file or the state folder', () => {
    writeFileSync(join(pending, 'x.env'), 'X_API_SECRET=xsecret-clipfarmTestValue0000\n');
    const runs = [autodeploy()];
    push({ UNHEALTHY: 'yes' });
    runs.push(autodeploy());

    const written: string[] = [readFileSync(statusFile, 'utf8'), readFileSync(log, 'utf8')];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name));
        else written.push(readFileSync(join(dir, entry.name), 'utf8'));
      }
    };
    walk(join(root, 'autodeploy-state'));
    for (const text of [...runs.map((r) => r.out), ...written]) {
      for (const secret of [GH_TOKEN, API_KEY, 'xsecret-clipfarmTestValue0000']) expect(text).not.toContain(secret);
    }
  });
});

describe('ops/clipfarm/install-autodeploy.sh', () => {
  let root: string;
  let log: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'clipfarm-install-autodeploy-test-'));
    log = join(root, 'calls.log');
    for (const dir of ['bin', 'systemd', 'sbin']) mkdirSync(join(root, dir));
    writeFileSync(join(root, 'gh.env'), `GH_TOKEN=${GH_TOKEN}\n`);
    for (const name of ['systemctl', 'gh']) {
      writeFileSync(join(root, 'bin', name), `#!/usr/bin/env bash\necho "${name} $*" >> "${log}"\n`);
      chmodSync(join(root, 'bin', name), 0o755);
    }
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function install(env: Record<string, string> = {}) {
    const result = spawnSync('bash', [join(opsDir, 'install-autodeploy.sh')], {
      env: {
        ...process.env,
        PATH: `${join(root, 'bin')}:${process.env.PATH}`,
        CLIPFARM_OPS_LIB: join(root, 'lib', 'ops'),
        CLIPFARM_SBIN: join(root, 'sbin'),
        SYSTEMD_DIR: join(root, 'systemd'),
        CLIPFARM_AUTODEPLOY_STATE: join(root, 'state'),
        CLIPFARM_PENDING_KEYS: join(root, 'pending-keys'),
        CLIPFARM_GH_TOKEN_FILE: join(root, 'gh.env'),
        CLIPFARM_NODE: process.execPath,
        ...env,
      },
      encoding: 'utf8',
    });
    return { status: result.status, out: result.stdout + result.stderr };
  }
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  const unit = (name: string) => readFileSync(join(root, 'systemd', name), 'utf8');

  it('installs the copies, the units and the timers, and a second run changes nothing', () => {
    const first = install();
    expect(first.out).toContain('auto-deploy is on');
    expect(first.status).toBe(0);
    expect(readdirSync(join(root, 'systemd')).sort()).toEqual([
      'clipfarm-autodeploy.service',
      'clipfarm-autodeploy.timer',
      'clipfarm-ytdlp-update.service',
      'clipfarm-ytdlp-update.timer',
    ]);
    expect(readFileSync(join(root, 'sbin', 'clipfarm-deploy'), 'utf8')).toBe(readFileSync(join(opsDir, 'deploy.sh'), 'utf8'));
    expect(existsSync(join(root, 'lib', 'ops', 'postiz', 'install.sh'))).toBe(true);
    expect(calls()).toEqual(['systemctl daemon-reload', 'systemctl enable --now clipfarm-autodeploy.timer clipfarm-ytdlp-update.timer']);

    const second = install();
    expect(second.status).toBe(0);
    expect(second.out).not.toContain('updated');
    expect(calls().filter((c) => c === 'systemctl daemon-reload')).toHaveLength(1);
  });

  it('updates a clipfarm unit that is already on the box, keeps its node path, and restarts clipfarm', () => {
    writeFileSync(join(root, 'systemd', 'clipfarm.service'), '[Service]\nExecStart=/opt/node22/bin/node dist/server/index.js\nMemoryMax=1536M\n');
    expect(install().status).toBe(0);
    expect(unit('clipfarm.service')).toContain('ExecStart=/opt/node22/bin/node dist/server/index.js');
    expect(unit('clipfarm.service')).toContain('MemoryMax=3072M');
    expect(calls()).toContain('systemctl try-restart clipfarm.service');
    // Units IT never installed are not put on the box behind their back.
    expect(existsSync(join(root, 'systemd', 'clipfarm-backup.service'))).toBe(false);
  });

  it('stops with the reason when the GitHub token file is missing', () => {
    const { status, out } = install({ CLIPFARM_GH_TOKEN_FILE: join(root, 'nope.env') });
    expect(status).not.toBe(0);
    expect(out).toContain('the GitHub token file');
    expect(calls()).toEqual([]);
  });

  it('the timer runs every 5 minutes, and the units run the root-owned copies', () => {
    expect(readFileSync(join(opsDir, 'clipfarm-autodeploy.timer'), 'utf8')).toContain('OnCalendar=*:0/5\n');
    expect(readFileSync(join(opsDir, 'clipfarm-autodeploy.service'), 'utf8')).toContain('ExecStart=/usr/local/lib/clipfarm/ops/clipfarm/autodeploy.sh\n');
    expect(readFileSync(join(opsDir, 'clipfarm-ytdlp-update.service'), 'utf8')).toContain('ExecStart=/usr/local/lib/clipfarm/ops/clipfarm/ytdlp-update.sh\n');
    expect(readFileSync(join(opsDir, 'clipfarm-ytdlp-update.timer'), 'utf8')).toMatch(/OnCalendar=\*-\*-\* \d\d:\d\d:00\n/);
  });
});
