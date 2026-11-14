// clipfarm-ops golive: the app's half of the one-command go-live (ops/clipfarm/golive.sh runs the
// box's half as root first, then this as the service's user). RUNBOOK.md, "Go live".
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ProofRun } from "../../shared/proof.js";
import { needsManualSubmit, type SubmitWindowInfo } from "../../shared/submitWindow.js";
import type { ChannelAccount, Clip, Permission, Source } from "../../shared/types.js";
import { channelKey } from "../liveproof/service.js";
import type { Runtime } from "../runtime.js";
import {
  duration,
  followProof,
  keyLine,
  keyResults,
  type KeyResult,
  launchLines,
  type OpsIo,
  proofLines,
  runDrill,
  sourceCommand,
  sourceLine,
  takeProofWork,
  UsageError,
} from "./commands.js";

/** The niche page the TJR clips go to first. */
export const GOLIVE_CHANNEL = "Leonida Daily";
export const TJR_RULES = "Caption must include #TJR. English only. Made without AI voices or added logos. Submit within 30 minutes of posting.";
const PENDING_KEYS = "/etc/clipfarm/pending-keys";

/** The private test post, kept so a second go-live reads its link instead of uploading again. */
export interface PrivatePost {
  clipId: number;
  accountId: string;
  externalId: string;
  url: string | null;
  at: string;
}

// --- Planners: what to do and what to say, from what was found. No calls out.

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The YouTube channel go-live posts to, among the accounts the posting service lists. */
export function findChannel(accounts: ChannelAccount[], name: string, service: string): { account: ChannelAccount | null; problem: string | null } {
  const named = accounts.filter((a) => a.platform === "youtube" && !a.direct && [a.name, a.handle ?? ""].some((n) => squash(n) === squash(name)));
  const account = named.find((a) => !a.disabled) ?? null;
  if (account) return { account, problem: null };
  if (named.length > 0) return { account: null, problem: `${name} is disconnected in ${service}: reconnect it there (Preferences, Reconnect channel).` };
  return { account: null, problem: `${name} (YouTube) is not among the accounts ${service} lists. Connect it in ${service} (Add Channel, YouTube), then run go-live again.` };
}

/** Go-live needs Postiz (to post) and YouTube (streams and trends); any key that fails is a problem too. */
export function keyProblems(results: KeyResult[]): string[] {
  const problems: string[] = [];
  for (const r of results) {
    if (r.state === "Failed") problems.push(`${r.label}: the saved key fails (${r.detail}). Fix it in the app under Settings.`);
    else if (r.state === "Not set" && r.id === "postiz") problems.push("Postiz: no key in clipfarm. Go-live as root reads it from Postiz; Postiz must have its first account (the manager signs up once).");
    else if (r.state === "Not set" && r.id === "youtube") {
      problems.push(`YouTube: no Data API key. Put a line YOUTUBE_API_KEY=<key> in a file under ${PENDING_KEYS}/ (or run the Google provider action), then run go-live again.`);
    }
  }
  return problems;
}

/** The clip for the private test: the best-scored one that passed the quality check and was not rejected. */
export function pickPrivateClip(clips: Clip[]): Clip | null {
  const usable = clips.filter((c) => c.status !== "rejected" && (c.quality === null || c.quality.issues.length === 0));
  // A clip the check passed beats one it never looked at.
  const rank = (c: Clip) => (c.quality ? 1000 : 0) + (c.score ?? 0);
  return [...usable].sort((a, b) => rank(b) - rank(a))[0] ?? null;
}

/** A private post kept from an earlier go-live, when it is for the same channel and its clip is still there. */
export function reusablePost(saved: PrivatePost | null, accountId: string, clipIds: number[]): PrivatePost | null {
  return saved && saved.accountId === accountId && clipIds.includes(saved.clipId) ? saved : null;
}

/** What stands between the private test and a public post, in plain words. */
export function beforePublic(input: { clip: Clip | null; channel: string; permission: Permission | null; submit: SubmitWindowInfo }): string[] {
  const { clip, channel, permission, submit } = input;
  const lines = [
    clip
      ? `The manager's go-ahead: approve clip ${clip.id} ("${clip.title}") in the app, then Post to ${channel}. Nothing goes public before that.`
      : `The manager's go-ahead: approve a TJR clip in the app, then Post to ${channel}. Nothing goes public before that.`,
  ];
  if (permission && needsManualSubmit(permission)) {
    lines.push(
      submit.hours.enabled
        ? `The Whop submit window: TJR posts go out only in the manager's submit hours (${submit.hours.timeZone}), and each one is submitted on Whop within 30 minutes (the phone counts down).`
        : "The Whop submit window: submit hours are off, so a TJR post goes out at once and must be submitted on Whop within 30 minutes (the phone counts down).",
    );
  }
  if (permission?.expiresAt) lines.push(`The TJR permission record runs until ${permission.expiresAt.slice(0, 10)}.`);
  return lines;
}

function readSaved(file: string): PrivatePost | null {
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as { privatePost?: PrivatePost }).privatePost ?? null;
  } catch {
    return null;
  }
}

function clipReport(c: Clip): string[] {
  const checked = c.quality === null ? "not checked" : c.quality.issues.length === 0 ? "quality ok" : `quality: ${c.quality.issues.length} issue(s)`;
  return [`clip ${c.id}  score ${c.score === null ? "-" : Math.round(c.score)}  ${duration(c.durationSec)}  ${checked}`, `  Hook: ${c.hook}`, `  Title: ${c.title}`];
}

/** Runs the app's go-live steps and returns the exit code: 1 while anything is missing. */
export async function golive(rt: Runtime, io: OpsIo, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      channel: { type: "string", default: GOLIVE_CHANNEL },
      campaign: { type: "string" },
      "drill-minutes": { type: "string", default: "15" },
      "url-wait": { type: "string", default: "10" },
    },
  });
  const drillMinutes = Number(values["drill-minutes"]);
  const urlWaitMin = Number(values["url-wait"]);
  if (positionals.length > 0 || !(drillMinutes >= 0 && drillMinutes <= 120) || !(urlWaitMin >= 0)) {
    throw new UsageError("Usage: clipfarm-ops golive [--channel \"Leonida Daily\"] [--campaign <TJR Whop link>] [--drill-minutes 15 (0: no drill)] [--url-wait 10]");
  }
  const missing: string[] = [];
  const miss = (text: string) => {
    missing.push(text);
    io.out(`Missing: ${text}`);
  };
  const service = rt.publisher.service;

  io.out("== Posting accounts ==");
  let channel: ChannelAccount | null = null;
  if (service.name === "none") miss("No posting service: clipfarm has no Postiz key.");
  else {
    try {
      const accounts = await rt.publisher.syncAccounts();
      io.out(`Posting through ${service.label}: ${accounts.length} account${accounts.length === 1 ? "" : "s"}.`);
      for (const a of accounts) io.out(`  ${a.name} (${a.platform}${a.handle ? `, ${a.handle}` : ""})${a.disabled ? ", disconnected" : ""}`);
      const found = findChannel(accounts, values.channel, service.label);
      channel = found.account;
      if (found.problem) miss(found.problem);
    } catch (err) {
      miss(`${service.label} could not list the accounts: ${(err as Error).message}`);
    }
  }

  io.out("== Keys ==");
  const keys = await keyResults(io.env);
  for (const r of keys) io.out(keyLine(r));
  for (const p of keyProblems(keys)) miss(p);

  io.out("== TJR campaign ==");
  const key = channelKey(rt.config.proof.campaignChannel);
  const tjr = (): Source | undefined => rt.sources.list().find((s) => s.channelUrls.some((u) => channelKey(u) === key));
  if (!tjr() && values.campaign) {
    sourceCommand(rt, io, ["add", rt.config.proof.campaignChannel, "--campaign", values.campaign, "--name", "TJR", "--rules", TJR_RULES]);
  }
  const source = tjr();
  if (!source) miss(`No source for ${rt.config.proof.campaignChannel} with its campaign permission record: run go-live with --campaign <the TJR Whop campaign link>.`);
  else {
    io.out(sourceLine(source));
    if (source.permissionState !== "active") miss(`The TJR permission record is ${source.permissionState}: renew it in Sources.`);
  }
  const permission = source?.permissions.at(-1) ?? null;

  io.out("== Daily proof and launch drill ==");
  let tjrClips: Clip[] = [];
  if (source?.permissionState === "active") {
    await takeProofWork(rt, io);
    const runs = await followProof(rt, io, rt.proof.request("ops").map((r) => r.id));
    for (const r of runs) for (const line of proofLines(r)) io.out(line);
    const failed = runs.filter((r) => r.status === "failed");
    if (failed.length > 0) miss(`The proof missed its target on ${failed.map((r) => r.label || r.target).join(", ")} (above).`);
    if (drillMinutes > 0) {
      const drill = await runDrill(rt, io, drillMinutes);
      for (const line of proofLines(drill)) io.out(line);
      if (drill.status === "failed") miss("The launch drill missed its target (above).");
    }
    for (const line of launchLines(rt)) io.out(line);

    // The TJR video the proof just clipped, else the newest TJR video clipfarm already clipped.
    const campaign: ProofRun | undefined = runs.find((r) => r.target === "campaign");
    const clipsOf = (vodId: number) => rt.clips.list().filter((c) => c.vodId === vodId).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    let vodId = campaign?.vodId ?? null;
    if (vodId === null || clipsOf(vodId).length === 0) {
      vodId = rt.vods.list().filter((v) => v.sourceId === source.id).map((v) => v.id).sort((a, b) => b - a).find((id) => clipsOf(id).length > 0) ?? null;
      if (vodId !== null) io.out(`No new TJR video this time; the newest one clipfarm already clipped is video ${vodId}.`);
    }
    if (vodId === null) miss("No TJR clips yet: the proof found no TJR video to clip (above).");
    else {
      tjrClips = clipsOf(vodId);
      const vod = rt.vods.get(vodId);
      const passed = tjrClips.filter((c) => c.quality && c.quality.issues.length === 0).length;
      const checked = tjrClips.filter((c) => c.quality).length;
      const minutes = campaign?.vodId === vodId ? campaign.metrics.allClipsMin : null;
      io.out(
        `TJR video ${vodId} (${duration(vod.durationSec ?? 0)}): ${tjrClips.length} clips${minutes !== null ? ` in ${Math.round(minutes)} min` : ""}, quality check ${passed} of ${checked} passed. ${vod.url}`,
      );
      for (const c of tjrClips) for (const line of clipReport(c)) io.out(line);
    }
  } else io.out("Skipped: it needs the TJR source with a permission record in force.");

  io.out("== Private test post ==");
  const clip = pickPrivateClip(tjrClips);
  if (channel && clip) {
    const stateFile = join(resolve(io.env.DATA_DIR ?? "data"), "golive.json");
    const save = (p: PrivatePost) => writeFileSync(stateFile, JSON.stringify({ privatePost: p }, null, 2), { mode: 0o600 });
    let post = reusablePost(readSaved(stateFile), channel.id, tjrClips.map((c) => c.id));
    if (post) io.out(`Already uploaded by an earlier go-live (clip ${post.clipId}): not uploading again.`);
    else {
      try {
        const at = new Date().toISOString();
        const result = await rt.publisher.privateTest(clip.id, channel.id);
        if (result.status === "failed" || !result.externalId) miss(`The private upload to ${channel.name} failed: ${result.error ?? "no post was made"}`);
        else {
          post = { clipId: clip.id, accountId: channel.id, externalId: result.externalId, url: result.url, at };
          save(post);
          io.out(`Uploaded clip ${clip.id} to ${channel.name} as a private video.`);
        }
      } catch (err) {
        miss(`The private upload to ${channel.name} was refused: ${(err as Error).message}`);
      }
    }
    // Postiz uploads in the background: its link comes with the post's status.
    const until = Date.now() + urlWaitMin * 60_000;
    while (post && !post.url) {
      const [update] = await service.refresh([{ externalId: post.externalId, accountId: post.accountId, platform: "youtube", scheduledAt: post.at }]);
      if (update?.status === "failed") {
        miss(`${channel.name} refused the private upload: ${update.error ?? "no reason given"}`);
        break;
      }
      if (update?.url) {
        post = { ...post, url: update.url };
        save(post);
      } else if (Date.now() >= until) {
        miss(`${service.label} has not finished the private upload yet (post ${post.externalId}). Run go-live again in a few minutes for its link.`);
        break;
      } else await new Promise((r) => setTimeout(r, (io.pollMs ?? 1000) * 15));
    }
    if (post?.url) io.out(`Private post on ${channel.name}: ${post.url} (private: only the channel's owner can see it)`);
  } else io.out(`Skipped: it needs ${values.channel} in the accounts and a TJR clip (see Missing above).`);

  io.out("== Before a public post ==");
  for (const line of beforePublic({ clip, channel: values.channel, permission, submit: rt.publisher.submitInfo() })) io.out(`  - ${line}`);

  if (missing.length === 0) {
    io.out("Nothing is missing on clipfarm's side.");
    return 0;
  }
  io.out("Still missing:");
  for (const m of missing) io.out(`  - ${m}`);
  return 1;
}
