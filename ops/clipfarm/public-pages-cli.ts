// npm run clipfarm:public-pages (the office, with its Cloudflare key): lets visitors who are not
// signed in read /home, /privacy and /terms, then checks from outside that they can.
// Needs CLOUDFLARE_API_TOKEN ("Access: Apps and Policies" Edit) and CLOUDFLARE_ACCOUNT_ID in the
// environment. Prints OK or what is wrong, never the token.
import { httpGet, publicPagesLine } from './check.ts';
import { openPublicPages } from './public-pages.ts';

const hostname = process.env.CLIPFARM_HOSTNAME ?? 'clip.techinsiderbytes.com';
const result = await openPublicPages({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
  token: process.env.CLOUDFLARE_API_TOKEN ?? '',
  hostname,
});
const lines = [...result.lines];
if (result.ok) lines.push(await publicPagesLine(hostname, httpGet));
for (const line of lines) console.log(line);
process.exitCode = lines.every((line) => line.startsWith('OK: ')) ? 0 : 1;
