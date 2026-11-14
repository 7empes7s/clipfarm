/**
 * The one-command go-live, the box's half (run as root by golive.sh; RUNBOOK.md, "Go live"):
 *   1. clipfarm keys waiting in /etc/clipfarm/pending-keys go into clipfarm.env (YouTube first),
 *   2. auto-deploy is installed or refreshed, and CI-green main is deployed and checked,
 *   3. Postiz's API key is read from Postiz itself when clipfarm has none that works, checked,
 *      and saved in clipfarm.env; Postiz's channels are listed,
 *   4. then `clipfarm-ops golive` (the app's half: accounts, keys, proof, clips, a private post).
 * It ends with one plain list of what is still missing, and exit code 1 while there is anything.
 * Every planner is a pure function; the box is behind GoliveBox, so tests run it all on fakes.
 * Keys only ever sit in memory: they are never printed, logged or put on a command line.
 */

/** Keys of clipfarm itself that may wait in the pending-keys folder (Postiz's own keys stay there for its installer). */
export const CLIPFARM_KEYS = ['YOUTUBE_API_KEY', 'TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CLOUD_PROJECT'];

export const GOLIVE_CHANNEL = 'Leonida Daily';

export interface PendingFile {
  path: string;
  text: string;
}

export interface DeployStatus {
  sha: string;
  result: string;
  reason: string;
}

export interface PostizChannel {
  name: string;
  identifier: string;
  disabled: boolean;
}

/** What a key got from Postiz's public API: its channels, or why it was refused. */
export type PostizAnswer = { ok: true; channels: PostizChannel[] } | { ok: false; reason: string };

export interface GoliveBox {
  say(line: string): void;
  /** clipfarm.env, as KEY → value. */
  readEnv(): Record<string, string>;
  /** Sets these keys in clipfarm.env (keeping its other lines, owner and mode). */
  writeEnv(values: Record<string, string>): void;
  pendingFiles(): PendingFile[];
  /** Rewrites a pending-keys file; empty text removes it. */
  writePending(path: string, text: string): void;
  /** ops/clipfarm/install-autodeploy.sh; false when it failed (it printed why). */
  installAutodeploy(): Promise<boolean>;
  /** origin/main's commit, after a fetch; null when GitHub cannot be reached. */
  mainSha(): Promise<string | null>;
  /** One auto-deploy run (it prints what it does), waiting for it to end. */
  runAutodeploy(): Promise<void>;
  /** The file /api/live-version serves. */
  deployStatus(): DeployStatus | null;
  /** The commit auto-deploy tried last. */
  lastTried(): string | null;
  /** Lets auto-deploy try the same commit again. */
  forgetTried(): void;
  /** Where clipfarm reaches the local Postiz (http://127.0.0.1:<port>); null when Postiz is not installed. */
  postizUrl(): string | null;
  /** The API key Postiz keeps in its database; null when it has none yet (no account). */
  postizDbKey(): Promise<string | null>;
  postizChannels(url: string, key: string): Promise<PostizAnswer>;
  /** Restarts clipfarm and waits for its health check; false when it did not come back. */
  restartClipfarm(): Promise<boolean>;
  /** `clipfarm-ops golive <args>` as the service's user; its output goes through `line`. */
  appGolive(args: string[], line: (text: string) => void): Promise<number>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface GoliveOptions {
  /** How long to wait for main's checks and its deploy, in minutes. */
  deployWaitMin?: number;
  pollSec?: number;
  /** Passed on to clipfarm-ops golive. */
  appArgs?: string[];
  channel?: string;
}

// --- Planners.

/** KEY=VALUE lines of a pending-keys file (comments and blanks left out), as the Postiz installer reads them. */
export function parseKeyLines(text: string): { name: string; value: string; line: string }[] {
  const out: { name: string; value: string; line: string }[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value);
    if (quoted) value = quoted[1]!;
    out.push({ name: m[1]!, value, line });
  }
  return out;
}

/**
 * Takes clipfarm's own keys out of the pending-keys files: they go into clipfarm.env, and the files
 * keep only Postiz's keys (its installer refuses any other name, which would stop it).
 */
export function planPendingKeys(files: PendingFile[]): { save: Record<string, string>; rewrite: PendingFile[]; bad: string[] } {
  const save: Record<string, string> = {};
  const rewrite: PendingFile[] = [];
  const bad: string[] = [];
  for (const file of files) {
    const ours = parseKeyLines(file.text).filter((k) => CLIPFARM_KEYS.includes(k.name));
    if (ours.length === 0) continue;
    const kept = new Set<string>();
    for (const k of ours) {
      // An env file line holds one plain value: a space, quote or line break would not survive it.
      if (k.value && !/^[A-Za-z0-9._~+/=:@-]+$/.test(k.value)) {
        kept.add(k.name);
        bad.push(`${k.name} in ${file.path} has a space or quote in it, so it was left there. Copy it again.`);
      } else if (k.value) save[k.name] = k.value;
    }
    const left = file.text.split('\n').filter((line) => {
      const k = parseKeyLines(line)[0];
      return !k || !CLIPFARM_KEYS.includes(k.name) || kept.has(k.name);
    });
    const text = left.some((line) => parseKeyLines(line).length > 0) ? left.join('\n') : '';
    rewrite.push({ path: file.path, text });
  }
  return { save, rewrite, bad };
}

/** What the deploy step found: main is live, auto-deploy should try again, or wait for main's checks. */
export function planDeploy(input: { main: string | null; status: DeployStatus | null; lastTried: string | null; retried: boolean }):
  | { state: 'live' | 'wait' | 'retry'; line: string }
  | { state: 'failed'; line: string } {
  const { main, status, lastTried, retried } = input;
  if (!main) return { state: 'failed', line: 'GitHub could not be reached, so main is unknown (the token file /etc/keel/gh.env, the network).' };
  const short = main.slice(0, 12);
  if (status?.sha === main && status.result === 'live') return { state: 'live', line: `${short} (main) is live.` };
  if (lastTried === main) {
    const why = status?.sha === main ? `${status.result}: ${status.reason || 'see journalctl -u clipfarm-autodeploy'}` : 'it did not go live';
    return retried ? { state: 'failed', line: `Main ${short} ${why}.` } : { state: 'retry', line: `Main ${short} was tried before (${why}): trying it once more.` };
  }
  return { state: 'wait', line: `Main ${short} is not deployed yet: its GitHub checks are still running or one failed.` };
}

/**
 * The Postiz key for clipfarm: keep the one clipfarm has when Postiz takes it, else the one Postiz
 * keeps in its database when Postiz takes that, else say what is missing.
 */
export function planPostizKey(input: { current: string | null; currentOk: boolean | null; dbKey: string | null; dbOk: boolean | null; postizUrl: string | null }):
  | { action: 'keep' | 'save'; line: string }
  | { action: 'missing'; line: string } {
  const { current, currentOk, dbKey, dbOk, postizUrl } = input;
  if (!postizUrl) return { action: 'missing', line: 'Postiz is not installed on this box (auto-deploy installs it; see journalctl -u clipfarm-autodeploy).' };
  if (current && currentOk) return { action: 'keep', line: 'clipfarm already has a Postiz key that works.' };
  const had = current ? 'The Postiz key in clipfarm is refused' : 'clipfarm has no Postiz key';
  if (!dbKey) return { action: 'missing', line: `${had}, and Postiz has none yet: the manager signs up once on postiz.techinsiderbytes.com (the first account is the admin), then run go-live again.` };
  if (dbKey === current || !dbOk) return { action: 'missing', line: `${had}, and Postiz refuses its own key: check Postiz (cd /opt/postiz && docker compose ps).` };
  return { action: 'save', line: `${had}: took the one from Postiz, which works, and saved it in clipfarm.env.` };
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The channel go-live posts to, among Postiz's channels. */
export function channelProblem(channels: PostizChannel[], name: string): string | null {
  const named = channels.filter((c) => c.identifier === 'youtube' && squash(c.name) === squash(name));
  if (named.some((c) => !c.disabled)) return null;
  if (named.length > 0) return `${name} is disconnected in Postiz: reconnect it there (Preferences, Reconnect channel).`;
  return `${name} (YouTube) is not connected in Postiz: Add Channel, YouTube, then run go-live again.`;
}

// --- The run.

export async function golive(box: GoliveBox, opts: GoliveOptions = {}): Promise<number> {
  const missing: string[] = [];
  const miss = (text: string) => {
    missing.push(text);
    box.say(`Missing: ${text}`);
  };
  const channel = opts.channel ?? GOLIVE_CHANNEL;
  let envChanged = false;

  box.say('== 1. Keys waiting in the pending-keys folder ==');
  const pending = planPendingKeys(box.pendingFiles());
  const names = Object.keys(pending.save);
  if (names.length > 0) {
    box.writeEnv(pending.save);
    envChanged = true;
    box.say(`Saved in clipfarm.env: ${names.join(', ')}.`);
  } else box.say('No clipfarm key is waiting there.');
  for (const f of pending.rewrite) box.writePending(f.path, f.text);
  for (const b of pending.bad) miss(b);

  box.say('== 2. Auto-deploy and main ==');
  if (!(await box.installAutodeploy())) miss('Auto-deploy could not be installed (above).');
  const deadline = box.now() + (opts.deployWaitMin ?? 30) * 60_000;
  let retried = false;
  for (;;) {
    await box.runAutodeploy();
    const plan = planDeploy({ main: await box.mainSha(), status: box.deployStatus(), lastTried: box.lastTried(), retried });
    box.say(plan.line);
    if (plan.state === 'live') break;
    if (plan.state === 'failed') {
      miss(plan.line);
      break;
    }
    if (plan.state === 'retry') {
      box.forgetTried();
      retried = true;
      continue;
    }
    if (box.now() >= deadline) {
      miss(`${plan.line} Waited ${opts.deployWaitMin ?? 30} minutes.`);
      break;
    }
    await box.sleep((opts.pollSec ?? 60) * 1000);
  }

  box.say('== 3. Postiz ==');
  const url = box.postizUrl();
  const env = box.readEnv();
  const current = env.POSTIZ_API_KEY || null;
  // clipfarm reaches Postiz on the box itself.
  const target = env.POSTIZ_URL || url;
  let answer: PostizAnswer | null = current && target ? await box.postizChannels(target, current) : null;
  let dbKey: string | null = null;
  let dbAnswer: PostizAnswer | null = null;
  if (url && !answer?.ok) {
    dbKey = await box.postizDbKey();
    if (dbKey && dbKey !== current) dbAnswer = await box.postizChannels(url, dbKey);
  }
  const plan = planPostizKey({ current, currentOk: answer ? answer.ok : null, dbKey, dbOk: dbAnswer ? dbAnswer.ok : null, postizUrl: url });
  box.say(plan.line);
  if (plan.action === 'missing') miss(plan.line);
  if (plan.action === 'save' && dbKey && url) {
    box.writeEnv({ POSTIZ_URL: env.POSTIZ_URL || url, POSTIZ_API_KEY: dbKey });
    envChanged = true;
    answer = dbAnswer;
  }
  if (answer?.ok) {
    box.say(`Postiz has ${answer.channels.length} channel${answer.channels.length === 1 ? '' : 's'}:`);
    for (const c of answer.channels) box.say(`  ${c.name} (${c.identifier})${c.disabled ? ', disconnected' : ''}`);
    const problem = channelProblem(answer.channels, channel);
    if (problem) miss(problem);
  } else if (answer && !answer.ok && plan.action !== 'missing') miss(`Postiz: ${answer.reason}`);

  if (envChanged) {
    box.say('clipfarm.env changed: restarting clipfarm.');
    if (!(await box.restartClipfarm())) miss('clipfarm did not come back after the restart (journalctl -u clipfarm -n 50).');
  }

  box.say('== 4. clipfarm: accounts, keys, proof, clips and a private post ==');
  const code = await box.appGolive(opts.appArgs ?? [], (text) => {
    box.say(text);
    const m = /^Missing: (.*)$/.exec(text);
    if (m) missing.push(m[1]!);
  });
  if (code !== 0 && code !== 1) missing.push(`clipfarm-ops golive stopped (exit code ${code}, above).`);

  box.say('');
  if (missing.length === 0) {
    box.say('Go-live: nothing is missing. The private post link is above; a public post waits for the manager.');
    return 0;
  }
  box.say('Go-live: still missing');
  for (const m of [...new Set(missing)]) box.say(`  - ${m}`);
  return 1;
}
