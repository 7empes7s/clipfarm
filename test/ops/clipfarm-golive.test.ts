import { describe, expect, it } from 'vitest';
import {
  channelProblem,
  golive,
  type DeployStatus,
  type GoliveBox,
  type PendingFile,
  type PostizAnswer,
  planDeploy,
  planPendingKeys,
  planPostizKey,
} from '../../ops/clipfarm/golive.ts';

// Made up, shaped like the real ones. None may show up in anything go-live prints.
const POSTIZ_KEY = 'a1b2c3d4e5f6postizGoliveTestKey0000';
const OLD_KEY = 'f0e1d2c3postizOldRevokedKey00001111';
const YT_KEY = 'AIzaSyGoliveTestYoutubeKey000000000000';
const MAIN = '1234567890abcdef1234567890abcdef12345678';
const LEONIDA = { name: 'Leonida Daily', identifier: 'youtube', disabled: false };

/** The box, faked: Postiz, the deploy and clipfarm-ops golive are in memory and record what was done. */
class FakeBox implements GoliveBox {
  lines: string[] = [];
  env: Record<string, string> = { PORT: '5310' };
  pending: PendingFile[] = [];
  removed: string[] = [];
  /** What each auto-deploy run leaves behind, in turn (the last one repeats). */
  deploys: { status: DeployStatus | null; tried: string | null }[] = [{ status: { sha: MAIN, result: 'live', reason: '' }, tried: MAIN }];
  autodeployRuns = 0;
  status: DeployStatus | null = null;
  tried: string | null = null;
  installOk = true;
  postiz: string | null = 'http://127.0.0.1:5300';
  dbKey: string | null = POSTIZ_KEY;
  /** The keys Postiz takes, and the channels it lists. */
  accepted = new Set([POSTIZ_KEY]);
  channels = [LEONIDA, { name: 'leonida.daily', identifier: 'tiktok', disabled: false }];
  restarts = 0;
  appArgs: string[] | null = null;
  appOut: string[] = ['Posting through Postiz: 2 accounts.', 'Private post on Leonida Daily: https://www.youtube.com/watch?v=abc (private: only the channel\'s owner can see it)'];
  appCode = 0;
  clock = 0;

  say(line: string) {
    this.lines.push(line);
  }
  readEnv() {
    return { ...this.env };
  }
  writeEnv(values: Record<string, string>) {
    Object.assign(this.env, values);
  }
  pendingFiles() {
    return this.pending;
  }
  writePending(path: string, text: string) {
    if (text === '') this.removed.push(path);
    this.pending = this.pending.flatMap((f) => (f.path !== path ? [f] : text ? [{ path, text }] : []));
  }
  async installAutodeploy() {
    return this.installOk;
  }
  async mainSha() {
    return MAIN;
  }
  async runAutodeploy() {
    const next = this.deploys[Math.min(this.autodeployRuns, this.deploys.length - 1)]!;
    this.autodeployRuns++;
    this.status = next.status;
    this.tried = next.tried;
  }
  deployStatus() {
    return this.status;
  }
  lastTried() {
    return this.tried;
  }
  forgetTried() {
    this.tried = null;
  }
  postizUrl() {
    return this.postiz;
  }
  async postizDbKey() {
    return this.dbKey;
  }
  async postizChannels(_url: string, key: string): Promise<PostizAnswer> {
    return this.accepted.has(key) ? { ok: true, channels: this.channels } : { ok: false, reason: 'Postiz refused the key.' };
  }
  async restartClipfarm() {
    this.restarts++;
    return true;
  }
  async appGolive(args: string[], line: (text: string) => void) {
    this.appArgs = args;
    for (const l of this.appOut) line(l);
    return this.appCode;
  }
  async sleep(ms: number) {
    this.clock += ms;
  }
  now() {
    return this.clock;
  }
}

const printed = (box: FakeBox) => box.lines.join('\n');

describe('go-live: Postiz key', () => {
  it('keys not set in clipfarm: reads the key from Postiz, checks it, saves it in clipfarm.env and restarts clipfarm', async () => {
    const box = new FakeBox();
    const code = await golive(box, { appArgs: ['--campaign', 'tjr-clipping'] });
    expect(box.env.POSTIZ_API_KEY).toBe(POSTIZ_KEY);
    expect(box.env.POSTIZ_URL).toBe('http://127.0.0.1:5300');
    expect(box.restarts).toBe(1);
    expect(box.lines).toContain('clipfarm has no Postiz key: took the one from Postiz, which works, and saved it in clipfarm.env.');
    expect(box.lines).toEqual(expect.arrayContaining(['Postiz has 2 channels:', '  Leonida Daily (youtube)']));
    expect(box.appArgs).toEqual(['--campaign', 'tjr-clipping']);
    expect(code).toBe(0);
    expect(box.lines.at(-1)).toMatch(/^Go-live: nothing is missing/);
    expect(printed(box)).not.toContain(POSTIZ_KEY);
  });

  it('a revoked key in clipfarm is replaced by the one Postiz takes', async () => {
    const box = new FakeBox();
    box.env.POSTIZ_API_KEY = OLD_KEY;
    box.env.POSTIZ_URL = 'http://127.0.0.1:5300';
    expect(await golive(box)).toBe(0);
    expect(box.env.POSTIZ_API_KEY).toBe(POSTIZ_KEY);
    expect(printed(box)).not.toContain(OLD_KEY);
  });

  it('a key that works is kept: a second run changes nothing and restarts nothing', async () => {
    const box = new FakeBox();
    await golive(box);
    box.lines = [];
    box.restarts = 0;
    expect(await golive(box)).toBe(0);
    expect(box.restarts).toBe(0);
    expect(box.lines).toContain('clipfarm already has a Postiz key that works.');
  });

  it('Postiz without an account yet: says the manager signs up, and exits 1', async () => {
    const box = new FakeBox();
    box.dbKey = null;
    expect(await golive(box)).toBe(1);
    expect(box.env.POSTIZ_API_KEY).toBeUndefined();
    expect(box.lines.slice(box.lines.indexOf('Go-live: still missing'))).toEqual([
      'Go-live: still missing',
      expect.stringMatching(/^ {2}- clipfarm has no Postiz key, and Postiz has none yet: the manager signs up once/),
    ]);
  });

  it('planPostizKey: never saves a key Postiz refuses, nor when Postiz is not installed', () => {
    const base = { current: null, currentOk: null, postizUrl: 'http://127.0.0.1:5300' };
    expect(planPostizKey({ ...base, dbKey: POSTIZ_KEY, dbOk: false }).action).toBe('missing');
    expect(planPostizKey({ ...base, dbKey: POSTIZ_KEY, dbOk: true }).action).toBe('save');
    expect(planPostizKey({ ...base, current: POSTIZ_KEY, currentOk: false, dbKey: POSTIZ_KEY, dbOk: null }).action).toBe('missing');
    expect(planPostizKey({ ...base, postizUrl: null, dbKey: POSTIZ_KEY, dbOk: true })).toMatchObject({ action: 'missing', line: expect.stringMatching(/not installed/) });
  });
});

describe('go-live: the channel', () => {
  it('Leonida Daily missing or disconnected in Postiz is on the missing list', async () => {
    expect(channelProblem([LEONIDA], 'Leonida Daily')).toBeNull();
    expect(channelProblem([{ ...LEONIDA, name: 'LEONIDA  daily' }], 'Leonida Daily')).toBeNull();
    expect(channelProblem([{ ...LEONIDA, disabled: true }], 'Leonida Daily')).toMatch(/disconnected in Postiz/);
    expect(channelProblem([{ ...LEONIDA, identifier: 'tiktok' }], 'Leonida Daily')).toMatch(/not connected in Postiz/);

    const box = new FakeBox();
    box.channels = [];
    expect(await golive(box)).toBe(1);
    expect(box.lines).toContain('Missing: Leonida Daily (YouTube) is not connected in Postiz: Add Channel, YouTube, then run go-live again.');
  });
});

describe('go-live: pending keys', () => {
  it('moves clipfarm keys (YouTube) into clipfarm.env and leaves Postiz platform keys for its installer', async () => {
    const box = new FakeBox();
    box.pending = [
      { path: '/etc/clipfarm/pending-keys/youtube.env', text: `# from Google\nexport YOUTUBE_API_KEY="${YT_KEY}"\n` },
      { path: '/etc/clipfarm/pending-keys/postiz.env', text: `YOUTUBE_CLIENT_ID=abc.apps.googleusercontent.com\nYOUTUBE_API_KEY=${YT_KEY}\n` },
    ];
    expect(await golive(box)).toBe(0);
    expect(box.env.YOUTUBE_API_KEY).toBe(YT_KEY);
    expect(box.removed).toEqual(['/etc/clipfarm/pending-keys/youtube.env']);
    expect(box.pending).toEqual([{ path: '/etc/clipfarm/pending-keys/postiz.env', text: 'YOUTUBE_CLIENT_ID=abc.apps.googleusercontent.com\n' }]);
    expect(box.lines).toContain('Saved in clipfarm.env: YOUTUBE_API_KEY.');
    expect(printed(box)).not.toContain(YT_KEY);
  });

  it('a value an env file cannot hold stays in its file and is reported by name', () => {
    const plan = planPendingKeys([{ path: '/p/k.env', text: 'YOUTUBE_API_KEY="has space"\nOPENAI_API_KEY=sk-ok123456\n' }]);
    expect(plan.save).toEqual({ OPENAI_API_KEY: 'sk-ok123456' });
    expect(plan.rewrite).toEqual([{ path: '/p/k.env', text: 'YOUTUBE_API_KEY="has space"\n' }]);
    expect(plan.bad).toEqual(['YOUTUBE_API_KEY in /p/k.env has a space or quote in it, so it was left there. Copy it again.']);
  });

  it('files without clipfarm keys are left alone', () => {
    expect(planPendingKeys([{ path: '/p/x.env', text: 'TIKTOK_CLIENT_ID=1\n' }])).toEqual({ save: {}, rewrite: [], bad: [] });
  });
});

describe('go-live: the deploy', () => {
  it('planDeploy: live, wait for the checks, try a failed main once more, then give up', () => {
    const live = { sha: MAIN, result: 'live', reason: '' };
    expect(planDeploy({ main: MAIN, status: live, lastTried: MAIN, retried: false }).state).toBe('live');
    expect(planDeploy({ main: MAIN, status: { ...live, sha: 'old0000' }, lastTried: 'old0000', retried: false }).state).toBe('wait');
    const failed = { sha: MAIN, result: 'rolled back', reason: 'Update 1234567 did not start' };
    expect(planDeploy({ main: MAIN, status: failed, lastTried: MAIN, retried: false }).state).toBe('retry');
    expect(planDeploy({ main: MAIN, status: failed, lastTried: MAIN, retried: true })).toEqual({ state: 'failed', line: 'Main 1234567890ab rolled back: Update 1234567 did not start.' });
    expect(planDeploy({ main: null, status: null, lastTried: null, retried: false }).state).toBe('failed');
  });

  it('waits for main\'s checks, then sees it live (the file /api/live-version serves)', async () => {
    const box = new FakeBox();
    box.deploys = [
      { status: { sha: 'old0000', result: 'live', reason: '' }, tried: null },
      { status: { sha: 'old0000', result: 'live', reason: '' }, tried: null },
      { status: { sha: MAIN, result: 'live', reason: '' }, tried: MAIN },
    ];
    expect(await golive(box, { pollSec: 60 })).toBe(0);
    expect(box.autodeployRuns).toBe(3);
    expect(box.lines).toContain('1234567890ab (main) is live.');
  });

  it('gives up after the wait and says so, and still runs the rest', async () => {
    const box = new FakeBox();
    box.deploys = [{ status: null, tried: null }];
    box.installOk = false;
    expect(await golive(box, { deployWaitMin: 5, pollSec: 60 })).toBe(1);
    const missing = box.lines.slice(box.lines.indexOf('Go-live: still missing') + 1);
    expect(missing).toEqual([
      '  - Auto-deploy could not be installed (above).',
      '  - Main 1234567890ab is not deployed yet: its GitHub checks are still running or one failed. Waited 5 minutes.',
    ]);
    expect(box.appArgs).not.toBeNull();
  });

  it('a failed main is tried once more, then reported', async () => {
    const box = new FakeBox();
    box.deploys = [{ status: { sha: MAIN, result: 'failed', reason: 'Update 1234567 could not be built.' }, tried: MAIN }];
    expect(await golive(box)).toBe(1);
    expect(box.autodeployRuns).toBe(2);
    expect(box.lines).toContain('Missing: Main 1234567890ab failed: Update 1234567 could not be built..');
  });
});

describe('go-live: the app\'s half', () => {
  it('collects every "Missing:" line of clipfarm-ops golive into the one list, and exits 1', async () => {
    const box = new FakeBox();
    box.appOut = ['== Keys ==', 'YouTube: Not set', 'Missing: YouTube: no Data API key.', 'Still missing:', '  - YouTube: no Data API key.'];
    box.appCode = 1;
    expect(await golive(box)).toBe(1);
    expect(box.lines.slice(box.lines.indexOf('Go-live: still missing'))).toEqual(['Go-live: still missing', '  - YouTube: no Data API key.']);
  });

  it('an app step that stopped (an old release without golive) is reported', async () => {
    const box = new FakeBox();
    box.appOut = ['clipfarm-ops: Unknown command "golive".'];
    box.appCode = 2;
    expect(await golive(box)).toBe(1);
    expect(box.lines.at(-1)).toBe('  - clipfarm-ops golive stopped (exit code 2, above).');
  });
});
