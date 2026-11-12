// npm run clipfarm:check (on the box, as root): prints OK or what is wrong for the service, its port,
// Caddy and the public URL. Reads only PORT from /etc/clipfarm/clipfarm.env; changes nothing.
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { checkClipfarm } from './check.ts';

const envFile = process.env.CLIPFARM_ENV_FILE ?? '/etc/clipfarm/clipfarm.env';
const fileEnv = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};

const result = await checkClipfarm({
  port: Number(process.env.PORT ?? fileEnv.PORT ?? 5310),
  hostname: process.env.CLIPFARM_HOSTNAME ?? 'clip.techinsiderbytes.com',
});
for (const line of result.lines) console.log(line);
process.exitCode = result.ok ? 0 : 1;
