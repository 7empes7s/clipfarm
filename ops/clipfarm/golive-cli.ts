// The real box for golive.ts (golive.sh runs it as root). Paths follow the other ops scripts and
// can be moved with the same environment variables. Keys stay in memory: never printed or logged,
// never on a command line (the Postiz key goes to Postiz in a header, the env file by rename).
import { execFile, spawn } from 'node:child_process';
import { chmodSync, chownSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseEnv, parseArgs } from 'node:util';
import { golive, type DeployStatus, type GoliveBox, type PendingFile, type PostizAnswer, type PostizChannel } from './golive.ts';

const env = process.env;
const here = import.meta.dirname;
const ROOT = env.CLIPFARM_ROOT ?? '/opt/clipfarm-live';
const APP_USER = env.CLIPFARM_USER ?? 'clipfarm';
const ENV_FILE = env.CLIPFARM_ENV_FILE ?? '/etc/clipfarm/clipfarm.env';
const PENDING_KEYS = env.CLIPFARM_PENDING_KEYS ?? '/etc/clipfarm/pending-keys';
const STATE = env.CLIPFARM_AUTODEPLOY_STATE ?? '/var/lib/clipfarm-autodeploy';
const STATUS_FILE = env.CLIPFARM_DEPLOY_STATUS ?? '/var/lib/clipfarm/deploy-status.json';
const POSTIZ_DIR = env.POSTIZ_DIR ?? '/opt/postiz';
const OPS_CLI = env.CLIPFARM_OPS_CLI ?? '/usr/local/sbin/clipfarm-ops';

// The arguments are clipfarm-ops golive's (--channel, --campaign, --drill-minutes, --url-wait); the
// channel is read here too, to look for it in Postiz.
const args = process.argv.slice(2);
const { values } = parseArgs({ args, allowPositionals: true, strict: false, options: { channel: { type: 'string' } } });

function run(cmd: string, args: string[], timeoutMs = 120_000): Promise<{ code: number; stdout: string }> {
  return new Promise((done) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout) });
    });
  });
}

/** Runs a command with its output on ours, line by line through `line`. */
function stream(cmd: string, args: string[], line: (text: string) => void): Promise<number> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    createInterface({ input: child.stdout }).on('line', line);
    createInterface({ input: child.stderr }).on('line', line);
    child.on('error', () => done(127));
    child.on('close', (code) => done(code ?? 1));
  });
}

const readText = (file: string): string | null => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

const fileEnv = (file: string): Record<string, string> => {
  const text = readText(file);
  return text === null ? {} : (parseEnv(text) as Record<string, string>);
};

/** Replaces the file in one rename, with the old file's owner and mode. */
function replaceFile(file: string, text: string): void {
  const tmp = `${file}.golive-${process.pid}`;
  const old = statSync(file);
  writeFileSync(tmp, text, { mode: old.mode & 0o777 });
  chmodSync(tmp, old.mode & 0o777);
  chownSync(tmp, old.uid, old.gid);
  renameSync(tmp, file);
}

const asApp = (args: string[]) => ['-u', APP_USER, '--', 'env', `HOME=${ROOT}`, ...args];

const box: GoliveBox = {
  say: (line) => console.log(line),
  readEnv: () => fileEnv(ENV_FILE),
  writeEnv(set) {
    const lines = (readText(ENV_FILE) ?? '').split('\n');
    if (lines.at(-1) === '') lines.pop();
    for (const [name, value] of Object.entries(set)) {
      const at = lines.findIndex((l) => l.startsWith(`${name}=`));
      if (at >= 0) lines[at] = `${name}=${value}`;
      else lines.push(`${name}=${value}`);
    }
    replaceFile(ENV_FILE, `${lines.join('\n')}\n`);
  },
  pendingFiles() {
    if (!existsSync(PENDING_KEYS)) return [];
    return readdirSync(PENDING_KEYS)
      .map((name) => join(PENDING_KEYS, name))
      .filter((path) => statSync(path).isFile())
      .map((path): PendingFile => ({ path, text: readText(path) ?? '' }));
  },
  writePending(path, text) {
    if (text.trim() === '') rmSync(path, { force: true });
    else replaceFile(path, text);
  },
  installAutodeploy: async () => (await stream('bash', [join(here, 'install-autodeploy.sh')], (l) => console.log(l))) === 0,
  async mainSha() {
    const repo = join(ROOT, 'repo');
    if ((await run('runuser', asApp(['git', '-C', repo, 'fetch', '--quiet', '--prune', 'origin']))).code !== 0) return null;
    const { code, stdout } = await run('runuser', asApp(['git', '-C', repo, 'rev-parse', '--verify', '--quiet', 'origin/main^{commit}']));
    return code === 0 ? stdout.trim() : null;
  },
  async runAutodeploy() {
    const since = `@${Math.floor(Date.now() / 1000) - 1}`;
    // Through its unit: a run the timer already started is waited for, not doubled.
    await run('systemctl', ['start', 'clipfarm-autodeploy.service'], 70 * 60_000);
    const { stdout } = await run('journalctl', ['-u', 'clipfarm-autodeploy.service', '--since', since, '-o', 'cat', '--no-pager']);
    for (const line of stdout.split('\n')) if (line.trim()) console.log(`  ${line}`);
  },
  deployStatus() {
    try {
      const raw = JSON.parse(readText(STATUS_FILE) ?? '') as Partial<DeployStatus>;
      return typeof raw.sha === 'string' ? { sha: raw.sha, result: String(raw.result ?? ''), reason: String(raw.reason ?? '') } : null;
    } catch {
      return null;
    }
  },
  lastTried: () => readText(join(STATE, 'last-sha'))?.trim() || null,
  forgetTried: () => rmSync(join(STATE, 'last-sha'), { force: true }),
  postizUrl() {
    if (!existsSync(join(POSTIZ_DIR, '.env'))) return null;
    return `http://127.0.0.1:${fileEnv(join(POSTIZ_DIR, '.env')).POSTIZ_PORT || '5300'}`;
  },
  async postizDbKey() {
    const sql = 'SELECT "apiKey" FROM "Organization" WHERE "deletedAt" IS NULL AND "apiKey" IS NOT NULL ORDER BY "createdAt" LIMIT 1';
    const { code, stdout } = await run('docker', ['compose', '--project-directory', POSTIZ_DIR, 'exec', '-T', 'postiz-postgres', 'psql', '-U', 'postiz', '-d', 'postiz', '-At', '-c', sql]);
    const key = stdout.split('\n')[0]!.trim();
    return code === 0 && /^[A-Za-z0-9._-]+$/.test(key) ? key : null;
  },
  async postizChannels(url, key): Promise<PostizAnswer> {
    try {
      const res = await fetch(`${url.replace(/\/+$/, '')}/api/public/v1/integrations`, { headers: { Authorization: key }, signal: AbortSignal.timeout(20_000) });
      if (res.status === 401 || res.status === 403) return { ok: false, reason: 'Postiz refused the key.' };
      if (!res.ok) return { ok: false, reason: `Postiz answered ${res.status}.` };
      const list = (await res.json()) as { name?: string; identifier?: string; disabled?: boolean }[];
      const channels: PostizChannel[] = (Array.isArray(list) ? list : []).map((i) => ({ name: String(i.name ?? i.identifier ?? ''), identifier: String(i.identifier ?? ''), disabled: Boolean(i.disabled) }));
      return { ok: true, channels };
    } catch (err) {
      return { ok: false, reason: `Postiz did not answer at ${url} (${(err as Error).name}).` };
    }
  },
  async restartClipfarm() {
    if ((await run('systemctl', ['restart', 'clipfarm.service'])).code !== 0) return false;
    const port = fileEnv(ENV_FILE).PORT || '5310';
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) return true;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  },
  appGolive: (args, line) =>
    stream(
      'systemd-run',
      [`--uid=${APP_USER}`, `--gid=${APP_USER}`, '--pipe', '--wait', '--collect', '--quiet', `-p`, `EnvironmentFile=${ENV_FILE}`, '-p', 'MemoryMax=3072M', '-p', 'UMask=0027', '-p', 'PrivateTmp=true', OPS_CLI, 'golive', ...args],
      line,
    ),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

process.exitCode = await golive(box, {
  deployWaitMin: Number(env.CLIPFARM_GOLIVE_DEPLOY_WAIT ?? 30),
  channel: typeof values.channel === 'string' ? values.channel : undefined,
  appArgs: args,
});
