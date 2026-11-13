import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = new URL('../../ops/clipfarm/ytdlp-update.sh', import.meta.url).pathname;

/** A stand-in yt-dlp: prints its version, and "downloads" a file unless the state folder says that version is broken. */
const ytdlp = (version: string, state: string) => `#!/usr/bin/env bash
if [ "$1" = --version ]; then echo ${version}; exit 0; fi
echo "yt-dlp ${version} download" >> "${state}/calls"
[ ! -f "${state}/broken-${version}" ] || exit 1
while [ $# -gt 0 ]; do if [ "$1" = -o ]; then out="\${2/\\%(ext)s/mp4}"; fi; shift; done
echo video > "$out"
`;

/**
 * Runs the real ytdlp-update.sh against a stand-in GitHub: curl is a fake that serves the files in
 * the release folder, systemd-run stands in for clipfarm-ops (test-keys, notify).
 */
describe('ops/clipfarm/ytdlp-update.sh', () => {
  let root: string;
  let state: string;
  let program: string;

  function fake(name: string, body: string) {
    writeFileSync(join(root, 'bin', name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(root, 'bin', name), 0o755);
  }

  /** What GitHub offers as the newest release. */
  function release(version: string, sum?: string) {
    const body = ytdlp(version, state);
    writeFileSync(join(root, 'release', 'yt-dlp'), body);
    writeFileSync(join(root, 'release', 'SHA2-256SUMS'), `${sum ?? createHash('sha256').update(body).digest('hex')}  yt-dlp\nabc  yt-dlp.exe\n`);
    writeFileSync(join(root, 'release', 'latest'), version);
  }

  function update() {
    const result = spawnSync('bash', [script], {
      env: {
        ...process.env,
        PATH: `${join(root, 'bin')}:${process.env.PATH}`,
        TMPDIR: join(root, 'tmp'),
        CLIPFARM_USER: userInfo().username,
        CLIPFARM_ENV_FILE: join(root, 'clipfarm.env'),
        YTDLP_RELEASES_URL: 'https://github.test/yt-dlp/releases',
      },
      encoding: 'utf8',
    });
    return { status: result.status, out: result.stdout + result.stderr };
  }

  const version = (file = program) => spawnSync(file, ['--version'], { encoding: 'utf8' }).stdout.trim();
  const calls = () => (existsSync(join(state, 'calls')) ? readFileSync(join(state, 'calls'), 'utf8').trim().split('\n') : []);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'clipfarm-ytdlp-test-'));
    state = join(root, 'state');
    program = join(root, 'yt-dlp');
    for (const dir of ['bin', 'state', 'release', 'tmp']) mkdirSync(join(root, dir));
    writeFileSync(join(root, 'clipfarm.env'), `PORT=5999\nYT_DLP_BIN=${program}\n`);
    writeFileSync(program, ytdlp('2026.10.01', state));
    chmodSync(program, 0o755);

    fake(
      'curl',
      `out=''; url="\${@: -1}"
       while [ $# -gt 1 ]; do [ "$1" != -o ] || out="$2"; shift; done
       case "$url" in
         */latest) printf 'https://github.test/yt-dlp/releases/tag/%s' "$(cat "${root}/release/latest")" ;;
         *) cp "${root}/release/\${url##*/}" "$out" ;;
       esac`,
    );
    fake(
      'systemd-run',
      `while [ $# -gt 0 ] && [ "$1" != /usr/local/sbin/clipfarm-ops ]; do shift; done; shift
       case "$1" in
         test-keys) echo "ops test-keys" >> "${state}/calls"; echo "OpenAI: Working"; [ ! -f "${state}/keys-fail" ] || exit 1 ;;
         notify) echo "ops notify $2 | $3" >> "${state}/calls" ;;
       esac`,
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('installs the newest release when its checksum matches and it still downloads, and keeps the old program', () => {
    release('2026.11.01');
    const { status, out } = update();
    expect(out).toContain('yt-dlp 2026.11.01 is in use');
    expect(status).toBe(0);
    expect(version()).toBe('2026.11.01');
    expect(version(`${program}.previous`)).toBe('2026.10.01');
    // Tested before with the old program and after with the new one; nobody is told.
    expect(calls()).toEqual(['yt-dlp 2026.10.01 download', 'ops test-keys', 'yt-dlp 2026.11.01 download', 'ops test-keys']);
  });

  it('does nothing when the newest release is already installed', () => {
    release('2026.10.01');
    const { status, out } = update();
    expect(status).toBe(0);
    expect(out).toBe('');
    expect(calls()).toEqual([]);
    expect(existsSync(`${program}.previous`)).toBe(false);
  });

  it('puts the old program back and notifies when the new one cannot download the test video', () => {
    release('2026.11.01');
    writeFileSync(join(state, 'broken-2026.11.01'), '');
    const { status, out } = update();
    expect(status).not.toBe(0);
    expect(out).toContain('2026.11.01 was put aside: it could not download the test video. 2026.10.01 is in use again.');
    expect(version()).toBe('2026.10.01');
    expect(calls().at(-1)).toBe('ops notify yt-dlp update rolled back | yt-dlp 2026.11.01 was put aside (it could not download the test video). 2026.10.01 is in use again.');
  });

  it('puts the old program back when the key test passed before the update and fails after it', () => {
    release('2026.11.01');
    // The new program's test download flips the key test to failing.
    writeFileSync(join(root, 'release', 'yt-dlp'), ytdlp('2026.11.01', state).replace('echo video', `touch "${state}/keys-fail"; echo video`));
    release2Sum();
    const { status, out } = update();
    expect(status).not.toBe(0);
    expect(out).toContain('the key test failed with it');
    expect(version()).toBe('2026.10.01');
  });

  it('a test that already failed before the update does not count against the new release', () => {
    release('2026.11.01');
    writeFileSync(join(state, 'keys-fail'), '');
    writeFileSync(join(state, 'broken-2026.10.01'), '');
    const { status, out } = update();
    expect(status).toBe(0);
    expect(out).toContain('could not be downloaded before the update either');
    expect(version()).toBe('2026.11.01');
  });

  it('refuses a download that does not match the release checksum, and changes nothing', () => {
    release('2026.11.01', 'f'.repeat(64));
    const { status, out } = update();
    expect(status).not.toBe(0);
    expect(out).toContain('does not match its checksum');
    expect(version()).toBe('2026.10.01');
    expect(existsSync(`${program}.previous`)).toBe(false);
    expect(calls()).toEqual([]);
  });

  it('refuses a release name that is not a version', () => {
    release('2026.11.01');
    writeFileSync(join(root, 'release', 'latest'), '../../evil');
    const { status, out } = update();
    expect(status).not.toBe(0);
    expect(out).toContain('unexpected release');
    expect(version()).toBe('2026.10.01');
  });

  /** Rewrites the checksum list for the release file as it is now. */
  function release2Sum() {
    const sum = createHash('sha256').update(readFileSync(join(root, 'release', 'yt-dlp'))).digest('hex');
    writeFileSync(join(root, 'release', 'SHA2-256SUMS'), `${sum}  yt-dlp\n`);
  }
});
