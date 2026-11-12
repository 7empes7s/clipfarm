// clipfarm-ops (npm run ops -- <command>): runs clipfarm on the box without a browser or a token.
// It reads the same DATA_DIR, keys and database as the server, as the service's user. RUNBOOK.md, "IT ops".
import { runOps } from "./commands.js";

const stop = new AbortController();
process.on("SIGINT", () => stop.abort());
process.on("SIGTERM", () => stop.abort());

process.exitCode = await runOps(process.argv.slice(2), {
  env: process.env,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  signal: stop.signal,
});
