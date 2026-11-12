import { readdirSync, statfsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Clip, Job, Source, WatchPlatform } from "../../shared/types.js";
import { PERMISSION_KIND_LABELS, WATCH_PLATFORMS } from "../../shared/types.js";
import { channelUrl, normalizeHandle } from "../../shared/watchlist.js";
import { openSettings } from "../config.js";
import { HttpError, ValidationError } from "../errors.js";
import { INGEST_JOB } from "../pipeline/ingest/ingest.js";
import { RENDER_JOB } from "../pipeline/render/job.js";
import { openRuntime, type Runtime } from "../runtime.js";
import { INTEGRATIONS, isConfigured } from "../settings/integrations.js";
import { testIntegration } from "../settings/keyTests.js";
import { Settings } from "../settings/store.js";
import { parseNewSource } from "../sources/repo.js";
import { mentionsLeak } from "../sources/watchlist/match.js";
import { PlatformError } from "../sources/watchlist/platforms/types.js";

export interface OpsIo {
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  /** How often `run` looks at its jobs. */
  pollMs?: number;
  /** Aborted on Ctrl+C or SIGTERM: `run` stops waiting and puts its job back in the queue. */
  signal?: AbortSignal;
}

const USAGE = `clipfarm-ops: run clipfarm on the box, without a browser.

  clipfarm-ops test-keys
      Tests every saved key. One line each: "NAME: Working", "NAME: Failed <reason>" or "NAME: Not set".
  clipfarm-ops source add <channel link> [--kind whop-campaign] --campaign <link or Whop id>
                          [--name <creator>] [--rules <brief>] [--banned <off limits>]
                          [--platforms tiktok,youtube,instagram] [--rate <USD per 1,000 views>]
                          [--min-views <n>] [--expires <date>]
      Adds a creator with its permission record. --kind: whop-campaign, direct-permission, own-content.
  clipfarm-ops source list
  clipfarm-ops source remove <id>
  clipfarm-ops run latest <source id or channel link> [--count N]
  clipfarm-ops run <video link> [--source <id or channel link>] [--count N]
      Download, transcribe, pick and render. The clips wait in the gallery; nothing is posted.
  clipfarm-ops clips [--since 2h | 3d | 2026-11-12]
  clipfarm-ops status
      Jobs, the queue and the disk.`;

/** A mistake in how the command was typed (exit code 2). */
class UsageError extends Error {}

function duration(sec: number): string {
  const s = Math.round(sec);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function withScheme(link: string): string {
  return /^https?:\/\//i.test(link) ? link : `https://${link}`;
}

/** The platform and handle of a channel link, when it is on Twitch, Kick or YouTube. */
function channelOf(link: string): { platform: WatchPlatform; handle: string } | null {
  for (const platform of WATCH_PLATFORMS) {
    const handle = normalizeHandle(platform, withScheme(link));
    if (handle) return { platform, handle };
  }
  return null;
}

/** One spelling per channel, so "kick.com/tjr" and "https://kick.com/TJR/" are the same source. */
function channelKey(link: string): string {
  const channel = channelOf(link);
  return (channel ? channelUrl(channel) : withScheme(link)).toLowerCase().replace(/\/+$/, "");
}

function findSource(rt: Runtime, ref: string): Source {
  if (/^\d+$/.test(ref)) return rt.sources.get(Number(ref));
  const key = channelKey(ref);
  const found = rt.sources.list().find((s) => s.channelUrls.some((u) => channelKey(u) === key));
  if (!found) throw new ValidationError(`No source has the channel ${ref}. Add it first: clipfarm-ops source add ${ref} --campaign <link>`);
  return found;
}

function sourceLine(s: Source): string {
  const p = s.permissions.at(-1);
  const permission = p ? `${PERMISSION_KIND_LABELS[p.kind]}${p.campaignUrl ? ` ${p.campaignUrl}` : ""}, ${p.allowedPlatforms.join(", ")}` : "no permission record";
  return `Source ${s.id}: ${s.creatorName} (${s.channelUrls.join(", ") || "no channel"}), ${permission}, permission ${s.permissionState}`;
}

async function testKeys(io: OpsIo): Promise<number> {
  // A copy in memory: testing from here never writes the keys file the server owns.
  const settings = new Settings(null, openSettings(io.env).env());
  const demo = io.env.CLIPFARM_FAKES === "1";
  let set = 0;
  let failed = 0;
  for (const def of INTEGRATIONS) {
    if (!isConfigured(settings, def.id)) {
      io.out(`${def.label}: Not set`);
      continue;
    }
    set++;
    const result = await testIntegration(def.id, settings, demo);
    if (!result.ok) failed++;
    io.out(`${def.label}: ${result.ok ? "Working" : `Failed ${settings.scrub(result.message)}`}`);
  }
  if (demo) io.out("Demo mode (CLIPFARM_FAKES=1): nothing outside was called.");
  if (set === 0) throw new ValidationError("No key is saved yet. Paste them in the app under Settings.");
  if (failed > 0) throw new ValidationError(`${failed} of ${set} connections failed.`);
  return 0;
}

function sourceCommand(rt: Runtime, io: OpsIo, args: string[]): number {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      kind: { type: "string", default: "whop-campaign" },
      campaign: { type: "string" },
      name: { type: "string" },
      rules: { type: "string" },
      banned: { type: "string" },
      platforms: { type: "string", default: "tiktok,youtube,instagram" },
      rate: { type: "string" },
      "min-views": { type: "string" },
      expires: { type: "string" },
    },
  });
  const [action, target] = positionals;
  if (action === "list" && positionals.length === 1) {
    const all = rt.sources.list();
    for (const s of all) io.out(sourceLine(s));
    if (all.length === 0) io.out("No sources yet.");
    return 0;
  }
  if (action === "remove" && target && /^\d+$/.test(target) && positionals.length === 2) {
    const removed = rt.sources.remove(Number(target));
    io.out(`Removed source ${target} with ${removed.videos} videos and ${removed.clips} clips.`);
    return 0;
  }
  if (action !== "add" || !target || positionals.length !== 2) throw new UsageError("Usage: clipfarm-ops source add <channel link> | list | remove <id>");

  const key = channelKey(target);
  const existing = rt.sources.list().find((s) => s.channelUrls.some((u) => channelKey(u) === key));
  if (existing) {
    io.out(`Already there, nothing changed. ${sourceLine(existing)}`);
    return 0;
  }
  const channel = channelOf(target);
  // A bare Whop id ("tjr-clips") is the campaign's page on whop.com.
  const campaign = values.campaign?.trim();
  const campaignUrl = !campaign ? undefined : /^https?:\/\//i.test(campaign) || campaign.includes(".") ? withScheme(campaign) : `https://whop.com/${campaign}`;
  const number = (v: string | undefined) => (v === undefined || v.trim() === "" ? undefined : Number(v));
  const source = rt.sources.create(
    parseNewSource({
      creatorName: values.name ?? channel?.handle ?? new URL(withScheme(target)).hostname,
      channelUrls: [channel ? channelUrl(channel) : withScheme(target)],
      bannedContent: values.banned,
      permission: {
        kind: values.kind,
        campaignUrl,
        briefRules: values.rules,
        cpmRateUsd: number(values.rate),
        minViews: number(values["min-views"]),
        allowedPlatforms: values.platforms.split(",").map((p) => p.trim()),
        expiresAt: values.expires,
      },
    }),
  );
  io.out(`Added. ${sourceLine(source)}`);
  return 0;
}

/** The newest finished video of the source's channel, from the platform (Kick needs no key). */
async function latestVodUrl(rt: Runtime, source: Source, ref: string): Promise<{ url: string; title: string }> {
  const link = /^\d+$/.test(ref) ? source.channelUrls.find((u) => channelOf(u)) : ref;
  const channel = link ? channelOf(link) : null;
  if (!channel) throw new ValidationError(`${source.creatorName} has no Twitch, Kick or YouTube channel link, so its latest video cannot be found. Pass the video link instead.`);
  const client = rt.config.watchClients.find((c) => c.platform === channel.platform);
  if (!client || client.missing) throw new ValidationError(client?.missing ?? `There is no ${channel.platform} connection.`);
  const { vods } = await client.check(channel.handle);
  // Newest first. Leaked footage is never clipped (charter: no leaks).
  const vod = vods.find((v) => !mentionsLeak(v.title));
  if (!vod) throw new ValidationError(`${channelUrl(channel)} has no finished video to clip yet.`);
  return { url: vod.url, title: vod.title };
}

async function run(rt: Runtime, io: OpsIo, args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { count: { type: "string" }, source: { type: "string" }, timeout: { type: "string", default: "180" } },
  });
  const count = values.count === undefined ? undefined : Number(values.count);
  if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > 50)) throw new UsageError("--count must be a whole number from 1 to 50.");
  const timeoutMin = Number(values.timeout);
  if (!(timeoutMin > 0)) throw new UsageError("--timeout must be a number of minutes.");

  let source: Source;
  let url: string;
  if (positionals[0] === "latest" && positionals[1] && positionals.length === 2) {
    source = findSource(rt, positionals[1]);
    rt.sources.assertCanUse(source.id);
    const latest = await latestVodUrl(rt, source, positionals[1]);
    url = latest.url;
    const had = rt.vods.list().find((v) => v.url === url);
    if (had) {
      io.out(`Nothing new: the latest video of ${source.creatorName} is already in clipfarm (video ${had.id}, ${had.status}): ${url}`);
      return 0;
    }
    io.out(`Latest video of ${source.creatorName}: ${latest.title || "(no title)"}`);
  } else if (positionals.length === 1 && positionals[0] !== "latest") {
    url = withScheme(positionals[0]!);
    // A Kick or Twitch video link starts with its channel; other links need --source.
    const ref = values.source ?? new URL(url).origin + "/" + (new URL(url).pathname.split("/").filter(Boolean)[0] ?? "");
    try {
      source = findSource(rt, ref);
    } catch (err) {
      if (values.source || !(err instanceof ValidationError)) throw err;
      throw new ValidationError("Say whose video this is: --source <id or channel link> (see: clipfarm-ops source list).");
    }
    // Server-side gate: nothing is ingested without an active permission record.
    rt.sources.assertCanUse(source.id);
  } else {
    throw new UsageError("Usage: clipfarm-ops run latest <source id or channel link> [--count N] | run <video link> [--source <id or channel link>] [--count N]");
  }

  const started = Date.now();
  const vod = rt.vods.create(source.id, url);
  // The clipfarm service runs the job when it is up (one heavy job at a time on the box);
  // otherwise this command takes the queue and does the work itself.
  rt.queue.start();
  const job = rt.queue.enqueue(INGEST_JOB, { vodId: vod.id, ...(count ? { maxPicks: count } : {}) }, { vodId: vod.id });
  io.out(`Job ${job.id}: video ${vod.id} of ${source.creatorName}: ${url}`);
  io.out(rt.queue.working ? "The clipfarm service is not running, so this command does the work." : "The clipfarm service does the work; this command follows it.");

  const mine = (): Job[] => rt.queue.list(1000).filter((j) => j.vodId === vod.id).reverse();
  const seen = new Map<number, string>();
  let quietPolls = 0;
  // Two quiet looks in a row: the next step is queued in the same instant the one before it ends.
  while (quietPolls < 2) {
    if (io.signal?.aborted) throw new ValidationError(`Stopped waiting. Job ${job.id} stays in the queue; see: clipfarm-ops status`);
    if (Date.now() - started > timeoutMin * 60_000) {
      throw new ValidationError(`Still working after ${timeoutMin} minutes; not waiting longer. The jobs carry on: clipfarm-ops status`);
    }
    const jobs = mine();
    for (const j of jobs) {
      if (j.status === "queued" && !j.error) continue;
      const state = `${j.status}|${j.message}|${Math.floor(j.progress * 10)}`;
      if (seen.get(j.id) === state) continue;
      seen.set(j.id, state);
      const detail = j.status === "failed" || j.status === "queued" ? `: ${j.error}` : j.status === "running" ? ` ${Math.round(j.progress * 100)}%` : "";
      io.out(`[${new Date().toISOString().slice(11, 19)}] job ${j.id} ${j.type}: ${j.message}${detail}`);
    }
    quietPolls = jobs.some((j) => j.status === "queued" || j.status === "running") ? 0 : quietPolls + 1;
    if (quietPolls < 2) await new Promise((r) => setTimeout(r, io.pollMs ?? 1000));
  }

  const jobs = mine();
  const stopped = jobs.find((j) => j.type !== RENDER_JOB && j.status !== "done");
  if (stopped) throw new ValidationError(`The ${stopped.type} step ${stopped.status === "failed" ? "failed" : "was cancelled"}: ${stopped.error ?? stopped.message}`);
  const clips = rt.clips.list().filter((c) => c.vodId === vod.id).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const leftOut = rt.picks.listForVod(vod.id).filter((p) => p.status === "dropped").length;
  const failedRenders = jobs.filter((j) => j.type === RENDER_JOB && j.status !== "done");
  const video = rt.vods.get(vod.id);
  io.out(
    `Done in ${duration((Date.now() - started) / 1000)}: ${clips.length} clip${clips.length === 1 ? "" : "s"} from a ${duration(video.durationSec ?? 0)} video` +
      `${leftOut ? ` (${leftOut} picks left out by the rules)` : ""}. Kept private: nothing was posted.`,
  );
  for (const c of clips) io.out(clipLine(rt, c));
  for (const j of failedRenders) io.out(`Job ${j.id} render ${j.status}: ${j.error ?? j.message}`);
  if (clips.length === 0) throw new ValidationError(failedRenders.length ? "No clip could be rendered." : "Picking kept no moment from this video.");
  return 0;
}

function clipLine(rt: Runtime, c: Clip): string {
  return `clip ${c.id}  ${c.status}  score ${c.score === null ? "-" : Math.round(c.score)}  ${duration(c.durationSec)}  ${c.createdAt.slice(0, 16).replace("T", " ")}  ${rt.clips.filePath(c.id)}  ${c.title}`;
}

/** "2h", "3d", "45m" (ago) or a date. */
function sinceDate(raw: string): Date {
  const ago = /^(\d+)\s*([mhd])$/.exec(raw.trim());
  const date = ago ? new Date(Date.now() - Number(ago[1]) * { m: 60_000, h: 3600_000, d: 86_400_000 }[ago[2] as "m" | "h" | "d"]) : new Date(raw);
  if (Number.isNaN(date.getTime())) throw new UsageError("--since takes 2h, 3d, 45m or a date like 2026-11-12.");
  return date;
}

function listClips(rt: Runtime, io: OpsIo, args: string[]): number {
  const { values } = parseArgs({ args, options: { since: { type: "string" } } });
  const since = values.since === undefined ? null : sinceDate(values.since);
  // Ready: rendered and waiting for review, or approved. Not rejected, not being made again.
  const ready = rt.clips
    .list()
    .filter((c) => (c.status === "pending" || c.status === "approved") && (!since || new Date(c.createdAt) >= since));
  for (const c of ready) io.out(clipLine(rt, c));
  io.out(ready.length === 0 ? "No clips ready." : `${ready.length} clip${ready.length === 1 ? "" : "s"} ready.`);
  return 0;
}

function folderBytes(dir: string): number {
  let bytes = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) bytes += folderBytes(path);
    else if (e.isFile()) bytes += statSync(path).size;
  }
  return bytes;
}

function status(rt: Runtime, io: OpsIo): number {
  const seenAt = rt.queue.workerSeenAt();
  io.out(seenAt ? "Worker: running. Queued jobs are picked up within seconds." : "Worker: not running. Queued jobs wait until the clipfarm service is back.");
  const jobs = rt.queue.list(1000);
  const by = (s: Job["status"]) => jobs.filter((j) => j.status === s);
  io.out(`Queue: ${by("running").length} running, ${by("queued").length} waiting, ${by("failed").length} failed.`);
  const line = (j: Job) =>
    `job ${j.id} ${j.type}${j.vodId ? ` video ${j.vodId}` : ""}${j.clipId ? ` clip ${j.clipId}` : ""}: ${j.status}, ${j.message}${j.status === "running" ? ` ${Math.round(j.progress * 100)}%` : ""}${j.error ? `: ${j.error}` : ""}`;
  for (const j of [...by("running"), ...by("queued").reverse()]) io.out(line(j));
  for (const j of jobs.filter((x) => x.status !== "running" && x.status !== "queued").slice(0, 5)) io.out(line(j));
  const clips = rt.clips.list();
  io.out(`Clips: ${clips.filter((c) => c.status === "pending").length} waiting for review, ${clips.filter((c) => c.status === "approved").length} approved.`);
  const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
  try {
    const fs = statfsSync(rt.config.mediaDir);
    io.out(`Disk: ${gb(fs.bavail * fs.bsize)} free of ${gb(fs.blocks * fs.bsize)}; clips use ${gb(folderBytes(rt.config.mediaDir))} (${rt.config.mediaDir}).`);
  } catch {
    io.out(`Disk: ${rt.config.mediaDir} does not exist yet (no clip was made).`);
  }
  return 0;
}

/** Runs one clipfarm-ops command and returns its exit code. Every line it prints has keys taken out. */
export async function runOps(argv: string[], io: OpsIo): Promise<number> {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    io.out(USAGE);
    return command ? 0 : 2;
  }
  let rt: Runtime | null = null;
  let scrub = (line: string) => line;
  try {
    if (command === "test-keys" && args.length === 0) return await testKeys(io);
    if (!["source", "run", "clips", "status"].includes(command) || (command === "status" && args.length > 0)) {
      throw new UsageError(`Unknown command "${argv.join(" ")}".\n\n${USAGE}`);
    }
    rt = openRuntime(io.env, { pollMs: io.pollMs });
    scrub = (line) => rt!.settings.scrub(line);
    const safe: OpsIo = { ...io, out: (line) => io.out(scrub(line)) };
    if (command === "source") return sourceCommand(rt, safe, args);
    if (command === "run") return await run(rt, safe, args);
    if (command === "clips") return listClips(rt, safe, args);
    return status(rt, safe);
  } catch (err) {
    // Plain reasons (ours, and the platforms') are shown as they are; node's own argument errors too.
    const plain = err instanceof HttpError || err instanceof PlatformError || err instanceof UsageError || (err as { code?: string })?.code?.startsWith("ERR_PARSE_ARGS");
    const message = err instanceof Error ? err.message : String(err);
    io.err(`clipfarm-ops: ${scrub(plain ? message : `it went wrong: ${message}`)}`);
    return err instanceof UsageError || (err as { code?: string })?.code?.startsWith("ERR_PARSE_ARGS") ? 2 : 1;
  } finally {
    if (rt) {
      // A job this command was running is aborted and put back in the queue for the service.
      rt.queue.stop();
      await rt.queue.idle();
      rt.db.close();
    }
  }
}
