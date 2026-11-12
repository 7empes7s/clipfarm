// npm run postiz:check: reads POSTIZ_URL / POSTIZ_API_KEY from the environment (or .env) and prints OK or what is wrong.
import { existsSync } from 'node:fs';
import { checkPostiz } from './check.ts';

if (existsSync('.env')) process.loadEnvFile('.env');

const result = await checkPostiz({ url: process.env.POSTIZ_URL, apiKey: process.env.POSTIZ_API_KEY });
for (const line of result.lines) console.log(line);
process.exitCode = result.ok ? 0 : 1;
