// npm run clipfarm:public-pages (the office, with its Cloudflare key): lets visitors who are not
// signed in read /home, /privacy and /terms, then checks from outside that they can. It also opens
// the clipping service's pages and client portal (/service, /pricing, /portal…), which have their own sign-in.
// Needs CLOUDFLARE_API_TOKEN ("Access: Apps and Policies" Edit) and CLOUDFLARE_ACCOUNT_ID in the
// environment. Prints OK or what is wrong, never the token.
import { httpGet, publicPagesLine } from './check.ts';
import { CLIENT_ACCESS_APP_NAME, CLIENT_SERVICE_PATHS, openPublicPages } from './public-pages.ts';

const hostname = process.env.CLIPFARM_HOSTNAME ?? 'clip.techinsiderbytes.com';
const keys = { accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? '', token: process.env.CLOUDFLARE_API_TOKEN ?? '', hostname };
const result = await openPublicPages(keys);
// The clipping service's pages and client portal, which sign clients in themselves.
const portal = await openPublicPages({ ...keys, name: CLIENT_ACCESS_APP_NAME, paths: CLIENT_SERVICE_PATHS });
const lines = [...result.lines, ...portal.lines];
if (result.ok) lines.push(await publicPagesLine(hostname, httpGet));
for (const line of lines) console.log(line);
process.exitCode = lines.every((line) => line.startsWith('OK: ')) ? 0 : 1;
